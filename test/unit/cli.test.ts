import * as fs from 'fs';
import * as path from 'path';
import { AccountCollection, CollectAccountOptions } from '../../src/app/collectAccount';
import { runCli } from '../../src/cli/run';
import { USAGE } from '../../src/cli/args';
import { VERSION } from '../../src/cli/version';
import { makeIp, makeVolume, NOW } from '../builders';
import { fakeFileSystem, fsError } from '../fsFakes';
import { collection, failure } from '../scanFakes';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  logs: Array<Record<string, unknown>>;
  fs: ReturnType<typeof fakeFileSystem>;
  collectOptions: CollectAccountOptions[];
}

async function run(
  argv: string[],
  options: { env?: Record<string, string>; result?: AccountCollection | Error; files?: Record<string, string>; fsFail?: Parameters<typeof fakeFileSystem>[0] } = {},
): Promise<Run> {
  const fake = fakeFileSystem(options.files);
  const out: string[] = [];
  const err: string[] = [];
  const collectOptions: CollectAccountOptions[] = [];
  const result = options.result ?? collection([makeIp({ id: 'eip-1' }), makeVolume({ id: 'vol-1' })]);
  const code = await runCli({
    argv,
    env: options.env ?? {},
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    now: () => NOW,
    fileSystem: fake,
    newRunId: () => 'run-123',
    collect: async (o) => {
      collectOptions.push(o);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  const stderr = err.join('');
  const logs = stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, stdout: out.join(''), stderr, logs, fs: fake, collectOptions };
}

describe('help and version', () => {
  it('prints help to stdout and exits 0', async () => {
    const r = await run(['--help']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe(`${USAGE}\n`);
    expect(r.collectOptions).toHaveLength(0);
  });

  it('prints the version', async () => {
    const r = await run(['--version']);
    expect(r).toMatchObject({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it('the version matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('mistakes', () => {
  it('a bad option prints the problem and the usage to stderr, exit 2, no scan', async () => {
    const r = await run(['--colour']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Error: Unknown option "--colour"');
    expect(r.stderr).toContain('Usage:');
    expect(r.collectOptions).toHaveLength(0);
  });

  it('one bad setting is reported in singular, nothing is scanned', async () => {
    const r = await run([], { env: { JANITOR_AWS_REGIONS: 'mars' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('There is a problem with the settings');
    expect(r.stderr).toContain('"mars"');
    expect(r.collectOptions).toHaveLength(0);
  });

  it('several bad settings are all listed at once', async () => {
    const r = await run([], { env: { JANITOR_AWS_REGIONS: 'mars', JANITOR_AWS_MAX_ATTEMPTS: '0', JANITOR_UNATTACHED_DAYS: 'x' } });
    expect(r.stderr).toContain('There are problems with the settings');
    expect(r.stderr.match(/^ {2}- /gm)).toHaveLength(3);
  });

  it('never prints a rejected External ID', async () => {
    const r = await run([], { env: { JANITOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/R', JANITOR_EXTERNAL_ID: 'secret value with spaces' } });
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain('secret value with spaces');
  });
});

describe('a normal scan', () => {
  it('puts only the report on stdout and only JSON log lines on stderr', async () => {
    const r = await run(['scan']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('CLOUD WASTE JANITOR REPORT')).toBe(true);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout).not.toContain('"level"');
    expect(r.stderr.trim().split('\n').every((line) => line.startsWith('{'))).toBe(true);
  });

  it('tags every log line with the run id', async () => {
    const r = await run(['scan']);
    expect(r.logs.length).toBeGreaterThan(2);
    for (const log of r.logs) expect(log.runId).toBe('run-123');
  });

  it('prints JSON that can be piped straight into another tool', async () => {
    const r = await run(['scan', '--format', 'json']);
    expect(JSON.parse(r.stdout).totals.monthlyUsd).toBe(3.65);
  });

  it('remembers what it saw in the default history file', async () => {
    const r = await run([]);
    expect(r.fs.files.has('.janitor/history.json')).toBe(true);
    expect(JSON.parse(r.fs.files.get('.janitor/history.json') as string).history['vol-1']).toHaveLength(1);
  });

  it('uses the history file it is told to use', async () => {
    const r = await run(['--history-file', 'elsewhere/h.json']);
    expect(r.fs.files.has('elsewhere/h.json')).toBe(true);
    expect(r.fs.files.has('.janitor/history.json')).toBe(false);
  });

  it('touches no file with --no-history', async () => {
    const r = await run(['--no-history']);
    expect(r.fs.calls).toEqual([]);
    expect(r.stdout).toContain('history is turned off');
  });

  it('reads the settings from the environment it is given', async () => {
    const r = await run([], { env: { JANITOR_AWS_REGIONS: 'eu-west-1', JANITOR_UNATTACHED_DAYS: '3' } });
    expect(r.collectOptions[0]?.config.aws.regions).toEqual(['eu-west-1']);
    expect(r.collectOptions[0]?.config.rules.unattachedDiskDays).toBe(3);
  });

  it('honours the log level setting', async () => {
    const quiet = await run([], { env: { JANITOR_LOG_LEVEL: 'ERROR' } });
    expect(quiet.logs).toEqual([]);
    const chatty = await run([], { env: { JANITOR_LOG_LEVEL: 'DEBUG' } });
    expect(chatty.logs.some((l) => l.level === 'DEBUG')).toBe(true);
  });

  it('keeps AWS settings and secrets out of the log lines', async () => {
    const r = await run([], { env: { JANITOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/R', JANITOR_EXTERNAL_ID: 'ext-super-private' } });
    expect(r.stderr).not.toContain('ext-super-private');
  });
});

describe('exit codes', () => {
  it('3 when the scan was incomplete, with the report still printed', async () => {
    const r = await run([], { result: collection([], { failures: [failure()], regionsScanned: [] }) });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('THIS SCAN IS INCOMPLETE');
    expect(r.stderr).toContain('The scan was incomplete');
  });

  it('4 when the history file is damaged, and nothing is scanned', async () => {
    const r = await run([], { files: { '.janitor/history.json': 'nope' } });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('corrupt');
    expect(r.collectOptions).toHaveLength(0);
  });

  it('4 when the history cannot be saved, with the report still printed', async () => {
    const fake = fakeFileSystem();
    fake.failOn.writeText = fsError('EACCES');
    const out: string[] = [];
    const code = await runCli({
      argv: [], env: {}, io: { stdout: (t) => out.push(t), stderr: () => undefined }, now: () => NOW, fileSystem: fake,
      collect: async () => collection([makeIp()]),
    });
    expect(code).toBe(4);
    expect(out.join('')).toContain('FINDINGS (1)');
  });

  it('1 for a bug, which is logged in full and explained briefly', async () => {
    const r = await run([], { result: new TypeError('boom') });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unexpected problem');
    const errorLog = r.logs.find((l) => l.message === 'Unexpected failure');
    expect(errorLog?.level).toBe('ERROR');
    expect(JSON.stringify(errorLog?.meta)).toContain('boom');
  });
});

describe('defaults', () => {
  it('runs with only the required parts supplied (real clock and run id)', async () => {
    const out: string[] = [];
    const code = await runCli({
      argv: ['--no-history'], env: {}, io: { stdout: (t) => out.push(t), stderr: () => undefined },
      collect: async () => collection([]),
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain('CLOUD WASTE JANITOR REPORT');
  });

  it('passes collector extras through', async () => {
    const sleep = async (): Promise<void> => undefined;
    const seen: CollectAccountOptions[] = [];
    await runCli({
      argv: ['--no-history'], env: {}, io: { stdout: () => undefined, stderr: () => undefined },
      collect: async (o) => { seen.push(o); return collection([]); }, collectExtras: { sleep },
    });
    expect(seen[0]?.sleep).toBe(sleep);
  });
});
