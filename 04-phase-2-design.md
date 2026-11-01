# Phase 2 Design: Collectors

Version 0.1. Builds on `01-design-doc.md`. Goal: read a real (or fake) AWS account and turn it into the plain data the Phase 1 rules engine already understands.

## 1. What Phase 2 delivers

- Four **collectors** (disks, servers, snapshots, Elastic IPs) that return `Resource` objects.
- A **runner** that runs all collectors and never lets one failure stop the others.
- An **AWS adapter layer**: clients, retries with exponential backoff, error classification, pagination, CloudWatch metrics.
- Config additions (regions, optional assume-role).
- Tests: fast unit tests with fakes, plus integration tests against **moto** (a fake AWS server).

Still read-only. Nothing in Phase 2 can change anything in a cloud account.

## 2. Layers (dependency direction: top depends on bottom, never the reverse)

```
app/            collectAccount: wires clients, collectors, regions
collectors/     what to read and how to turn it into Resources (uses PORTS, knows no SDK)
adapters/aws/   the only code that talks to the AWS SDK (implements the ports)
resilience/     retry with backoff (knows nothing about AWS)
core/           rules, costs, state machine (unchanged, knows nothing about any of the above)
```

Ports are small interfaces defined in `collectors/ports.ts`. Collectors are tested with simple fakes of the ports. The adapters are tested with a fake `send` function. Moto then proves the real SDK calls work end to end.

## 3. Key decisions

| # | Decision | Why | Trade-off |
|---|----------|-----|-----------|
| 1 | AWS SDK v3, version pinned exactly | Reproducible builds, supply-chain safety | Updates are deliberate (Dependabot proposes them) |
| 2 | SDK `maxAttempts: 1`, our own retry layer | Two retry layers multiply attempts and hide failures; ours logs every retry | We maintain the retry code (small and well tested) |
| 3 | Full-jitter exponential backoff, 5 attempts, 0.5s base, 20s cap | AWS-recommended; avoids many clients retrying in lockstep | A throttled run can take up to about a minute per call |
| 4 | Only throttling, timeouts, network and 5xx errors are retried | Access denied or bad credentials will never fix themselves | None |
| 5 | Request timeouts (5s connect, 30s response) | A hung connection must not hang the whole run | A very slow API call fails after 30s and is retried |
| 6 | Snapshots: ask AWS for `self` **and** keep only snapshots whose owner is the scanned account | We must never judge what we cannot act on (moto, and any odd API response, can return others) | None |
| 7 | "Used by an image" = snapshot id appears in an owned AMI's block device mappings | The standard signal that a snapshot backs an image | Snapshots used by images in other accounts, or by backup tools, are not detected. Quarantine (not delete) limits the risk |
| 8 | Server metrics: daily CPU averages and daily network sums from CloudWatch for the window | Cheap, always available (basic monitoring) | Three calls per running server (bounded concurrency of 5) |
| 9 | Metric window = the smallest of: configured days, days since launch, days with CPU data | A server that is new, or was stopped for part of the window, must not look idle by accident | Stays "insufficient data" longer, which is the safe side |
| 10 | Missing CPU **or** network data gives `metrics: null`, never zero | The rules never guess | More "insufficient data" lines in reports |
| 11 | Per-server metric failure (throttling exhausted, timeout) gives `metrics: null` plus a WARN; access denied / bad credentials fail the whole collector | A permissions problem must be loud, not look like "nothing is idle" | None |
| 12 | BYOIP addresses (not from Amazon's pool) are skipped with a reason | AWS does not charge for them, so a cost estimate would be wrong | They are listed in `skipped` |
| 13 | Collector output is re-validated by the runner | A bug in one collector must not poison the rules | Tiny cost |
| 14 | One region per collector run; the app layer loops over regions | Clients are region-bound | Regions are scanned one after another |
| 15 | Assume-role requires an External ID | Prevents the confused-deputy attack (threat T4) | One more setting |
| 16 | Time is injected (`now`) everywhere | Makes tests exact and lets moto tests simulate "weeks later" | None |

## 4. Collector contract

```ts
interface Collector {
  readonly name: string;
  readonly resourceType: ResourceType;
  collect(ctx: CollectContext): Promise<{ resources: Resource[]; skipped: SkippedItem[] }>;
}
```

Every collector must: return only valid `Resource` objects, return unique ids, stamp `region` and `accountId` from the context, copy tags exactly, and put anything it cannot use into `skipped` with a reason. A shared contract test runs against all four collectors.

## 5. How server metrics become `InstanceMetrics`

For each **running** server, over the window (default 14 days):

1. CPU: one `Average` per day. `avgCpuPercent` = mean of the most recent `windowDays` daily values (rounded to 2 decimals).
2. Network: one `Sum` per day for `NetworkIn` and for `NetworkOut`. `avgNetworkBytesPerDay` = (total in + total out) divided by `windowDays` (rounded to whole bytes).
3. `windowDays` = min(configured window, whole days since launch, number of days that have CPU data).
4. If any of the three series is empty, `metrics` is `null`.

Known limitation: the oldest and newest daily buckets can be partial days. Both errors lean toward "insufficient data" or a slightly different average, never toward a false "idle" on a short history.

## 6. Failure behaviour

| Situation | Behaviour |
|-----------|-----------|
| Throttling, timeout, network or 5xx error | Retry with backoff (up to 5 attempts), each retry logged at WARN |
| Still failing after the last attempt | `CloudApiError` with kind, operation and attempt count; the runner records a failure for that collector and continues with the others |
| Access denied or bad credentials | Not retried; same recording; logged at ERROR |
| Unexpected bug inside a collector | Logged at ERROR with the stack, recorded as kind `unexpected`, other collectors still run |
| One resource missing a required field | That resource goes to `skipped` with a reason; the rest are kept |

The caller (Phase 3 command line) decides the exit status from the recorded failures. A run with failures is reported as **incomplete**, never as a clean "nothing found".

## 7. Configuration added (all environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `JANITOR_AWS_REGIONS` | `us-east-1` | Comma-separated regions to scan |
| `JANITOR_ROLE_ARN` | none | Role to assume in the customer account |
| `JANITOR_EXTERNAL_ID` | none | Required when a role is set; treated as sensitive in logs |
| `JANITOR_AWS_MAX_ATTEMPTS` | 5 | Attempts per AWS call (1 to 10) |
| `JANITOR_AWS_ENDPOINT` | none | For tests and local fakes only |

AWS credentials themselves come from the standard AWS environment variables (or the role above). They are never read from files in this project.

## 8. Test strategy

- **Unit (fast, no network):** retry timing, error classification, pagination (including a loop guard), mapping, metric maths, collector rules, runner isolation, config validation, shared contract suite.
- **Integration (moto server):** the real SDK against a fake AWS: seed a wasteful account, collect, run the Phase 1 evaluator, and check the exact findings and total. Also: an unreachable endpoint is reported as failures, not a crash; assume-role returns usable temporary credentials.
- **What moto cannot test:** it ignores page sizes (so pagination is covered by unit tests) and cannot simulate throttling or access denied (covered by unit tests with injected errors).

## 9. Out of scope for Phase 2

Storage of observations (Phase 3), the command-line report (Phase 3), Slack (Phase 4), any write call to AWS (Phase 5).
