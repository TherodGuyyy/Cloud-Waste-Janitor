import { createEvaluator } from '../../src/core/evaluator';
import { DEFAULT_RULES } from '../../src/core/rules';
import { estimateMonthlyCost } from '../../src/core/cost/estimator';
import { DEFAULT_RULE_CONFIG } from '../../src/config/config';
import { createNullLogger } from '../../src/logging/logger';
import { Rule } from '../../src/core/types';
import { buildEvaluator, captureLogger, loadFixture, runFixture } from '../helpers';
import { makeIp, makeVolume, NOW } from '../builders';

describe('wasteful account (hand-computed expectations)', () => {
  const report = runFixture('wasteful-account', createNullLogger());

  it('finds 8 problems worth 178.41 per month', () => {
    // 40.00 + 20.00 + 30.37 + 60.74 + 15.00 + 5.00 + 3.65 + 3.65
    expect(report.findings).toHaveLength(8);
    expect(report.totalMonthlyUsd).toBe(178.41);
    expect(report.unestimatedFindings).toBe(0);
  });

  it('counts everything it was given', () => {
    expect(report.resourcesReceived).toBe(8);
    expect(report.resourcesEvaluated).toBe(8);
    expect(report.resourcesIgnoredByTag).toBe(0);
    expect(report.invalidResources).toEqual([]);
    expect(report.insufficientData).toEqual([]);
  });

  it('lists the most expensive problem first, ties broken by id', () => {
    expect(report.findings.map((f) => f.id)).toEqual([
      'idle-server:i-idle-batch', // 60.74
      'unattached-disk:vol-orphan-gp3-500', // 40.00
      'idle-server:i-idle-web', // 30.37
      'unattached-disk:vol-orphan-gp2-200', // 20.00
      'old-snapshot:snap-old-1', // 15.00
      'old-snapshot:snap-old-2', // 5.00
      'unused-ip:eipalloc-unused-1', // 3.65
      'unused-ip:eipalloc-unused-2', // 3.65
    ]);
  });

  it('gives each finding the right cost', () => {
    const costs = Object.fromEntries(
      report.findings.map((f) => [f.id, f.estimate.ok ? f.estimate.monthlyUsd : null]),
    );
    expect(costs).toEqual({
      'idle-server:i-idle-batch': 60.74,
      'unattached-disk:vol-orphan-gp3-500': 40,
      'idle-server:i-idle-web': 30.37,
      'unattached-disk:vol-orphan-gp2-200': 20,
      'old-snapshot:snap-old-1': 15,
      'old-snapshot:snap-old-2': 5,
      'unused-ip:eipalloc-unused-1': 3.65,
      'unused-ip:eipalloc-unused-2': 3.65,
    });
  });

  it('records how long each disk and snapshot has been wasteful', () => {
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    expect(byId['unattached-disk:vol-orphan-gp3-500']?.evidence.daysUnattached).toBe(48);
    expect(byId['unattached-disk:vol-orphan-gp2-200']?.evidence.daysUnattached).toBe(24);
    expect(byId['old-snapshot:snap-old-1']?.evidence.ageDays).toBe(241);
    expect(byId['old-snapshot:snap-old-2']?.evidence.ageDays).toBe(149);
  });

  it('stamps findings with the run time and copies resource facts', () => {
    const finding = report.findings[0];
    expect(report.generatedAt).toBe('2026-10-28T12:00:00.000Z');
    expect(finding?.detectedAt).toBe('2026-10-28T12:00:00.000Z');
    expect(finding?.resourceType).toBe('ec2_instance');
    expect(finding?.region).toBe('us-east-1');
    expect(finding?.resourceId).toBe('i-idle-batch');
    expect(finding?.ruleId).toBe('idle-server');
  });

  it('gives the same answer every time and does not change its input', () => {
    const fixture = loadFixture('wasteful-account');
    const before = JSON.stringify(fixture);
    const evaluator = buildEvaluator(createNullLogger());
    const input = { resources: fixture.resources, history: fixture.history, now: new Date(fixture.now), config: DEFAULT_RULE_CONFIG };
    const first = evaluator.evaluate(input);
    const second = evaluator.evaluate(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});

describe('clean account', () => {
  it('finds nothing', () => {
    const report = runFixture('clean-account', createNullLogger());
    expect(report.findings).toEqual([]);
    expect(report.totalMonthlyUsd).toBe(0);
    expect(report.resourcesReceived).toBe(5);
    expect(report.resourcesEvaluated).toBe(5);
    expect(report.insufficientData).toEqual([]);
    expect(report.invalidResources).toEqual([]);
  });
});

describe('mixed account (edge cases)', () => {
  const report = runFixture('mixed-account', createNullLogger());

  it('has the expected headline numbers', () => {
    expect(report.resourcesReceived).toBe(22);
    expect(report.resourcesEvaluated).toBe(17);
    expect(report.resourcesIgnoredByTag).toBe(2);
    expect(report.invalidResources).toHaveLength(3);
    expect(report.findings).toHaveLength(5);
    expect(report.totalMonthlyUsd).toBe(9); // 8.00 (disk) + 1.00 (snapshot)
    expect(report.unestimatedFindings).toBe(3);
  });

  it('flags only what truly crosses a threshold', () => {
    expect(report.findings.map((f) => f.id)).toEqual([
      'unattached-disk:vol-boundary-14', // exactly 14 days, 100 GB gp3 = 8.00
      'old-snapshot:snap-91', // 91 days, 20 GB = 1.00
      'idle-server:i-unknown-type', // no price for t3.xlarge
      'unattached-disk:vol-eu', // no prices for eu-west-1
      'unattached-disk:vol-unknown-type', // no price for volume type "standard"
    ]);
  });

  it('keeps unpriced findings but does not count them in the total', () => {
    const unpriced = report.findings.filter((f) => !f.estimate.ok);
    expect(unpriced).toHaveLength(3);
    for (const finding of unpriced) {
      expect(finding.estimate.ok).toBe(false);
    }
  });

  it('does not judge servers or snapshots without enough data', () => {
    expect(report.insufficientData.map((s) => `${s.ruleId}:${s.resourceId}`).sort()).toEqual([
      'idle-server:i-nometrics',
      'idle-server:i-shortwindow',
      'old-snapshot:snap-invalid-date',
    ]);
  });

  it('skips resources tagged janitor:ignore=true, in any letter case', () => {
    const ids = report.findings.map((f) => f.resourceId);
    expect(ids).not.toContain('vol-ignored');
    expect(ids).not.toContain('eip-ignored');
    expect(report.resourcesIgnoredByTag).toBe(2);
  });

  it('skips malformed input with a reason instead of crashing', () => {
    expect(report.invalidResources).toEqual([
      { resourceId: 'broken-1', reason: 'missing region' },
      { resourceId: 'unknown', reason: 'not an object' },
      { resourceId: 'weird', reason: 'unknown type "toaster"' },
    ]);
  });

  it('adds up: received = evaluated + ignored + invalid', () => {
    expect(report.resourcesReceived).toBe(
      report.resourcesEvaluated + report.resourcesIgnoredByTag + report.invalidResources.length,
    );
  });
});

describe('thresholds are configurable', () => {
  it('a higher unattached-disk threshold removes the younger findings', () => {
    const fixture = loadFixture('wasteful-account');
    const report = buildEvaluator(createNullLogger()).evaluate({
      resources: fixture.resources,
      history: fixture.history,
      now: new Date(fixture.now),
      config: { ...DEFAULT_RULE_CONFIG, unattachedDiskDays: 50 },
    });
    // The 48 day and 24 day disks are no longer flagged: 178.41 - 40.00 - 20.00
    expect(report.findings).toHaveLength(6);
    expect(report.totalMonthlyUsd).toBe(118.41);
  });
});

describe('dependency injection', () => {
  it('uses the rules it is given', () => {
    const alwaysFlagIps: Rule = {
      id: 'test-rule',
      appliesTo: 'elastic_ip',
      evaluate: () => ({ kind: 'finding', ruleId: 'test-rule', reason: 'because', evidence: { x: 1 } }),
    };
    const evaluator = createEvaluator({ rules: [alwaysFlagIps], estimate: estimateMonthlyCost, logger: createNullLogger() });
    const report = evaluator.evaluate({
      resources: [makeIp({ associated: true }), makeVolume()],
      history: {},
      now: NOW,
      config: DEFAULT_RULE_CONFIG,
    });
    expect(report.findings.map((f) => f.id)).toEqual(['test-rule:eipalloc-test']);
  });

  it('uses the cost function it is given', () => {
    const evaluator = createEvaluator({
      rules: DEFAULT_RULES,
      estimate: () => ({ ok: true, monthlyUsd: 1.234, basis: 'fake' }),
      logger: createNullLogger(),
    });
    const report = evaluator.evaluate({ resources: [makeIp()], history: {}, now: NOW, config: DEFAULT_RULE_CONFIG });
    expect(report.totalMonthlyUsd).toBe(1.23);
  });

  it('reports nothing when given nothing', () => {
    const report = buildEvaluator(createNullLogger()).evaluate({
      resources: [],
      history: {},
      now: NOW,
      config: DEFAULT_RULE_CONFIG,
    });
    expect(report.findings).toEqual([]);
    expect(report.totalMonthlyUsd).toBe(0);
    expect(report.resourcesReceived).toBe(0);
  });
});

describe('evaluator logging', () => {
  it('logs a summary at INFO with the totals', () => {
    const { logger, records } = captureLogger();
    runFixture('wasteful-account', logger);
    const summary = records.find((r) => r.message === 'Evaluation complete');
    expect(summary?.level).toBe('INFO');
    expect(summary?.meta).toMatchObject({ findings: 8, totalMonthlyUsd: 178.41, resourcesEvaluated: 8 });
  });

  it('logs a WARN for each resource it could not judge, malformed input and unpriced finding', () => {
    const { logger, records } = captureLogger();
    runFixture('mixed-account', logger);
    const warnings = records.filter((r) => r.level === 'WARN').map((r) => r.message);
    expect(warnings.filter((m) => m === 'Not enough data to judge resource')).toHaveLength(3);
    expect(warnings.filter((m) => m === 'Skipping malformed resource')).toHaveLength(3);
    expect(warnings.filter((m) => m === 'Could not estimate cost')).toHaveLength(3);
  });

  it('logs ignored resources and created findings at DEBUG', () => {
    const { logger, records } = captureLogger();
    runFixture('mixed-account', logger);
    expect(records.filter((r) => r.message === 'Resource ignored by tag')).toHaveLength(2);
    expect(records.filter((r) => r.message === 'Finding created')).toHaveLength(5);
    expect(records.every((r) => r.level === 'DEBUG' || r.level === 'INFO' || r.level === 'WARN')).toBe(true);
  });

  it('hides DEBUG lines when the level is INFO', () => {
    const { logger, records } = captureLogger('INFO');
    runFixture('mixed-account', logger);
    expect(records.some((r) => r.level === 'DEBUG')).toBe(false);
  });
});
