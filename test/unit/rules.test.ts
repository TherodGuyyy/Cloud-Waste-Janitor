import {
  DEFAULT_RULES,
  IDLE_SERVER_RULE_ID,
  IGNORE_TAG_KEY,
  isIgnoredByTag,
  OLD_SNAPSHOT_RULE_ID,
  UNATTACHED_DISK_RULE_ID,
  UNUSED_IP_RULE_ID,
} from '../../src/core/rules';
import { idleServerRule } from '../../src/core/rules/idleServer';
import { oldSnapshotRule } from '../../src/core/rules/oldSnapshot';
import { unattachedDiskRule } from '../../src/core/rules/unattachedDisk';
import { unusedIpRule } from '../../src/core/rules/unusedIp';
import { daysAgo, makeContext, makeInstance, makeIp, makeSnapshot, makeVolume } from '../builders';

function diskHistory(days: number, state = 'available') {
  return {
    'vol-test': [
      { observedAt: daysAgo(days), state },
      { observedAt: daysAgo(0.5), state },
    ],
  };
}

describe('unattached disk rule', () => {
  it('does not flag a disk unattached for 13 days', () => {
    expect(unattachedDiskRule.evaluate(makeVolume(), makeContext(diskHistory(13))).kind).toBe('no_finding');
  });

  it('flags a disk unattached for exactly 14 days', () => {
    const outcome = unattachedDiskRule.evaluate(makeVolume(), makeContext(diskHistory(14)));
    expect(outcome.kind).toBe('finding');
  });

  it('flags a disk unattached for 30 days and explains why', () => {
    const outcome = unattachedDiskRule.evaluate(makeVolume({ sizeGb: 250, volumeType: 'gp2' }), makeContext(diskHistory(30)));
    expect(outcome).toEqual({
      kind: 'finding',
      ruleId: UNATTACHED_DISK_RULE_ID,
      reason: 'Disk has not been attached to anything for 30 days',
      evidence: { daysUnattached: 30, thresholdDays: 14, sizeGb: 250, volumeType: 'gp2' },
    });
  });

  it('never flags an attached disk, however long the history', () => {
    const volume = makeVolume({ state: 'in-use' });
    expect(unattachedDiskRule.evaluate(volume, makeContext(diskHistory(100, 'in-use'))).kind).toBe('no_finding');
  });

  it('does not flag a disk with no history (first sighting)', () => {
    expect(unattachedDiskRule.evaluate(makeVolume(), makeContext({})).kind).toBe('no_finding');
  });

  it('respects a custom threshold', () => {
    const ctx = makeContext(diskHistory(5), { unattachedDiskDays: 3 });
    expect(unattachedDiskRule.evaluate(makeVolume(), ctx).kind).toBe('finding');
  });

  it('ignores resources of another type', () => {
    expect(unattachedDiskRule.evaluate(makeIp(), makeContext()).kind).toBe('no_finding');
  });
});

describe('idle server rule', () => {
  it('flags 4 percent CPU with low network over the full window', () => {
    const instance = makeInstance({ metrics: { windowDays: 14, avgCpuPercent: 4, avgNetworkBytesPerDay: 1000 } });
    const outcome = idleServerRule.evaluate(instance, makeContext());
    expect(outcome.kind).toBe('finding');
    if (outcome.kind === 'finding') {
      expect(outcome.ruleId).toBe(IDLE_SERVER_RULE_ID);
      expect(outcome.evidence).toMatchObject({ avgCpuPercent: 4, windowDays: 14, instanceType: 't3.micro' });
    }
  });

  it('does not flag 6 percent CPU', () => {
    const instance = makeInstance({ metrics: { windowDays: 14, avgCpuPercent: 6, avgNetworkBytesPerDay: 1000 } });
    expect(idleServerRule.evaluate(instance, makeContext()).kind).toBe('no_finding');
  });

  it('does not flag exactly 5 percent CPU (threshold is strict)', () => {
    const instance = makeInstance({ metrics: { windowDays: 14, avgCpuPercent: 5, avgNetworkBytesPerDay: 1000 } });
    expect(idleServerRule.evaluate(instance, makeContext()).kind).toBe('no_finding');
  });

  it('does not flag low CPU when network traffic is high', () => {
    const instance = makeInstance({ metrics: { windowDays: 14, avgCpuPercent: 1, avgNetworkBytesPerDay: 6_000_000 } });
    expect(idleServerRule.evaluate(instance, makeContext()).kind).toBe('no_finding');
  });

  it('does not flag network exactly at the threshold', () => {
    const instance = makeInstance({ metrics: { windowDays: 14, avgCpuPercent: 1, avgNetworkBytesPerDay: 5_000_000 } });
    expect(idleServerRule.evaluate(instance, makeContext()).kind).toBe('no_finding');
  });

  it('reports insufficient data (never guesses) when metrics are missing', () => {
    const outcome = idleServerRule.evaluate(makeInstance({ metrics: null }), makeContext());
    expect(outcome).toEqual({
      kind: 'insufficient_data',
      ruleId: IDLE_SERVER_RULE_ID,
      reason: 'No CPU metrics available for this server',
    });
  });

  it('reports insufficient data when metrics cover fewer days than needed', () => {
    const instance = makeInstance({ metrics: { windowDays: 7, avgCpuPercent: 1, avgNetworkBytesPerDay: 10 } });
    const outcome = idleServerRule.evaluate(instance, makeContext());
    expect(outcome.kind).toBe('insufficient_data');
    if (outcome.kind === 'insufficient_data') {
      expect(outcome.reason).toBe('Metrics cover 7 days but 14 are needed');
    }
  });

  it('accepts a longer window than required', () => {
    const instance = makeInstance({ metrics: { windowDays: 30, avgCpuPercent: 1, avgNetworkBytesPerDay: 10 } });
    expect(idleServerRule.evaluate(instance, makeContext()).kind).toBe('finding');
  });

  it('skips stopped servers', () => {
    expect(idleServerRule.evaluate(makeInstance({ state: 'stopped' }), makeContext()).kind).toBe('no_finding');
  });

  it('ignores resources of another type', () => {
    expect(idleServerRule.evaluate(makeVolume(), makeContext()).kind).toBe('no_finding');
  });
});

describe('old snapshot rule', () => {
  it('does not flag an 89 day old snapshot', () => {
    expect(oldSnapshotRule.evaluate(makeSnapshot({ startTime: daysAgo(89) }), makeContext()).kind).toBe('no_finding');
  });

  it('flags a snapshot exactly 90 days old', () => {
    expect(oldSnapshotRule.evaluate(makeSnapshot({ startTime: daysAgo(90) }), makeContext()).kind).toBe('finding');
  });

  it('flags a 91 day old unused snapshot with evidence', () => {
    const outcome = oldSnapshotRule.evaluate(makeSnapshot({ startTime: daysAgo(91), sizeGb: 40 }), makeContext());
    expect(outcome).toEqual({
      kind: 'finding',
      ruleId: OLD_SNAPSHOT_RULE_ID,
      reason: 'Snapshot is 91 days old and not used by any image',
      evidence: { ageDays: 91, thresholdDays: 90, sizeGb: 40 },
    });
  });

  it('never flags a snapshot still used by an image', () => {
    const snapshot = makeSnapshot({ startTime: daysAgo(400), usedByImage: true });
    expect(oldSnapshotRule.evaluate(snapshot, makeContext()).kind).toBe('no_finding');
  });

  it('reports insufficient data for an unreadable date', () => {
    const outcome = oldSnapshotRule.evaluate(makeSnapshot({ startTime: 'garbage' }), makeContext());
    expect(outcome.kind).toBe('insufficient_data');
  });

  it('respects a custom age limit', () => {
    const ctx = makeContext({}, { snapshotMaxAgeDays: 30 });
    expect(oldSnapshotRule.evaluate(makeSnapshot({ startTime: daysAgo(31) }), ctx).kind).toBe('finding');
  });

  it('ignores resources of another type', () => {
    expect(oldSnapshotRule.evaluate(makeIp(), makeContext()).kind).toBe('no_finding');
  });
});

describe('unused IP rule', () => {
  it('flags an unattached address', () => {
    const outcome = unusedIpRule.evaluate(makeIp({ publicIp: '203.0.113.7' }), makeContext());
    expect(outcome).toEqual({
      kind: 'finding',
      ruleId: UNUSED_IP_RULE_ID,
      reason: 'Elastic IP address is not attached to anything',
      evidence: { publicIp: '203.0.113.7' },
    });
  });

  it('does not flag an attached address', () => {
    expect(unusedIpRule.evaluate(makeIp({ associated: true }), makeContext()).kind).toBe('no_finding');
  });

  it('ignores resources of another type', () => {
    expect(unusedIpRule.evaluate(makeVolume(), makeContext()).kind).toBe('no_finding');
  });
});

describe('ignore tag', () => {
  it.each(['true', 'TRUE', 'True', ' true '])('treats janitor:ignore=%j as ignored', (value) => {
    expect(isIgnoredByTag(makeVolume({ tags: { [IGNORE_TAG_KEY]: value } }))).toBe(true);
  });

  it.each(['false', 'yes', '1', ''])('does not treat janitor:ignore=%j as ignored', (value) => {
    expect(isIgnoredByTag(makeVolume({ tags: { [IGNORE_TAG_KEY]: value } }))).toBe(false);
  });

  it('is not ignored without the tag or with a different tag', () => {
    expect(isIgnoredByTag(makeVolume())).toBe(false);
    expect(isIgnoredByTag(makeVolume({ tags: { ignore: 'true' } }))).toBe(false);
  });

  it('uses the documented tag name', () => {
    expect(IGNORE_TAG_KEY).toBe('janitor:ignore');
  });
});

describe('default rule set', () => {
  it('contains the four starter rules with unique ids', () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(ids).toEqual(['unattached-disk', 'idle-server', 'old-snapshot', 'unused-ip']);
    expect(new Set(ids).size).toBe(4);
  });

  it('each resource type is covered by exactly one rule', () => {
    const types = DEFAULT_RULES.map((r) => r.appliesTo).sort();
    expect(types).toEqual(['ebs_snapshot', 'ebs_volume', 'ec2_instance', 'elastic_ip']);
  });
});
