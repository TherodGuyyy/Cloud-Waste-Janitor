/**
 * Turning the many shapes of AWS errors into a few kinds we can act on.
 *
 * The AWS SDK throws errors with a `name` such as "ThrottlingException" or
 * "UnauthorizedOperation", an HTTP status in `$metadata.httpStatusCode`, and for
 * network problems a Node.js `code` such as "ECONNRESET".
 */

import { CloudApiError, CloudErrorInfo, CloudErrorKind } from '../../collectors/errors';

const THROTTLING_NAMES = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'SlowDown',
  'BandwidthLimitExceeded',
  'ProvisionedThroughputExceededException',
  'PriorRequestNotComplete',
]);

const TIMEOUT_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'TimeoutException']);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

const ACCESS_DENIED_NAMES = new Set([
  'UnauthorizedOperation',
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedAccess',
  'OptInRequired',
]);

const AUTH_NAMES = new Set([
  'AuthFailure',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'InvalidAccessKeyId',
  'ExpiredToken',
  'ExpiredTokenException',
  'SignatureDoesNotMatch',
  'CredentialsProviderError',
  'TokenRefreshRequired',
]);

const SERVER_ERROR_NAMES = new Set([
  'InternalError',
  'InternalFailure',
  'ServiceUnavailable',
  'Unavailable',
  'ServerInternal',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readStatus(source: Record<string, unknown>): number | undefined {
  const metadata = source.$metadata;
  if (isRecord(metadata) && typeof metadata.httpStatusCode === 'number') {
    return metadata.httpStatusCode;
  }
  return undefined;
}

function sdkSaysThrottling(source: Record<string, unknown>): boolean {
  const hint = source.$retryable;
  return isRecord(hint) && hint.throttling === true;
}

function info(kind: CloudErrorKind, retryable: boolean, code?: string, statusCode?: number): CloudErrorInfo {
  const result: CloudErrorInfo = { kind, retryable };
  if (code !== undefined) result.code = code;
  if (statusCode !== undefined) result.statusCode = statusCode;
  return result;
}

const NETWORK_CODE_IN_TEXT = new RegExp(`\\b(${[...NETWORK_CODES].join('|')})\\b`);

/**
 * The Node.js network code of an error, for example ECONNREFUSED.
 * Normally it is the `code` property. Some wrappers (the AWS SDK wraps errors that
 * come from another JavaScript realm, as happens inside Jest) drop that property but
 * keep the original text, so as a fallback we look for the code in the message.
 */
function networkCodeOf(error: Record<string, unknown>): string | undefined {
  const code = readString(error, 'code');
  if (code !== undefined) return code;
  const message = readString(error, 'message');
  return message === undefined ? undefined : NETWORK_CODE_IN_TEXT.exec(message)?.[1];
}

/** Works out what kind of failure an error is, and whether trying again could help. */
export function classifyAwsError(error: unknown): CloudErrorInfo {
  if (!isRecord(error)) return info('unknown', false);

  const name = readString(error, 'name');
  const nodeCode = networkCodeOf(error);
  const status = readStatus(error);
  // Node.js network errors are named just "Error" and carry the useful part in `code`
  // (for example ECONNRESET), so for those the code is the more helpful label.
  const code = nodeCode !== undefined && NETWORK_CODES.has(nodeCode) ? nodeCode : (name ?? nodeCode);

  if ((name && THROTTLING_NAMES.has(name)) || sdkSaysThrottling(error) || status === 429) {
    return info('throttling', true, code, status);
  }
  if (name && AUTH_NAMES.has(name)) return info('auth', false, code, status);
  if (name && ACCESS_DENIED_NAMES.has(name)) return info('access_denied', false, code, status);
  if (name && TIMEOUT_NAMES.has(name)) return info('timeout', true, code, status);
  if (nodeCode && NETWORK_CODES.has(nodeCode)) return info('network', true, code, status);
  if (name && name.endsWith('NotFound')) return info('not_found', false, code, status);
  if ((name && SERVER_ERROR_NAMES.has(name)) || (status !== undefined && status >= 500 && status <= 599)) {
    return info('server_error', true, code, status);
  }
  if (status === 401) return info('auth', false, code, status);
  if (status === 403) return info('access_denied', false, code, status);
  if (status === 404) return info('not_found', false, code, status);
  return info('unknown', false, code, status);
}

export function isRetryableAwsError(error: unknown): boolean {
  return classifyAwsError(error).retryable;
}

/** Wraps any thrown value in a CloudApiError (leaves an existing one alone). */
export function toCloudApiError(operation: string, error: unknown, attempts: number): CloudApiError {
  if (error instanceof CloudApiError) return error;
  return new CloudApiError(operation, classifyAwsError(error), attempts, error);
}
