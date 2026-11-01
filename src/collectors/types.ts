import { Logger } from '../logging/logger';
import { Resource, ResourceType } from '../core/types';

/** Everything a collector needs to know about the run it belongs to. */
export interface CollectContext {
  region: string;
  accountId: string;
  /** The clock for this run. Injected so tests can simulate any date. */
  now: Date;
  /** Days of metrics a server needs before it can be judged idle. */
  idleWindowDays: number;
  logger: Logger;
}

/** Something a collector saw but could not use, with the reason. */
export interface SkippedItem {
  id: string;
  collector: string;
  reason: string;
}

export interface CollectResult {
  resources: Resource[];
  skipped: SkippedItem[];
}

export interface Collector {
  /** Short stable name used in logs and reports. */
  readonly name: string;
  readonly resourceType: ResourceType;
  /**
   * Reads the cloud and returns valid resources.
   * Throws CloudApiError when the cloud cannot be read at all.
   */
  collect(ctx: CollectContext): Promise<CollectResult>;
}
