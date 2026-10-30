/**
 * Native structured JSON logger.
 *
 * One JSON object per line: { timestamp, level, message, ...context, meta }.
 * - Levels: DEBUG < INFO < WARN < ERROR.
 * - Secrets are redacted both by key name (token, secret, password ...) and by
 *   value pattern (AWS access keys, Slack tokens).
 * - The output destination (sink) is injected, so tests can capture lines and
 *   production can send them to stdout.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|credential|signature|session[_-]?key/i;

/** Values that look like secrets even when the key name is innocent. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
];

const MAX_DEPTH = 6;

export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Returns a logger that adds the given fields (for example a run id) to every line. */
  child(context: LogMeta): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives one finished JSON line (without a trailing newline). */
  sink?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => Date;
  context?: LogMeta;
}

export function isLogLevel(value: string): value is LogLevel {
  return value === 'DEBUG' || value === 'INFO' || value === 'WARN' || value === 'ERROR';
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Turns any value into something JSON.stringify can safely handle, with secrets removed. */
export function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        stack: value.stack ? redactString(value.stack) : undefined,
      };
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(inner, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function stdoutSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_RANK[options.level ?? 'INFO'];
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const context = options.context ?? {};

  function write(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_RANK[level] < threshold) return;
    const record: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level,
      message: redactString(message),
    };
    // Context fields (for example runId) are added but can never overwrite the core fields.
    for (const [key, val] of Object.entries(sanitize(context) as Record<string, unknown>)) {
      if (!(key in record) && key !== 'meta') {
        record[key] = val;
      }
    }
    if (meta !== undefined) {
      record.meta = sanitize(meta);
    }
    sink(JSON.stringify(record));
  }

  return {
    debug: (message, meta) => write('DEBUG', message, meta),
    info: (message, meta) => write('INFO', message, meta),
    warn: (message, meta) => write('WARN', message, meta),
    error: (message, meta) => write('ERROR', message, meta),
    child: (extra) => createLogger({ ...options, context: { ...context, ...extra } }),
  };
}

/** A logger that discards everything. Handy default for tests and libraries. */
export function createNullLogger(): Logger {
  return createLogger({ sink: () => undefined, level: 'ERROR' });
}
