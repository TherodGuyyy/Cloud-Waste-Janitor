/** Plain-words help for each kind of scan failure. */

import { CollectorFailure } from '../collectors/runner';

const ADVICE: Record<CollectorFailure['kind'], string> = {
  access_denied:
    'Permission is missing. Give the user or role the actions in policies/collector-readonly-policy.json, then run again.',
  auth: 'The AWS credentials are missing, wrong or expired. Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or the role settings).',
  network: 'AWS could not be reached. Check the internet connection and, if set, JANITOR_AWS_ENDPOINT.',
  timeout: 'AWS did not answer in time. Run again in a few minutes.',
  throttling: 'AWS asked us to slow down and the retries ran out. Run again later, or scan fewer regions at once.',
  server_error: 'AWS reported an internal problem. Run again later.',
  not_found: 'AWS said something we asked for does not exist. Check the region names.',
  unknown: 'An unfamiliar AWS error. The logs (stderr) hold the details.',
  unexpected: 'This looks like a bug in the Janitor, not in your account. Please report it with the logs (stderr).',
};

export function adviceFor(kind: CollectorFailure['kind']): string {
  return ADVICE[kind];
}
