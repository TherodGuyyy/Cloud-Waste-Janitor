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

export interface AwsConfig {
  /** Regions to scan, in order, without duplicates. */
  regions: string[];
  /** Role to assume in the customer account. When set, externalId is required. */
  roleArn?: string;
  /** Protects against the "confused deputy" attack. Treated as sensitive in logs. */
  externalId?: string;
  /** Attempts per AWS call, including the first. */
  maxAttempts: number;
  /** Only for tests and local fakes such as moto. */
  endpoint?: string;
}

export interface AppConfig {
  rules: RuleConfig;
  aws: AwsConfig;
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

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const MAX_REGIONS = 30;
const EXTERNAL_ID_PATTERN = /^[\w+=,.@:/-]{2,1224}$/;

function readRegions(env: Env, problems: string[]): string[] {
  const raw = env.JANITOR_AWS_REGIONS;
  if (raw === undefined || raw.trim() === '') return ['us-east-1'];

  const regions: string[] = [];
  let sawInvalid = false;
  for (const part of raw.split(',')) {
    const region = part.trim();
    if (region === '') continue;
    if (!REGION_PATTERN.test(region)) {
      problems.push(`JANITOR_AWS_REGIONS contains "${region}", which is not a region name such as us-east-1`);
      sawInvalid = true;
      continue;
    }
    if (!regions.includes(region)) regions.push(region);
  }
  if (regions.length > MAX_REGIONS) {
    problems.push(`JANITOR_AWS_REGIONS lists ${regions.length} regions (the most allowed is ${MAX_REGIONS})`);
  }
  if (regions.length === 0 && !sawInvalid) {
    problems.push('JANITOR_AWS_REGIONS has no region in it');
  }
  return regions.length > 0 ? regions : ['us-east-1'];
}

function readOptionalText(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

function readEndpoint(env: Env, problems: string[]): string | undefined {
  const raw = readOptionalText(env, 'JANITOR_AWS_ENDPOINT');
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The only thing that can fail here is parsing, so any failure means "not a web address".
    // (No instanceof check: errors from URL can come from another realm, e.g. inside Jest.)
    problems.push(`JANITOR_AWS_ENDPOINT must be a full web address (got "${raw}")`);
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`JANITOR_AWS_ENDPOINT must start with http:// or https:// (got "${raw}")`);
    return undefined;
  }
  return raw;
}

function readAws(env: Env, problems: string[]): AwsConfig {
  const regions = readRegions(env, problems);
  const maxAttempts = readNumber(
    env,
    { name: 'JANITOR_AWS_MAX_ATTEMPTS', fallback: 5, min: 1, max: 10, integer: true },
    problems,
  );
  const endpoint = readEndpoint(env, problems);

  const roleArn = readOptionalText(env, 'JANITOR_ROLE_ARN');
  const externalId = readOptionalText(env, 'JANITOR_EXTERNAL_ID');

  if (roleArn !== undefined && !ROLE_ARN_PATTERN.test(roleArn)) {
    problems.push('JANITOR_ROLE_ARN must look like arn:aws:iam::123456789012:role/RoleName');
  }
  if (externalId !== undefined && !EXTERNAL_ID_PATTERN.test(externalId)) {
    problems.push('JANITOR_EXTERNAL_ID must be 2 to 1224 characters from A-Z a-z 0-9 and + = , . @ : / _ -');
  }
  if (roleArn !== undefined && externalId === undefined) {
    problems.push('JANITOR_EXTERNAL_ID is required when JANITOR_ROLE_ARN is set');
  }
  if (roleArn === undefined && externalId !== undefined) {
    problems.push('JANITOR_EXTERNAL_ID is set but JANITOR_ROLE_ARN is not');
  }

  const aws: AwsConfig = { regions, maxAttempts };
  if (roleArn !== undefined) aws.roleArn = roleArn;
  if (externalId !== undefined) aws.externalId = externalId;
  if (endpoint !== undefined) aws.endpoint = endpoint;
  return aws;
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

  const aws = readAws(env, problems);
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
  return { rules, aws, actionsEnabled, logLevel };
}
