/**
 * Least privilege, proven by tests: the read-only policy we tell customers to create
 * must allow exactly what the code uses, and nothing that could change their account.
 */

import * as path from 'path';
import { listTypeScriptFiles, read, ROOT, SRC } from '../sourceFiles';

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource?: string | string[];
  Principal?: unknown;
  Condition?: Record<string, Record<string, string>>;
}

function loadPolicy(name: string): { Version: string; Statement: Statement[] } {
  return JSON.parse(read(path.join(ROOT, 'policies', name))) as { Version: string; Statement: Statement[] };
}

function actionsOf(statement: Statement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

const policy = loadPolicy('collector-readonly-policy.json');
const allowed = policy.Statement.flatMap(actionsOf);

/** Which IAM action each SDK command needs. sts:GetCallerIdentity never needs permission. */
function iamActionFor(commandName: string): string | null {
  if (commandName === 'GetCallerIdentity') return null;
  if (commandName === 'GetMetricStatistics') return 'cloudwatch:GetMetricStatistics';
  if (commandName.startsWith('Describe')) return `ec2:${commandName}`;
  throw new Error(`No IAM action is mapped for the SDK command "${commandName}". Add it here, and to the policy if it is read-only.`);
}

function commandsUsedByCode(): string[] {
  const names = new Set<string>();
  for (const file of listTypeScriptFiles(SRC)) {
    for (const match of read(file).matchAll(/new\s+(\w+)Command\s*\(/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('collector read-only policy', () => {
  it('is a valid policy document', () => {
    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement.length).toBeGreaterThan(0);
  });

  it('only allows, never denies or does anything else', () => {
    for (const statement of policy.Statement) expect(statement.Effect).toBe('Allow');
  });

  it('uses no wildcards in actions', () => {
    for (const action of allowed) expect(action).not.toContain('*');
  });

  it('allows only read actions: ec2 Describe and cloudwatch GetMetricStatistics', () => {
    for (const action of allowed) expect(action).toMatch(/^(ec2:Describe[A-Za-z]+|cloudwatch:GetMetricStatistics)$/);
  });

  it('allows nothing that could create, change, stop, tag or delete anything', () => {
    const forbidden = /(Create|Delete|Terminate|Stop|Start|Modify|Run|Put|Allocate|Release|Associate|Disassociate|Attach|Detach|Reboot|Tag|Untag|Copy|Register|Deregister|Revoke|Authorize|Enable|Disable|Update|Reset|Import|Assume|PassRole)/;
    for (const action of allowed) expect(action.split(':')[1]).not.toMatch(forbidden);
  });

  it('has no duplicate actions', () => {
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it('allows exactly the actions the code uses: nothing missing, nothing extra', () => {
    const needed = commandsUsedByCode()
      .map(iamActionFor)
      .filter((action): action is string => action !== null)
      .sort();
    expect([...allowed].sort()).toEqual(needed);
  });

  it('the code uses the expected set of SDK commands (a new one needs a deliberate review)', () => {
    expect(commandsUsedByCode()).toEqual([
      'DescribeAddresses',
      'DescribeImages',
      'DescribeInstances',
      'DescribeSnapshots',
      'DescribeVolumes',
      'GetCallerIdentity',
      'GetMetricStatistics',
    ]);
  });
});

describe('trust policy example', () => {
  const trust = loadPolicy('trust-policy.example.json');

  it('lets one principal assume the role, and only with an External ID', () => {
    expect(trust.Statement).toHaveLength(1);
    const statement = trust.Statement[0] as Statement;
    expect(statement.Effect).toBe('Allow');
    expect(statement.Action).toBe('sts:AssumeRole');
    expect(statement.Condition?.StringEquals?.['sts:ExternalId']).toBeDefined();
  });

  it('is clearly marked as an example with placeholders to replace', () => {
    expect(JSON.stringify(trust)).toContain('REPLACE_WITH_');
  });

  it('does not allow just anyone to assume the role', () => {
    const statement = trust.Statement[0] as Statement;
    expect(JSON.stringify(statement.Principal)).not.toBe('"*"');
    expect(JSON.stringify(statement.Principal)).not.toContain('"AWS":"*"');
  });
});
