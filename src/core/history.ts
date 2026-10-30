/**
 * Observation history helpers.
 *
 * AWS does not say how long a disk has been unattached, so the Janitor records
 * what it sees on every run. These pure functions answer questions such as
 * "how many days has this resource been in its current state?".
 */

import { Observation } from './types';

export const MS_PER_DAY = 86_400_000;

/** Parses an ISO date. Returns null for anything that is not a valid date. */
export function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Returns how many days the resource has been continuously in `currentState`,
 * counted from the first observation of the latest unbroken run of that state
 * up to `now`.
 *
 * Returns 0 when there is no usable history, when the latest observation is in
 * a different state, or when the newest observation is in the future.
 * Observations with invalid dates are ignored.
 */
export function daysInState(observations: Observation[] | undefined, currentState: string, now: Date): number {
  if (!observations || observations.length === 0) return 0;

  const dated = observations
    .map((o) => ({ at: parseDate(o.observedAt), state: o.state }))
    .filter((o): o is { at: Date; state: string } => o.at !== null && o.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const latest = dated[dated.length - 1];
  if (!latest || latest.state !== currentState) return 0;

  let runStart = latest.at;
  for (let i = dated.length - 1; i >= 0; i--) {
    const entry = dated[i];
    if (!entry || entry.state !== currentState) break;
    runStart = entry.at;
  }
  return (now.getTime() - runStart.getTime()) / MS_PER_DAY;
}
