import { daysInState, MS_PER_DAY, parseDate } from '../../src/core/history';
import { daysAgo, NOW } from '../builders';

describe('parseDate', () => {
  it('parses valid ISO dates', () => {
    expect(parseDate('2026-10-28T12:00:00.000Z')?.getTime()).toBe(NOW.getTime());
  });

  it('returns null for invalid dates', () => {
    expect(parseDate('not-a-date')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('daysInState', () => {
  it('is 0 with no history', () => {
    expect(daysInState(undefined, 'available', NOW)).toBe(0);
    expect(daysInState([], 'available', NOW)).toBe(0);
  });

  it('counts from the first sighting of an unbroken run', () => {
    const history = [
      { observedAt: daysAgo(20), state: 'available' },
      { observedAt: daysAgo(10), state: 'available' },
      { observedAt: daysAgo(1), state: 'available' },
    ];
    expect(daysInState(history, 'available', NOW)).toBe(20);
  });

  it('works with a single observation', () => {
    expect(daysInState([{ observedAt: daysAgo(5), state: 'available' }], 'available', NOW)).toBe(5);
  });

  it('supports fractional days', () => {
    const half = new Date(NOW.getTime() - 1.5 * MS_PER_DAY).toISOString();
    expect(daysInState([{ observedAt: half, state: 'available' }], 'available', NOW)).toBe(1.5);
  });

  it('restarts the count after the state changed in between', () => {
    const history = [
      { observedAt: daysAgo(30), state: 'available' },
      { observedAt: daysAgo(20), state: 'in-use' },
      { observedAt: daysAgo(3), state: 'available' },
    ];
    expect(daysInState(history, 'available', NOW)).toBe(3);
  });

  it('is 0 when the latest sighting is a different state', () => {
    const history = [
      { observedAt: daysAgo(30), state: 'available' },
      { observedAt: daysAgo(2), state: 'in-use' },
    ];
    expect(daysInState(history, 'available', NOW)).toBe(0);
  });

  it('does not depend on the order of the input', () => {
    const history = [
      { observedAt: daysAgo(1), state: 'available' },
      { observedAt: daysAgo(20), state: 'available' },
      { observedAt: daysAgo(10), state: 'available' },
    ];
    expect(daysInState(history, 'available', NOW)).toBe(20);
  });

  it('ignores observations with invalid dates', () => {
    const history = [
      { observedAt: 'garbage', state: 'in-use' },
      { observedAt: daysAgo(8), state: 'available' },
    ];
    expect(daysInState(history, 'available', NOW)).toBe(8);
  });

  it('ignores observations from the future', () => {
    const future = new Date(NOW.getTime() + MS_PER_DAY).toISOString();
    const history = [
      { observedAt: daysAgo(4), state: 'available' },
      { observedAt: future, state: 'in-use' },
    ];
    expect(daysInState(history, 'available', NOW)).toBe(4);
  });

  it('is 0 when every observation is unusable', () => {
    const future = new Date(NOW.getTime() + MS_PER_DAY).toISOString();
    expect(daysInState([{ observedAt: future, state: 'available' }], 'available', NOW)).toBe(0);
    expect(daysInState([{ observedAt: 'bad', state: 'available' }], 'available', NOW)).toBe(0);
  });
});
