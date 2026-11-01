/** Small pure helpers shared by the collectors. */

import { MS_PER_DAY, parseDate } from '../core/history';
import { InstanceMetrics } from '../core/types';
import { MetricPoint, MetricSeries } from './ports';

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** The newest `count` points, in any input order. */
export function latestPoints(points: readonly MetricPoint[], count: number): MetricPoint[] {
  return [...points]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, count);
}

/**
 * Turns daily CloudWatch figures into the numbers the idle-server rule uses.
 *
 * The number of days we are allowed to claim ("windowDays") is the SMALLEST of:
 *   - the days the rule asked for,
 *   - whole days since the server launched (a new server cannot be judged),
 *   - days that have CPU data, and days that have network-in and network-out data.
 *
 * That keeps the rule honest: a server that was stopped for part of the window,
 * or whose network data has gaps, reports a shorter window and is left as
 * "insufficient data" instead of looking idle by accident.
 *
 * Returns null (never a guess) when any of the three series is empty, or when
 * no whole day can be claimed.
 */
export function computeInstanceMetrics(
  series: MetricSeries,
  launchTime: string | undefined,
  requestedWindowDays: number,
  now: Date,
): InstanceMetrics | null {
  const { cpuDailyAverages, networkInDailySums, networkOutDailySums } = series;
  if (cpuDailyAverages.length === 0 || networkInDailySums.length === 0 || networkOutDailySums.length === 0) {
    return null;
  }

  const launched = launchTime !== undefined ? parseDate(launchTime) : null;
  const daysSinceLaunch = launched !== null ? Math.floor((now.getTime() - launched.getTime()) / MS_PER_DAY) : Infinity;

  const windowDays = Math.min(
    requestedWindowDays,
    daysSinceLaunch,
    cpuDailyAverages.length,
    networkInDailySums.length,
    networkOutDailySums.length,
  );
  if (!Number.isFinite(windowDays) || windowDays < 1) return null;

  const cpu = latestPoints(cpuDailyAverages, windowDays).map((p) => p.value);
  const networkIn = latestPoints(networkInDailySums, windowDays).map((p) => p.value);
  const networkOut = latestPoints(networkOutDailySums, windowDays).map((p) => p.value);

  return {
    windowDays,
    avgCpuPercent: round2(mean(cpu)),
    avgNetworkBytesPerDay: Math.round((sum(networkIn) + sum(networkOut)) / windowDays),
  };
}

/**
 * Like Promise.all over a list, but runs at most `limit` tasks at the same time
 * and keeps results in input order. If one task fails, no new tasks are started
 * and the first error is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a whole number of at least 1 (got ${limit})`);
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
