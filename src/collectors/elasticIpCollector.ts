import { Resource } from '../core/types';
import { InventoryPort } from './ports';
import { CollectContext, CollectResult, Collector, SkippedItem } from './types';

export const ELASTIC_IP_COLLECTOR_NAME = 'elastic-ips';

/** The pool name AWS uses for addresses it provides (as opposed to ones a customer brought along). */
const AMAZON_POOL = 'amazon';

/**
 * Reads Elastic IP addresses.
 *
 * Addresses a customer brought to AWS themselves (BYOIP) are skipped with a
 * reason, because AWS does not charge for them and a cost estimate would be wrong.
 */
export function createElasticIpCollector(inventory: InventoryPort): Collector {
  return {
    name: ELASTIC_IP_COLLECTOR_NAME,
    resourceType: 'elastic_ip',

    async collect(ctx: CollectContext): Promise<CollectResult> {
      const raw = await inventory.listAddresses();
      const resources: Resource[] = [];
      const skipped: SkippedItem[] = [];

      for (const address of raw) {
        const id = address.allocationId ?? address.publicIp;
        if (id === undefined || id === '') {
          skipped.push({ id: 'unknown', collector: ELASTIC_IP_COLLECTOR_NAME, reason: 'address has no id' });
        } else if (address.publicIp === undefined || address.publicIp === '') {
          skipped.push({ id, collector: ELASTIC_IP_COLLECTOR_NAME, reason: 'address has no public IP' });
        } else if (address.publicIpv4Pool !== undefined && address.publicIpv4Pool !== AMAZON_POOL) {
          skipped.push({
            id,
            collector: ELASTIC_IP_COLLECTOR_NAME,
            reason: 'brought-your-own address (AWS does not charge for it)',
          });
        } else {
          resources.push({
            id,
            type: 'elastic_ip',
            region: ctx.region,
            accountId: ctx.accountId,
            tags: address.tags,
            publicIp: address.publicIp,
            associated: Boolean(address.associationId || address.instanceId || address.networkInterfaceId),
          });
        }
      }

      ctx.logger.debug('Read addresses', {
        collector: ELASTIC_IP_COLLECTOR_NAME,
        read: raw.length,
        kept: resources.length,
      });
      return { resources, skipped };
    },
  };
}
