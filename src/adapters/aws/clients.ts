/**
 * Building the AWS clients.
 *
 * Choices made here, and why:
 *  - maxAttempts is 1: the SDK must not retry on its own. Our own retry layer
 *    (src/resilience/retry.ts) does it, so every retry is logged and counted.
 *  - Timeouts are set so one hung connection cannot hang the whole run.
 *  - Credentials come from the standard AWS environment variables by default,
 *    or from a short-lived assumed role (with a required External ID).
 *    Nothing is ever read from files in this project.
 */

import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { EC2Client, EC2ClientConfig } from '@aws-sdk/client-ec2';
import { STSClient } from '@aws-sdk/client-sts';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { AwsConfig } from '../../config/config';

export type AwsCredentialsOption = EC2ClientConfig['credentials'];

export interface AwsClientOptions {
  region: string;
  /** Only for tests and local fakes such as moto. */
  endpoint?: string;
  /** When omitted, the SDK's default chain is used (environment variables and so on). */
  credentials?: AwsCredentialsOption;
}

export interface AwsClients {
  ec2: EC2Client;
  cloudwatch: CloudWatchClient;
  sts: STSClient;
}

export const CONNECTION_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const ROLE_SESSION_NAME = 'cloud-waste-janitor';
export const ROLE_SESSION_SECONDS = 3_600;

export function createAwsClients(options: AwsClientOptions): AwsClients {
  const common = {
    region: options.region,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
  };
  return {
    ec2: new EC2Client(common),
    cloudwatch: new CloudWatchClient(common),
    sts: new STSClient(common),
  };
}

export interface AssumeRoleParams {
  RoleArn: string;
  RoleSessionName: string;
  ExternalId: string;
  DurationSeconds: number;
}

/** The exact request sent to STS when assuming the customer's role. */
export function buildAssumeRoleParams(roleArn: string, externalId: string): AssumeRoleParams {
  return {
    RoleArn: roleArn,
    RoleSessionName: ROLE_SESSION_NAME,
    ExternalId: externalId,
    DurationSeconds: ROLE_SESSION_SECONDS,
  };
}

/**
 * Returns a credentials provider that assumes the configured role (and renews it
 * automatically), or undefined when no role is configured.
 *
 * Throws if a role is set without an External ID. Config validation already
 * prevents that, this is the second lock on the same door.
 */
export function createCredentialsProvider(
  aws: Pick<AwsConfig, 'roleArn' | 'externalId' | 'endpoint'>,
  region: string,
  masterCredentials?: AwsCredentialsOption,
): AwsCredentialsOption | undefined {
  if (aws.roleArn === undefined) return undefined;
  if (aws.externalId === undefined) {
    throw new Error('An External ID is required when a role is configured');
  }
  return fromTemporaryCredentials({
    ...(masterCredentials !== undefined ? { masterCredentials } : {}),
    params: buildAssumeRoleParams(aws.roleArn, aws.externalId),
    clientConfig: {
      region,
      maxAttempts: 1,
      ...(aws.endpoint !== undefined ? { endpoint: aws.endpoint } : {}),
    },
  });
}
