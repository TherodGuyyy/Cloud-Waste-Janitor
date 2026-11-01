import { CloudApiError } from '../../src/collectors/errors';
import { runCollectors } from '../../src/collectors/runner';
import { CollectContext, CollectResult, Collector } from '../../src/collectors/types';
import { ResourceType } from '../../src/core/types';
import { makeIp, makeVolume } from '../builders';
import { ACCOUNT, makeCtx } from '../collectorFakes';
import { captureLogger } from '../helpers';

const vol = (id: string, overrides: Record<string, unknown> = {}) =>
  ({ ...makeVolume({ id, accountId: ACCOUNT }), ...overrides });
const ip = (id: string, overrides: Record<string, unknown> = {}) =>
  ({ ...makeIp({ id, accountId: ACCOUNT }), ...overrides });

function collector(
  name: string,
  resourceType: ResourceType,
  collect: (ctx: CollectContext) => Promise<CollectResult>,
): Collector {
  return { name, resourceType, collect };
}

/** A collector that returns whatever it is told to, even if it is wrong. */
function returning(name: string, resourceType: ResourceType, resources: unknown[], skipped: CollectResult['skipped'] = []): Collector {
  return collector(name, resourceType, async () => ({ resources: resources as CollectResult['resources'], skipped }));
}

describe('running several collectors', () => {
  it('merges everything in order, and counts the collectors', async () => {
    const result = await runCollectors(
      [
        returning('disks', 'ebs_volume', [vol('vol-1'), vol('vol-2')], [{ id: 'vol-x', collector: 'disks', reason: 'no size' }]),
        returning('ips', 'elastic_ip', [ip('eip-1')]),
      ],
      makeCtx(),
    );

    expect(result.resources.map((r) => r.id)).toEqual(['vol-1', 'vol-2', 'eip-1']);
    expect(result.skipped).toEqual([{ id: 'vol-x', collector: 'disks', reason: 'no size' }]);
    expect(result.failures).toEqual([]);
    expect(result.collectorsRun).toBe(2);
  });

  it('does nothing, successfully, when there are no collectors', async () => {
    expect(await runCollectors([], makeCtx())).toEqual({ resources: [], skipped: [], failures: [], collectorsRun: 0 });
  });

  it('runs the collectors one after another, not at the same time', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) =>
      collector(name, 'ebs_volume', async () => {
        order.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end ${name}`);
        return { resources: [], skipped: [] };
      });
    await runCollectors([slow('a', 10), slow('b', 1)], makeCtx());
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});

describe('failure isolation', () => {
  it('records a cloud failure with its details and still runs the other collectors', async () => {
    const { logger, records } = captureLogger();
    const failure = new CloudApiError('ec2:DescribeInstances', { kind: 'throttling', retryable: true }, 5);
    const result = await runCollectors(
      [
        returning('disks', 'ebs_volume', [vol('vol-1')]),
        collector('servers', 'ec2_instance', async () => Promise.reject(failure)),
        returning('ips', 'elastic_ip', [ip('eip-1')]),
      ],
      makeCtx({ logger }),
    );

    expect(result.resources.map((r) => r.id)).toEqual(['vol-1', 'eip-1']);
    expect(result.failures).toEqual([
      {
        region: 'us-east-1',
        collector: 'servers',
        kind: 'throttling',
        message: failure.message,
        operation: 'ec2:DescribeInstances',
        attempts: 5,
      },
    ]);
    expect(result.collectorsRun).toBe(3);
    const logged = records.find((r) => r.message === 'Collector failed');
    expect(logged?.level).toBe('ERROR');
    expect(logged?.meta).toMatchObject({ kind: 'throttling', operation: 'ec2:DescribeInstances', attempts: 5 });
  });

  it('records a permission failure the same way', async () => {
    const result = await runCollectors(
      [collector('disks', 'ebs_volume', async () => Promise.reject(new CloudApiError('ec2:DescribeVolumes', { kind: 'access_denied', retryable: false }, 1)))],
      makeCtx(),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ kind: 'access_denied', collector: 'disks', attempts: 1 });
  });

  it('records a bug in a collector as "unexpected" and carries on', async () => {
    const { logger, records } = captureLogger();
    const result = await runCollectors(
      [
        collector('buggy', 'ebs_volume', async () => {
          throw new TypeError('cannot read properties of undefined');
        }),
        returning('ips', 'elastic_ip', [ip('eip-1')]),
      ],
      makeCtx({ logger }),
    );

    expect(result.resources.map((r) => r.id)).toEqual(['eip-1']);
    expect(result.failures).toEqual([
      { region: 'us-east-1', collector: 'buggy', kind: 'unexpected', message: 'cannot read properties of undefined' },
    ]);
    const logged = records.find((r) => r.message === 'Collector crashed unexpectedly');
    expect(logged?.level).toBe('ERROR');
  });

  it('copes with something that is not an Error being thrown', async () => {
    const result = await runCollectors([collector('odd', 'ebs_volume', async () => Promise.reject('just a string'))], makeCtx());
    expect(result.failures).toEqual([{ region: 'us-east-1', collector: 'odd', kind: 'unexpected', message: 'just a string' }]);
  });

  it('a collector that fails contributes nothing, not even half a result', async () => {
    const result = await runCollectors(
      [collector('disks', 'ebs_volume', async () => Promise.reject(new CloudApiError('op', { kind: 'timeout', retryable: true }, 3)))],
      makeCtx(),
    );
    expect(result.resources).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('checking collector output', () => {
  async function runOne(resources: unknown[], resourceType: ResourceType = 'ebs_volume') {
    return runCollectors([returning('disks', resourceType, resources)], makeCtx());
  }

  it('keeps good resources and rejects bad ones with a reason', async () => {
    const result = await runOne([
      vol('vol-ok'),
      ip('eip-wrong-type'),
      vol('vol-wrong-region', { region: 'eu-west-1' }),
      vol('vol-wrong-account', { accountId: '999999999999' }),
      { id: 'vol-broken', type: 'ebs_volume' },
      'not even an object',
    ]);

    expect(result.resources.map((r) => r.id)).toEqual(['vol-ok']);
    expect(result.skipped).toEqual([
      { id: 'eip-wrong-type', collector: 'disks', reason: 'rejected by runner: wrong type "elastic_ip" from a ebs_volume collector' },
      { id: 'vol-wrong-region', collector: 'disks', reason: 'rejected by runner: wrong region "eu-west-1" (scanning us-east-1)' },
      { id: 'vol-wrong-account', collector: 'disks', reason: 'rejected by runner: wrong account "999999999999" (scanning 123456789012)' },
      { id: 'unknown', collector: 'disks', reason: 'rejected by runner: missing region' },
      { id: 'unknown', collector: 'disks', reason: 'rejected by runner: not an object' },
    ]);
  });

  it('rejects a repeated id, keeping the first', async () => {
    const result = await runOne([vol('vol-1', { sizeGb: 10 }), vol('vol-1', { sizeGb: 999 })]);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ id: 'vol-1', sizeGb: 10 });
    expect(result.skipped).toEqual([{ id: 'vol-1', collector: 'disks', reason: 'rejected by runner: duplicate id' }]);
  });

  it('rejects a repeat of the same id of the same type from another collector', async () => {
    const result = await runCollectors([returning('first', 'ebs_volume', [vol('vol-1')]), returning('second', 'ebs_volume', [vol('vol-1')])], makeCtx());
    expect(result.resources).toHaveLength(1);
    expect(result.skipped).toEqual([{ id: 'vol-1', collector: 'second', reason: 'rejected by runner: duplicate id' }]);
  });

  it('allows the same id text for resources of different types', async () => {
    const result = await runCollectors([returning('disks', 'ebs_volume', [vol('shared-id')]), returning('ips', 'elastic_ip', [ip('shared-id')])], makeCtx());
    expect(result.resources).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  it('keeps what the collector itself skipped, as well as what the runner rejects', async () => {
    const result = await runCollectors(
      [returning('disks', 'ebs_volume', [vol('vol-1'), vol('vol-1')], [{ id: 'vol-x', collector: 'disks', reason: 'no state' }])],
      makeCtx(),
    );
    expect(result.skipped.map((s) => s.reason)).toEqual(['no state', 'rejected by runner: duplicate id']);
  });
});

describe('runner logging and context', () => {
  it('gives each collector a logger that names the collector and the region', async () => {
    const { logger, records } = captureLogger();
    await runCollectors(
      [collector('disks', 'ebs_volume', async (ctx) => {
        ctx.logger.info('hello from inside');
        return { resources: [vol('vol-1', { region: 'eu-central-1' })], skipped: [] };
      })],
      makeCtx({ logger, region: 'eu-central-1' }),
    );

    const inside = records.find((r) => r.message === 'hello from inside');
    expect(inside).toMatchObject({ collector: 'disks', region: 'eu-central-1' });
    const started = records.find((r) => r.message === 'Collector started');
    expect(started).toMatchObject({ level: 'INFO', collector: 'disks', region: 'eu-central-1' });
    const finished = records.find((r) => r.message === 'Collector finished');
    expect(finished?.meta).toEqual({ resources: 1, skipped: 0 });
  });

  it('passes the rest of the run context through unchanged', async () => {
    let seen: CollectContext | undefined;
    const ctx = makeCtx({ idleWindowDays: 21 });
    await runCollectors([collector('disks', 'ebs_volume', async (c) => {
      seen = c;
      return { resources: [], skipped: [] };
    })], ctx);
    expect(seen).toMatchObject({ region: ctx.region, accountId: ctx.accountId, now: ctx.now, idleWindowDays: 21 });
  });
});
