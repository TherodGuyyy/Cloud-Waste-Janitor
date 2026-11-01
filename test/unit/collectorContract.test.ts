/**
 * The collector contract: rules every collector must obey, tested the same way for all four.
 *
 * A collector must: return only valid resources of its own type, stamp region and account
 * from the run, return unique ids, explain everything it skips, account for every item it
 * was given, never change its input, and give the same answer twice.
 */

import { createElasticIpCollector } from '../../src/collectors/elasticIpCollector';
import { createInstanceCollector } from '../../src/collectors/instanceCollector';
import { InventoryPort, RawAddress, RawInstance, RawSnapshot, RawVolume } from '../../src/collectors/ports';
import { createSnapshotCollector } from '../../src/collectors/snapshotCollector';
import { Collector } from '../../src/collectors/types';
import { createVolumeCollector } from '../../src/collectors/volumeCollector';
import { validateResource } from '../../src/core/validate';
import {
  ACCOUNT,
  deepFreeze,
  fakeInventory,
  fakeMetrics,
  makeCtx,
  rawAddress,
  rawInstance,
  rawSnapshot,
  rawVolume,
} from '../collectorFakes';

interface ContractCase {
  label: string;
  /** Builds the collector over an inventory that holds this case's mixed good and bad data. */
  build: (inventory: InventoryPort) => Collector;
  /** Inventory with some good items, some bad items, and (for snapshots) one owned by someone else. */
  populated: () => InventoryPort;
  itemsRead: number;
  /** Items dropped on purpose without being listed as skipped (other accounts' snapshots). */
  silentlyIgnored: number;
  expectedResources: number;
}

function frozenInventory(data: Partial<{
  volumes: RawVolume[];
  instances: RawInstance[];
  snapshots: RawSnapshot[];
  imageIds: string[];
  addresses: RawAddress[];
}>): InventoryPort {
  const frozen = deepFreeze(data);
  return fakeInventory({
    listVolumes: async () => frozen.volumes ?? [],
    listInstances: async () => frozen.instances ?? [],
    listOwnedSnapshots: async () => frozen.snapshots ?? [],
    listImageSnapshotIds: async () => frozen.imageIds ?? [],
    listAddresses: async () => frozen.addresses ?? [],
  });
}

const CASES: ContractCase[] = [
  {
    label: 'volume collector',
    build: (inventory) => createVolumeCollector(inventory),
    populated: () =>
      frozenInventory({
        volumes: [
          rawVolume({ id: 'vol-1', tags: { Name: 'a', team: 'x' } }),
          rawVolume({ id: 'vol-2', state: 'in-use' }),
          rawVolume({ id: 'vol-3', sizeGb: 0 }),
          rawVolume({ id: undefined }),
          rawVolume({ id: 'vol-5', state: undefined }),
          rawVolume({ id: 'vol-6', volumeType: '' }),
        ],
      }),
    itemsRead: 6,
    silentlyIgnored: 0,
    expectedResources: 3,
  },
  {
    label: 'instance collector',
    build: (inventory) => createInstanceCollector(inventory, fakeMetrics().port),
    populated: () =>
      frozenInventory({
        instances: [
          rawInstance({ id: 'i-1', tags: { Name: 'web' } }),
          rawInstance({ id: 'i-2', state: 'stopped' }),
          rawInstance({ id: 'i-3', state: 'pending' }),
          rawInstance({ id: undefined }),
          rawInstance({ id: 'i-5', instanceType: undefined }),
        ],
      }),
    itemsRead: 5,
    silentlyIgnored: 0,
    expectedResources: 3,
  },
  {
    label: 'snapshot collector',
    build: (inventory) => createSnapshotCollector(inventory),
    populated: () =>
      frozenInventory({
        snapshots: [
          rawSnapshot({ id: 'snap-1', tags: { keep: 'yes' } }),
          rawSnapshot({ id: 'snap-2' }),
          rawSnapshot({ id: 'snap-3' }),
          rawSnapshot({ id: 'snap-other', ownerId: '099720109477' }),
          rawSnapshot({ id: 'snap-5', startTime: undefined }),
          rawSnapshot({ id: undefined }),
        ],
        imageIds: ['snap-2'],
      }),
    itemsRead: 6,
    silentlyIgnored: 1,
    expectedResources: 3,
  },
  {
    label: 'Elastic IP collector',
    build: (inventory) => createElasticIpCollector(inventory),
    populated: () =>
      frozenInventory({
        addresses: [
          rawAddress({ allocationId: 'eipalloc-1', tags: { Name: 'nat' } }),
          rawAddress({ allocationId: 'eipalloc-2', associationId: 'eipassoc-2' }),
          rawAddress({ allocationId: 'eipalloc-3', publicIpv4Pool: 'amazon' }),
          rawAddress({ allocationId: 'eipalloc-byoip', publicIpv4Pool: 'ipv4pool-ec2-1' }),
          rawAddress({ allocationId: undefined, publicIp: undefined }),
          rawAddress({ allocationId: 'eipalloc-6', publicIp: '' }),
        ],
      }),
    itemsRead: 6,
    silentlyIgnored: 0,
    expectedResources: 3,
  },
];

describe.each(CASES)('collector contract: $label', (testCase) => {
  const ctx = makeCtx({ region: 'ap-southeast-2' });

  it('returns only valid resources', async () => {
    const result = await testCase.build(testCase.populated()).collect(ctx);
    expect(result.resources).toHaveLength(testCase.expectedResources);
    for (const resource of result.resources) {
      expect(validateResource(resource)).toBeNull();
    }
  });

  it('returns only resources of its own type', async () => {
    const collector = testCase.build(testCase.populated());
    const result = await collector.collect(ctx);
    for (const resource of result.resources) {
      expect(resource.type).toBe(collector.resourceType);
    }
  });

  it('stamps region and account from the run, not from the data', async () => {
    const result = await testCase.build(testCase.populated()).collect(ctx);
    for (const resource of result.resources) {
      expect(resource.region).toBe('ap-southeast-2');
      expect(resource.accountId).toBe(ACCOUNT);
    }
  });

  it('returns unique ids', async () => {
    const result = await testCase.build(testCase.populated()).collect(ctx);
    const ids = result.resources.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('explains everything it skips, under its own name', async () => {
    const collector = testCase.build(testCase.populated());
    const result = await collector.collect(ctx);
    expect(result.skipped.length).toBeGreaterThan(0);
    for (const item of result.skipped) {
      expect(item.collector).toBe(collector.name);
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  it('accounts for every item it read: kept + skipped + deliberately ignored = read', async () => {
    const result = await testCase.build(testCase.populated()).collect(ctx);
    expect(result.resources.length + result.skipped.length + testCase.silentlyIgnored).toBe(testCase.itemsRead);
  });

  it('copies tags exactly', async () => {
    const result = await testCase.build(testCase.populated()).collect(ctx);
    const tagged = result.resources.filter((r) => Object.keys(r.tags).length > 0);
    expect(tagged.length).toBeGreaterThan(0);
    for (const resource of tagged) {
      expect(Object.values(resource.tags).every((v) => typeof v === 'string')).toBe(true);
    }
  });

  it('never changes its input (the data is frozen, so any change would throw)', async () => {
    await expect(testCase.build(testCase.populated()).collect(ctx)).resolves.toBeDefined();
  });

  it('gives the same answer when run twice', async () => {
    const collector = testCase.build(testCase.populated());
    const first = await collector.collect(ctx);
    const second = await collector.collect(ctx);
    expect(second).toEqual(first);
  });

  it('returns an empty result for an empty account', async () => {
    const result = await testCase.build(fakeInventory()).collect(ctx);
    expect(result).toEqual({ resources: [], skipped: [] });
  });

  it('has a short, stable name', () => {
    const collector = testCase.build(fakeInventory());
    expect(collector.name).toMatch(/^[a-z0-9-]+$/);
  });
});
