/**
 * Command-line arguments: four flags, parsed by hand.
 *
 * No library on purpose: fewer dependencies, nothing to go stale, and every mistake gets a
 * plain-words message. Flags never carry secrets: settings stay in environment variables.
 */

import { OutputFormat } from '../report/types';

export type { OutputFormat };

export const DEFAULT_HISTORY_FILE = '.janitor/history.json';

export type ParsedArgs =
  | {
      kind: 'scan';
      format: OutputFormat;
      /** null means "do not read or write a history file". */
      historyFile: string | null;
    }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export const USAGE = `Cloud Waste Janitor: finds forgotten, costly cloud resources (read-only).

Usage:
  cloud-waste-janitor scan [options]

Options:
  --format <text|json>     How to print the report (default: text)
  --history-file <path>    Where to remember what was seen (default: ${DEFAULT_HISTORY_FILE})
  --no-history             Do not read or write a history file
  -h, --help               Show this help
  -v, --version            Show the version

Settings (environment variables): JANITOR_AWS_REGIONS, JANITOR_ROLE_ARN, JANITOR_EXTERNAL_ID,
JANITOR_AWS_MAX_ATTEMPTS, JANITOR_LOG_LEVEL and the rule thresholds. See the README.

Exit codes: 0 done, 1 unexpected error, 2 bad usage or settings, 3 scan incomplete, 4 history file problem.`;

function fail(message: string): ParsedArgs {
  return { kind: 'error', message };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Help and version win wherever they appear, even next to a mistake.
  if (argv.includes('-h') || argv.includes('--help')) return { kind: 'help' };
  if (argv.includes('-v') || argv.includes('--version')) return { kind: 'version' };

  let command: string | null = null;
  let format: OutputFormat | null = null;
  let historyFile: string | null = null;
  let noHistory = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (arg === '--no-history') {
      if (noHistory) return fail('--no-history was given twice');
      noHistory = true;
      continue;
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      if (format !== null) return fail('--format was given twice');
      const value = arg === '--format' ? argv[(i += 1)] : arg.slice('--format='.length);
      if (value !== 'text' && value !== 'json') {
        return fail(`--format must be "text" or "json" (got ${value === undefined ? 'nothing' : `"${value}"`})`);
      }
      format = value;
      continue;
    }

    if (arg === '--history-file' || arg.startsWith('--history-file=')) {
      if (historyFile !== null) return fail('--history-file was given twice');
      const value = arg === '--history-file' ? argv[(i += 1)] : arg.slice('--history-file='.length);
      if (value === undefined || value.trim() === '' || value.startsWith('--')) {
        return fail('--history-file needs a file path');
      }
      historyFile = value;
      continue;
    }

    if (arg.startsWith('-')) return fail(`Unknown option "${arg}". Try --help.`);

    if (command !== null) return fail(`Unexpected extra argument "${arg}". Try --help.`);
    command = arg;
  }

  if (command !== null && command !== 'scan') {
    return fail(`Unknown command "${command}". The only command is "scan". Try --help.`);
  }
  if (noHistory && historyFile !== null) return fail('--no-history and --history-file cannot be used together');

  return {
    kind: 'scan',
    format: format ?? 'text',
    historyFile: noHistory ? null : (historyFile ?? DEFAULT_HISTORY_FILE),
  };
}
