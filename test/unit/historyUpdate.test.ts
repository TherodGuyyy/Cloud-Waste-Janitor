import { MS_PER_DAY } from '../../src/core/history';
import { MAX_OBSERVATIONS_PER_RESOURCE, recordObservations } from '../../src/core/historyUpdate';
import { ObservationHistory } from '../../src/core/types';
import { daysAgo, makeInstance, makeIp, makeSnapshot, makeVolume, NOW } from '../builders';
import { deepFreeze } from '../collectorFakes';

const KEEP = { pruneMissing: false };
const PRUNE = { pruneMissing: true };

describe('recordObservations: adding a sighting', () => {
  it('starts a history for a disk seen for the first time', () => {
    const result = recordObservations({}, [makeVolume({ id: 'vol-1' })], NOW, PRUNE);
    expect(result).toEqual({ 'vol-1': [{ observedAt: NOW.toISOString(), state: 'available' }] });
  });

  it('remembers servers too', () => {
    const result = recordObservations({}, [makeInstance({ id: 'i-1' })], NOW, PRUNE);
    expect(result['i-1']).toEqual([{ observedAt: NOW.toISOString(), state: 'running' }]);
  });

  it('does not record snapshots or IP addresses, which have no state to remember', () => {
    const result = recordObservations({}, [makeSnapshot(), makeIp()], NOW, PRUNE);
    expect(result).toEqual({});
  });

  it('never changes its inputs', () => {
    const history = deepFreeze<ObservationHistory>({ 'vol-1': [{ observedAt: daysAgo(3), state: 'available' }] });
    const resources = deepFreeze([makeVolume({ id: 'vol-1' })]);
    expect(() => recordObservations(history, resources, NOW, PRUNE)).not.toThrow();
  });
});

describe('recordObservations: keeping the file small without losing "since when"', () => {
  it('collapses a long unbroken run to its first and latest sighting', () => {
    const history: ObservationHistory = {
      'vol-1': [10, 9, 8, 7, 6].map((d) => ({ observedAt: daysAgo(d), state: 'available' })),
    };
    const result = recordObservations(history, [makeVolume({ id: 'vol-1' })], NOW, PRUNE);
    expect(result['vol-1']).toEqual([
      { observedAt: daysAgo(10), state: 'available' },
      { observedAt: NOW.toISOString(), state: 'available' },
    ]);
  });

  it('keeps the edges where the state changed', () => {
    const history: ObservationHistory = {
      'vol-1': [
        { observedAt: daysAgo(10), state: 'in-use' },
        { observedAt: daysAgo(9), state: 'in-use' },
        { observedAt: daysAgo(8), state: 'in-use' },
        { observedAt: daysAgo(7), state: 'available' },
        { observedAt: daysAgo(6), state: 'available' },
      ],
    };
    const result = recordObservations(history, [makeVolume({ id: 'vol-1', state: 'available' })], NOW, PRUNE);
    expect(result['vol-1']?.map((o) => `${o.state}@${o.observedAt}`)).toEqual([
      `in-use@${daysAgo(10)}`,
      `in-use@${daysAgo(8)}`,
      `available@${daysAgo(7)}`,
      `available@${NOW.toISOString()}`,
    ]);
  });

  it('a state change starts a new run, so "days unattached" restarts', () => {
    const history: ObservationHistory = { 'vol-1': [{ observedAt: daysAgo(30), state: 'available' }, { observedAt: daysAgo(20), state: 'in-use' }] };
    const result = recordObservations(history, [makeVolume({ id: 'vol-1', state: 'available' })], NOW, PRUNE);
    expect(result['vol-1']?.[result['vol-1'].length - 1]).toEqual({ observedAt: NOW.toISOString(), state: 'available' });
    expect(result['vol-1']).toHaveLength(3);
  });

  it('ignores an exact repeat of the same sighting', () => {
    const history: ObservationHistory = { 'vol-1': [{ observedAt: NOW.toISOString(), state: 'available' }] };
    const result = recordObservations(history, [makeVolume({ id: 'vol-1' })], NOW, PRUNE);
    expect(result['vol-1']).toEqual([{ observedAt: NOW.toISOString(), state: 'available' }]);
  });

  it('sorts out-of-order history and drops entries with unreadable dates', () => {
    const history: ObservationHistory = {
      'vol-1': [
        { observedAt: daysAgo(2), state: 'available' },
        { observedAt: 'not a date', state: 'available' },
        { observedAt: daysAgo(9), state: 'available' },
      ],
    };
    const result = recordObservations(history, [makeVolume({ id: 'vol-1' })], NOW, PRUNE);
    expect(result['vol-1']).toEqual([
      { observedAt: daysAgo(9), state: 'available' },
      { observedAt: NOW.toISOString(), state: 'available' },
    ]);
  });

  it('caps a resource that flaps forever at the most recent sightings', () => {
    const flapping: ObservationHistory = {
      'vol-1': Array.from({ length: MAX_OBSERVATIONS_PER_RESOURCE + 100 }, (_u, i) => ({
        observedAt: new Date(NOW.getTime() - (MAX_OBSERVATIONS_PER_RESOURCE + 100 - i) * MS_PER_DAY).toISOString(),
        state: i % 2 === 0 ? 'available' : 'in-use',
      })),
    };
    const result = recordObservations(flapping, [makeVolume({ id: 'vol-1', state: 'available' })], NOW, PRUNE);
    expect(result['vol-1']).toHaveLength(MAX_OBSERVATIONS_PER_RESOURCE);
    expect(result['vol-1']?.[MAX_OBSERVATIONS_PER_RESOURCE - 1]?.observedAt).toBe(NOW.toISOString());
  });
});

describe('recordObservations: resources that are no longer there', () => {
  const history: ObservationHistory = {
    'vol-gone': [{ observedAt: daysAgo(20), state: 'available' }],
    'vol-here': [{ observedAt: daysAgo(20), state: 'available' }],
  };
  const here = [makeVolume({ id: 'vol-here' })];

  it('forgets them after a complete scan', () => {
    expect(Object.keys(recordObservations(history, here, NOW, PRUNE))).toEqual(['vol-here']);
  });

  it('keeps them after an incomplete scan, because they may simply have been unseen', () => {
    const result = recordObservations(history, here, NOW, KEEP);
    expect(Object.keys(result).sort()).toEqual(['vol-gone', 'vol-here']);
    expect(result['vol-gone']).toEqual(history['vol-gone']);
  });

  it('keeps no history for a resource that is present but has no state, such as an IP', () => {
    const result = recordObservations({ 'eipalloc-test': [{ observedAt: daysAgo(1), state: 'x' }] }, [makeIp()], NOW, PRUNE);
    expect(result).toEqual({});
  });
});
