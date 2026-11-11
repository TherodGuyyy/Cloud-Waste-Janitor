# Phase 3 design: the command-line report

Goal: one command that scans an AWS account (read-only), judges what it finds with the Phase 1 rules, remembers what it saw, and prints a report with the total money at stake. This is the first demo-able version.

```
node dist/cli/main.js scan                       # readable report
node dist/cli/main.js scan --format json         # machine-readable report
node dist/cli/main.js scan --no-history          # do not read or write the history file
node dist/cli/main.js scan --history-file my.json
```

## Decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | Report goes to **stdout**, logs go to **stderr** | The report can be piped or saved (`> report.txt`) without log lines mixed in. |
| 2 | Hand-written argument parser, no library | Four flags only. Fewer dependencies means a smaller attack surface and nothing for Dependabot to break. |
| 3 | Settings stay in environment variables, flags only choose output and the history file | Keeps the "secrets and settings in env vars only" rule. Flags never carry secrets. |
| 4 | History is a JSON file (`.janitor/history.json`), behind a `HistoryStore` port | AWS does not say how long a disk has been unattached, so we record what we see. A port lets SQLite or Postgres replace the file later without touching the logic. |
| 5 | The history file is written **atomically** (temp file, then rename) | A crash halfway through a write can never leave a half-written file. |
| 6 | A **corrupt** history file stops the run (exit 4) and is never overwritten | Silently starting over would reset every disk's "days unattached" and hide waste. The person fixes or moves the file. |
| 7 | History is pruned only after a **complete** scan | If a region failed, a missing resource may just be unseen, so its history is kept. |
| 8 | Consecutive identical observations are collapsed to the first and the latest | The file stays small forever, and "since when" (the first of the run) is preserved. |
| 9 | An **incomplete** scan still prints a report, with a loud banner, and exits 3 | Partial information is useful, but must never look like "all clear". |
| 10 | Unattached disks that are not old enough yet are listed as **watched** | On day one nothing can be flagged yet. Showing "3 of 14 days" explains why and shows progress. |
| 11 | Exit codes: 0 done, 1 unexpected bug, 2 bad usage or settings, 3 incomplete scan, 4 history file problem | Scripts and CI can react to each case. |
| 12 | Nothing in Phase 3 changes anything in the cloud | Still read-only. The kill switch stays off. Actions arrive in Phase 5. |

## Layers (dependency direction unchanged)

```
cli/main.ts      only place that touches process.* (arguments, environment, stdout, exit code)
cli/run.ts       parses flags, loads settings, wires everything, returns an exit code
app/runScan.ts   history -> collect -> record observations -> evaluate -> save history -> render
report/          pure functions: report data in, text or JSON out
storage/         HistoryStore port and the file implementation (the only code touching the disk)
core/historyUpdate.ts  pure function that adds today's observations to the history
```

## Error handling

| Situation | Behaviour |
|-----------|-----------|
| Unknown flag, missing value, repeated flag | Plain message and usage on stderr, exit 2 |
| Bad settings (`ConfigError`) | Every problem listed at once, exit 2 |
| History file missing | Normal first run, history starts empty |
| History file unreadable or corrupt | `HistoryStoreError`, run stops before any AWS call, exit 4 |
| Saving history fails after a good scan | Report is still printed, then exit 4 |
| A region or collector fails | Recorded, report printed with INCOMPLETE banner and advice per failure kind, exit 3 |
| Anything unexpected | Logged at ERROR with details on stderr, exit 1 |

## Test plan

- Unit: argument parser (every flag and every mistake), history update (pure), history store (real temp folder plus failure injection), text and JSON reports, `runScan` and `runCli` with fakes, exit codes.
- Integration: the real `runCli` against moto, twice with a shifted clock to prove the history logic across runs.
- Smoke: the **compiled** program (`node dist/cli/main.js`) run as a real process against moto in CI.
- Architecture: `process.env` and `process.stdout` only in `cli/main.ts`; report code is pure.
