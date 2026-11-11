/**
 * The real command-line code (runCli) against moto, with a real history file on disk.
 * The clock is moved forward to simulate weeks passing.
 */

import { AllocateAddressCommand, CreateSnapshotCommand, CreateVolumeCommand, EC2Client } from '@aws-sdk/client-ec2';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { runCli } from '../../src/cli/run';
import { MS_PER_DAY } from '../../src/core/history';

const ENDPOINT = process.env.MOTO_ENDPOINT as string;
const CREDENTIALS = { accessKeyId: 'testing', secretAccessKey: 'testing' };

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function janitor(args: string[], now: Date, extraEnv: Record<string, string> = {}): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv: args,
    env: { JANITOR_AWS_ENDPOINT: ENDPOINT, JANITOR_AWS_MAX_ATTEMPTS: '1', ...extraEnv },
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    now: () => now,
    collectExtras: { credentials: CREDENTIALS, sleep: async () => undefined },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

let dir: string;
let historyFile: string;

beforeEach(async () => {
  const response = await fetch(`${ENDPOINT}/moto-api/reset`, { method: 'POST' });
  if (!response.ok) throw new Error(`moto reset failed: HTTP ${response.status}`);
  const ec2 = new EC2Client({ region: 'us-east-1', endpoint: ENDPOINT, credentials: CREDENTIALS, maxAttempts: 1 });
  const volume = await ec2.send(new CreateVolumeCommand({ AvailabilityZone: 'us-east-1a', Size: 500, VolumeType: 'gp3' }));
  await ec2.send(new CreateSnapshotCommand({ VolumeId: volume.VolumeId as string }));
  await ec2.send(new AllocateAddressCommand({ Domain: 'vpc' }));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'janitor-cli-'));
  historyFile = path.join(dir, 'history.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the report across weeks', () => {
  it('day 0: finds the idle IP, only watches the disk, and writes the history file', async () => {
    const day0 = new Date();
    const result = await janitor(['--format', 'json', '--history-file', historyFile], day0);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    const rules = report.findings.map((f: { ruleId: string }) => f.ruleId);
    expect(rules).toContain('unused-ip');
    expect(rules).not.toContain('unattached-disk');
    expect(report.watching.some((w: { daysUnattached: number }) => w.daysUnattached === 0)).toBe(true);
    expect((await fs.stat(historyFile)).isFile()).toBe(true);
  });

  it('day 20 and day 120: the disk, then the snapshot, are flagged with prices', async () => {
    const day0 = new Date();
    await janitor(['--history-file', historyFile], day0);

    const day20 = await janitor(['--format', 'json', '--history-file', historyFile], new Date(day0.getTime() + 20 * MS_PER_DAY));
    const report20 = JSON.parse(day20.stdout);
    const disk = report20.findings.find((f: { ruleId: string }) => f.ruleId === 'unattached-disk');
    expect(disk.estimate).toMatchObject({ ok: true, monthlyUsd: 40 });
    expect(report20.findings.map((f: { ruleId: string }) => f.ruleId)).not.toContain('old-snapshot');

    const day120 = await janitor(['--format', 'json', '--history-file', historyFile], new Date(day0.getTime() + 120 * MS_PER_DAY));
    const rules120 = JSON.parse(day120.stdout).findings.map((f: { ruleId: string }) => f.ruleId);
    expect(rules120).toEqual(expect.arrayContaining(['unattached-disk', 'old-snapshot', 'unused-ip']));
  });

  it('prints a readable report with a total', async () => {
    const day0 = new Date();
    await janitor(['--history-file', historyFile], day0);
    const result = await janitor(['--history-file', historyFile], new Date(day0.getTime() + 20 * MS_PER_DAY));
    expect(result.stdout).toContain('POTENTIAL SAVINGS');
    expect(result.stdout).toContain('Unattached disk');
    expect(result.stdout).toMatch(/\$\d+\.\d{2} per month/);
  });
});

describe('failure modes with the real SDK and a real disk', () => {
  it('an unreachable AWS gives exit 3 and an incomplete report, without touching the history', async () => {
    const result = await janitor(['--history-file', historyFile], new Date(), { JANITOR_AWS_ENDPOINT: 'http://127.0.0.1:1' });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('THIS SCAN IS INCOMPLETE');
    expect(result.stdout).toContain('AWS could not be reached');
  });

  it('a damaged history file stops the run with exit 4', async () => {
    await fs.writeFile(historyFile, '{"version": 1');
    const result = await janitor(['--history-file', historyFile], new Date());
    expect(result.code).toBe(4);
    expect(await fs.readFile(historyFile, 'utf8')).toBe('{"version": 1');
  });
});
