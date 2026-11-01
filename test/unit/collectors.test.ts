import { createElasticIpCollector } from '../../src/collectors/elasticIpCollector';
import { CloudApiError } from '../../src/collectors/errors';
import { createInstanceCollector, DEFAULT_METRICS_CONCURRENCY } from '../../src/collectors/instanceCollector';
import { createSnapshotCollector } from '../../src/collectors/snapshotCollector';
import { createVolumeCollector } from '../../src/collectors/volumeCollector';
import { createDefaultCollectors } from '../../src/collectors';
import { MS_PER_DAY } from '../../src/core/history';
import { InstanceResource } from '../../src/core/types';
import { NOW } from '../builders';
import {
  ACCOUNT,
  dailyPoints,
  fakeInventory,
  fakeMetrics,
  makeCtx,
  rawAddress,
  rawInstance,
  rawSnapshot,
  rawVolume,
  series,
} from '../collectorFakes';
import { captureLogger } from '../helpers';

const daysAgoIso = (days: number): string => new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();

describe('volume collector', () => {
  it('turns disks into resources, stamping region and account from the run', async () => {
    const collector = createVolumeCollector(
      fakeInventory({
        listVolumes: async () => [
          rawVolume({ id: 'vol-a', state: 'available', sizeGb: 500, volumeType: 'gp3', tags: { Name: 'db' } }),
          rawVolume({ id: 'vol-b', state: 'in-use', sizeGb: 8, volumeType: 'gp2' }),
        ],
      }),
    );

    const result = await collector.collect(makeCtx({ region: 'eu-west-1' }));

    expect(result.skipped).toEqual([]);
    expect(result.resources).toEqual([
      { id: 'vol-a', type: 'ebs_volume', region: 'eu-west-1', accountId: ACCOUNT, tags: { Name: 'db' }, state: 'available', sizeGb: 500, volumeType: 'gp3' },
      { id: 'vol-b', type: 'ebs_volume', region: 'eu-west-1', accountId: ACCOUNT, tags: {}, state: 'in-use', sizeGb: 8, volumeType: 'gp2' },
    ]);
  });

  it('identifies itself', () => {
    const collector = createVolumeCollector(fakeInventory());
    expect(collector.name).toBe('ebs-volumes');
    expect(collector.resourceType).toBe('ebs_volume');
  });

  it.each([
    ['no id', { id: undefined }, 'unknown', 'disk has no id'],
    ['an empty id', { id: '' }, 'unknown', 'disk has no id'],
    ['no state', { state: undefined }, 'vol-1', 'disk has no state'],
    ['no size', { sizeGb: undefined }, 'vol-1', 'disk has no size'],
    ['a NaN size', { sizeGb: Number.NaN }, 'vol-1', 'disk has no size'],
    ['no volume type', { volumeType: undefined }, 'vol-1', 'disk has no volume type'],
    ['an empty volume type', { volumeType: '' }, 'vol-1', 'disk has no volume type'],
  ])('skips a disk with %s and says why', async (_label, change, id, reason) => {
    const collector = createVolumeCollector(fakeInventory({ listVolumes: async () => [rawVolume(change), rawVolume({ id: 'vol-ok' })] }));
    const result = await collector.collect(makeCtx());
    expect(result.resources.map((r) => r.id)).toEqual(['vol-ok']);
    expect(result.skipped).toEqual([{ id, collector: 'ebs-volumes', reason }]);
  });

  it('keeps a disk of size zero (it is a number, even if an odd one)', async () => {
    const collector = createVolumeCollector(fakeInventory({ listVolumes: async () => [rawVolume({ sizeGb: 0 })] }));
    expect((await collector.collect(makeCtx())).resources).toHaveLength(1);
  });

  it('returns nothing for an account with no disks, and logs what it read', async () => {
    const { logger, records } = captureLogger();
    const result = await createVolumeCollector(fakeInventory()).collect(makeCtx({ logger }));
    expect(result).toEqual({ resources: [], skipped: [] });
    expect(records.find((r) => r.message === 'Read disks')?.meta).toEqual({ collector: 'ebs-volumes', read: 0, kept: 0 });
  });

  it('lets cloud failures through for the runner to record', async () => {
    const failure = new CloudApiError('ec2:DescribeVolumes', { kind: 'access_denied', retryable: false }, 1);
    const collector = createVolumeCollector(fakeInventory({ listVolumes: async () => Promise.reject(failure) }));
    await expect(collector.collect(makeCtx())).rejects.toBe(failure);
  });
});

describe('instance collector', () => {
  it('reads metrics only for running servers and passes the run clock and window', async () => {
    const { port, calls } = fakeMetrics(() => series(14, 3, 1000, 500));
    const collector = createInstanceCollector(
      fakeInventory({
        listInstances: async () => [
          rawInstance({ id: 'i-run', state: 'running', instanceType: 't3.medium' }),
          rawInstance({ id: 'i-stop', state: 'stopped' }),
          rawInstance({ id: 'i-pend', state: 'pending' }),
          rawInstance({ id: 'i-term', state: 'terminated' }),
        ],
      }),
      port,
    );

    const result = await collector.collect(makeCtx({ idleWindowDays: 14 }));

    expect(calls).toEqual([{ instanceId: 'i-run', windowDays: 14, now: NOW }]);
    const byId = Object.fromEntries(result.resources.map((r) => [r.id, r as InstanceResource]));
    expect(byId['i-run']?.metrics).toEqual({ windowDays: 14, avgCpuPercent: 3, avgNetworkBytesPerDay: 1500 });
    expect(byId['i-run']).toMatchObject({ type: 'ec2_instance', region: 'us-east-1', accountId: ACCOUNT, state: 'running', instanceType: 't3.medium' });
    for (const id of ['i-stop', 'i-pend', 'i-term']) expect(byId[id]?.metrics).toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it('identifies itself', () => {
    const collector = createInstanceCollector(fakeInventory(), fakeMetrics().port);
    expect(collector.name).toBe('ec2-instances');
    expect(collector.resourceType).toBe('ec2_instance');
  });

  it('a server launched 5 days ago can only be judged on 5 days', async () => {
    const { port } = fakeMetrics(() => series(14, 2, 10, 10));
    const collector = createInstanceCollector(fakeInventory({ listInstances: async () => [rawInstance({ launchTime: daysAgoIso(5) })] }), port);
    const result = await collector.collect(makeCtx());
    expect((result.resources[0] as InstanceResource).metrics?.windowDays).toBe(5);
  });

  it('gives a server null metrics, and warns, when CloudWatch has no data for it', async () => {
    const { logger, records } = captureLogger();
    const { port } = fakeMetrics(() => ({ cpuDailyAverages: [], networkInDailySums: [], networkOutDailySums: [] }));
    const collector = createInstanceCollector(fakeInventory({ listInstances: async () => [rawInstance({ id: 'i-quiet' })] }), port);

    const result = await collector.collect(makeCtx({ logger }));

    expect((result.resources[0] as InstanceResource).metrics).toBeNull();
    const warning = records.find((r) => r.message === 'Not enough metric data to judge server');
    expect(warning?.level).toBe('WARN');
    expect(warning?.meta).toMatchObject({ instanceId: 'i-quiet' });
  });

  it.each(['throttling', 'timeout', 'network', 'server_error'] as const)(
    'a %s problem on one server gives null metrics for that server only',
    async (kind) => {
      const { logger, records } = captureLogger();
      const { port } = fakeMetrics((instanceId) => {
        if (instanceId === 'i-bad') throw new CloudApiError('cloudwatch:GetMetricStatistics CPUUtilization', { kind, retryable: true }, 5);
        return series(14, 2, 10, 10);
      });
      const collector = createInstanceCollector(
        fakeInventory({ listInstances: async () => [rawInstance({ id: 'i-bad' }), rawInstance({ id: 'i-good' })] }),
        port,
      );

      const result = await collector.collect(makeCtx({ logger }));

      const byId = Object.fromEntries(result.resources.map((r) => [r.id, r as InstanceResource]));
      expect(byId['i-bad']?.metrics).toBeNull();
      expect(byId['i-good']?.metrics).not.toBeNull();
      const warning = records.find((r) => r.message === 'Could not read metrics for server');
      expect(warning?.meta).toMatchObject({ instanceId: 'i-bad', kind, attempts: 5 });
    },
  );

  it.each(['access_denied', 'auth'] as const)(
    'a %s problem fails the whole collector, so a missing permission is never mistaken for "nothing is idle"',
    async (kind) => {
      const failure = new CloudApiError('cloudwatch:GetMetricStatistics CPUUtilization', { kind, retryable: false }, 1);
      const { port } = fakeMetrics(() => {
        throw failure;
      });
      const collector = createInstanceCollector(fakeInventory({ listInstances: async () => [rawInstance()] }), port);
      await expect(collector.collect(makeCtx())).rejects.toBe(failure);
    },
  );

  it('does not hide an unexpected programming error', async () => {
    const bug = new TypeError('cannot read properties of undefined');
    const { port } = fakeMetrics(() => {
      throw bug;
    });
    const collector = createInstanceCollector(fakeInventory({ listInstances: async () => [rawInstance()] }), port);
    await expect(collector.collect(makeCtx())).rejects.toBe(bug);
  });

  it.each([
    ['no id', { id: undefined }, 'unknown', 'server has no id'],
    ['an empty id', { id: '' }, 'unknown', 'server has no id'],
    ['no state', { state: undefined }, 'i-1', 'server has no state'],
    ['no instance type', { instanceType: undefined }, 'i-1', 'server has no instance type'],
    ['an empty instance type', { instanceType: '' }, 'i-1', 'server has no instance type'],
  ])('skips a server with %s and says why', async (_label, change, id, reason) => {
    const { port, calls } = fakeMetrics();
    const collector = createInstanceCollector(fakeInventory({ listInstances: async () => [rawInstance(change), rawInstance({ id: 'i-ok' })] }), port);
    const result = await collector.collect(makeCtx());
    expect(result.resources.map((r) => r.id)).toEqual(['i-ok']);
    expect(result.skipped).toEqual([{ id, collector: 'ec2-instances', reason }]);
    expect(calls.map((c) => c.instanceId)).toEqual(['i-ok']);
  });

  it('reads metrics for several servers at once, but never more than the limit', async () => {
    let running = 0;
    let peak = 0;
    const { port } = fakeMetrics(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return series(14, 2, 10, 10);
    });
    const many = Array.from({ length: 12 }, (_u, i) => rawInstance({ id: `i-${i}` }));
    const collector = createInstanceCollector(fakeInventory({ listInstances: async () => many }), port, 2);
    const result = await collector.collect(makeCtx());
    expect(result.resources).toHaveLength(12);
    expect(peak).toBe(2);
  });

  it('keeps results in the same order as the cloud listed them', async () => {
    const { port } = fakeMetrics(async (instanceId) => {
      await new Promise((resolve) => setTimeout(resolve, instanceId === 'i-0' ? 15 : 1));
      return series(14, 2, 10, 10);
    });
    const collector = createInstanceCollector(
      fakeInventory({ listInstances: async () => [rawInstance({ id: 'i-0' }), rawInstance({ id: 'i-1' }), rawInstance({ id: 'i-2' })] }),
      port,
    );
    expect((await collector.collect(makeCtx())).resources.map((r) => r.id)).toEqual(['i-0', 'i-1', 'i-2']);
  });

  it('defaults to 5 metric reads at a time', () => {
    expect(DEFAULT_METRICS_CONCURRENCY).toBe(5);
  });

  it('handles an account with no servers without calling CloudWatch', async () => {
    const { port, calls } = fakeMetrics();
    const result = await createInstanceCollector(fakeInventory(), port).collect(makeCtx());
    expect(result).toEqual({ resources: [], skipped: [] });
    expect(calls).toEqual([]);
  });

  it('a server with no launch time is not capped by age', async () => {
    const { port } = fakeMetrics(() => ({ cpuDailyAverages: dailyPoints(14, 1), networkInDailySums: dailyPoints(14, 1), networkOutDailySums: dailyPoints(14, 1) }));
    const collector = createInstanceCollector(fakeInventory({ listInstances: async () => [rawInstance({ launchTime: undefined })] }), port);
    expect(((await collector.collect(makeCtx())).resources[0] as InstanceResource).metrics?.windowDays).toBe(14);
  });
});

describe('snapshot collector', () => {
  it('marks a snapshot as used when a machine image points at it', async () => {
    const collector = createSnapshotCollector(
      fakeInventory({
        listOwnedSnapshots: async () => [rawSnapshot({ id: 'snap-image' }), rawSnapshot({ id: 'snap-loose' })],
        listImageSnapshotIds: async () => ['snap-image', 'snap-someone-elses'],
      }),
    );

    const result = await collector.collect(makeCtx());

    expect(result.skipped).toEqual([]);
    const flags = Object.fromEntries(result.resources.map((r) => [r.id, r.type === 'ebs_snapshot' ? r.usedByImage : null]));
    expect(flags).toEqual({ 'snap-image': true, 'snap-loose': false });
  });

  it('copies size, start time and tags, and stamps region and account', async () => {
    const collector = createSnapshotCollector(
      fakeInventory({ listOwnedSnapshots: async () => [rawSnapshot({ id: 'snap-1', sizeGb: 33, startTime: '2026-01-02T03:04:05.000Z', tags: { team: 'data' } })] }),
    );
    const result = await collector.collect(makeCtx({ region: 'ap-south-1' }));
    expect(result.resources).toEqual([
      { id: 'snap-1', type: 'ebs_snapshot', region: 'ap-south-1', accountId: ACCOUNT, tags: { team: 'data' }, sizeGb: 33, startTime: '2026-01-02T03:04:05.000Z', usedByImage: false },
    ]);
  });

  it('identifies itself', () => {
    const collector = createSnapshotCollector(fakeInventory());
    expect(collector.name).toBe('ebs-snapshots');
    expect(collector.resourceType).toBe('ebs_snapshot');
  });

  it('drops snapshots owned by other accounts and warns with the count', async () => {
    const { logger, records } = captureLogger();
    const collector = createSnapshotCollector(
      fakeInventory({
        listOwnedSnapshots: async () => [
          rawSnapshot({ id: 'snap-mine' }),
          rawSnapshot({ id: 'snap-public-1', ownerId: '099720109477' }),
          rawSnapshot({ id: 'snap-public-2', ownerId: '801119661308' }),
        ],
      }),
    );

    const result = await collector.collect(makeCtx({ logger }));

    expect(result.resources.map((r) => r.id)).toEqual(['snap-mine']);
    expect(result.skipped).toEqual([]);
    const warning = records.find((r) => r.message === 'Ignored snapshots owned by other accounts');
    expect(warning?.level).toBe('WARN');
    expect(warning?.meta).toEqual({ collector: 'ebs-snapshots', count: 2 });
  });

  it('does not warn when every snapshot belongs to this account', async () => {
    const { logger, records } = captureLogger();
    await createSnapshotCollector(fakeInventory({ listOwnedSnapshots: async () => [rawSnapshot()] })).collect(makeCtx({ logger }));
    expect(records.some((r) => r.level === 'WARN')).toBe(false);
  });

  it.each([
    ['no id', { id: undefined }, 'unknown', 'snapshot has no id'],
    ['an empty id', { id: '' }, 'unknown', 'snapshot has no id'],
    ['no owner', { ownerId: undefined }, 'snap-1', 'snapshot owner is unknown, so it is not judged'],
    ['no size', { sizeGb: undefined }, 'snap-1', 'snapshot has no size'],
    ['a NaN size', { sizeGb: Number.NaN }, 'snap-1', 'snapshot has no size'],
    ['no start time', { startTime: undefined }, 'snap-1', 'snapshot has no start time'],
  ])('skips a snapshot with %s and says why', async (_label, change, id, reason) => {
    const collector = createSnapshotCollector(fakeInventory({ listOwnedSnapshots: async () => [rawSnapshot(change), rawSnapshot({ id: 'snap-ok' })] }));
    const result = await collector.collect(makeCtx());
    expect(result.resources.map((r) => r.id)).toEqual(['snap-ok']);
    expect(result.skipped).toEqual([{ id, collector: 'ebs-snapshots', reason }]);
  });

  it('fails completely if it cannot tell which snapshots images use (never guesses "unused")', async () => {
    const failure = new CloudApiError('ec2:DescribeImages', { kind: 'access_denied', retryable: false }, 1);
    const collector = createSnapshotCollector(
      fakeInventory({
        listOwnedSnapshots: async () => [rawSnapshot()],
        listImageSnapshotIds: async () => Promise.reject(failure),
      }),
    );
    await expect(collector.collect(makeCtx())).rejects.toBe(failure);
  });

  it('fails completely if it cannot list the snapshots', async () => {
    const failure = new CloudApiError('ec2:DescribeSnapshots', { kind: 'throttling', retryable: true }, 5);
    const collector = createSnapshotCollector(fakeInventory({ listOwnedSnapshots: async () => Promise.reject(failure) }));
    await expect(collector.collect(makeCtx())).rejects.toBe(failure);
  });
});

describe('Elastic IP collector', () => {
  it('uses the allocation id as the id and the public IP as the address', async () => {
    const collector = createElasticIpCollector(fakeInventory({ listAddresses: async () => [rawAddress({ allocationId: 'eipalloc-9', publicIp: '203.0.113.9', tags: { Name: 'nat' } })] }));
    const result = await collector.collect(makeCtx({ region: 'us-west-2' }));
    expect(result.resources).toEqual([
      { id: 'eipalloc-9', type: 'elastic_ip', region: 'us-west-2', accountId: ACCOUNT, tags: { Name: 'nat' }, publicIp: '203.0.113.9', associated: false },
    ]);
  });

  it('identifies itself', () => {
    const collector = createElasticIpCollector(fakeInventory());
    expect(collector.name).toBe('elastic-ips');
    expect(collector.resourceType).toBe('elastic_ip');
  });

  it('falls back to the public IP as id when there is no allocation id', async () => {
    const collector = createElasticIpCollector(fakeInventory({ listAddresses: async () => [rawAddress({ allocationId: undefined, publicIp: '198.51.100.7' })] }));
    expect((await collector.collect(makeCtx())).resources[0]?.id).toBe('198.51.100.7');
  });

  it.each([
    ['an association id', { associationId: 'eipassoc-1' }, true],
    ['an instance id', { instanceId: 'i-1' }, true],
    ['a network interface id', { networkInterfaceId: 'eni-1' }, true],
    ['nothing', {}, false],
    ['only empty strings (what a fake AWS returns for an idle address)', { associationId: '', instanceId: '', networkInterfaceId: '' }, false],
  ])('an address with %s is associated: %s', async (_label, change, expected) => {
    const collector = createElasticIpCollector(fakeInventory({ listAddresses: async () => [rawAddress(change)] }));
    const resource = (await collector.collect(makeCtx())).resources[0];
    expect(resource?.type === 'elastic_ip' && resource.associated).toBe(expected);
  });

  it('keeps Amazon-provided addresses, and addresses with no pool information', async () => {
    const collector = createElasticIpCollector(
      fakeInventory({ listAddresses: async () => [rawAddress({ allocationId: 'a', publicIpv4Pool: 'amazon' }), rawAddress({ allocationId: 'b' })] }),
    );
    const result = await collector.collect(makeCtx());
    expect(result.resources.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.skipped).toEqual([]);
  });

  it('skips brought-your-own addresses, because AWS does not charge for them', async () => {
    const collector = createElasticIpCollector(fakeInventory({ listAddresses: async () => [rawAddress({ allocationId: 'eipalloc-byoip', publicIpv4Pool: 'ipv4pool-ec2-0abc' })] }));
    const result = await collector.collect(makeCtx());
    expect(result.resources).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'eipalloc-byoip', collector: 'elastic-ips', reason: 'brought-your-own address (AWS does not charge for it)' },
    ]);
  });

  it.each([
    ['no id at all', { allocationId: undefined, publicIp: undefined }, 'unknown', 'address has no id'],
    ['an empty id and no IP', { allocationId: '', publicIp: undefined }, 'unknown', 'address has no id'],
    ['no public IP', { publicIp: undefined }, 'eipalloc-1', 'address has no public IP'],
    ['an empty public IP', { publicIp: '' }, 'eipalloc-1', 'address has no public IP'],
  ])('skips an address with %s and says why', async (_label, change, id, reason) => {
    const collector = createElasticIpCollector(fakeInventory({ listAddresses: async () => [rawAddress(change), rawAddress({ allocationId: 'eipalloc-ok' })] }));
    const result = await collector.collect(makeCtx());
    expect(result.resources.map((r) => r.id)).toEqual(['eipalloc-ok']);
    expect(result.skipped).toEqual([{ id, collector: 'elastic-ips', reason }]);
  });
});

describe('default collectors', () => {
  it('are the four starter collectors, in a stable order', () => {
    const collectors = createDefaultCollectors(fakeInventory(), fakeMetrics().port);
    expect(collectors.map((c) => c.name)).toEqual(['ebs-volumes', 'ec2-instances', 'ebs-snapshots', 'elastic-ips']);
    expect(collectors.map((c) => c.resourceType)).toEqual(['ebs_volume', 'ec2_instance', 'ebs_snapshot', 'elastic_ip']);
  });
});
