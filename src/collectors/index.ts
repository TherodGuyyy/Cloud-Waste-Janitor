import { createElasticIpCollector } from './elasticIpCollector';
import { createInstanceCollector } from './instanceCollector';
import { InventoryPort, MetricsPort } from './ports';
import { createSnapshotCollector } from './snapshotCollector';
import { Collector } from './types';
import { createVolumeCollector } from './volumeCollector';

export * from './types';
export * from './ports';
export * from './errors';
export * from './runner';
export { createVolumeCollector } from './volumeCollector';
export { createInstanceCollector } from './instanceCollector';
export { createSnapshotCollector } from './snapshotCollector';
export { createElasticIpCollector } from './elasticIpCollector';
export { computeInstanceMetrics, mapWithConcurrency } from './helpers';

/** The four starter collectors, in the order they run. */
export function createDefaultCollectors(inventory: InventoryPort, metrics: MetricsPort): Collector[] {
  return [
    createVolumeCollector(inventory),
    createInstanceCollector(inventory, metrics),
    createSnapshotCollector(inventory),
    createElasticIpCollector(inventory),
  ];
}
