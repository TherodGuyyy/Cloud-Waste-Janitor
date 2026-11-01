import { Resource } from '../core/types';
import { InventoryPort } from './ports';
import { CollectContext, CollectResult, Collector, SkippedItem } from './types';

export const SNAPSHOT_COLLECTOR_NAME = 'ebs-snapshots';

/**
 * Reads EBS snapshots (backups) owned by the scanned account.
 *
 * Two safety rules:
 *  1. Only snapshots whose owner is exactly this account are kept. We must never
 *     judge something we cannot act on, even if the cloud returns extra items.
 *  2. If the list of snapshots used by machine images cannot be read, the whole
 *     collector fails. Treating "unknown" as "unused" would wrongly flag backups
 *     that machine images depend on.
 */
export function createSnapshotCollector(inventory: InventoryPort): Collector {
  return {
    name: SNAPSHOT_COLLECTOR_NAME,
    resourceType: 'ebs_snapshot',

    async collect(ctx: CollectContext): Promise<CollectResult> {
      const [snapshots, imageSnapshotIds] = await Promise.all([
        inventory.listOwnedSnapshots(),
        inventory.listImageSnapshotIds(),
      ]);
      const usedByImage = new Set(imageSnapshotIds);

      const resources: Resource[] = [];
      const skipped: SkippedItem[] = [];
      let ownedByOthers = 0;
      const skip = (id: string, reason: string): void => {
        skipped.push({ id, collector: SNAPSHOT_COLLECTOR_NAME, reason });
      };

      for (const snapshot of snapshots) {
        if (snapshot.id === undefined || snapshot.id === '') {
          skip('unknown', 'snapshot has no id');
        } else if (snapshot.ownerId === undefined) {
          skip(snapshot.id, 'snapshot owner is unknown, so it is not judged');
        } else if (snapshot.ownerId !== ctx.accountId) {
          ownedByOthers += 1;
        } else if (snapshot.sizeGb === undefined || !Number.isFinite(snapshot.sizeGb)) {
          skip(snapshot.id, 'snapshot has no size');
        } else if (snapshot.startTime === undefined) {
          skip(snapshot.id, 'snapshot has no start time');
        } else {
          resources.push({
            id: snapshot.id,
            type: 'ebs_snapshot',
            region: ctx.region,
            accountId: ctx.accountId,
            tags: snapshot.tags,
            sizeGb: snapshot.sizeGb,
            startTime: snapshot.startTime,
            usedByImage: usedByImage.has(snapshot.id),
          });
        }
      }

      if (ownedByOthers > 0) {
        ctx.logger.warn('Ignored snapshots owned by other accounts', {
          collector: SNAPSHOT_COLLECTOR_NAME,
          count: ownedByOthers,
        });
      }
      ctx.logger.debug('Read snapshots', {
        collector: SNAPSHOT_COLLECTOR_NAME,
        read: snapshots.length,
        kept: resources.length,
        usedByImages: resources.filter((r) => r.type === 'ebs_snapshot' && r.usedByImage).length,
      });
      return { resources, skipped };
    },
  };
}
