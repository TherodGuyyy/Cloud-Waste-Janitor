# Test Plan: Cloud Waste Janitor

Version 0.1. Tools: Jest (TypeScript), moto server for fake AWS, GitHub Actions for CI.

## 1. Principles

- The rules engine is pure logic, so it is tested with saved sample data and needs no cloud.
- External services (AWS, Slack, any AI service) are mocked or faked. Tests never touch a real cloud account.
- Safety behaviours (dry-run, kill switch, caps, quarantine) are tested as first-class features, not afterthoughts.
- Tests are written alongside each phase, not at the end.

## 2. Test layers

| Layer | What | Tools | Speed |
|-------|------|-------|-------|
| Unit | Rules, cost estimator, state machine, config validation, Slack signature check, audit hash chain, logger redaction | Jest | Milliseconds |
| Integration | Collectors against fake AWS, repositories against a temp SQLite file, webhook end to end with fake Slack | Jest, moto server, supertest | Seconds |
| Contract | Every collector satisfies the `Collector` interface and returns valid snapshots | Shared Jest suite | Seconds |
| End to end (small) | Full run: fake AWS to findings to fake Slack message to approval to quarantine | Jest | Seconds |
| Security checks | Dependency audit, secret scanning, IAM policy lint | CI tools | CI only |

## 3. Unit test catalogue

**Rules engine**
- Disk unattached 13 days: no finding. 14 days: finding. 30 days: finding.
- Disk attached: never a finding.
- Server at 4 percent CPU for 14 days: finding. 6 percent: none. Missing metrics: no finding and a logged warning (never guess).
- Snapshot 89 days old: none. 91 days and unused: finding. Used by an image: none.
- Unassociated IP: finding. Associated: none.
- `janitor:ignore=true` tag: always skipped.
- Boundary values and time zone independence (use UTC).

**Cost estimator**
- Known sizes and types give expected values from the price table.
- Unknown region or type returns a clear "cannot estimate" result, not zero.
- Price table must carry a date stamp.

**State machine**
- All valid transitions pass. All invalid ones throw. Snooze expiry returns to NOTIFIED.

**Slack signature**
- Valid request passes. Wrong secret, altered body and old timestamp all fail. Replay is rejected.

**Executor and safety**
- Dry-run makes zero write calls (assert on the mock).
- Kill switch false blocks all writes.
- Action cap per run enforced.
- State re-check: if the resource changed since detection, the action is skipped and logged.
- Backup is created before quarantine; if backup fails, quarantine does not happen.

**Audit log**
- Entries chain correctly. Editing any row breaks verification.

**Logging**
- Output is valid JSON with level and metadata. Secrets are redacted. No `console.log` in source (lint rule).

## 4. Integration tests (moto)

Note: moto is a Python library. For a TypeScript project, run it in **server mode** (for example in Docker or via `moto_server`) and point the AWS SDK `endpoint` at it. Before relying on it, confirm in Phase 2 that moto supports each API call we use (EC2 describe calls and CloudWatch metrics).

- Seed fake volumes, instances, snapshots and IPs, then assert collectors return the right snapshots.
- Pagination: more than one page of results is fully collected.
- Error handling: simulate throttling and access denied (using moto's error injection where available or a thin wrapper fake) and assert backoff and graceful failure.
- One collector failing does not stop the others.

## 5. Fixtures

A `test/fixtures/` folder with JSON files for "clean account", "wasteful account" and "mixed account". The "wasteful account" doubles as the demo data for Phase 3.

## 6. CI (GitHub Actions)

A workflow that runs on every pull request:
1. Install with lockfile (`npm ci`).
2. Lint and type-check.
3. Unit tests with coverage.
4. Start moto server and run integration tests (from Phase 2).
5. `npm audit` and secret scan.

Merging is blocked if any step fails. The workflow file is created in Phase 1 together with the first code.

## 7. Targets

- At least 90 percent coverage on `src/core`.
- 100 percent of safety behaviours listed in section 3 covered.
- Entire unit suite under 10 seconds.

## 8. Test plan per phase

| Phase | Tests added |
|-------|-------------|
| 1 | Rules, cost estimator, state machine, config, logger |
| 2 | Collector contract and moto integration |
| 3 | CLI report snapshot test using the wasteful fixture |
| 4 | Slack notifier with fake client, webhook signature tests |
| 5 | Executor safety tests, audit chain, end to end approval flow |
| 6 | Dashboard API and auth tests |
| 7 | Smoke test of the documented quick start |

## 9. Pro tip

Write the failing test first for each rule, then the rule. It forces you to define behaviour precisely, and the test names double as living documentation for interviewers reading your repo.
