import {
  canTransition,
  FindingEvent,
  FindingStatus,
  InvalidTransitionError,
  isTerminal,
  transition,
} from '../../src/core/stateMachine';

const STATUSES: FindingStatus[] = [
  'DETECTED',
  'NOTIFIED',
  'APPROVED',
  'SNOOZED',
  'IGNORED',
  'QUARANTINED',
  'RESTORED',
  'RESOLVED',
];

const EVENTS: FindingEvent[] = [
  'notify',
  'approve',
  'snooze',
  'ignore',
  'snooze_expired',
  'quarantine_done',
  'restore',
  'resolve',
];

/** The complete list of allowed moves, written independently of the implementation. */
const VALID: Array<[FindingStatus, FindingEvent, FindingStatus]> = [
  ['DETECTED', 'notify', 'NOTIFIED'],
  ['NOTIFIED', 'approve', 'APPROVED'],
  ['NOTIFIED', 'snooze', 'SNOOZED'],
  ['NOTIFIED', 'ignore', 'IGNORED'],
  ['SNOOZED', 'snooze_expired', 'NOTIFIED'],
  ['APPROVED', 'quarantine_done', 'QUARANTINED'],
  ['QUARANTINED', 'restore', 'RESTORED'],
  ['DETECTED', 'resolve', 'RESOLVED'],
  ['NOTIFIED', 'resolve', 'RESOLVED'],
  ['SNOOZED', 'resolve', 'RESOLVED'],
  ['APPROVED', 'resolve', 'RESOLVED'],
  ['QUARANTINED', 'resolve', 'RESOLVED'],
  ['IGNORED', 'resolve', 'RESOLVED'],
  ['RESTORED', 'resolve', 'RESOLVED'],
];

describe('valid transitions', () => {
  it.each(VALID)('%s + %s -> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
    expect(canTransition(from, event)).toBe(true);
  });
});

describe('invalid transitions', () => {
  const isValid = (from: FindingStatus, event: FindingEvent) => VALID.some(([f, e]) => f === from && e === event);
  const invalid: Array<[FindingStatus, FindingEvent]> = [];
  for (const status of STATUSES) {
    for (const event of EVENTS) {
      if (!isValid(status, event)) invalid.push([status, event]);
    }
  }

  it('covers every combination (8 statuses x 8 events = 64)', () => {
    expect(invalid.length + VALID.length).toBe(64);
  });

  it.each(invalid)('%s + %s is rejected', (from, event) => {
    expect(() => transition(from, event)).toThrow(InvalidTransitionError);
    expect(canTransition(from, event)).toBe(false);
  });

  it('the error says what went wrong', () => {
    try {
      transition('DETECTED', 'approve');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const typed = error as InvalidTransitionError;
      expect(typed.name).toBe('InvalidTransitionError');
      expect(typed.from).toBe('DETECTED');
      expect(typed.event).toBe('approve');
      expect(typed.message).toBe('Cannot apply "approve" to a finding in state DETECTED');
    }
  });
});

describe('safety properties of the life cycle', () => {
  it('nothing can be approved without first being notified', () => {
    expect(canTransition('DETECTED', 'approve')).toBe(false);
  });

  it('quarantine can only follow approval', () => {
    for (const status of STATUSES) {
      expect(canTransition(status, 'quarantine_done')).toBe(status === 'APPROVED');
    }
  });

  it('version 1 has no delete state or event', () => {
    expect(STATUSES).not.toContain('DELETED');
    expect(EVENTS).not.toContain('delete' as FindingEvent);
  });

  it('only RESOLVED is terminal', () => {
    for (const status of STATUSES) {
      expect(isTerminal(status)).toBe(status === 'RESOLVED');
    }
  });

  it('a snoozed finding returns to NOTIFIED so a person decides again', () => {
    expect(transition(transition('NOTIFIED', 'snooze'), 'snooze_expired')).toBe('NOTIFIED');
  });

  it('the full happy path works end to end', () => {
    let status: FindingStatus = 'DETECTED';
    status = transition(status, 'notify');
    status = transition(status, 'approve');
    status = transition(status, 'quarantine_done');
    status = transition(status, 'restore');
    expect(status).toBe('RESTORED');
  });
});
