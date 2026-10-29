# Threat Model: Cloud Waste Janitor

Method: STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege). Version 0.1.

## 1. Assets worth protecting

1. Access to the customer's cloud account.
2. Slack bot token and signing secret.
3. Findings data (reveals the customer's infrastructure and spend).
4. The audit log.
5. The customer's actual resources (they must not be harmed by mistake).

## 2. Trust boundaries

- Janitor service and customer cloud account (credentials cross here).
- Janitor service and Slack (tokens and signed requests cross here).
- Internet and the webhook endpoint (untrusted input arrives here).
- Janitor and its dependencies (npm supply chain).

## 3. Threats and mitigations

| ID | STRIDE | Threat | Mitigation | Test |
|----|--------|--------|-----------|------|
| T1 | Spoofing | Attacker sends a fake "Approve" to the webhook | Verify Slack signature, reject timestamps older than 5 minutes, constant-time comparison | Unit tests with valid, tampered and replayed requests |
| T2 | Spoofing | A Slack user who should not approve clicks Approve | Allow-list of approver Slack IDs, per-channel restriction | Unit test: non-approver rejected and logged |
| T3 | Elevation | Janitor role has more cloud permissions than needed | Separate roles: read-only collector role, narrow action role limited to tagging and stopping, explicit deny on delete and terminate in v1 | Policy review checklist, automated policy lint in CI |
| T4 | Elevation | Confused deputy: someone tricks the Janitor into using its role against another account | Assume role with a unique external ID per customer | Integration test for role assumption parameters |
| T5 | Info disclosure | Long-lived keys leak from code, logs or `.env` files | Short-lived credentials, secrets in environment variables only, log redaction of tokens and ARNs' secrets | Unit test that the logger redacts secrets; secret scanning in CI |
| T6 | Info disclosure | Findings exposed through a dashboard or logs | Dashboard requires authentication (Phase 6), minimal data in Slack messages, no secrets in logs | Review checklist |
| T7 | Tampering | Someone edits audit history to hide an action | Append-only table with hash chain, periodic chain verification | Unit test: modified row breaks verification |
| T8 | Repudiation | "I never approved that" | Every decision stores actor Slack ID, time and finding; audit entry written before the action runs | Integration test |
| T9 | Tampering | Rules or thresholds changed to cause mass quarantine | Config validated at startup with sane limits; cap on actions per run (for example max 10); kill switch | Unit tests for caps and validation |
| T10 | Harm | A bug quarantines a resource that was in use | Dry-run default, re-check the resource state immediately before acting, backup first, undo path, `janitor:ignore` tag respected | Tests with "state changed since detection" fixtures |
| T11 | DoS | Flood of webhook requests | Fast signature check first, rate limiting, small body size limit | Unit test for oversize and bad requests |
| T12 | DoS | Cloud API throttling stops collection | Exponential backoff with jitter, retry limit, per-collector isolation | Tests with simulated throttling errors |
| T13 | Supply chain | Malicious or vulnerable npm package | Lockfile, pinned versions, `npm audit` and Dependabot in CI, minimal dependencies, generate an SBOM (links nicely to your SBOM watcher project) | CI checks |
| T14 | Tampering | Stale price table makes cost claims wrong | Version and date stamp on the price table, show "estimate" labels | Unit test that the table has a date and region coverage |
| T15 | Info disclosure | Slack messages leak sensitive resource names | Show IDs and cost, avoid dumping full tags or attributes | Review checklist |

## 4. Reference read-only permission set (to be finalised in Phase 2)

Collector role needs only describe and metric-read calls, for example:
`ec2:DescribeVolumes`, `ec2:DescribeInstances`, `ec2:DescribeSnapshots`, `ec2:DescribeImages`, `ec2:DescribeAddresses`, `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`.

Action role (enabled only after the user opts in) is limited to tag, stop and snapshot-create calls on resources, with explicit deny on any delete, terminate or release call in v1.

## 5. Residual risks accepted for v1

- Estimates may differ from the real bill.
- A resource may be needed by a process the Janitor cannot see. Mitigated by quarantine (reversible), not eliminated.
- Slack workspace compromise. Out of scope, but the approver allow-list and action caps limit the damage.

## 6. Review cadence

Revisit this model at the start of Phase 4 (Slack, public endpoint) and Phase 5 (actions), since those add the largest attack surface.
