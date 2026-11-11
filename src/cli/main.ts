#!/usr/bin/env node
/**
 * The program's front door, and the only file that touches the real process:
 * arguments, environment variables, standard output and the exit code.
 * Everything else is tested through runCli.
 */

import { runCli } from './run';

runCli({
  argv: process.argv.slice(2),
  env: process.env,
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // runCli handles its own failures, so reaching here means something is badly wrong.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ level: 'ERROR', message: 'Fatal error', meta: { error: message } })}\n`);
    process.exitCode = 1;
  });
