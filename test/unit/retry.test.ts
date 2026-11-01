import {
  computeBackoffDelayMs,
  DEFAULT_RETRY_POLICY,
  realSleep,
  retryWithBackoff,
  RetryPolicy,
  validateRetryPolicy,
} from '../../src/resilience/retry';
import { captureLogger } from '../helpers';

const POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 20_000 };

function makeRetryDeps(random: () => number = () => 0.5) {
  const { logger, records } = captureLogger();
  const sleeps: number[] = [];
  return {
    deps: {
      logger,
      random,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
    sleeps,
    records,
  };
}

describe('computeBackoffDelayMs (hand-computed)', () => {
  it.each([
    // retry number, random, expected = floor(random x min(20000, 500 x 2^(n-1)))
    [1, 0.5, 250], // ceiling 500
    [2, 0.5, 500], // ceiling 1000
    [3, 0.5, 1000], // ceiling 2000
    [6, 0.5, 8000], // ceiling 16000
    [7, 0.5, 10000], // 32000 is capped at 20000
    [20, 0.5, 10000], // still capped
    [1, 0, 0],
    [1, 0.999999, 499],
    [7, 0.999999, 19999],
  ])('retry %d with random %d waits %d ms', (retryNumber, random, expected) => {
    expect(computeBackoffDelayMs(retryNumber, POLICY, () => random)).toBe(expected);
  });

  it('never exceeds the cap, whatever the random number', () => {
    for (let n = 1; n <= 30; n++) {
      expect(computeBackoffDelayMs(n, POLICY, () => 0.9999999)).toBeLessThan(POLICY.maxDelayMs);
    }
  });
});

describe('validateRetryPolicy', () => {
  it('accepts sensible policies, including a zero delay', () => {
    expect(() => validateRetryPolicy(POLICY)).not.toThrow();
    expect(() => validateRetryPolicy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 })).not.toThrow();
    expect(() => validateRetryPolicy(DEFAULT_RETRY_POLICY)).not.toThrow();
  });

  it.each([
    ['zero attempts', { ...POLICY, maxAttempts: 0 }, 'maxAttempts'],
    ['fractional attempts', { ...POLICY, maxAttempts: 2.5 }, 'maxAttempts'],
    ['NaN attempts', { ...POLICY, maxAttempts: Number.NaN }, 'maxAttempts'],
    ['negative base delay', { ...POLICY, baseDelayMs: -1 }, 'baseDelayMs'],
    ['NaN base delay', { ...POLICY, baseDelayMs: Number.NaN }, 'baseDelayMs'],
    ['max smaller than base', { ...POLICY, maxDelayMs: 100 }, 'maxDelayMs'],
    ['infinite max delay', { ...POLICY, maxDelayMs: Number.POSITIVE_INFINITY }, 'maxDelayMs'],
  ])('rejects %s', (_label, policy, field) => {
    expect(() => validateRetryPolicy(policy)).toThrow(RangeError);
    expect(() => validateRetryPolicy(policy)).toThrow(field);
  });

  it('the default policy is 5 attempts, 0.5 s base, 20 s cap', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 20_000 });
  });
});

describe('retryWithBackoff', () => {
  it('returns the value straight away when the first try works', async () => {
    const { deps, sleeps, records } = makeRetryDeps();
    const operation = jest.fn(async () => 'ok');

    const result = await retryWithBackoff('op', operation, () => true, POLICY, deps);

    expect(result).toEqual({ value: 'ok', attempts: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(records).toEqual([]); // nothing worth logging
  });

  it('retries retryable errors with growing, jittered pauses, then succeeds', async () => {
    const { deps, sleeps, records } = makeRetryDeps(() => 0.5);
    let calls = 0;
    const operation = async () => {
      calls += 1;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return 'finally';
    };

    const result = await retryWithBackoff('describe', operation, () => true, POLICY, deps);

    expect(result).toEqual({ value: 'finally', attempts: 3 });
    expect(sleeps).toEqual([250, 500]); // 0.5 x 500, 0.5 x 1000
    const warnings = records.filter((r) => r.level === 'WARN');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.meta).toMatchObject({ operation: 'describe', attempt: 1, maxAttempts: 4, delayMs: 250 });
    expect(warnings[1]?.meta).toMatchObject({ attempt: 2, delayMs: 500 });
    const success = records.find((r) => r.message === 'Operation succeeded after retry');
    expect(success?.level).toBe('INFO');
    expect(success?.meta).toEqual({ operation: 'describe', attempts: 3 });
  });

  it('never retries an error that is not retryable, and rethrows the very same error', async () => {
    const { deps, sleeps } = makeRetryDeps();
    const failure = new Error('permanent');
    const operation = jest.fn(async () => {
      throw failure;
    });
    const gaveUp: Array<[unknown, number]> = [];

    await expect(
      retryWithBackoff('op', operation, () => false, POLICY, deps, (error, attempts) => gaveUp.push([error, attempts])),
    ).rejects.toBe(failure);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(gaveUp).toEqual([[failure, 1]]);
  });

  it('gives up after the last allowed attempt and reports how many were made', async () => {
    const { deps, sleeps } = makeRetryDeps(() => 0);
    const failure = new Error('still failing');
    const operation = jest.fn(async () => {
      throw failure;
    });
    const gaveUp: Array<[unknown, number]> = [];

    await expect(
      retryWithBackoff('op', operation, () => true, POLICY, deps, (error, attempts) => gaveUp.push([error, attempts])),
    ).rejects.toBe(failure);

    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3); // pauses happen between tries, not after the last
    expect(gaveUp).toEqual([[failure, 4]]);
  });

  it('with one allowed attempt it never pauses or retries', async () => {
    const { deps, sleeps } = makeRetryDeps();
    const operation = jest.fn(async () => {
      throw new Error('x');
    });
    await expect(
      retryWithBackoff('op', operation, () => true, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, deps),
    ).rejects.toThrow('x');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('only retries when the classifier says so, per error', async () => {
    const { deps } = makeRetryDeps();
    const sequence = [new Error('transient'), new Error('fatal')];
    let index = 0;
    const operation = jest.fn(async () => {
      throw sequence[index++];
    });
    await expect(
      retryWithBackoff('op', operation, (error) => (error as Error).message === 'transient', POLICY, deps),
    ).rejects.toThrow('fatal');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('checks the policy before doing anything', async () => {
    const { deps } = makeRetryDeps();
    const operation = jest.fn(async () => 'x');
    await expect(
      retryWithBackoff('op', operation, () => true, { ...POLICY, maxAttempts: 0 }, deps),
    ).rejects.toThrow(RangeError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('works without a give-up callback', async () => {
    const { deps } = makeRetryDeps();
    await expect(
      retryWithBackoff('op', async () => Promise.reject(new Error('plain')), () => false, POLICY, deps),
    ).rejects.toThrow('plain');
  });
});

describe('realSleep', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for the given time', async () => {
    jest.useFakeTimers();
    let finished = false;
    const waiting = realSleep(1000).then(() => {
      finished = true;
    });
    jest.advanceTimersByTime(999);
    await Promise.resolve();
    expect(finished).toBe(false);
    jest.advanceTimersByTime(1);
    await waiting;
    expect(finished).toBe(true);
  });
});
