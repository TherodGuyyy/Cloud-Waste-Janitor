import { AwsClientOptions, AwsClients } from '../../src/adapters/aws/clients';
import { CloudWatchSender, Ec2Sender, StsSender } from '../../src/adapters/aws/readers';
import { collectAccount } from '../../src/app/collectAccount';
import { AppConfig, loadConfig } from '../../src/config/config';
import { MS_PER_DAY } from '../../src/core/history';
import { InstanceResource } from '../../src/core/types';
import { Logger } from '../../src/logging/logger';
import { NOW } from '../builders';
import { awsError, fakeSender, RecordedCall, Responder } from '../awsFakes';
import { captureLogger } from '../helpers';

const ACCOUNT_ID = '123456789012';
const LAUNCHED = new Date(NOW.getTime() - 60 * MS_PER_DAY);

interface RegionFakes {
  ec2: Responder;
  cloudwatch: Responder;
  sts: Responder;
}

/** A believable little account: one disk, one running server, two snapshots, one idle address. */
function healthyAccount(): RegionFakes {
  return {
    ec2: (name) => {
      switch (name) {
        case 'DescribeVolumesCommand':
          return { Volumes: [{ VolumeId: 'vol-orphan', State: 'available', Size: 500, VolumeType: 'gp3' }] };
        case 'DescribeInstancesCommand':
          return { Reservations: [{ Instances: [{ InstanceId: 'i-idle', State: { Name: 'running' }, InstanceType: 't3.medium', LaunchTime: LAUNCHED }] }] };
        case 'DescribeSnapshotsCommand':
          return {
            Snapshots: [
              { SnapshotId: 'snap-mine', OwnerId: ACCOUNT_ID, VolumeSize: 20, StartTime: LAUNCHED },
              { SnapshotId: 'snap-public', OwnerId: '099720109477', VolumeSize: 8, StartTime: LAUNCHED },
            ],
          };
        case 'DescribeImagesCommand':
          return { Images: [] };
        case 'DescribeAddressesCommand':
          return { Addresses: [{ AllocationId: 'eipalloc-idle', PublicIp: '203.0.113.5' }] };
        default:
          throw new Error(`unexpected EC2 request ${name}`);
      }
    },
    cloudwatch: () => ({
      Datapoints: Array.from({ length: 14 }, (_u, i) => ({
        Timestamp: new Date(NOW.getTime() - (14 - i) * MS_PER_DAY),
        Average: 2,
        Sum: 1000,
      })),
    }),
    sts: () => ({ Account: ACCOUNT_ID }),
  };
}

interface Harness {
  createClients: (options: AwsClientOptions) => AwsClients;
  optionsSeen: AwsClientOptions[];
  calls: Record<'ec2' | 'cloudwatch' | 'sts', RecordedCall[]>;
}

function harness(perRegion: (region: string) => RegionFakes = () => healthyAccount()): Harness {
  const optionsSeen: AwsClientOptions[] = [];
  const calls: Harness['calls'] = { ec2: [], cloudwatch: [], sts: [] };
  const createClients = (options: AwsClientOptions): AwsClients => {
    optionsSeen.push(options);
    const fakes = perRegion(options.region);
    const ec2 = fakeSender<Ec2Sender>(fakes.ec2);
    const cloudwatch = fakeSender<CloudWatchSender>(fakes.cloudwatch);
    const sts = fakeSender<StsSender>(fakes.sts);
    calls.ec2 = ec2.calls;
    calls.cloudwatch = cloudwatch.calls;
    calls.sts = sts.calls;
    return { ec2: ec2.sender, cloudwatch: cloudwatch.sender, sts: sts.sender } as unknown as AwsClients;
  };
  return { createClients, optionsSeen, calls };
}

function scan(
  config: AppConfig,
  h: Harness,
  extra: { logger?: Logger; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
) {
  const { logger } = captureLogger();
  return collectAccount({
    config,
    now: NOW,
    logger: extra.logger ?? logger,
    credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
    sleep: extra.sleep ?? (async () => undefined),
    random: extra.random ?? (() => 0.5),
    createClients: h.createClients,
  });
}

describe('scanning one region', () => {
  it('collects every kind of resource, stamped with the region and the account AWS reported', async () => {
    const h = harness();
    const result = await scan(loadConfig({}), h);

    expect(result.failures).toEqual([]);
    expect(result.regionsScanned).toEqual(['us-east-1']);
    expect(result.accountIds).toEqual([ACCOUNT_ID]);
    expect(result.collectorsRun).toBe(4);
    const byId = Object.fromEntries(result.resources.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(['eipalloc-idle', 'i-idle', 'snap-mine', 'vol-orphan']);
    for (const resource of result.resources) {
      expect(resource.region).toBe('us-east-1');
      expect(resource.accountId).toBe(ACCOUNT_ID);
    }
  });

  it('ignores snapshots that belong to other accounts', async () => {
    const result = await scan(loadConfig({}), harness());
    expect(result.resources.map((r) => r.id)).not.toContain('snap-public');
  });

  it('reads server metrics for the configured window, ending at the run clock', async () => {
    const h = harness();
    const result = await scan(loadConfig({ JANITOR_IDLE_WINDOW_DAYS: '7' }), h);

    const server = result.resources.find((r) => r.id === 'i-idle') as InstanceResource;
    expect(server.metrics?.windowDays).toBe(7);
    expect(h.calls.cloudwatch).toHaveLength(3);
    for (const call of h.calls.cloudwatch) {
      expect(call.input.EndTime).toEqual(NOW);
      expect(call.input.StartTime).toEqual(new Date(NOW.getTime() - 7 * MS_PER_DAY));
    }
  });

  it('asks AWS which account it is in before anything else', async () => {
    const h = harness();
    await scan(loadConfig({}), h);
    expect(h.calls.sts.map((c) => c.name)).toEqual(['GetCallerIdentityCommand']);
  });

  it('logs a summary at the end', async () => {
    const { logger, records } = captureLogger();
    await scan(loadConfig({}), harness(), { logger });
    const summary = records.find((r) => r.message === 'Account scan complete');
    expect(summary?.level).toBe('INFO');
    expect(summary?.meta).toEqual({ regionsScanned: 1, regionsRequested: 1, resources: 4, skipped: 0, failures: 0 });
  });

  it('works with the default clock helpers when none are injected', async () => {
    const { logger } = captureLogger();
    const h = harness();
    const result = await collectAccount({ config: loadConfig({}), now: NOW, logger, credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' }, createClients: h.createClients });
    expect(result.failures).toEqual([]);
  });
});

describe('scanning several regions', () => {
  it('scans each region in order and keeps their resources apart', async () => {
    const h = harness((region) => {
      const fakes = healthyAccount();
      const original = fakes.ec2;
      fakes.ec2 = (name, input, callNumber) =>
        name === 'DescribeVolumesCommand'
          ? { Volumes: [{ VolumeId: `vol-in-${region}`, State: 'available', Size: 10, VolumeType: 'gp2' }] }
          : original(name, input, callNumber);
      return fakes;
    });

    const result = await scan(loadConfig({ JANITOR_AWS_REGIONS: 'us-east-1, eu-west-1' }), h);

    expect(h.optionsSeen.map((o) => o.region)).toEqual(['us-east-1', 'eu-west-1']);
    expect(result.regionsScanned).toEqual(['us-east-1', 'eu-west-1']);
    expect(result.collectorsRun).toBe(8);
    expect(result.accountIds).toEqual([ACCOUNT_ID]); // the same account, listed once
    const disks = result.resources.filter((r) => r.type === 'ebs_volume');
    expect(disks.map((d) => `${d.region}:${d.id}`)).toEqual(['us-east-1:vol-in-us-east-1', 'eu-west-1:vol-in-eu-west-1']);
  });

  it('keeps going when one region cannot be identified, and records why', async () => {
    const h = harness((region) => {
      const fakes = healthyAccount();
      if (region === 'eu-west-1') {
        fakes.sts = () => {
          throw awsError('UnrecognizedClientException');
        };
      }
      return fakes;
    });

    const result = await scan(loadConfig({ JANITOR_AWS_REGIONS: 'eu-west-1,us-east-1' }), h);

    expect(result.regionsScanned).toEqual(['us-east-1']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ region: 'eu-west-1', collector: 'identity', kind: 'auth', operation: 'sts:GetCallerIdentity', attempts: 1 });
    expect(result.resources.every((r) => r.region === 'us-east-1')).toBe(true);
    expect(result.resources).toHaveLength(4);
  });

  it('reports a clean "nothing found" only when nothing failed', async () => {
    const h = harness(() => ({
      ...healthyAccount(),
      ec2: () => ({}),
    }));
    const result = await scan(loadConfig({}), h);
    expect(result.resources).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe('when something goes wrong', () => {
  it('records a collector failure and still returns what the other collectors found', async () => {
    const h = harness(() => {
      const fakes = healthyAccount();
      const original = fakes.ec2;
      fakes.ec2 = (name, input, callNumber) => {
        if (name === 'DescribeVolumesCommand') throw awsError('UnauthorizedOperation');
        return original(name, input, callNumber);
      };
      return fakes;
    });

    const result = await scan(loadConfig({}), h);

    expect(result.failures).toEqual([
      expect.objectContaining({ region: 'us-east-1', collector: 'ebs-volumes', kind: 'access_denied', operation: 'ec2:DescribeVolumes' }),
    ]);
    expect(result.resources.map((r) => r.id).sort()).toEqual(['eipalloc-idle', 'i-idle', 'snap-mine']);
  });

  it('a missing CloudWatch permission fails the server collector loudly', async () => {
    const h = harness(() => ({ ...healthyAccount(), cloudwatch: () => { throw awsError('AccessDenied'); } }));
    const result = await scan(loadConfig({}), h);
    expect(result.failures).toEqual([expect.objectContaining({ collector: 'ec2-instances', kind: 'access_denied' })]);
    expect(result.resources.map((r) => r.id)).not.toContain('i-idle');
  });

  it('retries throttling using the injected pause, so nothing really waits', async () => {
    const sleeps: number[] = [];
    const h = harness(() => {
      const fakes = healthyAccount();
      let first = true;
      fakes.sts = () => {
        if (first) {
          first = false;
          throw awsError('ThrottlingException');
        }
        return { Account: ACCOUNT_ID };
      };
      return fakes;
    });

    const result = await scan(loadConfig({}), h, { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 });

    expect(result.failures).toEqual([]);
    expect(sleeps).toEqual([250]); // 0.5 x 500 ms base delay
  });

  it('gives up on a region after the configured number of attempts', async () => {
    const h = harness(() => ({ ...healthyAccount(), sts: () => { throw awsError('ThrottlingException'); } }));
    const result = await scan(loadConfig({ JANITOR_AWS_MAX_ATTEMPTS: '2' }), h);
    expect(h.calls.sts).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ collector: 'identity', kind: 'throttling', attempts: 2 });
    expect(result.regionsScanned).toEqual([]);
  });

  it('crashes loudly (rather than silently scanning) if given an impossible retry setting', async () => {
    const config: AppConfig = { ...loadConfig({}), aws: { regions: ['us-east-1'], maxAttempts: 0 } };
    await expect(scan(config, harness())).rejects.toThrow(RangeError);
  });
});

describe('how clients are set up', () => {
  const ROLE = 'arn:aws:iam::123456789012:role/JanitorReadOnly';

  it('passes the region and the given credentials, and no endpoint by default', async () => {
    const h = harness();
    await scan(loadConfig({}), h);
    expect(h.optionsSeen).toHaveLength(1);
    expect(h.optionsSeen[0]).toEqual({ region: 'us-east-1', credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' } });
    expect('endpoint' in (h.optionsSeen[0] ?? {})).toBe(false);
  });

  it('passes a custom endpoint through when one is configured', async () => {
    const h = harness();
    await scan(loadConfig({ JANITOR_AWS_ENDPOINT: 'http://127.0.0.1:5555' }), h);
    expect(h.optionsSeen[0]?.endpoint).toBe('http://127.0.0.1:5555');
  });

  it('leaves credentials to the SDK default chain when none are given', async () => {
    const { logger } = captureLogger();
    const h = harness();
    await collectAccount({ config: loadConfig({}), now: NOW, logger, sleep: async () => undefined, createClients: h.createClients });
    expect(h.optionsSeen[0]).toEqual({ region: 'us-east-1' });
  });

  it('swaps in short-lived role credentials when a role and External ID are configured', async () => {
    const h = harness();
    await scan(loadConfig({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: 'ext-123' }), h);
    const credentials = h.optionsSeen[0]?.credentials;
    expect(typeof credentials).toBe('function');
    expect(credentials).not.toEqual({ accessKeyId: 'testing', secretAccessKey: 'testing' });
  });
});
