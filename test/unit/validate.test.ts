import { describeId, isResource, validateResource } from '../../src/core/validate';
import { makeInstance, makeIp, makeSnapshot, makeVolume } from '../builders';

function withChange(base: object, change: Record<string, unknown>): unknown {
  return { ...base, ...change };
}

describe('validateResource accepts good data', () => {
  it.each([
    ['volume', makeVolume()],
    ['instance with metrics', makeInstance()],
    ['instance without metrics', makeInstance({ metrics: null })],
    ['snapshot', makeSnapshot()],
    ['elastic ip', makeIp()],
  ])('%s', (_label, resource) => {
    expect(validateResource(resource)).toBeNull();
    expect(isResource(resource)).toBe(true);
  });
});

describe('validateResource rejects bad data with a reason', () => {
  const volume = makeVolume();
  const instance = makeInstance();
  const snapshot = makeSnapshot();
  const ip = makeIp();

  it.each([
    ['null', null, 'not an object'],
    ['a string', 'text', 'not an object'],
    ['an array', [], 'not an object'],
    ['missing id', withChange(volume, { id: '' }), 'missing id'],
    ['non-string id', withChange(volume, { id: 7 }), 'missing id'],
    ['unknown type', withChange(volume, { type: 'toaster' }), 'unknown type "toaster"'],
    ['missing type', withChange(volume, { type: undefined }), 'unknown type "undefined"'],
    ['missing region', withChange(volume, { region: '' }), 'missing region'],
    ['missing account', withChange(volume, { accountId: undefined }), 'missing accountId'],
    ['tags missing', withChange(volume, { tags: undefined }), 'tags must be an object'],
    ['tags is an array', withChange(volume, { tags: [] }), 'tags must be an object'],
    ['tag value not a string', withChange(volume, { tags: { a: 1 } }), 'tag values must be strings'],

    ['volume state', withChange(volume, { state: 1 }), 'volume state must be a string'],
    ['volume size', withChange(volume, { sizeGb: '100' }), 'volume sizeGb must be a number'],
    ['volume size NaN', withChange(volume, { sizeGb: Number.NaN }), 'volume sizeGb must be a number'],
    ['volume type', withChange(volume, { volumeType: '' }), 'volume volumeType missing'],

    ['instance state', withChange(instance, { state: null }), 'instance state must be a string'],
    ['instance type', withChange(instance, { instanceType: '' }), 'instanceType missing'],
    ['metrics wrong shape', withChange(instance, { metrics: 5 }), 'metrics must be an object or null'],
    ['metrics array', withChange(instance, { metrics: [] }), 'metrics must be an object or null'],
    ['metrics window', withChange(instance, { metrics: { avgCpuPercent: 1, avgNetworkBytesPerDay: 1 } }), 'metrics.windowDays must be a number'],
    ['metrics cpu', withChange(instance, { metrics: { windowDays: 14, avgNetworkBytesPerDay: 1 } }), 'metrics.avgCpuPercent must be a number'],
    ['metrics network', withChange(instance, { metrics: { windowDays: 14, avgCpuPercent: 1 } }), 'metrics.avgNetworkBytesPerDay must be a number'],

    ['snapshot size', withChange(snapshot, { sizeGb: null }), 'snapshot sizeGb must be a number'],
    ['snapshot start', withChange(snapshot, { startTime: 5 }), 'snapshot startTime must be a string'],
    ['snapshot used flag', withChange(snapshot, { usedByImage: 'no' }), 'snapshot usedByImage must be true or false'],

    ['ip address', withChange(ip, { publicIp: '' }), 'publicIp missing'],
    ['ip associated flag', withChange(ip, { associated: 'yes' }), 'associated must be true or false'],
  ])('%s', (_label, input, expected) => {
    expect(validateResource(input)).toBe(expected);
    expect(isResource(input)).toBe(false);
  });
});

describe('describeId', () => {
  it('returns the id when there is one', () => {
    expect(describeId({ id: 'vol-1' })).toBe('vol-1');
  });

  it('returns "unknown" otherwise', () => {
    expect(describeId(null)).toBe('unknown');
    expect(describeId({})).toBe('unknown');
    expect(describeId({ id: '' })).toBe('unknown');
    expect(describeId('x')).toBe('unknown');
  });
});
