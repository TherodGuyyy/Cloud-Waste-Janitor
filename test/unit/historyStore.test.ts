import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { nodeFileSystem } from '../../src/storage/fileSystem';
import {
  createFileHistoryStore,
  HISTORY_FILE_VERSION,
  HistoryStoreError,
  MAX_HISTORY_FILE_CHARS,
  parseHistoryFile,
} from '../../src/storage/historyStore';
import { ObservationHistory } from '../../src/core/types';
import { fakeFileSystem, fsError } from '../fsFakes';
import { captureLogger } from '../helpers';

const FILE = '.janitor/history.json';
const SAMPLE: ObservationHistory = { 'vol-1': [{ observedAt: '2026-10-01T00:00:00.000Z', state: 'available' }] };

function store(fake = fakeFileSystem(), filePath = FILE) {
  const { logger, records } = captureLogger();
  return { fake, records, store: createFileHistoryStore({ path: filePath, fileSystem: fake, logger }) };
}

async function failure(promise: Promise<unknown>): Promise<HistoryStoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HistoryStoreError) return error;
    throw error;
  }
  throw new Error('expected a HistoryStoreError');
}

describe('loading', () => {
  it('a missing file is a normal first run and gives an empty history', async () => {
    const { store: s, records } = store();
    await expect(s.load()).resolves.toEqual({});
    expect(records.some((r) => r.message === 'No history file yet, starting a new one')).toBe(true);
  });

  it('reads back what was saved', async () => {
    const { store: s } = store();
    await s.save(SAMPLE);
    await expect(s.load()).resolves.toEqual(SAMPLE);
  });

  it.each([
    ['not JSON', 'this is not json'],
    ['a JSON list', '[]'],
    ['null', 'null'],
    ['the wrong version', JSON.stringify({ version: 99, history: {} })],
    ['no history part', JSON.stringify({ version: HISTORY_FILE_VERSION })],
    ['a history that is a list', JSON.stringify({ version: HISTORY_FILE_VERSION, history: [] })],
    ['an entry that is not a list', JSON.stringify({ version: HISTORY_FILE_VERSION, history: { a: 'x' } })],
    ['an observation without a state', JSON.stringify({ version: HISTORY_FILE_VERSION, history: { a: [{ observedAt: 'x' }] } })],
    ['an observation that is null', JSON.stringify({ version: HISTORY_FILE_VERSION, history: { a: [null] } })],
    ['a __proto__ key', `{"version":${HISTORY_FILE_VERSION},"history":{"__proto__":[]}}`],
  ])('refuses a damaged file: %s', async (_name, content) => {
    const { store: s, fake } = store(fakeFileSystem({ [FILE]: content }));
    const error = await failure(s.load());
    expect(error.kind).toBe('corrupt');
    expect(error.filePath).toBe(FILE);
    expect(fake.files.get(FILE)).toBe(content); // never overwritten
  });

  it('refuses an absurdly large file', async () => {
    const { store: s } = store(fakeFileSystem({ [FILE]: ' '.repeat(MAX_HISTORY_FILE_CHARS + 1) }));
    expect((await failure(s.load())).kind).toBe('corrupt');
  });

  it.each(['EACCES', 'EISDIR', 'EPERM', 'EIO'])('reports an unreadable file (%s)', async (code) => {
    const fake = fakeFileSystem();
    fake.failOn.readText = fsError(code);
    const error = await failure(store(fake).store.load());
    expect(error.kind).toBe('unreadable');
    expect(error.message).toContain(code);
  });

  it('describes a failure without a code using its message', async () => {
    const fake = fakeFileSystem();
    fake.failOn.readText = new Error('disk on fire');
    expect((await failure(store(fake).store.load())).message).toContain('disk on fire');
  });

  it('describes a failure that is not even an Error', async () => {
    const fake = fakeFileSystem();
    fake.failOn.readText = 'weird';
    expect((await failure(store(fake).store.load())).message).toContain('weird');
  });
});

describe('saving', () => {
  it('writes a temporary file and then renames it, so a crash cannot leave half a file', async () => {
    const { store: s, fake } = store();
    await s.save(SAMPLE);
    expect(fake.calls.map((c) => c.op)).toEqual(['makeDirectory', 'writeText', 'rename']);
    expect(fake.calls[1]?.path).toBe(`${FILE}.tmp`);
    expect(fake.files.has(`${FILE}.tmp`)).toBe(false);
    expect(fake.directories).toEqual(['.janitor']);
    expect(JSON.parse(fake.files.get(FILE) as string)).toEqual({ version: HISTORY_FILE_VERSION, history: SAMPLE });
  });

  it('a failed write leaves the old file untouched and cleans up', async () => {
    const fake = fakeFileSystem({ [FILE]: 'OLD' });
    const { store: s } = store(fake);
    fake.failOn.rename = fsError('EACCES');
    fake.files.set(`${FILE}.tmp`, 'partial');
    const error = await failure(s.save(SAMPLE));
    expect(error.kind).toBe('unwritable');
    expect(fake.files.get(FILE)).toBe('OLD');
    expect(fake.files.has(`${FILE}.tmp`)).toBe(false);
  });

  it.each(['makeDirectory', 'writeText'] as const)('reports a failure in %s', async (op) => {
    const fake = fakeFileSystem();
    fake.failOn[op] = fsError('ENOSPC');
    const error = await failure(store(fake).store.save(SAMPLE));
    expect(error).toMatchObject({ kind: 'unwritable' });
    expect(error.message).toContain('ENOSPC');
  });

  it('is quiet when there was no temporary file to clean up', async () => {
    const fake = fakeFileSystem();
    fake.failOn.writeText = fsError('EACCES');
    const { store: s, records } = store(fake);
    await failure(s.save(SAMPLE));
    expect(records.filter((r) => r.level === 'WARN')).toEqual([]);
  });

  it('warns when cleaning up fails for a real reason', async () => {
    const fake = fakeFileSystem();
    fake.failOn.writeText = fsError('EACCES');
    fake.failOn.remove = fsError('EBUSY');
    const { store: s, records } = store(fake);
    await failure(s.save(SAMPLE));
    expect(records.filter((r) => r.level === 'WARN')).toHaveLength(1);
  });
});

describe('construction', () => {
  it.each(['', '   '])('refuses an empty path %j', (bad) => {
    expect(() => store(fakeFileSystem(), bad)).toThrow(HistoryStoreError);
  });
});

describe('parseHistoryFile', () => {
  it('copies only the known fields of each observation', () => {
    const result = parseHistoryFile({ version: 1, history: { a: [{ observedAt: 't', state: 's', extra: 'x' }] } });
    expect(result).toEqual({ ok: true, history: { a: [{ observedAt: 't', state: 's' }] } });
  });
});

describe('on a real disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'janitor-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates missing folders, saves, loads and leaves no temporary file behind', async () => {
    const file = path.join(dir, 'deep', 'er', 'history.json');
    const { logger } = captureLogger();
    const real = createFileHistoryStore({ path: file, fileSystem: nodeFileSystem, logger });

    await expect(real.load()).resolves.toEqual({});
    await real.save(SAMPLE);
    await expect(real.load()).resolves.toEqual(SAMPLE);
    expect(await fs.readdir(path.dirname(file))).toEqual(['history.json']);
  });

  it('reports a folder where the file should be as unreadable', async () => {
    const { logger } = captureLogger();
    const real = createFileHistoryStore({ path: dir, fileSystem: nodeFileSystem, logger });
    expect((await failure(real.load())).kind).toBe('unreadable');
  });

  it('creates the file readable only by its owner (on systems that support it)', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(dir, 'history.json');
    const { logger } = captureLogger();
    await createFileHistoryStore({ path: file, fileSystem: nodeFileSystem, logger }).save(SAMPLE);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
