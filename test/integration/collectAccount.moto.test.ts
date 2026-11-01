/**
 * Integration tests: the REAL AWS SDK and our whole pipeline talking over HTTP to moto,
 * an open-source fake AWS. Nothing here touches a real AWS account or costs money.
 *
 * What moto cannot do (so these tests do not claim it): simulate throttling, permission
 * errors, or page sizes. Those are covered by the unit tests with fakes.
 */

import {
  AllocateAddressCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  EC2Client,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';
import { createAwsClients } from '../../src/adapters/aws/clients';
import { collectAccount } from '../../src/app/collectAccount';
import { DEFAULT_RULE_CONFIG, loadConfig } from '../../src/config/config';
import { MS_PER_DAY } from '../../src/core/history';
import { ElasticIpResource, InstanceResource, ObservationHistory, Resource, SnapshotResource, VolumeResource } from '../../src/core/types';
import { buildEvaluator, captureLogger } from '../helpers';

const ENDPOINT = process.env.MOTO_ENDPOINT as string;
const CREDENTIALS = { accessKeyId: 'testing', secretAccessKey: 'testing' };
const MOTO_ACCOUNT = '123456789012';
const ROLE_ARN = `arn:aws:iam::${MOTO_ACCOUNT}:role/JanitorReadOnly`;
// A famous default image that moto always knows about.
const IMAGE_ID = 'ami-12c6146b';

async function resetMoto(): Promise<void> {
  const response = await fetch(`${ENDPOINT}/moto-api/reset`, { method: 'POST' });
  if (!response.ok) throw new Error(`moto reset failed: HTTP ${response.status}`);
}

function ec2(region: string): EC2Client {
  return new EC2Client({ region, endpoint: ENDPOINT, credentials: CREDENTIALS, maxAttempts: 1 });
}

/** Builds a deliberately wasteful corner of "AWS": the things the Janitor should find. */
async function seedWastefulRegion(region: string): Promise<void> {
  const client = ec2(region);
  const volume = await client.send(
    new CreateVolumeCommand({ AvailabilityZone: `${region}a`, Size: 500, VolumeType: 'gp3' }),
  );
  await client.send(
    new CreateSnapshotCommand({ VolumeId: volume.VolumeId as string, Description: 'forgotten backup' }),
  );
  await client.send(new RunInstancesCommand({ ImageId: IMAGE_ID, InstanceType: 't3.medium', MinCount: 1, MaxCount: 1 }));
  await client.send(new AllocateAddressCommand({ Domain: 'vpc' }));
}

function config(extra: Record<string, string> = {}) {
  return loadConfig({ JANITOR_AWS_ENDPOINT: ENDPOINT, JANITOR_AWS_MAX_ATTEMPTS: '2', ...extra });
}

function byType<T extends Resource>(resources: Resource[], type: T['type']): T[] {
  return resources.filter((r): r is T => r.type === type);
}

beforeEach(async () => {
  await resetMoto();
});

describe('collecting from a fake AWS account', () => {
  it('finds one resource of every kind, with the right region and account', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();

    const result = await collectAccount({ config: config(), now: new Date(), logger, credentials: CREDENTIALS });

    expect(result.failures).toEqual([]);
    expect(result.regionsScanned).toEqual(['us-east-1']);
    expect(result.accountIds).toEqual([MOTO_ACCOUNT]);

    const volumes = byType<VolumeResource>(result.resources, 'ebs_volume');
    const instances = byType<InstanceResource>(result.resources, 'ec2_instance');
    const snapshots = byType<SnapshotResource>(result.resources, 'ebs_snapshot');
    const addresses = byType<ElasticIpResource>(result.resources, 'elastic_ip');

    // moto also creates volumes for the running instance, so look for ours by its traits.
    expect(volumes.some((v) => v.sizeGb === 500 && v.volumeType === 'gp3' && v.state === 'available')).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.state).toBe('running');
    expect(instances[0]?.instanceType).toBe('t3.medium');
    expect(snapshots.some((s) => s.sizeGb === 500)).toBe(true);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.associated).toBe(false);

    for (const resource of result.resources) {
      expect(resource.region).toBe('us-east-1');
      expect(resource.accountId).toBe(MOTO_ACCOUNT);
    }
  });

  it('returns nothing, and no failures, for an empty account', async () => {
    const { logger } = captureLogger();
    const result = await collectAccount({ config: config(), now: new Date(), logger, credentials: CREDENTIALS });
    expect(result.failures).toEqual([]);
    expect(byType<VolumeResource>(result.resources, 'ebs_volume')).toEqual([]);
    expect(byType<ElasticIpResource>(result.resources, 'elastic_ip')).toEqual([]);
  });

  it('keeps regions apart when scanning several', async () => {
    await seedWastefulRegion('us-east-1');
    await seedWastefulRegion('eu-west-1');
    const { logger } = captureLogger();

    const result = await collectAccount({
      config: config({ JANITOR_AWS_REGIONS: 'us-east-1,eu-west-1' }),
      now: new Date(),
      logger,
      credentials: CREDENTIALS,
    });

    expect(result.failures).toEqual([]);
    expect(result.regionsScanned).toEqual(['us-east-1', 'eu-west-1']);
    for (const region of ['us-east-1', 'eu-west-1']) {
      const inRegion = result.resources.filter((r) => r.region === region);
      expect(byType<ElasticIpResource>(inRegion, 'elastic_ip')).toHaveLength(1);
      expect(byType<InstanceResource>(inRegion, 'ec2_instance')).toHaveLength(1);
    }
  });

  it('works through an assumed role with an External ID', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();

    const result = await collectAccount({
      config: config({ JANITOR_ROLE_ARN: ROLE_ARN, JANITOR_EXTERNAL_ID: 'integration-test-id' }),
      now: new Date(),
      logger,
      credentials: CREDENTIALS,
    });

    expect(result.failures).toEqual([]);
    expect(result.accountIds).toEqual([MOTO_ACCOUNT]);
    expect(byType<ElasticIpResource>(result.resources, 'elastic_ip')).toHaveLength(1);
  });

  it('gives the same answer when the same account is scanned twice', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();
    const run = () => collectAccount({ config: config(), now: new Date('2026-10-28T12:00:00Z'), logger, credentials: CREDENTIALS });

    const first = await run();
    const second = await run();

    const ids = (r: typeof first) => r.resources.map((x) => `${x.type}:${x.id}`).sort();
    expect(ids(second)).toEqual(ids(first));
    expect(ids(first).length).toBeGreaterThanOrEqual(4);
  });
});

describe('collecting then judging: the whole Phase 1 + 2 pipeline', () => {
  it('flags the wasteful resources weeks later and prices them', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();

    // moto cannot backdate resources, so we move OUR clock forward instead.
    const realNow = new Date();
    const later = new Date(realNow.getTime() + 120 * MS_PER_DAY);

    const first = await collectAccount({ config: config(), now: realNow, logger, credentials: CREDENTIALS });
    const second = await collectAccount({ config: config(), now: later, logger, credentials: CREDENTIALS });
    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);

    // The Janitor remembers what it saw. Here we hand it the sighting from 120 days ago.
    const history: ObservationHistory = {};
    for (const volume of byType<VolumeResource>(first.resources, 'ebs_volume')) {
      history[volume.id] = [{ observedAt: realNow.toISOString(), state: volume.state }];
    }

    const report = buildEvaluator(logger).evaluate({
      resources: second.resources,
      history,
      now: later,
      config: DEFAULT_RULE_CONFIG,
    });

    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    expect(ruleIds.has('unattached-disk')).toBe(true);
    expect(ruleIds.has('old-snapshot')).toBe(true);
    expect(ruleIds.has('unused-ip')).toBe(true);
    expect(report.invalidResources).toEqual([]);
    expect(report.totalMonthlyUsd).toBeGreaterThan(0);

    const disk = report.findings.find((f) => f.ruleId === 'unattached-disk');
    // 500 GB of gp3 at $0.08 per GB-month.
    expect(disk?.estimate).toMatchObject({ ok: true, monthlyUsd: 40 });
  });

  it('does not flag anything on day one', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();
    const now = new Date();

    const collected = await collectAccount({ config: config(), now, logger, credentials: CREDENTIALS });
    const report = buildEvaluator(logger).evaluate({ resources: collected.resources, history: {}, now, config: DEFAULT_RULE_CONFIG });

    const ruleIds = report.findings.map((f) => f.ruleId);
    expect(ruleIds).not.toContain('unattached-disk'); // not yet 14 days
    expect(ruleIds).not.toContain('old-snapshot'); // not yet 90 days
    expect(ruleIds).toContain('unused-ip'); // an unused IP costs money immediately
  });

  it('never calls a new server idle: it says there is not enough data', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();
    const now = new Date();

    const collected = await collectAccount({ config: config(), now, logger, credentials: CREDENTIALS });
    const report = buildEvaluator(logger).evaluate({ resources: collected.resources, history: {}, now, config: DEFAULT_RULE_CONFIG });

    expect(report.findings.map((f) => f.ruleId)).not.toContain('idle-server');
    expect(report.insufficientData.some((s) => s.ruleId === 'idle-server')).toBe(true);
  });
});

describe('when AWS cannot be reached', () => {
  it('reports a network failure after the configured attempts and does not crash', async () => {
    const { logger, records } = captureLogger();
    const sleeps: number[] = [];

    const result = await collectAccount({
      config: loadConfig({ JANITOR_AWS_ENDPOINT: 'http://127.0.0.1:1', JANITOR_AWS_MAX_ATTEMPTS: '3' }),
      now: new Date(),
      logger,
      credentials: CREDENTIALS,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.regionsScanned).toEqual([]);
    expect(result.resources).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ collector: 'identity', kind: 'network', attempts: 3 });
    expect(sleeps).toHaveLength(2); // paused between the three attempts
    expect(records.some((r) => r.level === 'ERROR' || r.level === 'WARN')).toBe(true);
  });

  it('one unreachable region does not stop the next one', async () => {
    await seedWastefulRegion('us-east-1');
    const { logger } = captureLogger();
    let calls = 0;
    const twoRegions = loadConfig({ JANITOR_AWS_ENDPOINT: ENDPOINT, JANITOR_AWS_REGIONS: 'us-east-1,eu-west-1', JANITOR_AWS_MAX_ATTEMPTS: '1' });

    const result = await collectAccount({
      config: twoRegions,
      now: new Date(),
      logger,
      credentials: CREDENTIALS,
      createClients: (options) => {
        calls += 1;
        // Point the second region at a dead port, the first at moto.
        return createAwsClients(options.region === 'eu-west-1' ? { ...options, endpoint: 'http://127.0.0.1:1' } : options);
      },
    });

    expect(calls).toBe(2);
    expect(result.regionsScanned).toEqual(['us-east-1']);
    expect(result.failures).toEqual([expect.objectContaining({ region: 'eu-west-1', kind: 'network' })]);
    expect(byType<ElasticIpResource>(result.resources, 'elastic_ip')).toHaveLength(1);
  });
});
