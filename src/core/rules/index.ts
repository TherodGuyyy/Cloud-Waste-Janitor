import { Resource, Rule } from '../types';
import { idleServerRule } from './idleServer';
import { oldSnapshotRule } from './oldSnapshot';
import { unattachedDiskRule } from './unattachedDisk';
import { unusedIpRule } from './unusedIp';

export { UNATTACHED_DISK_RULE_ID } from './unattachedDisk';
export { IDLE_SERVER_RULE_ID } from './idleServer';
export { OLD_SNAPSHOT_RULE_ID } from './oldSnapshot';
export { UNUSED_IP_RULE_ID } from './unusedIp';

export const DEFAULT_RULES: readonly Rule[] = [
  unattachedDiskRule,
  idleServerRule,
  oldSnapshotRule,
  unusedIpRule,
];

/** Tag that tells the Janitor to leave a resource alone. */
export const IGNORE_TAG_KEY = 'janitor:ignore';

/** True when the resource carries janitor:ignore=true (value is case-insensitive). */
export function isIgnoredByTag(resource: Resource): boolean {
  const value = resource.tags[IGNORE_TAG_KEY];
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}
