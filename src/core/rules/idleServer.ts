import { Resource, Rule, RuleContext, RuleOutcome } from '../types';

export const IDLE_SERVER_RULE_ID = 'idle-server';

/**
 * Flags a running server whose average CPU and network traffic have both been
 * low over the whole configured window.
 *
 * The rule never guesses: missing metrics, or metrics covering fewer days than
 * the window, give "insufficient_data" instead of a finding. Stopped servers
 * are not flagged (their disks are covered by the unattached-disk rule).
 */
export const idleServerRule: Rule = {
  id: IDLE_SERVER_RULE_ID,
  appliesTo: 'ec2_instance',

  evaluate(resource: Resource, ctx: RuleContext): RuleOutcome {
    if (resource.type !== 'ec2_instance') return { kind: 'no_finding' };
    if (resource.state !== 'running') return { kind: 'no_finding' };

    const { metrics } = resource;
    if (metrics === null) {
      return {
        kind: 'insufficient_data',
        ruleId: IDLE_SERVER_RULE_ID,
        reason: 'No CPU metrics available for this server',
      };
    }
    if (metrics.windowDays < ctx.config.idleWindowDays) {
      return {
        kind: 'insufficient_data',
        ruleId: IDLE_SERVER_RULE_ID,
        reason: `Metrics cover ${metrics.windowDays} days but ${ctx.config.idleWindowDays} are needed`,
      };
    }

    const cpuIsLow = metrics.avgCpuPercent < ctx.config.idleCpuPercent;
    const networkIsLow = metrics.avgNetworkBytesPerDay < ctx.config.idleNetworkBytesPerDay;
    if (!cpuIsLow || !networkIsLow) return { kind: 'no_finding' };

    return {
      kind: 'finding',
      ruleId: IDLE_SERVER_RULE_ID,
      reason: `Server averaged ${metrics.avgCpuPercent}% CPU over ${metrics.windowDays} days with very little network traffic`,
      evidence: {
        avgCpuPercent: metrics.avgCpuPercent,
        avgNetworkBytesPerDay: metrics.avgNetworkBytesPerDay,
        windowDays: metrics.windowDays,
        cpuThresholdPercent: ctx.config.idleCpuPercent,
        networkThresholdBytesPerDay: ctx.config.idleNetworkBytesPerDay,
        instanceType: resource.instanceType,
      },
    };
  },
};
