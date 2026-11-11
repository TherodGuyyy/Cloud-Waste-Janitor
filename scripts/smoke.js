/**
 * Smoke test: runs the COMPILED program (dist/cli/main.js) as a real process against the
 * fake AWS (moto). It checks what unit tests cannot: that the build works, that the process
 * starts, that stdout/stderr are separated and that the exit codes are right.
 *
 * Needs: npm run build, and a running moto server with MOTO_ENDPOINT set, for example
 *   MOTO_ENDPOINT=http://127.0.0.1:5555 npm run test:smoke
 */

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EC2Client, AllocateAddressCommand, CreateVolumeCommand } = require('@aws-sdk/client-ec2');

const ENDPOINT = process.env.MOTO_ENDPOINT;
const MAIN = path.join(__dirname, '..', 'dist', 'cli', 'main.js');
const CREDENTIALS = { accessKeyId: 'testing', secretAccessKey: 'testing' };

function fail(message) {
  process.stderr.write(`SMOKE TEST FAILED: ${message}\n`);
  process.exit(1);
}

function janitor(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: 'testing',
      AWS_SECRET_ACCESS_KEY: 'testing',
      JANITOR_AWS_ENDPOINT: ENDPOINT,
      JANITOR_AWS_MAX_ATTEMPTS: '1',
      ...extraEnv,
    },
  });
  if (result.error) fail(`could not start the program: ${result.error.message}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function main() {
  if (!ENDPOINT) fail('MOTO_ENDPOINT is not set. Start moto_server -p 5555 and set MOTO_ENDPOINT=http://127.0.0.1:5555');
  if (!fs.existsSync(MAIN)) fail('dist/cli/main.js does not exist. Run "npm run build" first.');

  const reset = await fetch(`${ENDPOINT}/moto-api/reset`, { method: 'POST' });
  assert.ok(reset.ok, 'moto reset failed');
  const ec2 = new EC2Client({ region: 'us-east-1', endpoint: ENDPOINT, credentials: CREDENTIALS, maxAttempts: 1 });
  await ec2.send(new CreateVolumeCommand({ AvailabilityZone: 'us-east-1a', Size: 500, VolumeType: 'gp3' }));
  await ec2.send(new AllocateAddressCommand({ Domain: 'vpc' }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-smoke-'));
  const historyFile = path.join(dir, 'history.json');
  try {
    // Version and help
    const version = janitor(['--version']);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), pkg.version);
    assert.equal(janitor(['--help']).code, 0);

    // A mistake gives exit 2 and nothing on stdout
    const mistake = janitor(['--colour']);
    assert.equal(mistake.code, 2);
    assert.equal(mistake.stdout, '');
    assert.match(mistake.stderr, /Unknown option/);

    // A real scan, JSON report
    const first = janitor(['scan', '--format', 'json', '--history-file', historyFile]);
    assert.equal(first.code, 0, `scan exit code ${first.code}; stderr: ${first.stderr}`);
    const report = JSON.parse(first.stdout);
    assert.equal(report.complete, true);
    assert.ok(report.findings.some((f) => f.ruleId === 'unused-ip'), 'the unused IP was not found');
    assert.ok(report.totals.monthlyUsd > 0, 'the total is not above zero');
    assert.ok(report.watching.length >= 1, 'the new unattached disk is not being watched');
    for (const line of first.stderr.trim().split('\n')) JSON.parse(line); // every log line is JSON
    assert.ok(fs.existsSync(historyFile), 'the history file was not written');

    // The text report, using the history from the first run
    const second = janitor(['scan', '--history-file', historyFile]);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /^CLOUD WASTE JANITOR REPORT/);
    assert.match(second.stdout, /Nothing in your account was changed/);

    // A damaged history file stops the run with exit 4 and is left untouched
    fs.writeFileSync(historyFile, 'not json');
    const damaged = janitor(['scan', '--history-file', historyFile]);
    assert.equal(damaged.code, 4);
    assert.equal(fs.readFileSync(historyFile, 'utf8'), 'not json');

    // AWS unreachable: exit 3, and the report says the scan is incomplete
    const unreachable = janitor(['scan', '--no-history'], { JANITOR_AWS_ENDPOINT: 'http://127.0.0.1:1' });
    assert.equal(unreachable.code, 3, `exit code ${unreachable.code}; stderr: ${unreachable.stderr}`);
    assert.match(unreachable.stdout, /THIS SCAN IS INCOMPLETE/);

    // Bad settings: exit 2, every problem named
    const badSettings = janitor(['scan', '--no-history'], { JANITOR_AWS_REGIONS: 'mars' });
    assert.equal(badSettings.code, 2);
    assert.match(badSettings.stderr, /"mars"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write('Smoke test passed: the compiled program works end to end.\n');
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
