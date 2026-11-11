/** What a report needs to know. Plain data: the report code never talks to AWS or the disk. */

import { CollectorFailure } from '../collectors/runner';
import { EvaluationReport } from '../core/types';

export type OutputFormat = 'text' | 'json';

export interface ScanSummary {
  regionsRequested: string[];
  regionsScanned: string[];
  accountIds: string[];
  collectorsRun: number;
  resourcesCollected: number;
  /** Items a collector saw but could not use (it says why in the logs). */
  itemsSkippedByCollectors: number;
  failures: CollectorFailure[];
}

/** A disk that is unattached but has not been so for long enough to be flagged yet. */
export interface WatchedDisk {
  resourceId: string;
  region: string;
  daysUnattached: number;
  thresholdDays: number;
}

export interface ReportInput {
  generatedAt: string;
  /** False when any region or collector failed: the report may be missing things. */
  complete: boolean;
  scan: ScanSummary;
  evaluation: EvaluationReport;
  watching: WatchedDisk[];
  /** False with --no-history: disks cannot be judged by age. */
  historyEnabled: boolean;
}
