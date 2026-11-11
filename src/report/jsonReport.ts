/** The machine-readable report. Stable field names, version-stamped, safe to parse in scripts. */

import { roundCents } from './format';
import { ReportInput } from './types';

export const JSON_REPORT_VERSION = 1;

export function renderJsonReport(input: ReportInput): string {
  const { evaluation, scan } = input;
  const report = {
    schemaVersion: JSON_REPORT_VERSION,
    generatedAt: input.generatedAt,
    complete: input.complete,
    historyEnabled: input.historyEnabled,
    scan: {
      accountIds: scan.accountIds,
      regionsRequested: scan.regionsRequested,
      regionsScanned: scan.regionsScanned,
      collectorsRun: scan.collectorsRun,
      resourcesCollected: scan.resourcesCollected,
      itemsSkippedByCollectors: scan.itemsSkippedByCollectors,
    },
    totals: {
      findings: evaluation.findings.length,
      monthlyUsd: roundCents(evaluation.totalMonthlyUsd),
      annualUsd: roundCents(evaluation.totalMonthlyUsd * 12),
      unestimatedFindings: evaluation.unestimatedFindings,
      resourcesEvaluated: evaluation.resourcesEvaluated,
      resourcesIgnoredByTag: evaluation.resourcesIgnoredByTag,
    },
    findings: evaluation.findings.map((finding) => ({
      id: finding.id,
      ruleId: finding.ruleId,
      resourceId: finding.resourceId,
      resourceType: finding.resourceType,
      region: finding.region,
      reason: finding.reason,
      evidence: finding.evidence,
      estimate: finding.estimate,
      detectedAt: finding.detectedAt,
    })),
    watching: input.watching,
    insufficientData: evaluation.insufficientData,
    invalidResources: evaluation.invalidResources,
    failures: scan.failures.map((failure) => ({
      region: failure.region,
      collector: failure.collector,
      kind: failure.kind,
      operation: failure.operation ?? null,
      attempts: failure.attempts ?? null,
      message: failure.message,
    })),
  };
  return JSON.stringify(report, null, 2);
}
