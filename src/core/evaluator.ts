/**
 * The evaluator: the first slice of the "Findings service".
 *
 * It takes resources plus observation history, applies every rule, attaches a
 * cost estimate and returns a report. It is pure business logic: no cloud, no
 * database, no HTTP. Rules, the cost function and the logger are injected, so
 * each can be replaced in tests.
 */

import { toCents } from './cost/estimator';
import { isIgnoredByTag } from './rules';
import { describeId, validateResource } from './validate';
import {
  CostEstimate,
  EvaluationReport,
  Finding,
  InvalidResource,
  ObservationHistory,
  Resource,
  Rule,
  RuleConfig,
  SkippedResource,
} from './types';
import { Logger } from '../logging/logger';

export interface EvaluatorDeps {
  rules: readonly Rule[];
  estimate: (resource: Resource) => CostEstimate;
  logger: Logger;
}

export interface EvaluationInput {
  /** Untyped on purpose: this is the boundary where outside data is validated. */
  resources: readonly unknown[];
  history: ObservationHistory;
  now: Date;
  config: RuleConfig;
}

export interface Evaluator {
  evaluate(input: EvaluationInput): EvaluationReport;
}

function sortFindings(findings: Finding[]): void {
  findings.sort((a, b) => {
    const costA = a.estimate.ok ? a.estimate.monthlyUsd : -1;
    const costB = b.estimate.ok ? b.estimate.monthlyUsd : -1;
    if (costA !== costB) return costB - costA; // most expensive first
    return a.id.localeCompare(b.id);
  });
}

export function createEvaluator(deps: EvaluatorDeps): Evaluator {
  const { rules, estimate, logger } = deps;

  return {
    evaluate(input: EvaluationInput): EvaluationReport {
      const findings: Finding[] = [];
      const insufficientData: SkippedResource[] = [];
      const invalidResources: InvalidResource[] = [];
      let evaluated = 0;
      let ignored = 0;
      const detectedAt = input.now.toISOString();

      for (const raw of input.resources) {
        const problem = validateResource(raw);
        if (problem !== null) {
          const resourceId = describeId(raw);
          invalidResources.push({ resourceId, reason: problem });
          logger.warn('Skipping malformed resource', { resourceId, reason: problem });
          continue;
        }
        const resource = raw as Resource;

        if (isIgnoredByTag(resource)) {
          ignored += 1;
          logger.debug('Resource ignored by tag', { resourceId: resource.id, type: resource.type });
          continue;
        }

        evaluated += 1;
        const ctx = { now: input.now, config: input.config, history: input.history };

        for (const rule of rules) {
          if (rule.appliesTo !== resource.type) continue;

          const outcome = rule.evaluate(resource, ctx);
          if (outcome.kind === 'no_finding') continue;

          if (outcome.kind === 'insufficient_data') {
            insufficientData.push({ resourceId: resource.id, ruleId: outcome.ruleId, reason: outcome.reason });
            logger.warn('Not enough data to judge resource', {
              resourceId: resource.id,
              ruleId: outcome.ruleId,
              reason: outcome.reason,
            });
            continue;
          }

          const cost = estimate(resource);
          if (!cost.ok) {
            logger.warn('Could not estimate cost', {
              resourceId: resource.id,
              ruleId: outcome.ruleId,
              reason: cost.reason,
            });
          }
          const finding: Finding = {
            id: `${outcome.ruleId}:${resource.id}`,
            ruleId: outcome.ruleId,
            resourceId: resource.id,
            resourceType: resource.type,
            region: resource.region,
            reason: outcome.reason,
            evidence: outcome.evidence,
            estimate: cost,
            detectedAt,
          };
          findings.push(finding);
          logger.debug('Finding created', { findingId: finding.id });
        }
      }

      sortFindings(findings);

      let total = 0;
      let unestimated = 0;
      for (const finding of findings) {
        if (finding.estimate.ok) {
          total += finding.estimate.monthlyUsd;
        } else {
          unestimated += 1;
        }
      }

      const report: EvaluationReport = {
        generatedAt: detectedAt,
        resourcesReceived: input.resources.length,
        resourcesEvaluated: evaluated,
        resourcesIgnoredByTag: ignored,
        invalidResources,
        findings,
        insufficientData,
        totalMonthlyUsd: toCents(total),
        unestimatedFindings: unestimated,
      };

      logger.info('Evaluation complete', {
        resourcesReceived: report.resourcesReceived,
        resourcesEvaluated: report.resourcesEvaluated,
        findings: findings.length,
        totalMonthlyUsd: report.totalMonthlyUsd,
        unestimatedFindings: unestimated,
        insufficientData: insufficientData.length,
        invalidResources: invalidResources.length,
      });

      return report;
    },
  };
}
