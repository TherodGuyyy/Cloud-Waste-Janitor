import { classifyAwsError, isRetryableAwsError, toCloudApiError } from '../../src/adapters/aws/errors';
import { CloudApiError, CloudErrorKind, SETUP_ERROR_KINDS } from '../../src/collectors/errors';
import { awsError } from '../awsFakes';

describe('classifyAwsError by error name', () => {
  it.each([
    ['ThrottlingException', 'throttling', true],
    ['Throttling', 'throttling', true],
    ['RequestLimitExceeded', 'throttling', true],
    ['TooManyRequestsException', 'throttling', true],
    ['RequestThrottled', 'throttling', true],
    ['AuthFailure', 'auth', false],
    ['ExpiredToken', 'auth', false],
    ['ExpiredTokenException', 'auth', false],
    ['InvalidClientTokenId', 'auth', false],
    ['UnrecognizedClientException', 'auth', false],
    ['CredentialsProviderError', 'auth', false],
    ['SignatureDoesNotMatch', 'auth', false],
    ['UnauthorizedOperation', 'access_denied', false],
    ['AccessDenied', 'access_denied', false],
    ['AccessDeniedException', 'access_denied', false],
    ['OptInRequired', 'access_denied', false],
    ['TimeoutError', 'timeout', true],
    ['RequestTimeout', 'timeout', true],
    ['InvalidVolume.NotFound', 'not_found', false],
    ['InvalidInstanceID.NotFound', 'not_found', false],
    ['InternalError', 'server_error', true],
    ['ServiceUnavailable', 'server_error', true],
    ['SomethingNobodyHasSeenBefore', 'unknown', false],
  ] as Array<[string, CloudErrorKind, boolean]>)('%s is %s (retryable: %s)', (name, kind, retryable) => {
    const info = classifyAwsError(awsError(name));
    expect(info.kind).toBe(kind);
    expect(info.retryable).toBe(retryable);
    expect(info.code).toBe(name);
    expect(isRetryableAwsError(awsError(name))).toBe(retryable);
  });
});

describe('classifyAwsError by network code', () => {
  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH'])(
    '%s is a retryable network error and is named by its code, not by "Error"',
    (nodeCode) => {
      const info = classifyAwsError(awsError('Error', { code: nodeCode }));
      expect(info).toEqual({ kind: 'network', retryable: true, code: nodeCode });
    },
  );

  it('an unfamiliar Node code is not treated as a network error', () => {
    const info = classifyAwsError(awsError('Error', { code: 'EWHATEVER' }));
    expect(info.kind).toBe('unknown');
    expect(info.retryable).toBe(false);
    expect(info.code).toBe('Error');
  });
});

describe('classifyAwsError when a wrapper dropped the network code but kept the text', () => {
  // The AWS SDK wraps errors from another JavaScript realm (this happens inside Jest)
  // and the wrapper has no `code`, only a message that quotes the original error.
  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])('finds %s in the message', (code) => {
    const wrapped = new Error(`AWS SDK error wrapper for Error: connect ${code} 127.0.0.1:1`);
    expect(classifyAwsError(wrapped)).toEqual({ kind: 'network', retryable: true, code });
  });

  it('prefers a real code property over the message', () => {
    const info = classifyAwsError(awsError('Error', { code: 'ECONNRESET', message: 'mentions ETIMEDOUT too' }));
    expect(info.code).toBe('ECONNRESET');
  });

  it('only matches whole words, so unrelated text is not mistaken for a network error', () => {
    for (const message of ['NOT_ECONNRESET_AT_ALL', 'xECONNREFUSED', 'connection problem']) {
      expect(classifyAwsError(new Error(message)).kind).toBe('unknown');
    }
  });

  it('does not let a network word in the message override a clear permission error', () => {
    const info = classifyAwsError(awsError('UnauthorizedOperation', { message: 'not allowed after ECONNRESET' }));
    expect(info.kind).toBe('access_denied');
    expect(info.retryable).toBe(false);
  });
});

describe('classifyAwsError by HTTP status and SDK hint', () => {
  it.each([
    [429, 'throttling', true],
    [500, 'server_error', true],
    [502, 'server_error', true],
    [503, 'server_error', true],
    [599, 'server_error', true],
    [401, 'auth', false],
    [403, 'access_denied', false],
    [404, 'not_found', false],
    [400, 'unknown', false],
    [600, 'unknown', false],
  ] as Array<[number, CloudErrorKind, boolean]>)('status %d (generic name) is %s', (status, kind, retryable) => {
    const info = classifyAwsError(awsError('Error', { $metadata: { httpStatusCode: status } }));
    expect(info.kind).toBe(kind);
    expect(info.retryable).toBe(retryable);
    expect(info.statusCode).toBe(status);
  });

  it('trusts the SDK when it flags an error as throttling', () => {
    const info = classifyAwsError(awsError('WeirdName', { $retryable: { throttling: true } }));
    expect(info.kind).toBe('throttling');
  });

  it('ignores an SDK hint that says it is not throttling', () => {
    const info = classifyAwsError(awsError('WeirdName', { $retryable: { throttling: false } }));
    expect(info.kind).toBe('unknown');
  });

  it('throttling wins over a 500 status on the same error', () => {
    const info = classifyAwsError(awsError('ThrottlingException', { $metadata: { httpStatusCode: 500 } }));
    expect(info.kind).toBe('throttling');
    expect(info.statusCode).toBe(500);
  });

  it('a named permission error wins over its 403 status', () => {
    const info = classifyAwsError(awsError('UnauthorizedOperation', { $metadata: { httpStatusCode: 403 } }));
    expect(info).toEqual({ kind: 'access_denied', retryable: false, code: 'UnauthorizedOperation', statusCode: 403 });
  });

  it('ignores a malformed $metadata', () => {
    expect(classifyAwsError(awsError('Odd', { $metadata: 'nope' })).statusCode).toBeUndefined();
    expect(classifyAwsError(awsError('Odd', { $metadata: { httpStatusCode: '500' } })).statusCode).toBeUndefined();
  });
});

describe('classifyAwsError with odd input', () => {
  it.each([[null], [undefined], ['a string'], [42], [true]])('%p is unknown and not retryable', (value) => {
    expect(classifyAwsError(value)).toEqual({ kind: 'unknown', retryable: false });
  });

  it('an object with no name, code or status is unknown with no extra fields', () => {
    expect(classifyAwsError({})).toEqual({ kind: 'unknown', retryable: false });
  });

  it('empty-string name and code are treated as missing', () => {
    expect(classifyAwsError({ name: '', code: '' })).toEqual({ kind: 'unknown', retryable: false });
  });
});

describe('toCloudApiError', () => {
  it('wraps a raw error with its kind, the operation, the attempts and the original as cause', () => {
    const original = awsError('ThrottlingException');
    const wrapped = toCloudApiError('ec2:DescribeVolumes', original, 5);
    expect(wrapped).toBeInstanceOf(CloudApiError);
    expect(wrapped.kind).toBe('throttling');
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.operation).toBe('ec2:DescribeVolumes');
    expect(wrapped.attempts).toBe(5);
    expect(wrapped.cause).toBe(original);
  });

  it('leaves an existing CloudApiError alone instead of wrapping it twice', () => {
    const existing = new CloudApiError('first', { kind: 'timeout', retryable: true }, 2);
    expect(toCloudApiError('second', existing, 9)).toBe(existing);
    expect(existing.operation).toBe('first');
    expect(existing.attempts).toBe(2);
  });

  it('copes with a thrown value that is not an Error', () => {
    const wrapped = toCloudApiError('op', 'just text', 1);
    expect(wrapped.kind).toBe('unknown');
    expect(wrapped.cause).toBe('just text');
  });
});

describe('CloudApiError', () => {
  it('writes a clear message, with singular and plural attempts', () => {
    const one = new CloudApiError('ec2:DescribeVolumes', { kind: 'access_denied', retryable: false, code: 'UnauthorizedOperation' }, 1);
    expect(one.message).toBe('Cloud call "ec2:DescribeVolumes" failed after 1 attempt: access_denied (UnauthorizedOperation)');
    const many = new CloudApiError('x', { kind: 'timeout', retryable: true }, 5);
    expect(many.message).toBe('Cloud call "x" failed after 5 attempts: timeout');
  });

  it('carries its details, and leaves optional fields empty when they were not given', () => {
    const full = new CloudApiError('op', { kind: 'server_error', retryable: true, code: 'InternalError', statusCode: 503 }, 3);
    expect(full.name).toBe('CloudApiError');
    expect(full).toMatchObject({ kind: 'server_error', retryable: true, code: 'InternalError', statusCode: 503, attempts: 3 });
    const bare = new CloudApiError('op', { kind: 'unknown', retryable: false }, 1);
    expect(bare.code).toBeUndefined();
    expect(bare.statusCode).toBeUndefined();
  });

  it('is an Error, so normal error handling works', () => {
    expect(new CloudApiError('op', { kind: 'unknown', retryable: false }, 1)).toBeInstanceOf(Error);
  });

  it('only access_denied and auth are "fix your setup" errors', () => {
    expect([...SETUP_ERROR_KINDS].sort()).toEqual(['access_denied', 'auth']);
  });
});
