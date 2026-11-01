import {
  AwsDeps,
  callAws,
  CloudWatchSender,
  createAwsDeps,
  createInventoryPort,
  createMetricsPort,
  Ec2Sender,
  fetchAccountId,
  fetchAllPages,
  MAX_PAGES,
  SECONDS_PER_DAY,
  StsSender,
  tagsToRecord,
  toIso,
} from '../../src/adapters/aws/readers';
import { CloudApiError } from '../../src/collectors/errors';
import { MS_PER_DAY } from '../../src/core/history';
import { createNullLogger } from '../../src/logging/logger';
import { awsError, fakeSender, FAST_POLICY, makeDeps } from '../awsFakes';
import { captureLogger } from '../helpers';

async function failureOf(promise: Promise<unknown>): Promise<CloudApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CloudApiError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('callAws', () => {
  it('returns the result without waiting when the first call works', async () => {
    const { deps, sleeps } = makeDeps();
    await expect(callAws('op', async () => 42, deps)).resolves.toBe(42);
    expect(sleeps).toEqual([]);
  });

  it('retries throttling with backoff and then succeeds', async () => {
    const { deps, sleeps } = makeDeps({ random: () => 0.5 });
    let calls = 0;
    const result = await callAws(
      'op',
      async () => {
        calls += 1;
        if (calls < 3) throw awsError('ThrottlingException');
        return 'done';
      },
      deps,
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([50, 100]); // 0.5 x 100, 0.5 x 200
  });

  it('turns exhausted retries into a CloudApiError that says how many tries were made', async () => {
    const { logger, records } = captureLogger();
    const { deps, sleeps } = makeDeps({ logger });
    const original = awsError('ThrottlingException');

    const failure = await failureOf(callAws('ec2:DescribeVolumes', async () => Promise.reject(original), deps));

    expect(failure.kind).toBe('throttling');
    expect(failure.attempts).toBe(3);
    expect(failure.operation).toBe('ec2:DescribeVolumes');
    expect(failure.cause).toBe(original);
    expect(sleeps).toHaveLength(2);
    const logged = records.find((r) => r.message === 'AWS call failed');
    expect(logged?.level).toBe('ERROR');
    expect(logged?.meta).toMatchObject({ operation: 'ec2:DescribeVolumes', kind: 'throttling', attempts: 3, code: 'ThrottlingException' });
  });

  it('never retries a permission error', async () => {
    const { deps, sleeps } = makeDeps();
    let calls = 0;
    const failure = await failureOf(
      callAws(
        'op',
        async () => {
          calls += 1;
          throw awsError('UnauthorizedOperation', { $metadata: { httpStatusCode: 403 } });
        },
        deps,
      ),
    );
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(failure).toMatchObject({ kind: 'access_denied', attempts: 1, statusCode: 403 });
  });

  it('wraps an unrecognised error as unknown, with one attempt', async () => {
    const { deps } = makeDeps();
    const failure = await failureOf(callAws('op', async () => Promise.reject(new Error('who knows')), deps));
    expect(failure).toMatchObject({ kind: 'unknown', attempts: 1 });
  });

  it('passes an existing CloudApiError through unchanged', async () => {
    const { deps } = makeDeps();
    const existing = new CloudApiError('inner', { kind: 'timeout', retryable: false }, 7);
    const failure = await failureOf(callAws('outer', async () => Promise.reject(existing), deps));
    expect(failure).toBe(existing);
  });
});

describe('fetchAllPages', () => {
  it('returns a single page that has no next token', async () => {
    const { deps } = makeDeps();
    const items = await fetchAllPages('op', async () => ({ items: [1, 2, 3] }), deps);
    expect(items).toEqual([1, 2, 3]);
  });

  it('follows tokens through every page, in order', async () => {
    const { deps } = makeDeps();
    const tokensSeen: Array<string | undefined> = [];
    const pages: Record<string, { items: number[]; nextToken?: string }> = {
      start: { items: [1, 2], nextToken: 't1' },
      t1: { items: [3], nextToken: 't2' },
      t2: { items: [4, 5] },
    };
    const items = await fetchAllPages(
      'op',
      async (token) => {
        tokensSeen.push(token);
        return pages[token ?? 'start'] as { items: number[]; nextToken?: string };
      },
      deps,
    );
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(tokensSeen).toEqual([undefined, 't1', 't2']);
  });

  it('treats an empty next token as the end', async () => {
    const { deps } = makeDeps();
    const items = await fetchAllPages('op', async () => ({ items: ['a'], nextToken: '' }), deps);
    expect(items).toEqual(['a']);
  });

  it('retries one failed page without losing the others', async () => {
    const { deps, sleeps } = makeDeps();
    let secondPageTries = 0;
    const items = await fetchAllPages(
      'op',
      async (token) => {
        if (token === undefined) return { items: [1], nextToken: 'next' };
        secondPageTries += 1;
        if (secondPageTries === 1) throw awsError('RequestLimitExceeded');
        return { items: [2] };
      },
      deps,
    );
    expect(items).toEqual([1, 2]);
    expect(sleeps).toHaveLength(1);
  });

  it('fails when a page fails for good', async () => {
    const { deps } = makeDeps();
    const failure = await failureOf(
      fetchAllPages(
        'op',
        async (token) => {
          if (token === undefined) return { items: [1], nextToken: 'next' };
          throw awsError('UnauthorizedOperation');
        },
        deps,
      ),
    );
    expect(failure.kind).toBe('access_denied');
  });

  it('stops an API that repeats a token instead of looping forever', async () => {
    const { deps } = makeDeps();
    const failure = await failureOf(fetchAllPages('op', async () => ({ items: [1], nextToken: 'same' }), deps));
    expect(failure.code).toBe('RepeatedPageToken');
    expect(failure.attempts).toBe(2);
  });

  it('stops after the maximum number of pages', async () => {
    const { deps } = makeDeps();
    let page = 0;
    const failure = await failureOf(
      fetchAllPages(
        'op',
        async () => {
          page += 1;
          return { items: [page], nextToken: `token-${page}` };
        },
        deps,
      ),
    );
    expect(failure.code).toBe('TooManyPages');
    expect(page).toBe(MAX_PAGES);
  });
});

describe('tagsToRecord and toIso', () => {
  it('turns the tag list into a simple object', () => {
    expect(tagsToRecord([{ Key: 'Name', Value: 'web' }, { Key: 'janitor:ignore', Value: 'true' }])).toEqual({
      Name: 'web',
      'janitor:ignore': 'true',
    });
  });

  it('copes with missing lists, missing keys and missing values', () => {
    expect(tagsToRecord(undefined)).toEqual({});
    expect(tagsToRecord([])).toEqual({});
    expect(tagsToRecord([{ Value: 'orphan value' }, { Key: '', Value: 'x' }])).toEqual({});
    expect(tagsToRecord([{ Key: 'Empty' }])).toEqual({ Empty: '' });
  });

  it('lets a later duplicate key win', () => {
    expect(tagsToRecord([{ Key: 'a', Value: '1' }, { Key: 'a', Value: '2' }])).toEqual({ a: '2' });
  });

  it('writes valid dates as ISO text and rejects everything else', () => {
    expect(toIso(new Date('2026-10-28T12:00:00Z'))).toBe('2026-10-28T12:00:00.000Z');
    expect(toIso(new Date('nope'))).toBeUndefined();
    expect(toIso('2026-10-28')).toBeUndefined();
    expect(toIso(1_700_000_000_000)).toBeUndefined();
    expect(toIso(undefined)).toBeUndefined();
    expect(toIso(null)).toBeUndefined();
  });
});

describe('inventory port: disks', () => {
  it('maps what AWS says into plain data, leaving missing fields out entirely', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<Ec2Sender>(() => ({
      Volumes: [
        { VolumeId: 'vol-1', State: 'available', Size: 100, VolumeType: 'gp3', Tags: [{ Key: 'Name', Value: 'db' }] },
        { VolumeId: 'vol-2' },
      ],
    }));

    const volumes = await createInventoryPort(sender, deps).listVolumes();

    expect(volumes).toEqual([
      { id: 'vol-1', state: 'available', sizeGb: 100, volumeType: 'gp3', tags: { Name: 'db' } },
      { id: 'vol-2', tags: {} },
    ]);
    expect(Object.keys(volumes[1] ?? {})).toEqual(['id', 'tags']);
  });

  it('asks for big pages and follows the next token', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>((_name, input) =>
      input.NextToken === undefined
        ? { Volumes: [{ VolumeId: 'vol-a' }], NextToken: 'page2' }
        : { Volumes: [{ VolumeId: 'vol-b' }] },
    );

    const volumes = await createInventoryPort(sender, deps).listVolumes();

    expect(volumes.map((v) => v.id)).toEqual(['vol-a', 'vol-b']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: 'DescribeVolumesCommand', input: { MaxResults: 500, NextToken: undefined } });
    expect(calls[1]?.input.NextToken).toBe('page2');
  });

  it('returns an empty list for an empty answer', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<Ec2Sender>(() => ({}));
    expect(await createInventoryPort(sender, deps).listVolumes()).toEqual([]);
  });

  it('reports a permission error as a CloudApiError without retrying', async () => {
    const { deps, sleeps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>(() => {
      throw awsError('UnauthorizedOperation');
    });
    const failure = await failureOf(createInventoryPort(sender, deps).listVolumes());
    expect(failure).toMatchObject({ kind: 'access_denied', operation: 'ec2:DescribeVolumes', attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries throttling up to the policy limit', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>(() => {
      throw awsError('RequestLimitExceeded');
    });
    const failure = await failureOf(createInventoryPort(sender, deps).listVolumes());
    expect(failure).toMatchObject({ kind: 'throttling', attempts: FAST_POLICY.maxAttempts });
    expect(calls).toHaveLength(FAST_POLICY.maxAttempts);
  });
});

describe('inventory port: servers, snapshots, images and addresses', () => {
  it('flattens servers from every reservation and writes launch time as ISO text', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>(() => ({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-1',
              State: { Name: 'running' },
              InstanceType: 't3.micro',
              LaunchTime: new Date('2026-09-01T00:00:00Z'),
              Tags: [{ Key: 'Name', Value: 'web' }],
            },
            { InstanceId: 'i-2' },
          ],
        },
        { Instances: [{ InstanceId: 'i-3', State: {} }] },
        {},
      ],
    }));

    const instances = await createInventoryPort(sender, deps).listInstances();

    expect(instances).toEqual([
      { id: 'i-1', state: 'running', instanceType: 't3.micro', launchTime: '2026-09-01T00:00:00.000Z', tags: { Name: 'web' } },
      { id: 'i-2', tags: {} },
      { id: 'i-3', tags: {} },
    ]);
    expect(calls[0]?.input.MaxResults).toBe(1000);
  });

  it('asks only for snapshots owned by this account, on every page', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>((_name, input) =>
      input.NextToken === undefined
        ? {
            Snapshots: [{ SnapshotId: 'snap-1', OwnerId: '123456789012', VolumeSize: 20, StartTime: new Date('2026-01-01T00:00:00Z'), Tags: [] }],
            NextToken: 'more',
          }
        : { Snapshots: [{ SnapshotId: 'snap-2' }] },
    );

    const snapshots = await createInventoryPort(sender, deps).listOwnedSnapshots();

    expect(snapshots).toEqual([
      { id: 'snap-1', ownerId: '123456789012', sizeGb: 20, startTime: '2026-01-01T00:00:00.000Z', tags: {} },
      { id: 'snap-2', tags: {} },
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.name).toBe('DescribeSnapshotsCommand');
      expect(call.input.OwnerIds).toEqual(['self']);
      expect(call.input.MaxResults).toBe(1000);
    }
  });

  it('collects each snapshot id used by an owned image once, ignoring empty entries', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>((_name, input) =>
      input.NextToken === undefined
        ? {
            Images: [
              { BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-a' } }, { DeviceName: '/dev/sdb' }, { Ebs: { SnapshotId: '' } }, { Ebs: {} }] },
              { BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-a' } }, { Ebs: { SnapshotId: 'snap-b' } }] },
              {},
            ],
            NextToken: 'next',
          }
        : { Images: [{ BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-c' } }] }] },
    );

    const ids = await createInventoryPort(sender, deps).listImageSnapshotIds();

    expect(ids).toEqual(['snap-a', 'snap-b', 'snap-c']);
    expect(calls.map((c) => c.input.Owners)).toEqual([['self'], ['self']]);
  });

  it('maps Elastic IP addresses and makes just one request (that call has no pages)', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>(() => ({
      Addresses: [
        {
          AllocationId: 'eipalloc-1',
          PublicIp: '203.0.113.5',
          AssociationId: 'eipassoc-1',
          InstanceId: 'i-1',
          NetworkInterfaceId: 'eni-1',
          PublicIpv4Pool: 'amazon',
          Tags: [{ Key: 'Name', Value: 'nat' }],
        },
        { PublicIp: '198.51.100.7' },
      ],
    }));

    const addresses = await createInventoryPort(sender, deps).listAddresses();

    expect(addresses).toEqual([
      {
        allocationId: 'eipalloc-1',
        publicIp: '203.0.113.5',
        associationId: 'eipassoc-1',
        instanceId: 'i-1',
        networkInterfaceId: 'eni-1',
        publicIpv4Pool: 'amazon',
        tags: { Name: 'nat' },
      },
      { publicIp: '198.51.100.7', tags: {} },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('DescribeAddressesCommand');
  });

  it('handles empty answers everywhere', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<Ec2Sender>(() => ({}));
    const port = createInventoryPort(sender, deps);
    expect(await port.listInstances()).toEqual([]);
    expect(await port.listOwnedSnapshots()).toEqual([]);
    expect(await port.listImageSnapshotIds()).toEqual([]);
    expect(await port.listAddresses()).toEqual([]);
  });

  it('only ever sends read-only "Describe" requests', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<Ec2Sender>(() => ({}));
    const port = createInventoryPort(sender, deps);
    await Promise.all([port.listVolumes(), port.listInstances(), port.listOwnedSnapshots(), port.listImageSnapshotIds(), port.listAddresses()]);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call.name).toMatch(/^Describe\w+Command$/);
  });

  it('refuses an invalid retry policy when it is created', () => {
    const { sender } = fakeSender<Ec2Sender>(() => ({}));
    const bad: AwsDeps = { ...makeDeps().deps, policy: { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 } };
    expect(() => createInventoryPort(sender, bad)).toThrow(RangeError);
  });
});

describe('metrics port', () => {
  const NOW_FOR_METRICS = new Date('2026-10-28T12:00:00.000Z');
  const T1 = new Date('2026-10-20T00:00:00Z');

  it('asks CloudWatch for three daily series over the right window', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<CloudWatchSender>(() => ({ Datapoints: [] }));

    await createMetricsPort(sender, deps).getInstanceMetricSeries('i-123', 14, NOW_FOR_METRICS);

    expect(calls).toHaveLength(3);
    const byMetric = Object.fromEntries(calls.map((c) => [String(c.input.MetricName), c.input]));
    expect(Object.keys(byMetric).sort()).toEqual(['CPUUtilization', 'NetworkIn', 'NetworkOut']);
    expect(byMetric.CPUUtilization?.Statistics).toEqual(['Average']);
    expect(byMetric.NetworkIn?.Statistics).toEqual(['Sum']);
    expect(byMetric.NetworkOut?.Statistics).toEqual(['Sum']);
    for (const call of calls) {
      expect(call.name).toBe('GetMetricStatisticsCommand');
      expect(call.input.Namespace).toBe('AWS/EC2');
      expect(call.input.Dimensions).toEqual([{ Name: 'InstanceId', Value: 'i-123' }]);
      expect(call.input.Period).toBe(SECONDS_PER_DAY);
      expect(call.input.EndTime).toEqual(NOW_FOR_METRICS);
      expect(call.input.StartTime).toEqual(new Date(NOW_FOR_METRICS.getTime() - 14 * MS_PER_DAY));
    }
  });

  it('reads the Average field for CPU and the Sum field for traffic', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<CloudWatchSender>((_name, input) =>
      input.MetricName === 'CPUUtilization'
        ? { Datapoints: [{ Timestamp: T1, Average: 3, Sum: 999 }] }
        : { Datapoints: [{ Timestamp: T1, Sum: 500, Average: 1 }] },
    );

    const result = await createMetricsPort(sender, deps).getInstanceMetricSeries('i-1', 7, NOW_FOR_METRICS);

    expect(result.cpuDailyAverages).toEqual([{ at: T1.toISOString(), value: 3 }]);
    expect(result.networkInDailySums).toEqual([{ at: T1.toISOString(), value: 500 }]);
    expect(result.networkOutDailySums).toEqual([{ at: T1.toISOString(), value: 500 }]);
  });

  it('drops data points without a valid time or a finite number', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<CloudWatchSender>(() => ({
      Datapoints: [
        { Average: 1, Sum: 1 }, // no timestamp
        { Timestamp: T1 }, // no value
        { Timestamp: new Date('nope'), Average: 2, Sum: 2 }, // invalid timestamp
        { Timestamp: T1, Average: Number.NaN, Sum: Number.NaN },
        { Timestamp: T1, Average: Number.POSITIVE_INFINITY, Sum: Number.POSITIVE_INFINITY },
        { Timestamp: T1, Average: 7, Sum: 7 }, // the only good one
      ],
    }));

    const result = await createMetricsPort(sender, deps).getInstanceMetricSeries('i-1', 7, NOW_FOR_METRICS);

    expect(result.cpuDailyAverages).toEqual([{ at: T1.toISOString(), value: 7 }]);
  });

  it('treats a missing Datapoints list as no data', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<CloudWatchSender>(() => ({}));
    const result = await createMetricsPort(sender, deps).getInstanceMetricSeries('i-1', 7, NOW_FOR_METRICS);
    expect(result).toEqual({ cpuDailyAverages: [], networkInDailySums: [], networkOutDailySums: [] });
  });

  it.each([0, -3, 1.5, Number.NaN])('rejects a window of %p days', async (days) => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<CloudWatchSender>(() => ({ Datapoints: [] }));
    await expect(createMetricsPort(sender, deps).getInstanceMetricSeries('i-1', days, NOW_FOR_METRICS)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('fails with a CloudApiError when one series cannot be read', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<CloudWatchSender>((_name, input) => {
      if (input.MetricName === 'NetworkOut') throw awsError('AccessDenied');
      return { Datapoints: [] };
    });
    const failure = await failureOf(createMetricsPort(sender, deps).getInstanceMetricSeries('i-1', 7, NOW_FOR_METRICS));
    expect(failure).toMatchObject({ kind: 'access_denied', operation: 'cloudwatch:GetMetricStatistics NetworkOut' });
  });

  it('only sends read-only requests and refuses an invalid policy', () => {
    const { sender } = fakeSender<CloudWatchSender>(() => ({ Datapoints: [] }));
    const bad: AwsDeps = { ...makeDeps().deps, policy: { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 } };
    expect(() => createMetricsPort(sender, bad)).toThrow(RangeError);
  });
});

describe('fetchAccountId', () => {
  it('returns the 12-digit account number', async () => {
    const { deps } = makeDeps();
    const { sender, calls } = fakeSender<StsSender>(() => ({ Account: '123456789012' }));
    expect(await fetchAccountId(sender, deps)).toBe('123456789012');
    expect(calls[0]?.name).toBe('GetCallerIdentityCommand');
  });

  it.each([[undefined], [''], ['abc'], ['12345678901'], ['1234567890123'], ['12345678901a']])(
    'rejects the invalid account %p',
    async (account) => {
      const { deps } = makeDeps();
      const { sender } = fakeSender<StsSender>(() => ({ Account: account }));
      const failure = await failureOf(fetchAccountId(sender, deps));
      expect(failure.code).toBe('InvalidAccountId');
      expect(failure.operation).toBe('sts:GetCallerIdentity');
    },
  );

  it('retries throttling and then succeeds', async () => {
    const { deps, sleeps } = makeDeps();
    const { sender } = fakeSender<StsSender>((_name, _input, callNumber) => {
      if (callNumber === 1) throw awsError('Throttling');
      return { Account: '123456789012' };
    });
    expect(await fetchAccountId(sender, deps)).toBe('123456789012');
    expect(sleeps).toHaveLength(1);
  });

  it('reports bad credentials as an auth failure', async () => {
    const { deps } = makeDeps();
    const { sender } = fakeSender<StsSender>(() => {
      throw awsError('InvalidClientTokenId');
    });
    expect((await failureOf(fetchAccountId(sender, deps))).kind).toBe('auth');
  });
});

describe('createAwsDeps', () => {
  it('bundles the logger, policy, sleep and random', () => {
    const logger = createNullLogger();
    const sleep = async () => undefined;
    const random = () => 0.1;
    const deps = createAwsDeps(logger, FAST_POLICY, sleep, random);
    expect(deps).toEqual({ logger, policy: FAST_POLICY, sleep, random });
  });

  it('refuses an invalid policy', () => {
    expect(() => createAwsDeps(createNullLogger(), { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 }, async () => undefined, () => 0)).toThrow(RangeError);
  });
});
