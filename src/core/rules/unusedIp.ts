import { Resource, Rule, RuleOutcome } from '../types';

export const UNUSED_IP_RULE_ID = 'unused-ip';

/** Flags an Elastic IP address that is not attached to anything. */
export const unusedIpRule: Rule = {
  id: UNUSED_IP_RULE_ID,
  appliesTo: 'elastic_ip',

  evaluate(resource: Resource): RuleOutcome {
    if (resource.type !== 'elastic_ip') return { kind: 'no_finding' };
    if (resource.associated) return { kind: 'no_finding' };

    return {
      kind: 'finding',
      ruleId: UNUSED_IP_RULE_ID,
      reason: 'Elastic IP address is not attached to anything',
      evidence: { publicIp: resource.publicIp },
    };
  },
};
