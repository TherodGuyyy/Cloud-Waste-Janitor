/**
 * Fakes for the AWS layer: tiny stand-ins for the SDK clients so unit tests need no network.
 */

import { AwsDeps } from '../src/adapters/aws/readers';
import { createNullLogger, Logger } from '../src/logging/logger';
import { RetryPolicy } from '../src/resilience/retry';

export interface RecordedCall {
  /** The SDK command class name, for example DescribeVolumesCommand. */
  name: string;
  input: Record<string, unknown>;
}

export interface FakeSender<S> {
  sender: S;
  calls: RecordedCall[];
}

/** Decides the answer to each request. May return a value or throw an error. */
export type Responder = (name: string, input: Record<string, unknown>, callNumber: number) => unknown;

/** A client whose `send` records every command and answers with `responder`. */
export function fakeSender<S>(responder: Responder): FakeSender<S> {
  const calls: RecordedCall[] = [];
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
    calls.push({ name: command.constructor.name, input: command.input });
    return responder(command.constructor.name, command.input, calls.length);
  };
  return { sender: { send } as unknown as S, calls };
}

/** An error shaped like the ones the AWS SDK throws. */
export function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(`${name} (fake)`);
  error.name = name;
  Object.assign(error, extra);
  return error;
}

export const FAST_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

export interface DepsOptions {
  logger?: Logger;
  policy?: RetryPolicy;
  random?: () => number;
}

/** Retry dependencies that never really wait. `sleeps` lists the pauses that would have happened. */
export function makeDeps(options: DepsOptions = {}): { deps: AwsDeps; sleeps: number[] } {
  const sleeps: number[] = [];
  const deps: AwsDeps = {
    logger: options.logger ?? createNullLogger(),
    policy: options.policy ?? FAST_POLICY,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: options.random ?? (() => 0.5),
  };
  return { deps, sleeps };
}
