import { CostEstimate, Resource } from '../types';
import { DEFAULT_PRICE_TABLE, PriceTable } from './priceTable';

/** Rounds to whole cents so displayed amounts add up exactly. */
export function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function isValidSize(sizeGb: number): boolean {
  return Number.isFinite(sizeGb) && sizeGb >= 0;
}

/**
 * Estimates the monthly cost of leaving a resource as it is.
 *
 * If the price is unknown (new region, new volume type, new server type) the
 * result says so with ok:false. It never returns zero as a guess.
 */
export function estimateMonthlyCost(resource: Resource, table: PriceTable = DEFAULT_PRICE_TABLE): CostEstimate {
  const prices = table.regions[resource.region];
  if (!prices) {
    return { ok: false, reason: `No prices for region ${resource.region}` };
  }

  switch (resource.type) {
    case 'ebs_volume': {
      if (!isValidSize(resource.sizeGb)) {
        return { ok: false, reason: `Invalid disk size ${resource.sizeGb}` };
      }
      const perGb = prices.ebsVolumePerGbMonth[resource.volumeType];
      if (perGb === undefined) {
        return { ok: false, reason: `No price for volume type ${resource.volumeType} in ${resource.region}` };
      }
      return {
        ok: true,
        monthlyUsd: toCents(resource.sizeGb * perGb),
        basis: `${resource.sizeGb} GB x $${perGb}/GB-month (${resource.volumeType} storage only)`,
      };
    }

    case 'ec2_instance': {
      const perHour = prices.instancePerHour[resource.instanceType];
      if (perHour === undefined) {
        return { ok: false, reason: `No price for server type ${resource.instanceType} in ${resource.region}` };
      }
      return {
        ok: true,
        monthlyUsd: toCents(perHour * table.hoursPerMonth),
        basis: `$${perHour}/hour x ${table.hoursPerMonth} hours (${resource.instanceType} Linux on-demand, compute only)`,
      };
    }

    case 'ebs_snapshot': {
      if (!isValidSize(resource.sizeGb)) {
        return { ok: false, reason: `Invalid snapshot size ${resource.sizeGb}` };
      }
      return {
        ok: true,
        monthlyUsd: toCents(resource.sizeGb * prices.snapshotPerGbMonth),
        basis: `${resource.sizeGb} GB x $${prices.snapshotPerGbMonth}/GB-month (upper bound: AWS bills only changed data)`,
      };
    }

    case 'elastic_ip': {
      return {
        ok: true,
        monthlyUsd: toCents(prices.elasticIpPerHour * table.hoursPerMonth),
        basis: `$${prices.elasticIpPerHour}/hour x ${table.hoursPerMonth} hours`,
      };
    }
  }
}
