import { MS_PER_DAY, parseDate } from '../history';
import { Resource, Rule, RuleContext, RuleOutcome } from '../types';

export const OLD_SNAPSHOT_RULE_ID = 'old-snapshot';

/**
 * Flags a snapshot that is at least the configured age and is not referenced by
 * any machine image. A snapshot still used by an image is never flagged.
 */
export const oldSnapshotRule: Rule = {
  id: OLD_SNAPSHOT_RULE_ID,
  appliesTo: 'ebs_snapshot',

  evaluate(resource: Resource, ctx: RuleContext): RuleOutcome {
    if (resource.type !== 'ebs_snapshot') return { kind: 'no_finding' };
    if (resource.usedByImage) return { kind: 'no_finding' };

    const started = parseDate(resource.startTime);
    if (started === null) {
      return {
        kind: 'insufficient_data',
        ruleId: OLD_SNAPSHOT_RULE_ID,
        reason: `Snapshot start time is not a valid date ("${resource.startTime}")`,
      };
    }

    const ageDays = (ctx.now.getTime() - started.getTime()) / MS_PER_DAY;
    if (ageDays < ctx.config.snapshotMaxAgeDays) return { kind: 'no_finding' };

    const wholeDays = Math.floor(ageDays);
    return {
      kind: 'finding',
      ruleId: OLD_SNAPSHOT_RULE_ID,
      reason: `Snapshot is ${wholeDays} days old and not used by any image`,
      evidence: {
        ageDays: wholeDays,
        thresholdDays: ctx.config.snapshotMaxAgeDays,
        sizeGb: resource.sizeGb,
      },
    };
  },
};
