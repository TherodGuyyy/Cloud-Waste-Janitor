/**
 * Finding life cycle.
 *
 *   DETECTED -> NOTIFIED -> APPROVED -> QUARANTINED -> RESTORED
 *                        -> SNOOZED  -> NOTIFIED (when the snooze ends)
 *                        -> IGNORED
 *   Any state except RESOLVED -> RESOLVED (resource vanished or became used)
 *
 * Version 1 has no DELETED state on purpose: nothing is ever deleted.
 * Any move that is not listed is rejected with InvalidTransitionError.
 */

export type FindingStatus =
  | 'DETECTED'
  | 'NOTIFIED'
  | 'APPROVED'
  | 'SNOOZED'
  | 'IGNORED'
  | 'QUARANTINED'
  | 'RESTORED'
  | 'RESOLVED';

export type FindingEvent =
  | 'notify'
  | 'approve'
  | 'snooze'
  | 'ignore'
  | 'snooze_expired'
  | 'quarantine_done'
  | 'restore'
  | 'resolve';

type TransitionTable = Record<FindingStatus, Partial<Record<FindingEvent, FindingStatus>>>;

const TRANSITIONS: TransitionTable = {
  DETECTED: { notify: 'NOTIFIED', resolve: 'RESOLVED' },
  NOTIFIED: { approve: 'APPROVED', snooze: 'SNOOZED', ignore: 'IGNORED', resolve: 'RESOLVED' },
  SNOOZED: { snooze_expired: 'NOTIFIED', resolve: 'RESOLVED' },
  APPROVED: { quarantine_done: 'QUARANTINED', resolve: 'RESOLVED' },
  QUARANTINED: { restore: 'RESTORED', resolve: 'RESOLVED' },
  IGNORED: { resolve: 'RESOLVED' },
  RESTORED: { resolve: 'RESOLVED' },
  RESOLVED: {},
};

export class InvalidTransitionError extends Error {
  readonly from: FindingStatus;
  readonly event: FindingEvent;

  constructor(from: FindingStatus, event: FindingEvent) {
    super(`Cannot apply "${event}" to a finding in state ${from}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.event = event;
  }
}

/** Returns the new status, or throws InvalidTransitionError. */
export function transition(from: FindingStatus, event: FindingEvent): FindingStatus {
  const next = TRANSITIONS[from][event];
  if (next === undefined) {
    throw new InvalidTransitionError(from, event);
  }
  return next;
}

export function canTransition(from: FindingStatus, event: FindingEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function isTerminal(status: FindingStatus): boolean {
  return Object.keys(TRANSITIONS[status]).length === 0;
}
