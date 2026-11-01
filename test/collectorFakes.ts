/**
 * Fakes and builders for collector tests: in-memory versions of the ports.
 */

import { CollectContext } from '../src/collectors/types';
import {
  InventoryPort,
  MetricPoint,
  MetricsPort,
  MetricSeries,
  RawAddress,
  RawInstance,
  RawSnapshot,
  RawVolume,
} from '../src/collectors/ports';
import { createNullLogger } from '../src/logging/logger';
import { MS_PER_DAY } from '../src/core/history';
import { NOW } from './builders';

export const ACCOUNT = '123456789012';

export function makeCtx(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    region: 'us-east-1',
    accountId: ACCOUNT,
    now: NOW,
    idleWindowDays: 14,
    logger: createNullLogger(),
    ...overrides,
  };
}

export function fakeInventory(overrides: Partial<InventoryPort> = {}): InventoryPort {
  return {
    listVolumes: async () => [],
    listInstances: async () => [],
    listOwnedSnapshots: async () => [],
    listImageSnapshotIds: async () => [],
    listAddresses: async () => [],
    ...overrides,
  };
}

export function rawVolume(overrides: Partial<RawVolume> = {}): RawVolume {
  return { id: 'vol-1', state: 'available', sizeGb: 100, volumeType: 'gp3', tags: {}, ...overrides };
}

export function rawInstance(overrides: Partial<RawInstance> = {}): RawInstance {
  return {
    id: 'i-1',
    state: 'running',
    instanceType: 't3.micro',
    launchTime: new Date(NOW.getTime() - 60 * MS_PER_DAY).toISOString(),
    tags: {},
    ...overrides,
  };
}

export function rawSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    id: 'snap-1',
    ownerId: ACCOUNT,
    sizeGb: 20,
    startTime: new Date(NOW.getTime() - 120 * MS_PER_DAY).toISOString(),
    tags: {},
    ...overrides,
  };
}

export function rawAddress(overrides: Partial<RawAddress> = {}): RawAddress {
  return { allocationId: 'eipalloc-1', publicIp: '203.0.113.5', tags: {}, ...overrides };
}

/** `count` daily points ending the day before NOW, oldest first, all with the same value. */
export function dailyPoints(count: number, value: number): MetricPoint[] {
  return Array.from({ length: count }, (_unused, index) => ({
    at: new Date(NOW.getTime() - (count - index) * MS_PER_DAY).toISOString(),
    value,
  }));
}

export function series(days: number, cpu: number, networkIn: number, networkOut: number): MetricSeries {
  return {
    cpuDailyAverages: dailyPoints(days, cpu),
    networkInDailySums: dailyPoints(days, networkIn),
    networkOutDailySums: dailyPoints(days, networkOut),
  };
}

export interface MetricsCall {
  instanceId: string;
  windowDays: number;
  now: Date;
}

export function fakeMetrics(
  answer: (instanceId: string) => MetricSeries | Promise<MetricSeries> = () => series(14, 2, 100, 100),
): { port: MetricsPort; calls: MetricsCall[] } {
  const calls: MetricsCall[] = [];
  const port: MetricsPort = {
    async getInstanceMetricSeries(instanceId, windowDays, now) {
      calls.push({ instanceId, windowDays, now });
      return answer(instanceId);
    },
  };
  return { port, calls };
}

/** Freezes an object and everything inside it, so any attempt to change it throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}
