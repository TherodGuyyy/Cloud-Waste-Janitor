import {
  ElasticIpResource,
  InstanceResource,
  ObservationHistory,
  RuleContext,
  SnapshotResource,
  VolumeResource,
} from '../src/core/types';
import { DEFAULT_RULE_CONFIG } from '../src/config/config';
import { MS_PER_DAY } from '../src/core/history';

export const NOW = new Date('2026-10-28T12:00:00.000Z');

export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

export function makeContext(history: ObservationHistory = {}, overrides: Partial<RuleContext['config']> = {}): RuleContext {
  return { now: NOW, config: { ...DEFAULT_RULE_CONFIG, ...overrides }, history };
}

export function makeVolume(overrides: Partial<VolumeResource> = {}): VolumeResource {
  return {
    id: 'vol-test',
    type: 'ebs_volume',
    region: 'us-east-1',
    accountId: '999999999999',
    tags: {},
    state: 'available',
    sizeGb: 100,
    volumeType: 'gp3',
    ...overrides,
  };
}

export function makeInstance(overrides: Partial<InstanceResource> = {}): InstanceResource {
  return {
    id: 'i-test',
    type: 'ec2_instance',
    region: 'us-east-1',
    accountId: '999999999999',
    tags: {},
    state: 'running',
    instanceType: 't3.micro',
    metrics: { windowDays: 14, avgCpuPercent: 2, avgNetworkBytesPerDay: 1000 },
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<SnapshotResource> = {}): SnapshotResource {
  return {
    id: 'snap-test',
    type: 'ebs_snapshot',
    region: 'us-east-1',
    accountId: '999999999999',
    tags: {},
    sizeGb: 100,
    startTime: daysAgo(120),
    usedByImage: false,
    ...overrides,
  };
}

export function makeIp(overrides: Partial<ElasticIpResource> = {}): ElasticIpResource {
  return {
    id: 'eipalloc-test',
    type: 'elastic_ip',
    region: 'us-east-1',
    accountId: '999999999999',
    tags: {},
    publicIp: '203.0.113.99',
    associated: false,
    ...overrides,
  };
}
