/**
 * The runner: runs every collector for one region and never lets one failure
 * stop the rest.
 *
 * What it guarantees:
 *  - Every collector is attempted, one after another.
 *  - A collector that fails is recorded as a failure (with kind, operation and
 *    attempts) and logged at ERROR. Other collectors still run.
 *  - Output is re-checked: only valid resources of the collector's own type,
 *    region and account, with no repeated ids, are passed on. The rest go to
 *    "skipped" with a reason, so one buggy collector cannot poison the rules.
 *
 * The caller decides what to do about failures. A run with failures is
 * INCOMPLETE and must never be presented as "nothing found".
 */

import { Resource } from '../core/types';
import { validateResource } from '../core/validate';
import { CloudApiError, CloudErrorKind } from './errors';
import { CollectContext, Collector, SkippedItem } from './types';

export interface CollectorFailure {
  region: string;
  collector: string;
  /** "unexpected" means a bug in our own code rather than a cloud problem. */
  kind: CloudErrorKind | 'unexpected';
  message: string;
  operation?: string;
  attempts?: number;
}

export interface CollectionResult {
  resources: Resource[];
  skipped: SkippedItem[];
  failures: CollectorFailure[];
  collectorsRun: number;
}

function filterOutput(
  collector: Collector,
  resources: readonly unknown[],
  ctx: CollectContext,
  seen: Set<string>,
): { kept: Resource[]; skipped: SkippedItem[] } {
  const kept: Resource[] = [];
  const skipped: SkippedItem[] = [];

  for (const candidate of resources) {
    const problem = validateResource(candidate);
    const resource = candidate as Resource;
    const id = problem === null ? resource.id : 'unknown';
    let reason: string | null = problem;

    if (reason === null && resource.type !== collector.resourceType) {
      reason = `wrong type "${resource.type}" from a ${collector.resourceType} collector`;
    } else if (reason === null && resource.region !== ctx.region) {
      reason = `wrong region "${resource.region}" (scanning ${ctx.region})`;
    } else if (reason === null && resource.accountId !== ctx.accountId) {
      reason = `wrong account "${resource.accountId}" (scanning ${ctx.accountId})`;
    } else if (reason === null && seen.has(`${resource.type}:${resource.id}`)) {
      reason = 'duplicate id';
    }

    if (reason !== null) {
      skipped.push({ id, collector: collector.name, reason: `rejected by runner: ${reason}` });
    } else {
      seen.add(`${resource.type}:${resource.id}`);
      kept.push(resource);
    }
  }
  return { kept, skipped };
}

export async function runCollectors(collectors: readonly Collector[], ctx: CollectContext): Promise<CollectionResult> {
  const resources: Resource[] = [];
  const skipped: SkippedItem[] = [];
  const failures: CollectorFailure[] = [];
  const seen = new Set<string>();

  for (const collector of collectors) {
    const log = ctx.logger.child({ collector: collector.name, region: ctx.region });
    log.info('Collector started');
    try {
      const output = await collector.collect({ ...ctx, logger: log });
      const checked = filterOutput(collector, output.resources, ctx, seen);
      resources.push(...checked.kept);
      skipped.push(...output.skipped, ...checked.skipped);
      log.info('Collector finished', {
        resources: checked.kept.length,
        skipped: output.skipped.length + checked.skipped.length,
      });
    } catch (error) {
      if (error instanceof CloudApiError) {
        failures.push({
          region: ctx.region,
          collector: collector.name,
          kind: error.kind,
          message: error.message,
          operation: error.operation,
          attempts: error.attempts,
        });
        log.error('Collector failed', { kind: error.kind, operation: error.operation, attempts: error.attempts, error });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ region: ctx.region, collector: collector.name, kind: 'unexpected', message });
        log.error('Collector crashed unexpectedly', { error });
      }
    }
  }

  return { resources, skipped, failures, collectorsRun: collectors.length };
}
