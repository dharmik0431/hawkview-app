# Global mailbox-risk availability — implementation and rollout gates

## Product boundary

All current and future connected tenants are eligible regardless of Microsoft
premium licensing or HawkView plan. There is no per-tenant opt-in, manually
entered key, or seven-day product cutoff. The supported detector remains ONLY
`HV-ID-MBX-001.v1`: mailbox forwarding outside Graph-verified tenant domains.
This is an investigation lead, not compromise proof or Microsoft Identity
Protection parity. Microsoft risk remains a separate unchanged channel. No new
Microsoft permissions, customer alerts, automatic remediation, or paid service
are introduced.

Eligibility does not prove coverage. Missing Exchange access, absent/failed/
partial/stale/oversized source evidence, key failures and operational stops must
remain unavailable/not evaluated/error. An unregistered tenant must never be
given an invented clean result. Existing API version 1 and `hvr1` references are
preserved; frontend must render the backend envelope without license inference.

## Runtime contract (not proof of live configuration)

The global backend requires all of:

- `HAWKVIEW_IDENTITY_RISK_ROLLOUT=global`
- `HAWKVIEW_IDENTITY_RISK_MODE=shadow` (evaluation only; not email alerts)
- `HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER=wrapped-v1`
- A valid `HAWKVIEW_IDENTITY_RISK_ENVIRONMENT` and the existing valid wrapping
  root `SECRET_ENCRYPTION_KEY`. Never print, replace, or commit the root.
- `HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE` **absent**, not blank or contradictory.
- Applied scheduler-cursor migration and authorized scheduled-sync requests.

`MODE=off` is the backend emergency stop; explicit frontend
`HAWKVIEW_IDENTITY_RISK_UI_ENABLED=false` is the separate emergency hide. Source
publication is not production activation. Unknown/contradictory configuration
fails closed. Unset rollout retains the strict historical pilot parser only for
backward compatibility, not as the new onboarding policy.

Stored provider `WRAPPED_AES_GCM_V1`, immutable physical key names and existing
pilot keys are unchanged. Global ensure reuses a valid active winner. It never
regenerates retired/disabled/destroyed keys, missing ciphertext, or a key that
cannot decrypt under the configured root. Those require explicit reconciliation,
not an automatic fallback or rotation.

## Lifecycle, isolation and fair scheduling

One global risk path runs independently of the collector's first-1,000 candidate
window. Legacy post-sync evaluations do not also run in global mode. A durable
environment cursor scans tenant UUIDs in key order, including ineligible or
failed candidates, and wraps. Lower-ID/new tenants are reached on a later pass.
Deleted cursor targets do not reset progress. A two-minute lease and conditional
release prevent overlapping schedulers from advancing the same cycle; a crashed
worker cannot release its successor's lease.

Only a scanned candidate advances the cursor. A lost acknowledgement is retried
on the next pass; it cannot overwrite an immutable key. Before key/source work,
a bounded, sanitized operational attempt is persisted. Failure to persist it
prevents that work. A newer pending/failed attempt prevents a prior completed
zero-match run from looking like the latest successful check. No tokens, email
content, source payloads, raw error messages or user identifiers enter this event.

Automatic ensure acquires the evaluator's sorted control-lock namespace, then
rechecks global/tenant hard stop and locks ACTIVE organization/tenant plus
CONNECTED ownership rows inside the transaction. The key-scope lock serializes
first create and explicit revocation. Registry history distinguishes NEVER
PROVISIONED from REVOKED. Commit rechecks scope, key, and current source proof;
source changes after loading must not create fresh findings from old evidence.

## Resource bounds and truthful delay

The risk-only cycle has a shared 45-second budget and at most five scanned
candidates. It does not increase the four-minute cron timeout or collector caps.
It tries the existing process memory lane without queueing behind interactive
work. Key/cursor/source deadlines close actual bounded DB transports. Global
claim/commit/safety and scheduled existing maintenance use risk-owned single-
connection Prisma adapters with physical socket destruction and awaited cleanup,
not Prisma timeout/Promise-race abandonment. Exact runtime CI proof is required.
Near deadline, defer
remaining work, release the lease if time permits, and preserve collector work.
Do not abandon a running Promise and declare the work cancelled.

With five fast candidates per five-minute tick, nominal scan capacity is 60
tenants/hour (100 tenants approximately 100 minutes; 1,000 approximately 16.7
hours). This is a capacity model, not a freshness SLA. Slow work, busy lanes or
failures reduce it. Sustained lane saturation can defer risk indefinitely: cursor
fairness applies only when capacity is obtained, not a finite no-starvation or
freshness guarantee. The existing 36-hour source bound never expands to hide
backlog. No-source states remain truthful until natural collection/evaluation
succeeds. Settled maintenance failure/backlog defers risk work. The request clock
starts before authorization; maintenance admission ends at 15 seconds, risk at
45 seconds, and new collector admission at four minutes. An expired request
admits no new tenant; a slow first collector prevents the next one. This is NOT
a four-minute whole-controller SLA or in-flight cancellation: inherited collector
limits (including four/ten-minute operations), auth and candidate-query latency
can exceed it. HTTP client timeout does not cancel server work. No trigger retry
or second request is added.

Deadline teardown and event-loop scheduling have small overhead; these budgets
are not mathematically exact wall-clock guarantees. A lost commit acknowledgement
must be handled through the existing durable idempotency/lease keys, not by
assuming that every client-side timeout proves the transaction never committed.

## Retention decision — RELEASE HOLD

Existing operational/scoped retention behavior is preserved. Inventory found
that runs/coverage/results/findings lack an active global physical-prune caller.
A newly proposed cross-organization destructive sweep is **NOT authorized**.
The local untracked `risk-global-retention.ts` draft is unwired, unexecuted,
excluded from release, and must not be imported/staged as a workaround.

Before global production activation, the owner must resolve the retention scope
decision and independent QA must verify the approved implementation. Required
design evidence: finite expiry, leaf-first bounds, no live-child cascade, backlog
progress, drain capacity exceeding admitted creation, tenant/privacy isolation,
and cleanup behavior while evaluation is OFF. Do not claim this gate complete
from expiry filters alone, and do not silently extend retention indefinitely.

## Controlled release prerequisites

1. Resolve the retention HOLD. Independently review exact integrated source,
   concurrency/not-before repair, migration, threat/resource/isolation matrix.
2. Pass protected Node 22/PostgreSQL 16 CI and the final runtime-image checks.
   Local Node 24/PostgreSQL 15 tests are preliminary, not image/CI equivalence.
3. Verify API/scheduler/frontend exact revisions, applied schema and existing
   wrapping-root availability without disclosure. Use separate DB/environment
   custody for production vs development; never copy live customer data to tests.
4. Verify backup/revocation inventory. Restoring a DB/root can restore old
   ciphertext: keep risk OFF until deletion/revocation reconciliation is proven.
   Do not rotate the shared root casually; it also protects Microsoft credentials.
5. Only after all gates, coordinate explicit production rollout flags and the
   existing frontend publication path. Preserve an intentional live UI OFF until
   that coordinated decision. No invasive customer event or fabricated finding.
6. Validate real collector/evaluator errors, control stops, leases and freshness,
   two-MSP boundaries, and premium/nonpremium unavailable/available states. Keep
   Microsoft risk values independent. Stop on unsafe evidence or scope failure.

Rollback disables evaluation/UI without deleting tenant data or key material.
Do not automatically replace failed/revoked keys or run a destructive cleanup.
