import { AccountCollection, CollectAccountOptions } from '../../src/app/collectAccount';
import { EXIT_HISTORY, EXIT_INCOMPLETE, EXIT_OK, runScan, ScanDeps } from '../../src/app/runScan';
import { MS_PER_DAY } from '../../src/core/history';
import { Resource } from '../../src/core/types';
import { createFileHistoryStore, HISTORY_FILE_VERSION, HistoryStore, HistoryStoreError } from '../../src/storage/historyStore';
import { makeIp, makeVolume, NOW } from '../builders';
import { fakeFileSystem, fsError } from '../fsFakes';
import { buildEvaluator, captureLogger } from '../helpers';
import { collection, config, failure } from '../scanFakes';

const FILE = 'h.json';

interface Setup {
  deps: ScanDeps;
  fs: ReturnType<typeof fakeFileSystem>;
  collectCalls: CollectAccountOptions[];
  records: Array<Record<string, unknown>>;
  setResult(result: AccountCollection): void;
  setNow(date: Date): void;
}

function setup(initialResult: AccountCollection, files: Record<string, string> = {}, withHistory = true): Setup {
  const fs = fakeFileSystem(files);
  const { logger, records } = captureLogger();
  let result = initialResult;
  let now = NOW;
  const collectCalls: CollectAccountOptions[] = [];
  const deps: ScanDeps = {
    collect: async (options) => {
      collectCalls.push(options);
      return result;
    },
    evaluator: buildEvaluator(logger),
    historyStore: withHistory ? createFileHistoryStore({ path: FILE, fileSystem: fs, logger }) : null,
    logger,
    now: () => now,
  };
  return { deps, fs, collectCalls, records, setResult: (r) => { result = r; }, setNow: (d) => { now = d; } };
}

const laterBy = (days: number): Date => new Date(NOW.getTime() + days * MS_PER_DAY);
const saved = (fs: Setup['fs']) => JSON.parse(fs.files.get(FILE) as string) as { version: number; history: Record<string, unknown[]> };

describe('a first scan', () => {
  const disk = makeVolume({ id: 'vol-1' });
  const ip = makeIp({ id: 'eip-1' });

  it('flags what needs no history, and only watches a disk that has just been seen', async () => {
    const s = setup(collection([disk, ip]));
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.problem).toBeUndefined();
    expect(outcome.output).toContain('FINDINGS (1)');
    expect(outcome.output).toContain('eip-1');
    expect(outcome.output).toContain('DISKS BEING WATCHED (1)');
    expect(outcome.output).toContain('vol-1 (us-east-1): unattached for 0 of 14 days');
  });

  it('remembers the disk for next time', async () => {
    const s = setup(collection([disk, ip]));
    await runScan(s.deps, { config: config(), format: 'text' });
    expect(saved(s.fs)).toEqual({
      version: HISTORY_FILE_VERSION,
      history: { 'vol-1': [{ observedAt: NOW.toISOString(), state: 'available' }] },
    });
  });

  it('hands the collector the settings, the clock and the logger', async () => {
    const s = setup(collection([]));
    const cfg = config({ JANITOR_AWS_REGIONS: 'us-east-1' });
    await runScan(s.deps, { config: cfg, format: 'text' });
    expect(s.collectCalls).toHaveLength(1);
    expect(s.collectCalls[0]).toMatchObject({ config: cfg, now: NOW });
  });

  it('passes extras (credentials, fake clients) through to the collector', async () => {
    const s = setup(collection([]));
    const sleep = async (): Promise<void> => undefined;
    await runScan({ ...s.deps, collectExtras: { sleep } }, { config: config(), format: 'text' });
    expect(s.collectCalls[0]?.sleep).toBe(sleep);
  });
});

describe('scans weeks apart', () => {
  it('flags the disk once it has been unattached long enough, at the right price', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1', sizeGb: 500 })]));
    await runScan(s.deps, { config: config(), format: 'text' }); // day 0

    s.setNow(laterBy(13));
    const day13 = await runScan(s.deps, { config: config(), format: 'text' });
    expect(day13.output).toContain('unattached for 13 of 14 days');
    expect(day13.output).toContain('FINDINGS (0)');

    s.setNow(laterBy(14));
    const day14 = await runScan(s.deps, { config: config(), format: 'text' });
    expect(day14.output).toContain('FINDINGS (1)');
    expect(day14.output).toContain('1. $40.00/month  Unattached disk: vol-1');
    expect(day14.output).not.toContain('DISKS BEING WATCHED');
  });

  it('keeps the history file small however many scans there are', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1' })]));
    for (let day = 0; day < 40; day += 1) {
      s.setNow(laterBy(day));
      await runScan(s.deps, { config: config(), format: 'text' });
    }
    expect(saved(s.fs).history['vol-1']).toHaveLength(2);
  });

  it('restarts the clock when a disk is attached and detached again', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1' })]));
    await runScan(s.deps, { config: config(), format: 'text' });
    s.setNow(laterBy(10));
    s.setResult(collection([makeVolume({ id: 'vol-1', state: 'in-use' })]));
    await runScan(s.deps, { config: config(), format: 'text' });
    s.setNow(laterBy(20));
    s.setResult(collection([makeVolume({ id: 'vol-1' })]));
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });
    expect(outcome.output).toContain('unattached for 0 of 14 days');
  });

  it('forgets a deleted disk after a complete scan', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1' })]));
    await runScan(s.deps, { config: config(), format: 'text' });
    s.setResult(collection([]));
    await runScan(s.deps, { config: config(), format: 'text' });
    expect(saved(s.fs).history).toEqual({});
  });

  it('does not watch a disk tagged janitor:ignore=true', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1', tags: { 'janitor:ignore': 'true' } })]));
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });
    expect(outcome.output).not.toContain('DISKS BEING WATCHED');
  });
});

describe('an incomplete scan', () => {
  const incomplete = (resources: Resource[] = []): AccountCollection =>
    collection(resources, { failures: [failure()], regionsScanned: [] });

  it('still prints a report, with a warning, and exits 3', async () => {
    const s = setup(incomplete());
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });
    expect(outcome.exitCode).toBe(EXIT_INCOMPLETE);
    expect(outcome.output).toContain('THIS SCAN IS INCOMPLETE');
    expect(outcome.problem).toContain('incomplete');
  });

  it('keeps what it remembered about resources it could not see this time', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1' })]));
    await runScan(s.deps, { config: config(), format: 'text' });

    s.setNow(laterBy(5));
    s.setResult(incomplete());
    await runScan(s.deps, { config: config(), format: 'text' });
    expect(Object.keys(saved(s.fs).history)).toEqual(['vol-1']);
  });

  it('counts a region that was never reached as incomplete even with no failure listed', async () => {
    const s = setup(collection([], { regionsScanned: ['us-east-1'] }));
    const outcome = await runScan(s.deps, { config: config({ JANITOR_AWS_REGIONS: 'us-east-1,eu-west-1' }), format: 'text' });
    expect(outcome.exitCode).toBe(EXIT_INCOMPLETE);
  });
});

describe('history problems', () => {
  it('a damaged history file stops the run before AWS is called and is left alone', async () => {
    const s = setup(collection([makeVolume()]), { [FILE]: '{ broken' });
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });

    expect(outcome).toMatchObject({ exitCode: EXIT_HISTORY, output: '' });
    expect(outcome.problem).toContain('corrupt');
    expect(s.collectCalls).toHaveLength(0);
    expect(s.fs.files.get(FILE)).toBe('{ broken');
    expect(s.records.some((r) => r.level === 'ERROR' && r.message === 'Cannot load the history file')).toBe(true);
  });

  it('failing to save still prints the report, then exits 4', async () => {
    const s = setup(collection([makeIp()]));
    s.fs.failOn.rename = fsError('ENOSPC');
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });

    expect(outcome.exitCode).toBe(EXIT_HISTORY);
    expect(outcome.output).toContain('FINDINGS (1)');
    expect(outcome.problem).toContain('unwritable');
    expect(s.records.some((r) => r.level === 'ERROR' && r.message === 'Cannot save the history file')).toBe(true);
  });

  it('a save failure outranks an incomplete scan in the exit code', async () => {
    const s = setup(collection([], { failures: [failure()], regionsScanned: [] }));
    s.fs.failOn.writeText = fsError('EACCES');
    expect((await runScan(s.deps, { config: config(), format: 'text' })).exitCode).toBe(EXIT_HISTORY);
  });

  it('an unexpected error from the store is not swallowed', async () => {
    const s = setup(collection([]));
    const broken: HistoryStore = { load: async () => { throw new TypeError('bug'); }, save: async () => undefined };
    await expect(runScan({ ...s.deps, historyStore: broken }, { config: config(), format: 'text' })).rejects.toThrow('bug');
  });

  it('an unexpected error while saving is not swallowed either', async () => {
    const s = setup(collection([]));
    const broken: HistoryStore = { load: async () => ({}), save: async () => { throw new TypeError('bug'); } };
    await expect(runScan({ ...s.deps, historyStore: broken }, { config: config(), format: 'text' })).rejects.toThrow('bug');
  });

  it('a store that raises HistoryStoreError itself is handled like the real one', async () => {
    const s = setup(collection([]));
    const store: HistoryStore = {
      load: async () => { throw new HistoryStoreError('unreadable', 'x.json', 'EACCES'); },
      save: async () => undefined,
    };
    expect((await runScan({ ...s.deps, historyStore: store }, { config: config(), format: 'text' })).exitCode).toBe(EXIT_HISTORY);
  });
});

describe('history switched off', () => {
  it('touches no file, never flags disks by age, and says why', async () => {
    const s = setup(collection([makeVolume({ id: 'vol-1' }), makeIp({ id: 'eip-1' })]), {}, false);
    const outcome = await runScan(s.deps, { config: config(), format: 'text' });
    expect(s.fs.calls).toEqual([]);
    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(outcome.output).toContain('history is turned off');
    expect(outcome.output).not.toContain('DISKS BEING WATCHED');
    expect(outcome.output).toContain('eip-1');
  });
});

describe('output format', () => {
  it('prints JSON when asked, and the totals match the text report', async () => {
    const s = setup(collection([makeIp({ id: 'eip-1' })]));
    const json = JSON.parse((await runScan(s.deps, { config: config(), format: 'json' })).output);
    expect(json.totals).toMatchObject({ findings: 1, monthlyUsd: 3.65 });
    const text = (await runScan(s.deps, { config: config(), format: 'text' })).output;
    expect(text).toContain('$3.65 per month');
  });
});

describe('logging', () => {
  it('logs the start and the end of the scan with the result', async () => {
    const s = setup(collection([makeIp()]));
    await runScan(s.deps, { config: config(), format: 'text' });
    const finished = s.records.find((r) => r.message === 'Scan finished');
    expect(finished?.meta).toMatchObject({ complete: true, findings: 1, exitCode: 0, failures: 0 });
    expect(s.records.some((r) => r.message === 'Scan started')).toBe(true);
  });
});
