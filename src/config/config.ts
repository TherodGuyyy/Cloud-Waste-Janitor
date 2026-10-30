/**
 * Typed, validated configuration.
 *
 * Settings come from environment variables only (never .env files, never code).
 * Everything has a safe default. Bad values are rejected at startup with a
 * message listing every problem at once, so you fix them in one go.
 *
 * Phase 1 only needs rule thresholds, the kill switch and the log level.
 * Secrets (Slack token, cloud role) arrive in later phases the same way.
 */

import { isLogLevel, LogLevel } from '../logging/logger';
import { RuleConfig } from '../core/types';

export interface AppConfig {
  rules: RuleConfig;
  /** Kill switch. Must be explicitly "true" to allow any change to the cloud. */
  actionsEnabled: boolean;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  unattachedDiskDays: 14,
  idleWindowDays: 14,
  idleCpuPercent: 5,
  idleNetworkBytesPerDay: 5_000_000,
  snapshotMaxAgeDays: 90,
};

type Env = Record<string, string | undefined>;

interface NumberSpec {
  name: string;
  fallback: number;
  min: number;
  max: number;
  integer: boolean;
}

function readNumber(env: Env, spec: NumberSpec, problems: string[]): number {
  const raw = env[spec.name];
  if (raw === undefined || raw.trim() === '') return spec.fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    problems.push(`${spec.name} must be a number (got "${raw}")`);
    return spec.fallback;
  }
  if (spec.integer && !Number.isInteger(value)) {
    problems.push(`${spec.name} must be a whole number (got "${raw}")`);
    return spec.fallback;
  }
  if (value < spec.min || value > spec.max) {
    problems.push(`${spec.name} must be between ${spec.min} and ${spec.max} (got ${value})`);
    return spec.fallback;
  }
  return value;
}

function readBoolean(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  problems.push(`${name} must be "true" or "false" (got "${raw}")`);
  return fallback;
}

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];
  const d = DEFAULT_RULE_CONFIG;

  const rules: RuleConfig = {
    unattachedDiskDays: readNumber(
      env,
      { name: 'JANITOR_UNATTACHED_DAYS', fallback: d.unattachedDiskDays, min: 1, max: 365, integer: true },
      problems,
    ),
    idleWindowDays: readNumber(
      env,
      { name: 'JANITOR_IDLE_WINDOW_DAYS', fallback: d.idleWindowDays, min: 1, max: 90, integer: true },
      problems,
    ),
    idleCpuPercent: readNumber(
      env,
      { name: 'JANITOR_IDLE_CPU_PERCENT', fallback: d.idleCpuPercent, min: 0.1, max: 50, integer: false },
      problems,
    ),
    idleNetworkBytesPerDay: readNumber(
      env,
      {
        name: 'JANITOR_IDLE_NETWORK_BYTES_PER_DAY',
        fallback: d.idleNetworkBytesPerDay,
        min: 0,
        max: 10_000_000_000,
        integer: false,
      },
      problems,
    ),
    snapshotMaxAgeDays: readNumber(
      env,
      { name: 'JANITOR_SNAPSHOT_MAX_AGE_DAYS', fallback: d.snapshotMaxAgeDays, min: 1, max: 3650, integer: true },
      problems,
    ),
  };

  const actionsEnabled = readBoolean(env, 'JANITOR_ACTIONS_ENABLED', false, problems);

  let logLevel: LogLevel = 'INFO';
  const rawLevel = env.JANITOR_LOG_LEVEL;
  if (rawLevel !== undefined && rawLevel.trim() !== '') {
    const upper = rawLevel.trim().toUpperCase();
    if (isLogLevel(upper)) {
      logLevel = upper;
    } else {
      problems.push(`JANITOR_LOG_LEVEL must be DEBUG, INFO, WARN or ERROR (got "${rawLevel}")`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return { rules, actionsEnabled, logLevel };
}
