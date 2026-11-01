/**
 * Ports: the small interfaces collectors use to read the cloud.
 *
 * Collectors know nothing about the AWS SDK. They talk to these interfaces, and
 * the AWS adapters (src/adapters/aws) implement them. In tests, tiny fakes
 * implement them instead, so no network is needed.
 *
 * Raw shapes mirror what the cloud says, with every field optional because
 * real cloud data can be incomplete. Collectors decide what is usable.
 */

export interface RawVolume {
  id?: string;
  state?: string;
  sizeGb?: number;
  volumeType?: string;
  tags: Record<string, string>;
}

export interface RawInstance {
  id?: string;
  state?: string;
  instanceType?: string;
  /** ISO 8601 */
  launchTime?: string;
  tags: Record<string, string>;
}

export interface RawSnapshot {
  id?: string;
  ownerId?: string;
  sizeGb?: number;
  /** ISO 8601 */
  startTime?: string;
  tags: Record<string, string>;
}

export interface RawAddress {
  allocationId?: string;
  publicIp?: string;
  associationId?: string;
  instanceId?: string;
  networkInterfaceId?: string;
  /** "amazon" for Amazon-provided addresses; anything else means the customer brought their own (BYOIP). */
  publicIpv4Pool?: string;
  tags: Record<string, string>;
}

export interface MetricPoint {
  /** ISO 8601 start of the day bucket. */
  at: string;
  value: number;
}

/** One value per day, per metric, as reported by CloudWatch. */
export interface MetricSeries {
  cpuDailyAverages: MetricPoint[];
  networkInDailySums: MetricPoint[];
  networkOutDailySums: MetricPoint[];
}

export interface InventoryPort {
  listVolumes(): Promise<RawVolume[]>;
  listInstances(): Promise<RawInstance[]>;
  /** Snapshots the adapter believes belong to this account. Collectors still double-check ownership. */
  listOwnedSnapshots(): Promise<RawSnapshot[]>;
  /** Ids of every snapshot referenced by a machine image (AMI) owned by this account. */
  listImageSnapshotIds(): Promise<string[]>;
  listAddresses(): Promise<RawAddress[]>;
}

export interface MetricsPort {
  /** Daily CPU and network figures for the `windowDays` days before `now`. */
  getInstanceMetricSeries(instanceId: string, windowDays: number, now: Date): Promise<MetricSeries>;
}
