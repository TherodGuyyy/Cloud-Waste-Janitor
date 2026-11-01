/**
 * Wiring: scan every configured region of an AWS account.
 *
 * This is the only place where config, AWS clients, collectors and the runner
 * meet. For each region it:
 *   1. builds region clients (assuming the customer role when one is configured),
 *   2. asks AWS which account it is talking to,
 *   3. runs the collectors,
 * and merges the results. A region that cannot be reached is recorded as a
 * failure and the other regions still run.
 */

import { AwsClients, AwsClientOptions, AwsCredentialsOption, createAwsClients, createCredentialsProvider } from '../adapters/aws/clients';
import { createAwsDeps, createInventoryPort, createMetricsPort, fetchAccountId } from '../adapters/aws/readers';
import { createDefaultCollectors } from '../collectors';
import { CloudApiError } from '../collectors/errors';
import { CollectionResult, CollectorFailure, runCollectors } from '../collectors/runner';
import { AppConfig } from '../config/config';
import { Logger } from '../logging/logger';
import { realSleep } from '../resilience/retry';

export interface CollectAccountOptions {
  config: AppConfig;
  /** The clock for this run. */
  now: Date;
  logger: Logger;
  /**
   * Credentials used directly, or as the starting point for assuming the role.
   * Normally left out so the standard AWS environment variables are used.
   */
  credentials?: AwsCredentialsOption;
  /** Replaceable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  createClients?: (options: AwsClientOptions) => AwsClients;
}

export interface AccountCollection extends CollectionResult {
  regionsScanned: string[];
  /** Accounts seen across regions (normally exactly one). */
  accountIds: string[];
}

export async function collectAccount(options: CollectAccountOptions): Promise<AccountCollection> {
  const { config, now, logger } = options;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const makeClients = options.createClients ?? createAwsClients;

  const result: AccountCollection = {
    resources: [],
    skipped: [],
    failures: [],
    collectorsRun: 0,
    regionsScanned: [],
    accountIds: [],
  };

  for (const region of config.aws.regions) {
    const log = logger.child({ region });
    const credentials = createCredentialsProvider(config.aws, region, options.credentials) ?? options.credentials;
    const clients = makeClients({
      region,
      ...(config.aws.endpoint !== undefined ? { endpoint: config.aws.endpoint } : {}),
      ...(credentials !== undefined ? { credentials } : {}),
    });
    const deps = createAwsDeps(
      log,
      { maxAttempts: config.aws.maxAttempts, baseDelayMs: 500, maxDelayMs: 20_000 },
      sleep,
      random,
    );

    let accountId: string;
    try {
      accountId = await fetchAccountId(clients.sts, deps);
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      const failure: CollectorFailure = {
        region,
        collector: 'identity',
        kind: error.kind,
        message: error.message,
        operation: error.operation,
        attempts: error.attempts,
      };
      result.failures.push(failure);
      log.error('Could not identify the account, skipping region', { kind: error.kind, attempts: error.attempts });
      continue;
    }

    log.info('Scanning region', { accountId });
    const collectors = createDefaultCollectors(createInventoryPort(clients.ec2, deps), createMetricsPort(clients.cloudwatch, deps));
    const regional = await runCollectors(collectors, {
      region,
      accountId,
      now,
      idleWindowDays: config.rules.idleWindowDays,
      logger: log,
    });

    result.resources.push(...regional.resources);
    result.skipped.push(...regional.skipped);
    result.failures.push(...regional.failures);
    result.collectorsRun += regional.collectorsRun;
    result.regionsScanned.push(region);
    if (!result.accountIds.includes(accountId)) result.accountIds.push(accountId);
  }

  logger.info('Account scan complete', {
    regionsScanned: result.regionsScanned.length,
    regionsRequested: config.aws.regions.length,
    resources: result.resources.length,
    skipped: result.skipped.length,
    failures: result.failures.length,
  });
  return result;
}
