/**
 * The one error type collectors and the runner deal with.
 *
 * It lives here (not in the AWS adapter) so collectors can recognise a cloud
 * failure without knowing anything about AWS. The AWS adapter creates these.
 */

export type CloudErrorKind =
  | 'throttling' // "slow down": retry later
  | 'timeout' // no answer in time: retry
  | 'network' // connection problem: retry
  | 'server_error' // the cloud had a problem: retry
  | 'access_denied' // permissions missing: never retry, tell the person
  | 'auth' // bad or expired credentials: never retry, tell the person
  | 'not_found' // the thing is gone: never retry
  | 'unknown'; // anything else: never retry

export interface CloudErrorInfo {
  kind: CloudErrorKind;
  retryable: boolean;
  /** Cloud error name or Node.js error code, when known. */
  code?: string;
  statusCode?: number;
}

/** Kinds that mean "fix your setup", so they must stop the work loudly rather than be skipped over. */
export const SETUP_ERROR_KINDS: ReadonlySet<CloudErrorKind> = new Set<CloudErrorKind>(['access_denied', 'auth']);

export class CloudApiError extends Error {
  readonly kind: CloudErrorKind;
  readonly operation: string;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly code?: string;
  readonly statusCode?: number;

  constructor(operation: string, details: CloudErrorInfo, attempts: number, cause?: unknown) {
    const reason = details.code ? `${details.kind} (${details.code})` : details.kind;
    super(`Cloud call "${operation}" failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}`, {
      cause,
    });
    this.name = 'CloudApiError';
    this.kind = details.kind;
    this.operation = operation;
    this.attempts = attempts;
    this.retryable = details.retryable;
    if (details.code !== undefined) this.code = details.code;
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
  }
}
