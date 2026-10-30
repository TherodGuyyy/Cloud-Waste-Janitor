import { createLogger, createNullLogger, isLogLevel, REDACTED, sanitize } from '../../src/logging/logger';
import { captureLogger } from '../helpers';

describe('logger output', () => {
  it('writes one valid JSON object per line with timestamp, level and message', () => {
    const { logger, lines } = captureLogger();
    logger.info('hello', { runId: 'r1' });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string);
    expect(record).toEqual({
      timestamp: '2026-10-28T12:00:00.000Z',
      level: 'INFO',
      message: 'hello',
      meta: { runId: 'r1' },
    });
  });

  it('omits meta when none is given', () => {
    const { logger, records } = captureLogger();
    logger.warn('no meta');
    expect(records[0]).not.toHaveProperty('meta');
  });

  it('supports all four levels', () => {
    const { logger, records } = captureLogger('DEBUG');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(records.map((r) => r.level)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });
});

describe('logger level filtering', () => {
  it('drops messages below the threshold', () => {
    const { logger, records } = captureLogger('WARN');
    logger.debug('x');
    logger.info('x');
    logger.warn('keep');
    logger.error('keep');
    expect(records.map((r) => r.level)).toEqual(['WARN', 'ERROR']);
  });

  it('defaults to INFO', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    logger.debug('hidden');
    logger.info('shown');
    expect(lines).toHaveLength(1);
  });

  it('isLogLevel accepts only the four levels', () => {
    expect(isLogLevel('DEBUG')).toBe(true);
    expect(isLogLevel('INFO')).toBe(true);
    expect(isLogLevel('WARN')).toBe(true);
    expect(isLogLevel('ERROR')).toBe(true);
    expect(isLogLevel('info')).toBe(false);
    expect(isLogLevel('TRACE')).toBe(false);
  });
});

describe('logger redaction', () => {
  it('redacts values whose key name looks sensitive', () => {
    const { logger, records } = captureLogger();
    logger.info('call', {
      slackToken: 'abc',
      signingSecret: 'def',
      password: 'ghi',
      Authorization: 'Bearer zzz',
      apiKey: 'k',
      api_key: 'k2',
      credentials: { anything: 1 },
      safe: 'visible',
    });
    expect(records[0]?.meta).toEqual({
      slackToken: REDACTED,
      signingSecret: REDACTED,
      password: REDACTED,
      Authorization: REDACTED,
      apiKey: REDACTED,
      api_key: REDACTED,
      credentials: REDACTED,
      safe: 'visible',
    });
  });

  it('redacts nested sensitive keys', () => {
    const { logger, records } = captureLogger();
    logger.info('nested', { outer: { inner: { token: 'x', ok: 1 } } });
    expect(records[0]?.meta).toEqual({ outer: { inner: { token: REDACTED, ok: 1 } } });
  });

  it('redacts AWS access key ids and Slack tokens found inside text', () => {
    const { logger, lines } = captureLogger();
    logger.error('failed with AKIAIOSFODNN7EXAMPLE', { note: 'bot xoxb-1234567890-abcdefghij leaked' });
    const text = lines[0] as string;
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('xoxb-1234567890-abcdefghij');
    expect(text).toContain(REDACTED);
  });

  it('redacts secrets inside error messages and stacks', () => {
    const { logger, lines } = captureLogger();
    logger.error('boom', { err: new Error('bad key AKIAIOSFODNN7EXAMPLE') });
    expect(lines[0]).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts sensitive keys supplied through child context', () => {
    const { logger, records } = captureLogger();
    logger.child({ runId: 'r1', apiKey: 'shh' }).info('x');
    expect(records[0]?.runId).toBe('r1');
    expect(records[0]?.apiKey).toBe(REDACTED);
  });
});

describe('logger value handling', () => {
  it('serialises errors with name, message and stack', () => {
    const { logger, records } = captureLogger();
    logger.error('failed', { err: new TypeError('nope') });
    const err = (records[0]?.meta as { err: { name: string; message: string; stack?: string } }).err;
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('nope');
    expect(typeof err.stack).toBe('string');
  });

  it('handles circular references', () => {
    const { logger, records } = captureLogger();
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    logger.info('circular', { a });
    expect(records[0]?.meta).toEqual({ a: { name: 'a', self: '[Circular]' } });
  });

  it('handles bigint, dates, functions, symbols, null and undefined', () => {
    const { logger, records } = captureLogger();
    logger.info('types', {
      big: BigInt(12),
      date: new Date('2026-01-02T03:04:05.000Z'),
      badDate: new Date('nope'),
      fn: () => 1,
      sym: Symbol('s'),
      nothing: null,
      missing: undefined,
      list: [1, 'two', { three: 3 }],
    });
    expect(records[0]?.meta).toEqual({
      big: '12',
      date: '2026-01-02T03:04:05.000Z',
      badDate: 'Invalid Date',
      fn: '[function]',
      sym: '[symbol]',
      nothing: null,
      list: [1, 'two', { three: 3 }],
    });
  });

  it('stops at a maximum depth instead of recursing forever', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'too deep' } } } } } } };
    const result = JSON.stringify(sanitize(deep));
    expect(result).toContain('[MaxDepth]');
    expect(result).not.toContain('too deep');
  });
});

describe('logger child and context', () => {
  it('adds child context to every line', () => {
    const { logger, records } = captureLogger();
    const child = logger.child({ runId: 'run-42' });
    child.info('one');
    child.child({ accountId: 'a1' }).info('two');
    expect(records[0]?.runId).toBe('run-42');
    expect(records[1]?.runId).toBe('run-42');
    expect(records[1]?.accountId).toBe('a1');
  });

  it('never lets context overwrite the core fields', () => {
    const { logger, records } = captureLogger();
    logger.child({ level: 'FAKE', message: 'fake', timestamp: 'fake', meta: 'fake' }).info('real', { a: 1 });
    expect(records[0]).toMatchObject({ level: 'INFO', message: 'real', timestamp: '2026-10-28T12:00:00.000Z' });
    expect(records[0]?.meta).toEqual({ a: 1 });
  });
});

describe('default and null sinks', () => {
  it('the default sink writes one line to standard output', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createLogger().info('to stdout');
      expect(spy).toHaveBeenCalledTimes(1);
      const written = String(spy.mock.calls[0]?.[0]);
      expect(written.endsWith('\n')).toBe(true);
      expect(JSON.parse(written).message).toBe('to stdout');
    } finally {
      spy.mockRestore();
    }
  });

  it('the null logger prints nothing', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logger = createNullLogger();
      logger.error('silent');
      logger.info('silent');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
