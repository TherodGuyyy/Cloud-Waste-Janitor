/**
 * Readers: the only code that sends requests to AWS.
 *
 * They implement the ports in src/collectors/ports.ts. Every request:
 *  - is retried with backoff when the error is worth retrying (throttling,
 *    timeouts, network trouble, 5xx), and never otherwise;
 *  - follows pagination to the end, with guards against endless loops;
 *  - turns the SDK's answer into plain "raw" data and nothing more.
 *
 * Every function here only READS. No write call to AWS exists in this file.
 */

import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Logger } from '../../logging/logger';
import { RetryDeps, RetryPolicy, retryWithBackoff, validateRetryPolicy } from '../../resilience/retry';
import {
  InventoryPort,
  MetricPoint,
  MetricsPort,
  MetricSeries,
  RawAddress,
  RawInstance,
  RawSnapshot,
  RawVolume,
} from '../../collectors/ports';
import { CloudApiError } from '../../collectors/errors';
import { isRetryableAwsError, toCloudApiError } from './errors';

export interface AwsDeps extends RetryDeps {
  policy: RetryPolicy;
}

export type Ec2Sender = Pick<EC2Client, 'send'>;
export type CloudWatchSender = Pick<CloudWatchClient, 'send'>;
export type StsSender = Pick<STSClient, 'send'>;

/** Stops a misbehaving API that never ends its pages from looping forever. */
export const MAX_PAGES = 1_000;
export const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = 86_400_000;

/** Runs one AWS request with retries, and turns any final failure into a CloudApiError. */
export async function callAws<T>(operation: string, request: () => Promise<T>, deps: AwsDeps): Promise<T> {
  let attemptsMade = 1;
  try {
    const result = await retryWithBackoff(operation, request, isRetryableAwsError, deps.policy, deps, (_error, attempts) => {
      attemptsMade = attempts;
    });
    return result.value;
  } catch (error) {
    const failure = toCloudApiError(operation, error, attemptsMade);
    deps.logger.error('AWS call failed', {
      operation,
      kind: failure.kind,
      code: failure.code,
      statusCode: failure.statusCode,
      attempts: failure.attempts,
      error,
    });
    throw failure;
  }
}

interface Page<T> {
  items: T[];
  nextToken?: string | undefined;
}

/** Reads every page of a paginated AWS call. */
export async function fetchAllPages<T>(
  operation: string,
  fetchPage: (token: string | undefined) => Promise<Page<T>>,
  deps: AwsDeps,
): Promise<T[]> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const page = await callAws(operation, () => fetchPage(token), deps);
    for (const item of page.items) items.push(item);

    if (page.nextToken === undefined || page.nextToken === '') return items;
    if (seenTokens.has(page.nextToken)) {
      throw new CloudApiError(operation, { kind: 'unknown', retryable: false, code: 'RepeatedPageToken' }, pageNumber);
    }
    seenTokens.add(page.nextToken);
    token = page.nextToken;
  }
  throw new CloudApiError(operation, { kind: 'unknown', retryable: false, code: 'TooManyPages' }, MAX_PAGES);
}

/** AWS tags are a list of Key/Value pairs. We keep them as a simple object. */
export function tagsToRecord(tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (typeof tag.Key === 'string' && tag.Key !== '') {
      result[tag.Key] = tag.Value ?? '';
    }
  }
  return result;
}

/** Date to ISO text, or undefined when the date is missing or invalid. */
export function toIso(date: unknown): string | undefined {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

/** Copies a field only when it has a value, so raw objects never hold explicit undefined. */
function defined<T extends object>(fields: { [K in keyof T]?: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function createInventoryPort(ec2: Ec2Sender, deps: AwsDeps): InventoryPort {
  validateRetryPolicy(deps.policy);

  return {
    async listVolumes(): Promise<RawVolume[]> {
      return fetchAllPages(
        'ec2:DescribeVolumes',
        async (token) => {
          const response = await ec2.send(new DescribeVolumesCommand({ MaxResults: 500, NextToken: token }));
          return {
            items: (response.Volumes ?? []).map((v) =>
              defined<RawVolume>({
                id: v.VolumeId,
                state: v.State,
                sizeGb: v.Size,
                volumeType: v.VolumeType,
                tags: tagsToRecord(v.Tags),
              }),
            ),
            nextToken: response.NextToken,
          };
        },
        deps,
      );
    },

    async listInstances(): Promise<RawInstance[]> {
      return fetchAllPages(
        'ec2:DescribeInstances',
        async (token) => {
          const response = await ec2.send(new DescribeInstancesCommand({ MaxResults: 1000, NextToken: token }));
          const instances = (response.Reservations ?? []).flatMap((r) => r.Instances ?? []);
          return {
            items: instances.map((i) =>
              defined<RawInstance>({
                id: i.InstanceId,
                state: i.State?.Name,
                instanceType: i.InstanceType,
                launchTime: toIso(i.LaunchTime),
                tags: tagsToRecord(i.Tags),
              }),
            ),
            nextToken: response.NextToken,
          };
        },
        deps,
      );
    },

    async listOwnedSnapshots(): Promise<RawSnapshot[]> {
      return fetchAllPages(
        'ec2:DescribeSnapshots',
        async (token) => {
          const response = await ec2.send(
            new DescribeSnapshotsCommand({ OwnerIds: ['self'], MaxResults: 1000, NextToken: token }),
          );
          return {
            items: (response.Snapshots ?? []).map((s) =>
              defined<RawSnapshot>({
                id: s.SnapshotId,
                ownerId: s.OwnerId,
                sizeGb: s.VolumeSize,
                startTime: toIso(s.StartTime),
                tags: tagsToRecord(s.Tags),
              }),
            ),
            nextToken: response.NextToken,
          };
        },
        deps,
      );
    },

    async listImageSnapshotIds(): Promise<string[]> {
      const images = await fetchAllPages(
        'ec2:DescribeImages',
        async (token) => {
          const response = await ec2.send(new DescribeImagesCommand({ Owners: ['self'], NextToken: token }));
          return { items: response.Images ?? [], nextToken: response.NextToken };
        },
        deps,
      );
      const ids = new Set<string>();
      for (const image of images) {
        for (const mapping of image.BlockDeviceMappings ?? []) {
          const snapshotId = mapping.Ebs?.SnapshotId;
          if (typeof snapshotId === 'string' && snapshotId !== '') ids.add(snapshotId);
        }
      }
      return [...ids];
    },

    async listAddresses(): Promise<RawAddress[]> {
      const response = await callAws('ec2:DescribeAddresses', () => ec2.send(new DescribeAddressesCommand({})), deps);
      return (response.Addresses ?? []).map((a) =>
        defined<RawAddress>({
          allocationId: a.AllocationId,
          publicIp: a.PublicIp,
          associationId: a.AssociationId,
          instanceId: a.InstanceId,
          networkInterfaceId: a.NetworkInterfaceId,
          publicIpv4Pool: a.PublicIpv4Pool,
          tags: tagsToRecord(a.Tags),
        }),
      );
    },
  };
}

export function createMetricsPort(cloudwatch: CloudWatchSender, deps: AwsDeps): MetricsPort {
  validateRetryPolicy(deps.policy);

  async function dailySeries(
    instanceId: string,
    metricName: string,
    statistic: 'Average' | 'Sum',
    start: Date,
    end: Date,
  ): Promise<MetricPoint[]> {
    const response = await callAws(
      `cloudwatch:GetMetricStatistics ${metricName}`,
      () =>
        cloudwatch.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: metricName,
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: start,
            EndTime: end,
            Period: SECONDS_PER_DAY,
            Statistics: [statistic],
          }),
        ),
      deps,
    );

    const points: MetricPoint[] = [];
    for (const datapoint of response.Datapoints ?? []) {
      const value = statistic === 'Average' ? datapoint.Average : datapoint.Sum;
      const at = toIso(datapoint.Timestamp);
      if (at !== undefined && typeof value === 'number' && Number.isFinite(value)) {
        points.push({ at, value });
      }
    }
    return points;
  }

  return {
    async getInstanceMetricSeries(instanceId: string, windowDays: number, now: Date): Promise<MetricSeries> {
      if (!Number.isInteger(windowDays) || windowDays < 1) {
        throw new RangeError(`windowDays must be a whole number of at least 1 (got ${windowDays})`);
      }
      const end = now;
      const start = new Date(now.getTime() - windowDays * MS_PER_DAY);
      const [cpuDailyAverages, networkInDailySums, networkOutDailySums] = await Promise.all([
        dailySeries(instanceId, 'CPUUtilization', 'Average', start, end),
        dailySeries(instanceId, 'NetworkIn', 'Sum', start, end),
        dailySeries(instanceId, 'NetworkOut', 'Sum', start, end),
      ]);
      return { cpuDailyAverages, networkInDailySums, networkOutDailySums };
    },
  };
}

/** Asks AWS which account these credentials belong to. */
export async function fetchAccountId(sts: StsSender, deps: AwsDeps): Promise<string> {
  validateRetryPolicy(deps.policy);
  const response = await callAws('sts:GetCallerIdentity', () => sts.send(new GetCallerIdentityCommand({})), deps);
  const account = response.Account;
  if (typeof account !== 'string' || !/^\d{12}$/.test(account)) {
    throw new CloudApiError(
      'sts:GetCallerIdentity',
      { kind: 'unknown', retryable: false, code: 'InvalidAccountId' },
      1,
    );
  }
  return account;
}

/** Convenience for building AwsDeps from a logger and policy, with real time and randomness. */
export function createAwsDeps(
  logger: Logger,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): AwsDeps {
  validateRetryPolicy(policy);
  return { logger, policy, sleep, random };
}
