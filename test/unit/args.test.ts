import { DEFAULT_HISTORY_FILE, parseArgs, USAGE } from '../../src/cli/args';

describe('parseArgs: normal use', () => {
  it('no arguments means scan with text output and the default history file', () => {
    expect(parseArgs([])).toEqual({ kind: 'scan', format: 'text', historyFile: DEFAULT_HISTORY_FILE });
  });

  it('accepts the scan command explicitly', () => {
    expect(parseArgs(['scan'])).toEqual({ kind: 'scan', format: 'text', historyFile: DEFAULT_HISTORY_FILE });
  });

  it.each([
    [['scan', '--format', 'json'], 'json'],
    [['scan', '--format=json'], 'json'],
    [['--format', 'text'], 'text'],
    [['--format=text', 'scan'], 'text'],
  ])('reads the format from %j', (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject({ kind: 'scan', format: expected });
  });

  it('reads a history file in both spellings', () => {
    expect(parseArgs(['--history-file', 'a/b.json'])).toMatchObject({ historyFile: 'a/b.json' });
    expect(parseArgs(['--history-file=c.json'])).toMatchObject({ historyFile: 'c.json' });
  });

  it('--no-history turns the history file off', () => {
    expect(parseArgs(['scan', '--no-history'])).toEqual({ kind: 'scan', format: 'text', historyFile: null });
  });

  it('accepts flags in any order', () => {
    expect(parseArgs(['--no-history', '--format', 'json', 'scan'])).toEqual({ kind: 'scan', format: 'json', historyFile: null });
  });
});

describe('parseArgs: help and version win over everything else', () => {
  it.each([['-h'], ['--help'], ['scan', '--help'], ['--bogus', '--help']])('%j shows help', (...argv) => {
    expect(parseArgs(argv.flat())).toEqual({ kind: 'help' });
  });

  it.each([['-v'], ['--version'], ['scan', '--version']])('%j shows the version', (...argv) => {
    expect(parseArgs(argv.flat())).toEqual({ kind: 'version' });
  });
});

describe('parseArgs: mistakes get plain messages', () => {
  const message = (argv: string[]): string => {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'error') throw new Error(`expected an error, got ${JSON.stringify(parsed)}`);
    return parsed.message;
  };

  it('unknown option', () => expect(message(['--colour'])).toContain('Unknown option "--colour"'));
  it('unknown command', () => expect(message(['delete'])).toContain('Unknown command "delete"'));
  it('extra argument', () => expect(message(['scan', 'now'])).toContain('Unexpected extra argument "now"'));
  it('bad format', () => expect(message(['--format', 'xml'])).toContain('got "xml"'));
  it('missing format value', () => expect(message(['--format'])).toContain('got nothing'));
  it('bad format in = spelling', () => expect(message(['--format='])).toContain('got ""'));
  it('format given twice', () => expect(message(['--format', 'json', '--format=text'])).toContain('twice'));
  it('history file given twice', () => expect(message(['--history-file', 'a', '--history-file', 'b'])).toContain('twice'));
  it('no-history given twice', () => expect(message(['--no-history', '--no-history'])).toContain('twice'));
  it('missing history path', () => expect(message(['--history-file'])).toContain('needs a file path'));
  it('blank history path', () => expect(message(['--history-file='])).toContain('needs a file path'));
  it('history path that is really another flag', () => expect(message(['--history-file', '--no-history'])).toContain('needs a file path'));
  it('conflicting history options', () => expect(message(['--no-history', '--history-file', 'x'])).toContain('cannot be used together'));
  it('short unknown flag', () => expect(message(['-x'])).toContain('Unknown option "-x"'));
});

describe('usage text', () => {
  it('mentions every option and every exit code', () => {
    for (const text of ['--format', '--history-file', '--no-history', '--help', '--version', '0 done', '3 scan incomplete', '4 history file problem']) {
      expect(USAGE).toContain(text);
    }
  });
});
