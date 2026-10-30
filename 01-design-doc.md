# Design Document: Cloud Waste Janitor

Version 0.1 (Phase 0). Status: draft for review.

## 1. Problem and goals

**Problem.** Teams leave behind unused cloud resources that keep billing every month.

**Goals (v1)**
- Detect four kinds of waste on AWS: unattached disks, idle servers, old snapshots, unassociated IP addresses.
- Show an estimated monthly cost for each finding.
- Notify a Slack channel and let a human Approve, Snooze or Ignore.
- Make every action safe and reversible.

**Non-goals (v1)**
- Deleting anything. Version 1 can only quarantine (see section 7).
- Other clouds (the design allows them, we do not build them yet).
- Automatic rightsizing, reserved instance advice, or billing analytics.
- Multi-tenant SaaS hosting.

**Users:** a small startup's engineer or founder who owns the cloud bill.

**Success measures:** the Phase 3 demo reports a believable monthly saving on a fake account; zero write calls to the cloud in v1 except quarantine (tag/stop) after approval; core logic test coverage of at least 90 percent.

## 2. Key decisions (mini ADRs)

| # | Decision | Why | Trade-off |
|---|----------|-----|-----------|
| 1 | TypeScript on Node.js | Strong typing, shared with a later dashboard, Jest for tests | Slightly more setup than plain JS |
| 2 | AWS first | Largest market, best fake-cloud tooling (moto) | Other clouds come later |
| 3 | Collectors behind one interface | Add Azure or GCP without touching the rules | A little extra abstraction now |
| 4 | Rules engine is pure functions | Testable with saved data, no cloud needed | Collectors must gather all data first |
| 5 | SQLite locally, Postgres later | Free, zero setup | Needs a repository interface so the swap is painless |
| 6 | Test with moto, not LocalStack | LocalStack Community Edition ended 23 March 2026 and commercial use needs a paid plan | moto runs as a separate server process (see test plan) |
| 7 | No delete in v1 | Safety, trust, simpler threat model | Savings are only realised once the user cleans up or a later version adds delete |
| 8 | Track "first seen in state" in our own database | AWS does not tell you how long a disk has been unattached | Needs one full cycle of observation (optionally backfilled from CloudTrail later) |
| 9 | Human approval via Slack buttons | People already live in Slack | Needs a public HTTPS endpoint for button clicks |

## 3. Modules and interfaces

Business logic is fully separate from HTTP and from the database. Dependencies are passed in (dependency injection), so every module can be tested alone.

### 3.1 Collectors (read-only)
```ts
interface Collector {
  readonly resourceType: ResourceType;
  collect(ctx: CollectContext): Promise<ResourceSnapshot[]>;
}
```
One collector per service: `EbsVolumeCollector`, `Ec2InstanceCollector`, `SnapshotCollector`, `ElasticIpCollector`. Each returns plain data objects. Each wraps its own AWS calls with specific error handling and exponential backoff (see section 9).

### 3.2 Rules engine (pure logic)
```ts
type Rule = (snapshot: ResourceSnapshot, history: StateHistory, now: Date, cfg: RuleConfig) => RuleResult;
```
Starter rules (thresholds configurable):
- **Unattached disk:** volume state is `available` for at least 14 days (from our observation history).
- **Idle server:** average CPU under 5 percent and low network traffic for 14 days (CloudWatch metrics).
- **Old snapshot:** older than 90 days and not used by any image.
- **Unused IP:** not associated with any instance or network interface.
- **Escape hatch:** any resource tagged `janitor:ignore=true` is skipped.

### 3.3 Cost estimator
Takes a resource snapshot plus a price table (JSON file by region) and returns an estimated monthly cost. All figures are labelled **estimates**. The price table values must be checked against official AWS pricing during Phase 1 before any number is shown to a user.

### 3.4 Findings service (core business logic)
Orchestrates: runs collectors, applies rules, estimates cost, creates or updates findings, decides what to notify, and drives the state machine. It knows nothing about HTTP or SQL.

### 3.5 Slack notifier
Sends a message per finding or a daily digest, with Approve, Snooze (7 days) and Ignore buttons. Behind an interface so tests use a fake.

### 3.6 Webhook endpoint (transport layer)
A thin HTTP handler: verifies the Slack signature and timestamp, parses the click, calls the Findings service, returns quickly. No business logic here.

### 3.7 Action executor
Dry-run by default. In v1, "approve" means **quarantine**, not delete (section 7). Every call is preceded by a backup step and followed by an audit entry.

### 3.8 Storage
Repository interfaces (`FindingRepository`, `ObservationRepository`, `AuditRepository`) with a SQLite implementation.

### 3.9 Scheduler
Runs the collection cycle (for example every 24 hours). Local cron or a simple in-process timer at first.

## 4. Data model (SQLite)

- `resources(id, type, cloud_id, region, account_id, first_seen_at, last_seen_at, attributes_json)`
- `observations(resource_id, observed_at, state, metrics_json)`, which gives us "unattached for N days"
- `findings(id, resource_id, rule_id, status, monthly_cost_estimate, created_at, updated_at, snooze_until)`
- `decisions(id, finding_id, actor_slack_id, decision, decided_at)`
- `audit_log(id, ts, actor, event, details_json, prev_hash, hash)`, append-only with hash chaining so tampering is detectable

## 5. Finding state machine

```
DETECTED -> NOTIFIED -> APPROVED -> QUARANTINED -> (v2: DELETED)
                     -> SNOOZED  -> NOTIFIED (after snooze ends)
                     -> IGNORED
QUARANTINED -> RESTORED (undo)
Any state -> RESOLVED (resource disappeared or became used)
```
Invalid transitions are rejected in code and tested.

## 6. Slack approval flow

1. Findings service creates a finding and the notifier posts it.
2. A person clicks a button. Slack calls the webhook with a signed request.
3. The webhook verifies the signature, timestamp (rejects old requests) and that the clicker is in the allowed approver list.
4. The Findings service applies the decision, runs the executor (dry-run unless enabled), writes the audit entry, and the message is updated to show the outcome.

## 7. Safe actions (v1)

| Resource | Quarantine action | Undo |
|----------|------------------|------|
| Unattached disk | Create a snapshot as backup, tag `janitor:quarantined` with date | Remove tag (disk untouched) |
| Idle server | Stop the instance (not terminate), tag it | Start it again |
| Old snapshot | Tag only | Remove tag |
| Unused IP | Tag only | Remove tag |

Delete is explicitly out of scope for v1. A later version may delete resources that stayed quarantined for a configurable period and got a second approval.

**Kill switch:** an environment variable (`JANITOR_ACTIONS_ENABLED=false`) checked before every write. When false, the executor refuses all changes.

## 8. Configuration and secrets

- All secrets (Slack token, signing secret, cloud role ARN, external ID) come from environment variables only. Never in `.env` files or code.
- Non-secret settings (thresholds, schedule, region list) live in a typed config object validated at startup.
- Cloud access uses short-lived credentials via assumed role, with an external ID.

## 9. Reliability and observability

- **Errors:** no generic catch-all blocks. Each external call handles its specific failures (throttling, access denied, timeout, not found). Throttling and timeouts use exponential backoff with jitter and a retry limit. If one collector fails, the others still run and the failure is logged and reported.
- **Logging:** a native structured JSON logger with levels DEBUG, INFO, WARN, ERROR. No `console.log`. Every critical event, database write and caught exception is logged with metadata (run id, account, resource id, rule id).
- **Graceful failure:** one bad resource or one failed service never crashes the whole run.

## 10. Proposed repository layout

```
cloud-waste-janitor/
  README.md
  docs/            (these documents)
  src/
    core/          (findings service, state machine, rules, cost)
    collectors/
    adapters/      (aws, slack, sqlite, http)
    config/
    logging/
    main.ts
  test/
    unit/
    integration/
    fixtures/
  .github/workflows/ci.yml
```
The dependency direction is `adapters -> core`, never the reverse.

## 11. Hosting and cost (free first)

- Local run during development.
- Slack buttons need a public HTTPS URL. Options to evaluate in Phase 4: a free tunnel for development, then a free-tier serverless function or small free host for the webhook.
- First costs when selling: a domain and a database that does not pause.

## 12. Business angle

Target small startups that waste an estimated 30 to 40 percent of cloud spend. Pricing: flat fee or a share of savings. The Phase 3 report, showing money found, is the sales demo.

## 13. Open questions

1. Daily digest or one message per finding? (Start with digest to avoid noise.)
2. How to handle accounts with many regions? (Start with a configured region list.)
3. Where to host the webhook for real use?
4. Do we backfill history from CloudTrail so findings appear on day one?

## 14. Pro tips

- Write the rules engine first and run it against saved JSON: it proves the idea with zero cloud risk.
- Keep the demo fixtures realistic. A believable "you are wasting $X a month" screen is what hiring managers remember.
- Record decisions like the table in section 2. Interviewers love to hear the reasons behind your choices.
