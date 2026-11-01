import { ConfigError, loadConfig } from '../../src/config/config';
import { REDACTED } from '../../src/logging/logger';
import { captureLogger } from '../helpers';

const ROLE = 'arn:aws:iam::123456789012:role/JanitorReadOnly';

function problemsFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('AWS settings: defaults', () => {
  it('scans us-east-1 with 5 attempts and no role or custom endpoint', () => {
    expect(loadConfig({}).aws).toEqual({ regions: ['us-east-1'], maxAttempts: 5 });
  });

  it('treats blank values as not set', () => {
    const config = loadConfig({ JANITOR_AWS_REGIONS: '  ', JANITOR_ROLE_ARN: ' ', JANITOR_EXTERNAL_ID: '', JANITOR_AWS_ENDPOINT: ' ', JANITOR_AWS_MAX_ATTEMPTS: '' });
    expect(config.aws).toEqual({ regions: ['us-east-1'], maxAttempts: 5 });
  });
});

describe('AWS settings: regions', () => {
  it('trims, removes repeats and empty parts, and keeps the order', () => {
    const config = loadConfig({ JANITOR_AWS_REGIONS: ' us-east-1 , eu-west-1,us-east-1,, ap-southeast-2 ' });
    expect(config.aws.regions).toEqual(['us-east-1', 'eu-west-1', 'ap-southeast-2']);
  });

  it.each(['us-east-1', 'eu-west-2', 'ap-southeast-2', 'us-gov-west-1', 'cn-north-1', 'il-central-1', 'sa-east-1'])(
    'accepts the region %s',
    (region) => {
      expect(loadConfig({ JANITOR_AWS_REGIONS: region }).aws.regions).toEqual([region]);
    },
  );

  it.each(['mars', 'US-EAST-1', 'us-east', 'us_east_1', 'us-east-123', 'us east 1', '1-east-us'])(
    'rejects the region %s and names it in the problem',
    (region) => {
      const problems = problemsFor({ JANITOR_AWS_REGIONS: `us-east-1,${region}` });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`"${region}"`);
    },
  );

  it('rejects a list that is only commas', () => {
    expect(problemsFor({ JANITOR_AWS_REGIONS: ',,,' })).toEqual(['JANITOR_AWS_REGIONS has no region in it']);
  });

  it('allows at most 30 regions', () => {
    const many = (count: number) => Array.from({ length: count }, (_u, i) => `us-east-${i + 1}`).join(',');
    expect(loadConfig({ JANITOR_AWS_REGIONS: many(30) }).aws.regions).toHaveLength(30);
    expect(problemsFor({ JANITOR_AWS_REGIONS: many(31) })).toEqual(['JANITOR_AWS_REGIONS lists 31 regions (the most allowed is 30)']);
  });

  it('does not add a second complaint about "no region" when the only entry was invalid', () => {
    expect(problemsFor({ JANITOR_AWS_REGIONS: 'mars' })).toHaveLength(1);
  });
});

describe('AWS settings: attempts and endpoint', () => {
  it.each([['1', 1], ['5', 5], ['10', 10], [' 3 ', 3]])('accepts %j attempts', (raw, expected) => {
    expect(loadConfig({ JANITOR_AWS_MAX_ATTEMPTS: raw }).aws.maxAttempts).toBe(expected);
  });

  it.each([['0', 'between 1 and 10'], ['11', 'between 1 and 10'], ['2.5', 'whole number'], ['many', 'must be a number']])(
    'rejects %j attempts',
    (raw, text) => {
      expect(problemsFor({ JANITOR_AWS_MAX_ATTEMPTS: raw })[0]).toContain(text);
    },
  );

  it.each(['http://127.0.0.1:5555', 'https://localhost:4566', ' http://moto:5000 '])('accepts the endpoint %j', (raw) => {
    expect(loadConfig({ JANITOR_AWS_ENDPOINT: raw }).aws.endpoint).toBe(raw.trim());
  });

  it.each([
    ['ftp://example.com', 'must start with http:// or https://'],
    ['file:///etc/passwd', 'must start with http:// or https://'],
    ['not a url', 'must be a full web address'],
    ['127.0.0.1:5555', 'must be a full web address'],
    ['localhost:4566', 'must start with http:// or https://'],
  ])('rejects the endpoint %j', (raw, text) => {
    expect(problemsFor({ JANITOR_AWS_ENDPOINT: raw })[0]).toContain(text);
  });
});

describe('AWS settings: assuming a role', () => {
  it('accepts a role together with an External ID, trimmed', () => {
    const config = loadConfig({ JANITOR_ROLE_ARN: ` ${ROLE} `, JANITOR_EXTERNAL_ID: ' ext-123 ' });
    expect(config.aws.roleArn).toBe(ROLE);
    expect(config.aws.externalId).toBe('ext-123');
  });

  it('refuses a role without an External ID (protection against the confused-deputy attack)', () => {
    expect(problemsFor({ JANITOR_ROLE_ARN: ROLE })).toEqual(['JANITOR_EXTERNAL_ID is required when JANITOR_ROLE_ARN is set']);
  });

  it('refuses an External ID without a role', () => {
    expect(problemsFor({ JANITOR_EXTERNAL_ID: 'ext-123' })).toEqual(['JANITOR_EXTERNAL_ID is set but JANITOR_ROLE_ARN is not']);
  });

  it.each([
    'arn:aws:iam::123456789012:role/JanitorReadOnly',
    'arn:aws:iam::123456789012:role/path/to/Role',
    'arn:aws-us-gov:iam::123456789012:role/Role',
    'arn:aws-cn:iam::123456789012:role/Role',
  ])('accepts the role ARN %s', (arn) => {
    expect(loadConfig({ JANITOR_ROLE_ARN: arn, JANITOR_EXTERNAL_ID: 'ext-123' }).aws.roleArn).toBe(arn);
  });

  it.each([
    'JanitorReadOnly',
    'arn:aws:iam::123:role/Role',
    'arn:aws:iam::123456789012:user/Someone',
    'arn:aws:s3:::bucket',
    'arn:aws:iam::123456789012:role/',
  ])('rejects the role ARN %s', (arn) => {
    expect(problemsFor({ JANITOR_ROLE_ARN: arn, JANITOR_EXTERNAL_ID: 'ext-123' })).toEqual([
      'JANITOR_ROLE_ARN must look like arn:aws:iam::123456789012:role/RoleName',
    ]);
  });

  it.each(['a', 'has space', 'semi;colon', 'x'.repeat(1225)])('rejects the External ID %j', (id) => {
    const problems = problemsFor({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: id });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('JANITOR_EXTERNAL_ID must be 2 to 1224 characters');
  });

  it('accepts External IDs at both length limits and with allowed punctuation', () => {
    expect(loadConfig({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: 'ab' }).aws.externalId).toBe('ab');
    expect(loadConfig({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: 'x'.repeat(1224) }).aws.externalId).toHaveLength(1224);
    expect(loadConfig({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: 'a+b=c,d.e@f:g/h_i-j' }).aws.externalId).toBe('a+b=c,d.e@f:g/h_i-j');
  });

  it('never repeats a rejected External ID in the error message', () => {
    const bad = 'secret value with spaces';
    try {
      loadConfig({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: bad });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(bad);
    }
  });

  it('keeps the External ID out of the logs, but not the role name', () => {
    const { logger, lines, records } = captureLogger();
    const config = loadConfig({ JANITOR_ROLE_ARN: ROLE, JANITOR_EXTERNAL_ID: 'ext-super-private' });
    logger.info('config loaded', { aws: config.aws });
    expect(lines[0]).not.toContain('ext-super-private');
    expect(records[0]?.meta).toMatchObject({ aws: { externalId: REDACTED, roleArn: ROLE } });
  });
});

describe('AWS settings: reporting problems together', () => {
  it('lists every AWS problem at once along with any others', () => {
    const problems = problemsFor({
      JANITOR_AWS_REGIONS: 'mars',
      JANITOR_AWS_MAX_ATTEMPTS: '0',
      JANITOR_AWS_ENDPOINT: 'ftp://x',
      JANITOR_ROLE_ARN: 'bad',
      JANITOR_UNATTACHED_DAYS: 'x',
    });
    expect(problems).toHaveLength(6); // region, attempts, endpoint, ARN format, missing External ID, unattached days
  });
});
