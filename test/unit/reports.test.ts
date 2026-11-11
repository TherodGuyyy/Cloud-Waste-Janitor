import { formatUsd, plural, roundCents } from '../../src/report/format';
import { adviceFor } from '../../src/report/advice';
import { JSON_REPORT_VERSION, renderJsonReport } from '../../src/report/jsonReport';
import { renderTextReport } from '../../src/report/textReport';
import { ReportInput } from '../../src/report/types';
import { DEFAULT_RULE_CONFIG } from '../../src/config/config';
import { CollectorFailure } from '../../src/collectors/runner';
import { daysAgo, makeInstance, makeIp, makeSnapshot, makeVolume, NOW } from '../builders';
import { buildEvaluator, captureLogger } from '../helpers';
import { failure } from '../scanFakes';

function input(overrides: Partial<ReportInput> = {}, resources: unknown[] = defaultResources()): ReportInput {
  const { logger } = captureLogger();
  const evaluation = buildEvaluator(logger).evaluate({
    resources,
    // Every disk in these tests has been unattached for 20 days.
    history: Object.fromEntries(
      (resources as Array<{ id?: string; type?: string }>)
        .filter((r) => r.type === 'ebs_volume' && typeof r.id === 'string')
        .map((r) => [r.id as string, [{ observedAt: daysAgo(20), state: 'available' }, { observedAt: NOW.toISOString(), state: 'available' }]]),
    ),
    now: NOW,
    config: DEFAULT_RULE_CONFIG,
  });
  return {
    generatedAt: NOW.toISOString(),
    complete: true,
    scan: {
      regionsRequested: ['us-east-1'],
      regionsScanned: ['us-east-1'],
      accountIds: ['999999999999'],
      collectorsRun: 4,
      resourcesCollected: resources.length,
      itemsSkippedByCollectors: 0,
      failures: [],
    },
    evaluation,
    watching: [],
    historyEnabled: true,
    ...overrides,
  };
}

function defaultResources() {
  return [
    makeVolume({ id: 'vol-big', sizeGb: 500, volumeType: 'gp3' }), // 500 x $0.08 = $40.00
    makeSnapshot({ id: 'snap-old', sizeGb: 100 }), // 100 x $0.05 = $5.00
    makeIp({ id: 'eipalloc-idle' }), // 0.005 x 730 = $3.65
  ];
}

describe('formatUsd and friends', () => {
  it.each([
    [0, '$0.00'],
    [0.5, '$0.50'],
    [40, '$40.00'],
    [1234.5, '$1,234.50'],
    [1234567.891, '$1,234,567.89'],
    [999.999, '$1,000.00'],
    [-12.3, '-$12.30'],
    [Number.NaN, 'n/a'],
    [Number.POSITIVE_INFINITY, 'n/a'],
  ])('formats %j as %s', (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });

  it('rounds to cents without floating-point noise', () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3);
    expect(roundCents(48.65 * 12)).toBe(583.8);
  });

  it('pluralises', () => {
    expect(plural(1, 'finding')).toBe('1 finding');
    expect(plural(0, 'finding')).toBe('0 findings');
    expect(plural(2, 'IP address', 'IP addresses')).toBe('2 IP addresses');
  });
});

describe('advice', () => {
  const kinds: Array<CollectorFailure['kind']> = ['access_denied', 'auth', 'network', 'timeout', 'throttling', 'server_error', 'not_found', 'unknown', 'unexpected'];
  it.each(kinds)('has plain-words advice for %s', (kind) => {
    expect(adviceFor(kind).length).toBeGreaterThan(20);
  });
  it('points a permission problem at the policy file', () => {
    expect(adviceFor('access_denied')).toContain('policies/collector-readonly-policy.json');
  });
});

describe('text report', () => {
  it('shows the headline numbers, which were checked by hand', () => {
    const text = renderTextReport(input());
    expect(text).toContain('$48.65 per month');
    expect(text).toContain('about $583.80 per year');
    expect(text).toContain('FINDINGS (3)');
    expect(text).toContain('Account:    999999999999');
    expect(text).toContain('Regions:    us-east-1 (1 of 1 scanned)');
    expect(text).toContain('Checked:    3 resources');
  });

  it('lists the most expensive finding first, with why and how it was priced', () => {
    const text = renderTextReport(input());
    const first = text.indexOf('1. $40.00/month  Unattached disk: vol-big (disk, us-east-1)');
    const second = text.indexOf('2. $5.00/month  Old snapshot: snap-old (snapshot, us-east-1)');
    const third = text.indexOf('3. $3.65/month  Unused IP address: eipalloc-idle (IP address, us-east-1)');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(text).toMatch(/Why:\s+\S/);
    expect(text).toMatch(/Cost:\s+\S/);
  });

  it('says plainly that nothing was changed', () => {
    expect(renderTextReport(input())).toContain('Nothing in your account was changed');
  });

  it('says "no wasteful resources" only when the scan was complete', () => {
    const clean = input({}, [makeVolume({ state: 'in-use' })]);
    expect(renderTextReport(clean)).toContain('No wasteful resources found.');
    expect(renderTextReport(clean)).not.toContain('INCOMPLETE');
  });

  it('never says "all clear" on an incomplete scan, and explains each failure', () => {
    const text = renderTextReport(
      input({
        complete: false,
        scan: { ...input().scan, regionsScanned: [], failures: [failure(), failure({ region: 'eu-west-1', kind: 'network', collector: 'identity', operation: undefined })] },
      }, []),
    );
    expect(text).toContain('THIS SCAN IS INCOMPLETE');
    expect(text).toContain('2 problems');
    expect(text).not.toContain('No wasteful resources found.');
    expect(text).toContain('Nothing found in the parts that could be scanned');
    expect(text).toContain('SCAN PROBLEMS (2)');
    expect(text).toContain('us-east-1 / ebs-volumes: access_denied during ec2:DescribeVolumes');
    expect(text).toContain('eu-west-1 / identity: network');
    expect(text).toContain(adviceFor('access_denied'));
  });

  it('singular wording for exactly one problem', () => {
    const text = renderTextReport(input({ complete: false, scan: { ...input().scan, failures: [failure()] } }));
    expect(text).toContain('1 problem stopped part of the scan');
  });

  it('lists disks being watched with their progress', () => {
    const text = renderTextReport(
      input({ watching: [{ resourceId: 'vol-new', region: 'us-east-1', daysUnattached: 3, thresholdDays: 14 }] }),
    );
    expect(text).toContain('DISKS BEING WATCHED (1)');
    expect(text).toContain('vol-new (us-east-1): unattached for 3 of 14 days');
  });

  it('explains that disks cannot be judged when history is off', () => {
    expect(renderTextReport(input({ historyEnabled: false }))).toContain('history is turned off');
    expect(renderTextReport(input())).not.toContain('history is turned off');
  });

  it('lists servers it could not judge, and malformed items it skipped', () => {
    const resources: unknown[] = [makeInstance({ id: 'i-new', metrics: null }), { id: 'broken', type: 'ebs_volume' }];
    const text = renderTextReport(input({}, resources));
    expect(text).toContain('NOT ENOUGH DATA TO JUDGE (1)');
    expect(text).toContain('i-new (Idle server)');
    expect(text).toContain('SKIPPED AS MALFORMED (1)');
    expect(text).toContain('broken:');
  });

  it('mentions resources ignored by tag', () => {
    const text = renderTextReport(input({}, [makeVolume({ id: 'vol-keep', tags: { 'janitor:ignore': 'true' } })]));
    expect(text).toContain('Ignored:    1 resource tagged janitor:ignore=true');
  });

  it('reports findings that could not be priced, without counting them in the total', () => {
    const text = renderTextReport(input({}, [makeVolume({ id: 'vol-odd', volumeType: 'mystery', sizeGb: 10 }), makeIp()]));
    expect(text).toContain('Plus 1 finding that could not be priced');
    expect(text).toContain('cost unknown');
    expect(text).toContain('Cost: could not be estimated');
    expect(text).toContain('$3.65 per month');
  });

  it('shows "none" when no account or region was reached', () => {
    const text = renderTextReport(input({ complete: false, scan: { ...input().scan, accountIds: [], regionsScanned: [] } }, []));
    expect(text).toContain('Account:    none');
    expect(text).toContain('Regions:    none (0 of 1 scanned)');
  });

  it('falls back to the raw id and type for unfamiliar rules and resources', () => {
    const base = input();
    const odd = {
      ...base,
      evaluation: {
        ...base.evaluation,
        findings: [{ ...(base.evaluation.findings[0] as object), ruleId: 'new-rule', resourceType: 'new_type' }] as never,
      },
    };
    expect(renderTextReport(odd as ReportInput)).toContain('new-rule: vol-big (new_type, us-east-1)');
  });

  it('has no colour codes, so it reads the same in any terminal or file', () => {
    // eslint-disable-next-line no-control-regex
    expect(renderTextReport(input())).not.toMatch(/\u001b\[/);
  });
});

describe('JSON report', () => {
  it('is valid JSON with a version and the totals', () => {
    const parsed = JSON.parse(renderJsonReport(input()));
    expect(parsed.schemaVersion).toBe(JSON_REPORT_VERSION);
    expect(parsed.complete).toBe(true);
    expect(parsed.totals).toMatchObject({ findings: 3, monthlyUsd: 48.65, annualUsd: 583.8, unestimatedFindings: 0 });
    expect(parsed.scan).toMatchObject({ accountIds: ['999999999999'], regionsScanned: ['us-east-1'], resourcesCollected: 3 });
  });

  it('carries every finding with its evidence and estimate', () => {
    const parsed = JSON.parse(renderJsonReport(input()));
    expect(parsed.findings.map((f: { resourceId: string }) => f.resourceId)).toEqual(['vol-big', 'snap-old', 'eipalloc-idle']);
    expect(parsed.findings[0]).toMatchObject({ ruleId: 'unattached-disk', estimate: { ok: true, monthlyUsd: 40 } });
    expect(parsed.findings[0].evidence).toBeDefined();
  });

  it('lists failures with null for details that were not known, and never the raw cause', () => {
    const parsed = JSON.parse(renderJsonReport(input({ complete: false, scan: { ...input().scan, failures: [failure({ operation: undefined, attempts: undefined })] } })));
    expect(parsed.complete).toBe(false);
    expect(parsed.failures[0]).toEqual({
      region: 'us-east-1',
      collector: 'ebs-volumes',
      kind: 'access_denied',
      operation: null,
      attempts: null,
      message: expect.any(String),
    });
  });

  it('includes watched disks and the history switch', () => {
    const watching = [{ resourceId: 'vol-new', region: 'us-east-1', daysUnattached: 1, thresholdDays: 14 }];
    const parsed = JSON.parse(renderJsonReport(input({ watching, historyEnabled: false })));
    expect(parsed.watching).toEqual(watching);
    expect(parsed.historyEnabled).toBe(false);
  });
});
