/**
 * Runtime checks for data that arrives from outside (collectors, JSON files).
 *
 * TypeScript only checks types at build time. Real cloud data can be missing
 * fields, so the evaluator validates every resource first and skips malformed
 * ones with a clear reason instead of crashing the whole run.
 */

import { Resource } from './types';

const RESOURCE_TYPES = ['ebs_volume', 'ec2_instance', 'ebs_snapshot', 'elastic_ip'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Best-effort id for error messages. */
export function describeId(input: unknown): string {
  return isRecord(input) && isNonEmptyString(input.id) ? input.id : 'unknown';
}

/** Returns null when the input is a valid Resource, otherwise a short reason. */
export function validateResource(input: unknown): string | null {
  if (!isRecord(input)) return 'not an object';
  if (!isNonEmptyString(input.id)) return 'missing id';
  if (typeof input.type !== 'string' || !RESOURCE_TYPES.includes(input.type)) {
    return `unknown type "${String(input.type)}"`;
  }
  if (!isNonEmptyString(input.region)) return 'missing region';
  if (!isNonEmptyString(input.accountId)) return 'missing accountId';

  if (!isRecord(input.tags)) return 'tags must be an object';
  for (const value of Object.values(input.tags)) {
    if (typeof value !== 'string') return 'tag values must be strings';
  }

  switch (input.type) {
    case 'ebs_volume':
      if (typeof input.state !== 'string') return 'volume state must be a string';
      if (!isFiniteNumber(input.sizeGb)) return 'volume sizeGb must be a number';
      if (!isNonEmptyString(input.volumeType)) return 'volume volumeType missing';
      return null;

    case 'ec2_instance': {
      if (typeof input.state !== 'string') return 'instance state must be a string';
      if (!isNonEmptyString(input.instanceType)) return 'instanceType missing';
      if (input.metrics === null) return null;
      if (!isRecord(input.metrics)) return 'metrics must be an object or null';
      if (!isFiniteNumber(input.metrics.windowDays)) return 'metrics.windowDays must be a number';
      if (!isFiniteNumber(input.metrics.avgCpuPercent)) return 'metrics.avgCpuPercent must be a number';
      if (!isFiniteNumber(input.metrics.avgNetworkBytesPerDay)) {
        return 'metrics.avgNetworkBytesPerDay must be a number';
      }
      return null;
    }

    case 'ebs_snapshot':
      if (!isFiniteNumber(input.sizeGb)) return 'snapshot sizeGb must be a number';
      if (typeof input.startTime !== 'string') return 'snapshot startTime must be a string';
      if (typeof input.usedByImage !== 'boolean') return 'snapshot usedByImage must be true or false';
      return null;

    default:
      // elastic_ip is the only type left after the checks above.
      if (!isNonEmptyString(input.publicIp)) return 'publicIp missing';
      if (typeof input.associated !== 'boolean') return 'associated must be true or false';
      return null;
  }
}

/** Type guard form of validateResource. */
export function isResource(input: unknown): input is Resource {
  return validateResource(input) === null;
}
