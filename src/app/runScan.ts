/**
 * One scan from start to finish:
 *   load history -> collect from AWS -> record today's sightings -> judge -> save history -> render.
 *
 * Everything outside the program (AWS, the disk, the clock) is injected, so this is tested with
 * fakes. Nothing here prints: it returns the finished report text and an exit code.
 */

import { AccountCollection, CollectAccountOptions } from './collectAccount';
import { AppConfig } from '../config/config';
import { daysInState } from '../core/history';
import { recordObservations } from '../core/historyUpdate';
import { Evaluator } from '../core/evaluator';
import { isIgnoredByTag } from '../core/rules';
import { ObservationHistory } from '../core/types';
import { Logger } from '../logging/logger';
import { renderJsonReport } from '../report/jsonReport';
import { renderTextReport } from '../report/textReport';
import { OutputFormat, ReportInput, WatchedDisk } from '../report/types';
import { HistoryStore, HistoryStoreError } from '../storage/historyStore';

export const EXIT_OK = 0;
export const EXIT_UNEXPECTED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INCOMPLETE = 3;
export const EXIT_HISTORY = 4;

export interface ScanDeps {
  collect: (options: CollectAccountOptions) => Promise<AccountCollection>;
  evaluator: Evaluator;
  /** null means history is turned off. */
  historyStore: HistoryStore | null;
  logger: Logger;
  now: () => Date;
  /** Passed straight through to the collector (credentials, test clocks, fake clients). */
  collectExtras?: Pick<CollectAccountOptions, 'credentials' | 'sleep' | 'random' | 'createClients'>;
}

export interface ScanRequest {
  config: AppConfig;
  format: OutputFormat;
}

export interface ScanOutcome {
  exitCode: number;
  /** The finished report, or an empty string when the run stopped before scanning. */
  output: string;
  /** A plain-words explanation for the person when the run did not go fully well. */
  problem?: string;
}

function findWatchedDisks(
  collection: AccountCollection,
  history: ObservationHistory,
  thresholdDays: number,
  now: Date,
): WatchedDisk[] {
  const watched: WatchedDisk[] = [];
  for (const resource of collection.resources) {
    if (resource.type !== 'ebs_volume' || resource.state !== 'available' || isIgnoredByTag(resource)) continue;
    const days = Math.floor(daysInState(history[resource.id], 'available', now));
    if (days < thresholdDays) {
      watched.push({ resourceId: resource.id, region: resource.region, daysUnattached: days, thresholdDays });
    }
  }
  return watched.sort((a, b) => b.daysUnattached - a.daysUnattached || a.resourceId.localeCompare(b.resourceId));
}

export async function runScan(deps: ScanDeps, request: ScanRequest): Promise<ScanOutcome> {
  const { logger, historyStore } = deps;
  const { config } = request;

  // 1. Load history first: a damaged file must stop the run before any AWS call is made.
  let history: ObservationHistory = {};
  if (historyStore !== null) {
    try {
      history = await historyStore.load();
    } catch (error) {
      if (error instanceof HistoryStoreError) {
        logger.error('Cannot load the history file', { kind: error.kind, path: error.filePath, error });
        return { exitCode: EXIT_HISTORY, output: '', problem: error.message };
      }
      throw error;
    }
  }

  // 2. Collect.
  const now = deps.now();
  logger.info('Scan started', { regions: config.aws.regions });
  const collection = await deps.collect({ config, now, logger, ...deps.collectExtras });
  const complete = collection.failures.length === 0 && collection.regionsScanned.length === config.aws.regions.length;

  // 3. Remember what we saw. Forget vanished resources only after a complete scan.
  const updated = recordObservations(history, collection.resources, now, { pruneMissing: complete });

  // 4. Judge.
  const evaluation = deps.evaluator.evaluate({
    resources: collection.resources,
    history: updated,
    now,
    config: config.rules,
  });
  const watching = historyStore === null ? [] : findWatchedDisks(collection, updated, config.rules.unattachedDiskDays, now);

  // 5. Save history (the report is still worth printing if this fails).
  let exitCode = complete ? EXIT_OK : EXIT_INCOMPLETE;
  let problem: string | undefined = complete ? undefined : 'The scan was incomplete: see the problems listed in the report.';
  if (historyStore !== null) {
    try {
      await historyStore.save(updated);
    } catch (error) {
      if (!(error instanceof HistoryStoreError)) throw error;
      logger.error('Cannot save the history file', { kind: error.kind, path: error.filePath, error });
      exitCode = EXIT_HISTORY;
      problem = error.message;
    }
  }

  // 6. Render.
  const reportInput: ReportInput = {
    generatedAt: now.toISOString(),
    complete,
    scan: {
      regionsRequested: config.aws.regions,
      regionsScanned: collection.regionsScanned,
      accountIds: collection.accountIds,
      collectorsRun: collection.collectorsRun,
      resourcesCollected: collection.resources.length,
      itemsSkippedByCollectors: collection.skipped.length,
      failures: collection.failures,
    },
    evaluation,
    watching,
    historyEnabled: historyStore !== null,
  };
  const output = request.format === 'json' ? renderJsonReport(reportInput) : renderTextReport(reportInput);

  logger.info('Scan finished', {
    complete,
    findings: evaluation.findings.length,
    totalMonthlyUsd: evaluation.totalMonthlyUsd,
    failures: collection.failures.length,
    exitCode,
  });
  return problem === undefined ? { exitCode, output } : { exitCode, output, problem };
}
