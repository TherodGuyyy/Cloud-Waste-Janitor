/** Shared helpers for tests that run a whole scan with fakes. */

import { AccountCollection } from '../src/app/collectAccount';
import { CollectorFailure } from '../src/collectors/runner';
import { AppConfig, loadConfig } from '../src/config/config';
import { Resource } from '../src/core/types';

export const SCAN_ACCOUNT = '999999999999';

export function collection(resources: Resource[], extra: Partial<AccountCollection> = {}): AccountCollection {
  return {
    resources,
    skipped: [],
    failures: [],
    collectorsRun: 4,
    regionsScanned: ['us-east-1'],
    accountIds: [SCAN_ACCOUNT],
    ...extra,
  };
}

export function failure(extra: Partial<CollectorFailure> = {}): CollectorFailure {
  return {
    region: 'us-east-1',
    collector: 'ebs-volumes',
    kind: 'access_denied',
    message: 'Cloud call "ec2:DescribeVolumes" failed after 1 attempt: access_denied',
    operation: 'ec2:DescribeVolumes',
    attempts: 1,
    ...extra,
  };
}

export function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig(env);
}
