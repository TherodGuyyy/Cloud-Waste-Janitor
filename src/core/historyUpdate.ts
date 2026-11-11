/**
 * Adding today's sightings to the observation history.
 *
 * Pure function: nothing is read from disk and the input is never changed.
 *
 * Rules:
 *  - Only disks and servers have a state worth remembering.
 *  - Runs of identical states are collapsed to their first and latest sighting. The first one
 *    is what answers "since when?", the latest one proves the state still holds, so the file
 *    stays small however long the Janitor runs.
 *  - Resources that vanished are forgotten only when the scan was complete. After a partial
 *    scan a missing resource may simply have been unseen, so its history is kept.
 */

import { parseDate } from './history';
import { Observation, ObservationHistory, Resource } from './types';

/** Safety cap so a resource that flaps between states forever cannot grow without limit. */
export const MAX_OBSERVATIONS_PER_RESOURCE = 500;

export interface RecordOptions {
  /** True only after a complete scan: forget resources that no longer exist. */
  pruneMissing: boolean;
}

function stateOf(resource: Resource): string | null {
  if (resource.type === 'ebs_volume' || resource.type === 'ec2_instance') return resource.state;
  return null;
}

interface Dated {
  at: number;
  observation: Observation;
}

/** Sorts by time, drops entries with unreadable dates, drops exact repeats, collapses runs. */
function tidy(observations: readonly Observation[]): Observation[] {
  const dated: Dated[] = [];
  for (const observation of observations) {
    const date = parseDate(observation.observedAt);
    if (date !== null) dated.push({ at: date.getTime(), observation });
  }
  dated.sort((a, b) => a.at - b.at);

  const unique: Dated[] = [];
  for (const entry of dated) {
    const last = unique[unique.length - 1];
    if (last !== undefined && last.at === entry.at && last.observation.state === entry.observation.state) continue;
    unique.push(entry);
  }

  const kept: Observation[] = [];
  unique.forEach((entry, index) => {
    const before = unique[index - 1];
    const after = unique[index + 1];
    const startsRun = before === undefined || before.observation.state !== entry.observation.state;
    const endsRun = after === undefined || after.observation.state !== entry.observation.state;
    if (startsRun || endsRun) kept.push(entry.observation);
  });

  return kept.length > MAX_OBSERVATIONS_PER_RESOURCE ? kept.slice(kept.length - MAX_OBSERVATIONS_PER_RESOURCE) : kept;
}

export function recordObservations(
  history: ObservationHistory,
  resources: readonly Resource[],
  now: Date,
  options: RecordOptions,
): ObservationHistory {
  const observedAt = now.toISOString();
  const next: ObservationHistory = {};
  const currentIds = new Set<string>();

  for (const resource of resources) {
    currentIds.add(resource.id);
    const state = stateOf(resource);
    if (state === null) continue;
    next[resource.id] = tidy([...(history[resource.id] ?? []), { observedAt, state }]);
  }

  if (!options.pruneMissing) {
    for (const [id, observations] of Object.entries(history)) {
      if (!currentIds.has(id)) next[id] = tidy(observations);
    }
  }
  return next;
}
