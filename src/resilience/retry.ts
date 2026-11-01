/**
 * Retry with exponential backoff and full jitter.
 *
 * Why this exists: cloud APIs sometimes say "slow down" (throttling) or hiccup
 * (timeouts, 5xx). Trying again after a growing, randomised pause usually works.
 * Randomising ("jitter") stops many clients from retrying at the same instant.
 *
 * Delay before retry number n (1, 2, 3 ...):
 *     random() * min(maxDelayMs, baseDelayMs * 2^(n-1))
 *
 * This module knows nothing about AWS. The caller decides which errors are
 * worth retrying, and the clock (sleep) and randomness are injected so tests
 * are instant and exact.
 */

import { Logger } from '../logging/logger';

export interface RetryPolicy {
  /** Total tries including the first one. Must be a whole number of at least 1. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryDeps {
  logger: Logger;
  /** Waits for the given number of milliseconds. Injected so tests do not really wait. */
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
};

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a whole number of at least 1 (got ${policy.maxAttempts})`);
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new RangeError(`baseDelayMs must be 0 or more (got ${policy.baseDelayMs})`);
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError(`maxDelayMs must be at least baseDelayMs (got ${policy.maxDelayMs})`);
  }
}

/** The pause before retry number `retryNumber` (1 = the first retry). */
export function computeBackoffDelayMs(
  retryNumber: number,
  policy: RetryPolicy,
  random: () => number,
): number {
  const growth = policy.baseDelayMs * 2 ** (retryNumber - 1);
  const ceiling = Math.min(policy.maxDelayMs, growth);
  return Math.floor(random() * ceiling);
}

export interface RetryResult<T> {
  value: T;
  /** How many tries it took (1 means it worked first time). */
  attempts: number;
}

/**
 * Runs `operation`. If it throws and `isRetryable(error)` is true, waits and
 * tries again, up to `policy.maxAttempts` tries in total.
 *
 * When it gives up (error not retryable, or tries used up) the ORIGINAL error
 * is rethrown with the attempt count attached via `onGiveUp`, so no detail is lost.
 */
export async function retryWithBackoff<T>(
  operationName: string,
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  policy: RetryPolicy,
  deps: RetryDeps,
  onGiveUp?: (error: unknown, attempts: number) => void,
): Promise<RetryResult<T>> {
  validateRetryPolicy(policy);

  for (let attempt = 1; ; attempt++) {
    try {
      const value = await operation();
      if (attempt > 1) {
        deps.logger.info('Operation succeeded after retry', { operation: operationName, attempts: attempt });
      }
      return { value, attempts: attempt };
    } catch (error) {
      const retryable = isRetryable(error);
      if (!retryable || attempt >= policy.maxAttempts) {
        onGiveUp?.(error, attempt);
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, policy, deps.random);
      deps.logger.warn('Retrying after error', {
        operation: operationName,
        attempt,
        maxAttempts: policy.maxAttempts,
        delayMs,
        error,
      });
      await deps.sleep(delayMs);
    }
  }
}
