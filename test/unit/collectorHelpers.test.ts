import { computeInstanceMetrics, latestPoints, mapWithConcurrency, round2 } from '../../src/collectors/helpers';
import { MS_PER_DAY } from '../../src/core/history';
import { MetricPoint, MetricSeries } from '../../src/collectors/ports';
import { NOW } from '../builders';
import { dailyPoints, series } from '../collectorFakes';

const daysBeforeNow = (days: number): string => new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();

/** One point per day with the given values, oldest first. */
function pointsFrom(values: number[]): MetricPoint[] {
  return values.map((value, index) => ({ at: daysBeforeNow(values.length - index), value }));
}

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(3.33333)).toBe(3.33);
    expect(round2(2.005 + 0.0001)).toBe(2.01);
    expect(round2(7)).toBe(7);
  });
});

describe('latestPoints', () => {
  it('returns the newest points whatever the input order', () => {
    const points = [
      { at: '2026-10-01T00:00:00.000Z', value: 1 },
      { at: '2026-10-03T00:00:00.000Z', value: 3 },
      { at: '2026-10-02T00:00:00.000Z', value: 2 },
    ];
    expect(latestPoints(points, 2).map((p) => p.value)).toEqual([3, 2]);
  });

  it('returns everything when asked for more than exist, without changing the input', () => {
    const points = [
      { at: '2026-10-02T00:00:00.000Z', value: 2 },
      { at: '2026-10-01T00:00:00.000Z', value: 1 },
    ];
    expect(latestPoints(points, 10)).toHaveLength(2);
    expect(points.map((p) => p.value)).toEqual([2, 1]);
  });

  it('copes with points that share the same time', () => {
    const same = [
      { at: '2026-10-01T00:00:00.000Z', value: 1 },
      { at: '2026-10-01T00:00:00.000Z', value: 2 },
    ];
    expect(latestPoints(same, 1)).toHaveLength(1);
  });
});

describe('computeInstanceMetrics (hand-computed)', () => {
  const launchedLongAgo = daysBeforeNow(60);

  it('a full 14 days of data gives 14 days, mean CPU and mean daily traffic', () => {
    // network per day: 1,000,000 in + 500,000 out = 1,500,000
    const result = computeInstanceMetrics(series(14, 2, 1_000_000, 500_000), launchedLongAgo, 14, NOW);
    expect(result).toEqual({ windowDays: 14, avgCpuPercent: 2, avgNetworkBytesPerDay: 1_500_000 });
  });

  it('averages varying days: CPU 1..14 has mean 7.5', () => {
    const cpu = pointsFrom(Array.from({ length: 14 }, (_u, i) => i + 1));
    const input: MetricSeries = { cpuDailyAverages: cpu, networkInDailySums: dailyPoints(14, 10), networkOutDailySums: dailyPoints(14, 20) };
    expect(computeInstanceMetrics(input, launchedLongAgo, 14, NOW)).toEqual({
      windowDays: 14,
      avgCpuPercent: 7.5,
      avgNetworkBytesPerDay: 30,
    });
  });

  it('rounds CPU to two decimals and traffic to whole bytes', () => {
    // CPU (1 + 1 + 2) / 3 = 1.3333, traffic (1 + 1 + 1 + 0 + 0 + 0) / 3 = 1
    const input: MetricSeries = {
      cpuDailyAverages: pointsFrom([1, 1, 2]),
      networkInDailySums: pointsFrom([1, 1, 1]),
      networkOutDailySums: pointsFrom([0, 0, 0]),
    };
    expect(computeInstanceMetrics(input, launchedLongAgo, 3, NOW)).toEqual({
      windowDays: 3,
      avgCpuPercent: 1.33,
      avgNetworkBytesPerDay: 1,
    });
    const odd: MetricSeries = {
      cpuDailyAverages: pointsFrom([1, 1, 1]),
      networkInDailySums: pointsFrom([1, 0, 0]),
      networkOutDailySums: pointsFrom([0, 0, 0]),
    };
    expect(computeInstanceMetrics(odd, launchedLongAgo, 3, NOW)?.avgNetworkBytesPerDay).toBe(0); // 1/3 rounds to 0
  });

  it('uses only the newest days when there is more data than the window', () => {
    // 20 days of CPU: 18 old days at 50%, then the newest 2 at 4% and 6%.
    const cpu = pointsFrom([...Array.from({ length: 18 }, () => 50), 4, 6]);
    const input: MetricSeries = { cpuDailyAverages: cpu, networkInDailySums: dailyPoints(20, 0), networkOutDailySums: dailyPoints(20, 0) };
    expect(computeInstanceMetrics(input, launchedLongAgo, 2, NOW)).toEqual({
      windowDays: 2,
      avgCpuPercent: 5,
      avgNetworkBytesPerDay: 0,
    });
  });

  it('a server launched 5 days ago can only claim 5 days, even with 14 requested', () => {
    const result = computeInstanceMetrics(series(14, 2, 100, 100), daysBeforeNow(5), 14, NOW);
    expect(result?.windowDays).toBe(5);
  });

  it('partial days since launch are not rounded up', () => {
    const launched = new Date(NOW.getTime() - 5.9 * MS_PER_DAY).toISOString();
    expect(computeInstanceMetrics(series(14, 2, 100, 100), launched, 14, NOW)?.windowDays).toBe(5);
  });

  it('the window is capped by whichever series is shortest', () => {
    const cpuShort: MetricSeries = { ...series(14, 2, 100, 100), cpuDailyAverages: dailyPoints(10, 2) };
    const inShort: MetricSeries = { ...series(14, 2, 100, 100), networkInDailySums: dailyPoints(7, 100) };
    const outShort: MetricSeries = { ...series(14, 2, 100, 100), networkOutDailySums: dailyPoints(9, 100) };
    expect(computeInstanceMetrics(cpuShort, launchedLongAgo, 14, NOW)?.windowDays).toBe(10);
    expect(computeInstanceMetrics(inShort, launchedLongAgo, 14, NOW)?.windowDays).toBe(7);
    expect(computeInstanceMetrics(outShort, launchedLongAgo, 14, NOW)?.windowDays).toBe(9);
  });

  it('the requested window is also a cap', () => {
    expect(computeInstanceMetrics(series(30, 2, 100, 100), launchedLongAgo, 14, NOW)?.windowDays).toBe(14);
  });

  it.each([
    ['CPU', { cpuDailyAverages: [] as MetricPoint[] }],
    ['network in', { networkInDailySums: [] as MetricPoint[] }],
    ['network out', { networkOutDailySums: [] as MetricPoint[] }],
  ])('returns null (never a guess) when the %s series is empty', (_label, override) => {
    const input: MetricSeries = { ...series(14, 2, 100, 100), ...override };
    expect(computeInstanceMetrics(input, launchedLongAgo, 14, NOW)).toBeNull();
  });

  it('returns null for a server launched less than a whole day ago', () => {
    const launched = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
    expect(computeInstanceMetrics(series(14, 2, 100, 100), launched, 14, NOW)).toBeNull();
  });

  it('returns null when the launch time is in the future', () => {
    const launched = new Date(NOW.getTime() + MS_PER_DAY).toISOString();
    expect(computeInstanceMetrics(series(14, 2, 100, 100), launched, 14, NOW)).toBeNull();
  });

  it('does not cap by launch time when it is missing or unreadable', () => {
    expect(computeInstanceMetrics(series(14, 2, 100, 100), undefined, 14, NOW)?.windowDays).toBe(14);
    expect(computeInstanceMetrics(series(14, 2, 100, 100), 'garbage', 14, NOW)?.windowDays).toBe(14);
  });
});

describe('mapWithConcurrency', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps results in input order even when tasks finish out of order', async () => {
    const result = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms, index) => {
      await sleep(ms);
      return `${index}:${ms}`;
    });
    expect(result).toEqual(['0:30', '1:5', '2:20', '3:1']);
  });

  it('never runs more tasks at once than the limit, but does use the full limit', async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_u, i) => i), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it('a limit of 1 runs strictly one after another', async () => {
    const order: string[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(`start ${n}`);
      await sleep(2);
      order.push(`end ${n}`);
    });
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('handles an empty list and a limit bigger than the list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 50, async (n) => n * 2)).toEqual([2, 4]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a limit of %p', async (limit) => {
    await expect(mapWithConcurrency([1], limit, async (n) => n)).rejects.toThrow(RangeError);
  });

  it('rethrows the first error and starts no new tasks after it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});
