import { InstanceMetrics, Resource } from '../core/types';
import { CloudApiError, SETUP_ERROR_KINDS } from './errors';
import { computeInstanceMetrics, mapWithConcurrency } from './helpers';
import { InventoryPort, MetricsPort, RawInstance } from './ports';
import { CollectContext, CollectResult, Collector, SkippedItem } from './types';

export const INSTANCE_COLLECTOR_NAME = 'ec2-instances';
export const DEFAULT_METRICS_CONCURRENCY = 5;

/**
 * Reads EC2 servers. For servers that are running it also reads CloudWatch
 * metrics. Metrics are only fetched for running servers because only those can
 * be judged idle.
 *
 * If metrics cannot be read for one server (for example the cloud was too busy
 * after all retries) that server gets `metrics: null` and a warning is logged,
 * so the rules report "insufficient data" for it. But if the problem is
 * permissions or credentials, the whole collector fails loudly: otherwise a
 * missing permission would look exactly like "nothing is idle".
 */
export function createInstanceCollector(
  inventory: InventoryPort,
  metricsPort: MetricsPort,
  concurrency: number = DEFAULT_METRICS_CONCURRENCY,
): Collector {
  async function readMetrics(instance: RawInstance & { id: string }, ctx: CollectContext): Promise<InstanceMetrics | null> {
    try {
      const series = await metricsPort.getInstanceMetricSeries(instance.id, ctx.idleWindowDays, ctx.now);
      const metrics = computeInstanceMetrics(series, instance.launchTime, ctx.idleWindowDays, ctx.now);
      if (metrics === null) {
        ctx.logger.warn('Not enough metric data to judge server', { collector: INSTANCE_COLLECTOR_NAME, instanceId: instance.id });
      }
      return metrics;
    } catch (error) {
      if (error instanceof CloudApiError && !SETUP_ERROR_KINDS.has(error.kind)) {
        ctx.logger.warn('Could not read metrics for server', {
          collector: INSTANCE_COLLECTOR_NAME,
          instanceId: instance.id,
          kind: error.kind,
          operation: error.operation,
          attempts: error.attempts,
        });
        return null;
      }
      throw error;
    }
  }

  return {
    name: INSTANCE_COLLECTOR_NAME,
    resourceType: 'ec2_instance',

    async collect(ctx: CollectContext): Promise<CollectResult> {
      const raw = await inventory.listInstances();
      const skipped: SkippedItem[] = [];
      const usable: Array<RawInstance & { id: string; state: string; instanceType: string }> = [];

      for (const instance of raw) {
        const skip = (id: string, reason: string): void => {
          skipped.push({ id, collector: INSTANCE_COLLECTOR_NAME, reason });
        };
        if (instance.id === undefined || instance.id === '') {
          skip('unknown', 'server has no id');
        } else if (instance.state === undefined) {
          skip(instance.id, 'server has no state');
        } else if (instance.instanceType === undefined || instance.instanceType === '') {
          skip(instance.id, 'server has no instance type');
        } else {
          usable.push({ ...instance, id: instance.id, state: instance.state, instanceType: instance.instanceType });
        }
      }

      const metrics = await mapWithConcurrency(usable, concurrency, (instance) =>
        instance.state === 'running' ? readMetrics(instance, ctx) : Promise.resolve(null),
      );

      const resources: Resource[] = usable.map((instance, index) => ({
        id: instance.id,
        type: 'ec2_instance',
        region: ctx.region,
        accountId: ctx.accountId,
        tags: instance.tags,
        state: instance.state,
        instanceType: instance.instanceType,
        metrics: metrics[index] ?? null,
      }));

      ctx.logger.debug('Read servers', { collector: INSTANCE_COLLECTOR_NAME, read: raw.length, kept: resources.length });
      return { resources, skipped };
    },
  };
}
