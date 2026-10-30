/**
 * AWS price table (list prices, USD).
 *
 * IMPORTANT: these are estimates for showing roughly how much a forgotten
 * resource costs. Prices change, so the table carries a date stamp, and every
 * number shown to a user must be labelled an estimate.
 *
 * Verified on 2026-10-29 against public AWS price listings for us-east-1:
 *   - EBS storage and snapshot rates (storage only: extra IOPS/throughput not included)
 *   - Public IPv4 / idle Elastic IP: $0.005 per hour (in effect since 1 Feb 2024)
 *   - EC2 Linux on-demand hourly rates for a few common instance types
 *
 * To add a region or instance type, add it here and update the tests.
 */

export interface RegionPrices {
  /** Price per GB-month by EBS volume type (storage only). */
  ebsVolumePerGbMonth: Record<string, number>;
  /** Standard-tier snapshot price per GB-month. */
  snapshotPerGbMonth: number;
  /** Price per hour for an idle (unattached) Elastic IP address. */
  elasticIpPerHour: number;
  /** Linux on-demand price per hour by instance type. */
  instancePerHour: Record<string, number>;
}

export interface PriceTable {
  version: string;
  /** Date the numbers were last checked, YYYY-MM-DD. */
  retrievedOn: string;
  currency: 'USD';
  /** AWS convention for turning hourly prices into monthly ones. */
  hoursPerMonth: number;
  regions: Record<string, RegionPrices>;
}

export const DEFAULT_PRICE_TABLE: PriceTable = {
  version: '2026-10-29',
  retrievedOn: '2026-10-29',
  currency: 'USD',
  hoursPerMonth: 730,
  regions: {
    'us-east-1': {
      ebsVolumePerGbMonth: {
        gp3: 0.08,
        gp2: 0.1,
        io1: 0.125,
        io2: 0.125,
        st1: 0.045,
        sc1: 0.015,
      },
      snapshotPerGbMonth: 0.05,
      elasticIpPerHour: 0.005,
      instancePerHour: {
        't3.nano': 0.0052,
        't3.micro': 0.0104,
        't3.small': 0.0208,
        't3.medium': 0.0416,
        't3.large': 0.0832,
        'm5.large': 0.096,
      },
    },
  },
};
