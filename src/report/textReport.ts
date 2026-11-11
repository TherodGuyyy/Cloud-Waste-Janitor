/** The human-readable report. Plain text, no colours, so it reads the same in any terminal or file. */

import { adviceFor } from './advice';
import { formatUsd, plural, roundCents } from './format';
import { ReportInput } from './types';

const RULE_NAMES: Record<string, string> = {
  'unattached-disk': 'Unattached disk',
  'idle-server': 'Idle server',
  'old-snapshot': 'Old snapshot',
  'unused-ip': 'Unused IP address',
};

const RESOURCE_NAMES: Record<string, string> = {
  ebs_volume: 'disk',
  ec2_instance: 'server',
  ebs_snapshot: 'snapshot',
  elastic_ip: 'IP address',
};

function ruleName(ruleId: string): string {
  return RULE_NAMES[ruleId] ?? ruleId;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

export function renderTextReport(input: ReportInput): string {
  const { evaluation, scan } = input;
  const lines: string[] = [];
  const add = (text = ''): void => {
    lines.push(text);
  };

  add('CLOUD WASTE JANITOR REPORT');
  add('==========================');
  add(`Generated:  ${input.generatedAt}`);
  add(`Account:    ${listOrNone(scan.accountIds)}`);
  add(`Regions:    ${listOrNone(scan.regionsScanned)} (${scan.regionsScanned.length} of ${scan.regionsRequested.length} scanned)`);
  add(`Checked:    ${plural(evaluation.resourcesEvaluated, 'resource')}`);
  if (evaluation.resourcesIgnoredByTag > 0) {
    add(`Ignored:    ${plural(evaluation.resourcesIgnoredByTag, 'resource')} tagged janitor:ignore=true`);
  }

  if (!input.complete) {
    add();
    add('!! THIS SCAN IS INCOMPLETE !!');
    add(`   ${plural(scan.failures.length, 'problem')} stopped part of the scan (details at the end).`);
    add('   Do not read an empty or small list below as "all clear".');
  }

  add();
  add('POTENTIAL SAVINGS');
  const annual = roundCents(evaluation.totalMonthlyUsd * 12);
  add(`  ${formatUsd(evaluation.totalMonthlyUsd)} per month  (about ${formatUsd(annual)} per year)`);
  if (evaluation.unestimatedFindings > 0) {
    add(`  Plus ${plural(evaluation.unestimatedFindings, 'finding')} that could not be priced (not in the total).`);
  }

  add();
  add(`FINDINGS (${evaluation.findings.length})`);
  if (evaluation.findings.length === 0) {
    add(
      input.complete
        ? '  No wasteful resources found.'
        : '  Nothing found in the parts that could be scanned. See the problems below.',
    );
  }
  evaluation.findings.forEach((finding, index) => {
    const cost = finding.estimate.ok ? `${formatUsd(finding.estimate.monthlyUsd)}/month` : 'cost unknown';
    const kind = RESOURCE_NAMES[finding.resourceType] ?? finding.resourceType;
    add();
    add(`${index + 1}. ${cost}  ${ruleName(finding.ruleId)}: ${finding.resourceId} (${kind}, ${finding.region})`);
    add(`   Why:  ${finding.reason}`);
    add(finding.estimate.ok ? `   Cost: ${finding.estimate.basis}` : `   Cost: could not be estimated (${finding.estimate.reason})`);
  });

  if (input.watching.length > 0) {
    add();
    add(`DISKS BEING WATCHED (${input.watching.length})`);
    add('  Unattached, but not for long enough to be flagged yet:');
    for (const disk of input.watching) {
      add(`  - ${disk.resourceId} (${disk.region}): unattached for ${disk.daysUnattached} of ${disk.thresholdDays} days`);
    }
  }

  if (!input.historyEnabled) {
    add();
    add('NOTE: history is turned off (--no-history), so unattached disks cannot be judged by age and are not flagged.');
  }

  if (evaluation.insufficientData.length > 0) {
    add();
    add(`NOT ENOUGH DATA TO JUDGE (${evaluation.insufficientData.length})`);
    for (const item of evaluation.insufficientData) {
      add(`  - ${item.resourceId} (${ruleName(item.ruleId)}): ${item.reason}`);
    }
  }

  if (evaluation.invalidResources.length > 0) {
    add();
    add(`SKIPPED AS MALFORMED (${evaluation.invalidResources.length})`);
    for (const item of evaluation.invalidResources) {
      add(`  - ${item.resourceId}: ${item.reason}`);
    }
  }

  if (scan.failures.length > 0) {
    add();
    add(`SCAN PROBLEMS (${scan.failures.length})`);
    for (const failure of scan.failures) {
      add(`  - ${failure.region} / ${failure.collector}: ${failure.kind}${failure.operation ? ` during ${failure.operation}` : ''}`);
      add(`    ${adviceFor(failure.kind)}`);
    }
  }

  add();
  add('Prices are estimates from a list-price table. Nothing in your account was changed: the Janitor only reads.');
  return lines.join('\n');
}
