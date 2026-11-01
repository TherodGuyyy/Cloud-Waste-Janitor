import { Resource } from '../core/types';
import { CollectContext, CollectResult, Collector, SkippedItem } from './types';
import { InventoryPort } from './ports';

export const VOLUME_COLLECTOR_NAME = 'ebs-volumes';

/** Reads EBS disks. Anything missing a field the rules need is skipped with a reason. */
export function createVolumeCollector(inventory: InventoryPort): Collector {
  return {
    name: VOLUME_COLLECTOR_NAME,
    resourceType: 'ebs_volume',

    async collect(ctx: CollectContext): Promise<CollectResult> {
      const raw = await inventory.listVolumes();
      const resources: Resource[] = [];
      const skipped: SkippedItem[] = [];
      const skip = (id: string, reason: string): void => {
        skipped.push({ id, collector: VOLUME_COLLECTOR_NAME, reason });
      };

      for (const volume of raw) {
        if (volume.id === undefined || volume.id === '') {
          skip('unknown', 'disk has no id');
        } else if (volume.state === undefined) {
          skip(volume.id, 'disk has no state');
        } else if (volume.sizeGb === undefined || !Number.isFinite(volume.sizeGb)) {
          skip(volume.id, 'disk has no size');
        } else if (volume.volumeType === undefined || volume.volumeType === '') {
          skip(volume.id, 'disk has no volume type');
        } else {
          resources.push({
            id: volume.id,
            type: 'ebs_volume',
            region: ctx.region,
            accountId: ctx.accountId,
            tags: volume.tags,
            state: volume.state,
            sizeGb: volume.sizeGb,
            volumeType: volume.volumeType,
          });
        }
      }

      ctx.logger.debug('Read disks', { collector: VOLUME_COLLECTOR_NAME, read: raw.length, kept: resources.length });
      return { resources, skipped };
    },
  };
}
