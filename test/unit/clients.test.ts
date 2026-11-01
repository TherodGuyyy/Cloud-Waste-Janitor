import {
  buildAssumeRoleParams,
  CONNECTION_TIMEOUT_MS,
  createAwsClients,
  createCredentialsProvider,
  REQUEST_TIMEOUT_MS,
  ROLE_SESSION_NAME,
  ROLE_SESSION_SECONDS,
} from '../../src/adapters/aws/clients';

const FAKE_CREDENTIALS = { accessKeyId: 'testing', secretAccessKey: 'testing' };

interface ResolvedConfig {
  region: () => Promise<string>;
  maxAttempts: () => Promise<number>;
  endpoint?: () => Promise<{ hostname: string; port?: number; protocol: string }>;
}

function configOf(client: unknown): ResolvedConfig {
  return (client as { config: ResolvedConfig }).config;
}

describe('createAwsClients', () => {
  it('builds all three clients for the requested region', async () => {
    const clients = createAwsClients({ region: 'eu-west-1', credentials: FAKE_CREDENTIALS });
    expect(await configOf(clients.ec2).region()).toBe('eu-west-1');
    expect(await configOf(clients.cloudwatch).region()).toBe('eu-west-1');
    expect(await configOf(clients.sts).region()).toBe('eu-west-1');
  });

  it('turns off the SDK retries so only our own logged retries happen', async () => {
    const clients = createAwsClients({ region: 'us-east-1', credentials: FAKE_CREDENTIALS });
    expect(await configOf(clients.ec2).maxAttempts()).toBe(1);
    expect(await configOf(clients.cloudwatch).maxAttempts()).toBe(1);
    expect(await configOf(clients.sts).maxAttempts()).toBe(1);
  });

  it('uses a custom endpoint when one is given (tests and local fakes only)', async () => {
    const clients = createAwsClients({ region: 'us-east-1', endpoint: 'http://127.0.0.1:5555', credentials: FAKE_CREDENTIALS });
    const endpoint = await configOf(clients.ec2).endpoint?.();
    expect(endpoint?.hostname).toBe('127.0.0.1');
    expect(endpoint?.port).toBe(5555);
    expect(endpoint?.protocol).toBe('http:');
  });

  it('has no custom endpoint by default', () => {
    const clients = createAwsClients({ region: 'us-east-1', credentials: FAKE_CREDENTIALS });
    expect(configOf(clients.ec2).endpoint).toBeUndefined();
  });

  it('works without explicit credentials (the SDK default chain is used)', () => {
    expect(() => createAwsClients({ region: 'us-east-1' })).not.toThrow();
  });

  it('has sensible timeouts', () => {
    expect(CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe('assume-role helpers', () => {
  it('builds the exact request, with the External ID and a one-hour session', () => {
    expect(buildAssumeRoleParams('arn:aws:iam::123456789012:role/JanitorReadOnly', 'ext-123')).toEqual({
      RoleArn: 'arn:aws:iam::123456789012:role/JanitorReadOnly',
      RoleSessionName: 'cloud-waste-janitor',
      ExternalId: 'ext-123',
      DurationSeconds: 3600,
    });
    expect(ROLE_SESSION_NAME).toBe('cloud-waste-janitor');
    expect(ROLE_SESSION_SECONDS).toBe(3600);
  });

  it('returns nothing when no role is configured', () => {
    expect(createCredentialsProvider({}, 'us-east-1')).toBeUndefined();
  });

  it('refuses a role without an External ID (protection against the confused-deputy attack)', () => {
    expect(() => createCredentialsProvider({ roleArn: 'arn:aws:iam::123456789012:role/R' }, 'us-east-1')).toThrow('External ID is required');
  });

  it('returns a credentials provider when role and External ID are both set', () => {
    const provider = createCredentialsProvider(
      { roleArn: 'arn:aws:iam::123456789012:role/R', externalId: 'ext-123', endpoint: 'http://127.0.0.1:5555' },
      'us-east-1',
      FAKE_CREDENTIALS,
    );
    expect(typeof provider).toBe('function');
  });

  it('also works without an endpoint or master credentials', () => {
    const provider = createCredentialsProvider({ roleArn: 'arn:aws:iam::123456789012:role/R', externalId: 'ext-123' }, 'us-east-1');
    expect(typeof provider).toBe('function');
  });
});
