import { daysInState } from '../history';
import { Resource, Rule, RuleContext, RuleOutcome } from '../types';

export const UNATTACHED_DISK_RULE_ID = 'unattached-disk';

/** AWS reports a volume that is not attached to anything as "available". */
const UNATTACHED_STATE = 'available';

/**
 * Flags a disk that has been unattached for at least the configured number of
 * days, measured from the Janitor's own observation history.
 *
 * Known limitation (Phase 1): history is trusted as given. If the Janitor stops
 * running for a long time, a disk could have been attached and detached in the
 * gap without being noticed. A later phase will add a freshness check.
 */
export const unattachedDiskRule: Rule = {
  id: UNATTACHED_DISK_RULE_ID,
  appliesTo: 'ebs_volume',

  evaluate(resource: Resource, ctx: RuleContext): RuleOutcome {
    if (resource.type !== 'ebs_volume') return { kind: 'no_finding' };
    if (resource.state !== UNATTACHED_STATE) return { kind: 'no_finding' };

    const days = daysInState(ctx.history[resource.id], UNATTACHED_STATE, ctx.now);
    if (days < ctx.config.unattachedDiskDays) return { kind: 'no_finding' };

    const wholeDays = Math.floor(days);
    return {
      kind: 'finding',
      ruleId: UNATTACHED_DISK_RULE_ID,
      reason: `Disk has not been attached to anything for ${wholeDays} days`,
      evidence: {
        daysUnattached: wholeDays,
        thresholdDays: ctx.config.unattachedDiskDays,
        sizeGb: resource.sizeGb,
        volumeType: resource.volumeType,
      },
    };
  },
};
