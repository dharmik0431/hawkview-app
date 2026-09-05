# Derived risk history: 90-day physical retention

## Policy and validity are separate

The owner approved **90 x 24 hours** of physical retention for HawkView-derived
assessment history: evaluation runs and their coverage, matched results and
findings, including FULL, PARTIAL, UNAVAILABLE and no-usable-source checks.
The original authoritative `IdentityRiskEvaluationRun.created_at` is the
assessment anchor. Related children follow the run they currently reference.
Cleanup uses the PostgreSQL transaction clock in UTC, not a caller timestamp,
deployment date, completion retry, calendar month, or source observation time.

Physical eligibility is `created_at <= transaction_time - 2160 hours`. Current
assessment/read validity remains independently capped by `expires_at`, source
freshness, capability, collection state, head causality, safety and key status.
A row may be physically retained without being a valid/current assessment.
New no-source checks use the same 90-day validity ceiling; no-source capability
remains UNAVAILABLE and cannot become a clean/complete verdict. Contributing
source expiry can still shorten read validity, never physical history retention.

Compatibility: migration `20260905120000_risk_history_retention` does **not**
rewrite existing timestamps or evidence. A legacy no-source check whose validity
expired after seven days stays physically present until its ORIGINAL day 90,
but remains expired/unavailable to current read paths. Deleted rows are not
recreated. No timestamp is reset on deployment. All capabilities use the same
physical predicate. No new historical browsing API/UI is included; current
endpoints continue to expose only the evidence their existing gates permit.

There is **no investigation/legal hold feature** or indefinite open-case
exemption. OPEN findings are also finite history. RUNNING records (even with
expired leases), any live lease, future/invalid clock values, and nonexpired
children prevent deletion of their required parent graph. Such exceptions can
delay physical removal beyond day 90; they are not proof of a drained backlog.
Operators must investigate persistent protected/failed batches before expansion.

## Excluded data and backup limits

No Microsoft/Graph/Exchange/UAL source, sign-in, Change Evidence, workspace or
security audit, operational events/controls, account, credential, key/key
history, wrapped ciphertext or existing evaluation scheduler cursor is deleted
by this worker. Their policies are unchanged (in particular, operational-event
retention is NOT changed to 30 days). Only a matching expired completed-run link
may be cleared from an attempt head using org+tenant+environment+attempt+run CAS.
A newer head is preserved. No fallback to historical success is introduced.

Physical deletion here means live application tables, not immediate erasure of
backups, PostgreSQL WAL, replicas or exported copies. Those policies are separate.
After restore, keep evaluation/customer risk access OFF, reconcile deletion and
key revocation state, run approved scoped preflight and bounded cleanup of
restored eligible history, and validate isolation/freshness before enabling.
Never rotate the wrapping root or erase backups as a retention shortcut.

## Bounded scheduler operation

The existing authenticated scheduler invokes retention before ordinary collection
and independently of evaluation MODE. Cleanup OFF is zero DB work. Cleanup ON
while evaluation OFF performs no source loads, key provisioning/pinning or risk
evaluation. Normal unrelated collection still follows its existing schedule.
Cleanup backlog does not indefinitely gate evaluation or collection.

Limits are fixed in code: 10 seconds per cycle, at most 128 tenant batches,
1 second owned transport per transaction, 16 selected parents and **256 total
child rows** per batch (findings, then matched results, then coverage). At most
16 childless parents may then be removed. Materialized matched/finding
candidate sets each contain at most 256 IDs
before final unique-parent probes. Synthetic transaction-contained EXPLAIN
ANALYZE verifies at most one parent row per probe and at most 256 such probes;
this is not a claim that PostgreSQL examines only 256 index/heap entries while
searching. Index/heap search and sorting remain subject to the strict SQL/socket
deadline. Protected child prefixes cannot pin later eligible matched siblings.
Only IDs/counts cross the transaction boundary, never evidence payloads.
Statements and the actual socket are deadline-bound;
failure rolls back the batch, not just its awaiting promise. A lost COMMIT
acknowledgement may under-report counts; retry remains idempotent.

A dedicated leased scope-set cursor advances before tenant work; a second
org+tenant cursor rotates through ordered `(created_at,id)` runs. A blocked or
large tenant cannot pin the global scan, and permanently protected oldest runs
cannot pin that tenant's next page. End-of-scan wraps and lower-ID insertions are
visited subsequently. These metadata tables do not repurpose evaluation cursors.
Leases expire after 30 seconds; CAS and NOWAIT/SKIP LOCKED avoid overlapping
destructive work. Attempt heads lock before run records. Child FKs are NO ACTION,
so a missed live child causes rollback instead of an implicit cascade.

The 256-child budget is smaller than the admitted 2,000-match run and deliberately
requires incremental draining of large graphs. A maximum normal graph has 2,000
results, at most 2,000 linked findings, up to 22 rule coverage rows and one run.
The row admission envelope per cycle is 32,768 children plus at most 2,048 runs,
not guaranteed throughput. Actual time, protected rows, locks and tenant count
can reduce it. Measure real synthetic capacity in CI/local reports and scoped
preflight; there is **no hard global drain SLA under saturation**. Persistent
backlog/failures are a stop/diagnosis signal, not permission to enlarge batches.

The existing evaluation cycle admits at most five candidates, hence at most
20,110 normal child rows per cycle. The cleanup admission envelope is higher,
but that arithmetic is **not a measured guarantee**: the preliminary Windows
Node 24/PostgreSQL 15 synthetic test drained one maximum normal graph (4,022
children plus one run) in 16 batches, about 4 seconds after enforcing the
unique-ID matched-parent lookup. A query-plan regression protects against
quadratic tenant rescans under stale database statistics. The 1,001-tenant cursor
test also proved restart/wrap progress, not a global-cycle drain time. Protected
CI and scoped natural-run observations must be assessed separately; sustained
worst-case generation exceeding measured cleanup is a blocker to broader risk
activation, not justification for loosening bounds or claiming compliance.

## Staged release and rollback

1. Ship source/migration with `HAWKVIEW_RISK_HISTORY_RETENTION_MODE=off` (or absent).
   Neither merge, migration nor startup initiates deletion. Pass independent
   exact-commit Backend/Test QA, protected Node 22/PostgreSQL 16 CI and image smoke.
2. Attest exact API/scheduler source and applied migration. Select a legitimate
   organization+tenant pair from an authorized metadata surface; do not invent
   customer IDs, acquire/copy credentials, or use customer resource payloads.
3. Through the existing reviewed Render environment workflow, set SCOPES to a
   closed JSON array such as `[{"organizationId":"<uuid>","customerTenantId":"<uuid>"}]`
   and MODE to `observe`. At most 100 exact pairs; no wildcard/coercion. The
   explicit string `all` is reserved for reviewed broad rollout, not initial
   scoped validation. Invalid config fails OFF. Observe executes only SELECTs
   in a read-only transaction and reports at most 256 retention-age candidates
   plus a capped marker. Candidate counts do not prove parent deletability.
4. Read the next natural scheduler's aggregate `risk_history_retention` output.
   Verify healthy cadence, no failed batches, exact deployed revision and DB
   health. No customer load test or manual broad deletion script.
5. After successful reviewed preflight, scoped MODE=`delete` is owner-authorized.
   Observe the next natural run's aggregate committed deletion counts, capped
   batch count and `backlog=UNKNOWN`. That value intentionally does not claim a
   full inventory or “nothing left.” Confirm normal scheduler/API health.
6. On anomalies, set MODE=`off` using the same configuration path. Admission
   stops by the next batch; already-started work remains transaction/deadline
   bound. Do not restore deleted rows automatically or increase limits. Record
   exact stage, revision and aggregate outcome. Source deployment, cleanup
   enablement, and customer Risky Users activation are separate attestations.

This document is source/runbook behavior, **not evidence of live enablement**.
No customer Risky Users flag is enabled by this slice.
