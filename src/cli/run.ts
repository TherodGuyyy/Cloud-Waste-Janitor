/**
 * The command-line program, minus the real process: arguments, environment, output and the clock
 * all come in as parameters, so the whole thing is tested without starting a process.
 * Returns the exit code instead of exiting.
 */

import { randomUUID } from 'crypto';
import { collectAccount } from '../app/collectAccount';
import { EXIT_UNEXPECTED, EXIT_USAGE, ScanDeps, runScan } from '../app/runScan';
import { ConfigError, loadConfig } from '../config/config';
import { createEvaluator } from '../core/evaluator';
import { DEFAULT_RULES } from '../core/rules';
import { estimateMonthlyCost } from '../core/cost/estimator';
import { createLogger } from '../logging/logger';
import { FileSystemPort, nodeFileSystem } from '../storage/fileSystem';
import { createFileHistoryStore } from '../storage/historyStore';
import { parseArgs, USAGE } from './args';
import { VERSION } from './version';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDeps {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  io: CliIo;
  now?: () => Date;
  collect?: ScanDeps['collect'];
  collectExtras?: ScanDeps['collectExtras'];
  fileSystem?: FileSystemPort;
  newRunId?: () => string;
}

export async function runCli(deps: CliDeps): Promise<number> {
  const { io } = deps;
  const args = parseArgs(deps.argv);

  if (args.kind === 'help') {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (args.kind === 'version') {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (args.kind === 'error') {
    io.stderr(`Error: ${args.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  let config;
  try {
    config = loadConfig({ ...deps.env });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`There ${error.problems.length === 1 ? 'is a problem' : 'are problems'} with the settings:\n`);
      for (const problem of error.problems) io.stderr(`  - ${problem}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const now = deps.now ?? (() => new Date());
  const logger = createLogger({
    level: config.logLevel,
    sink: (line) => io.stderr(`${line}\n`),
    now,
    context: { runId: (deps.newRunId ?? randomUUID)() },
  });

  try {
    const historyStore =
      args.historyFile === null
        ? null
        : createFileHistoryStore({ path: args.historyFile, fileSystem: deps.fileSystem ?? nodeFileSystem, logger });

    const scanDeps: ScanDeps = {
      collect: deps.collect ?? collectAccount,
      evaluator: createEvaluator({ rules: DEFAULT_RULES, estimate: (resource) => estimateMonthlyCost(resource), logger }),
      historyStore,
      logger,
      now,
      ...(deps.collectExtras !== undefined ? { collectExtras: deps.collectExtras } : {}),
    };

    const outcome = await runScan(scanDeps, { config, format: args.format });
    if (outcome.output !== '') io.stdout(`${outcome.output}\n`);
    if (outcome.problem !== undefined) io.stderr(`${outcome.problem}\n`);
    return outcome.exitCode;
  } catch (error) {
    // The last line of defence: anything not handled by a specific rule above is a bug.
    // It is logged with full detail, and the process still ends with a clear exit code.
    logger.error('Unexpected failure', { error });
    io.stderr('The Janitor hit an unexpected problem. The details are in the log lines above.\n');
    return EXIT_UNEXPECTED;
  }
}
