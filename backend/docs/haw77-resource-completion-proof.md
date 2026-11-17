# HAW-77 resource completion proof: inactive storage contract

## Sign-in producer boundary contract — 17 November 2026 UTC

Collection pagination, authentication evidence integrity and initial-sync epoch
completion are three separate facts. `persistAuthenticationRecords` returns
`hasConflicts` when it has retained a quarantined row, including sticky replay
of an existing marker. That result is not a failed persistence transaction.
The registered `risk-assessment-connected.database-integration.test.ts` case
“actual Graph collector persists conflict gaps without hiding unrelated intact
positive evidence” explicitly requires a completed page-chain window and a
successful collector, while risk evidence stays PARTIAL and independent
positive findings remain visible. This step reads that physical contract; it
does not execute it or claim fresh physical proof.

Do not convert `hasConflicts` alone into `CORE_AUTHENTICATION_PARTIAL` or a
collection failure. That would change existing alert/failure behavior and
could fail every replay indefinitely. The risk readiness mapper already
excludes marked events, reports CONFLICTING_EVIDENCE and preserves independent
usable evidence. Conversely, a successful collector or completed page-chain
window cannot certify conflict-free evidence or a current initial-sync epoch.

Two bounded synthetic tests now run the real collector, ingestion helper,
window writer and readiness/rule functions over an explicit in-memory
transaction seam. A conflicting Graph duplicate plus ten independent events
keeps its first quarantine marker through replay, completes pagination and
retains an independent positive finding while risk readiness remains PARTIAL.
A 501-record control performs two batches; rejecting the second batch leaves
the first modeled 500-row commit intact but writes no window and no terminal
success. The matching successful control writes all 501 rows and the window.
The seam models neither PostgreSQL locking nor JSONB size nor uncertain commits.
Existing physical and epoch/takeover/recovery gates remain mandatory.

The current producer has these separate durable boundaries:

| Boundary | Existing fact | Missing HAW-77 proof |
| --- | --- | --- |
| Each bounded record batch | Ingestion transaction accepted, possibly with quarantined evidence | Current epoch/attempt/owner and every prior batch acknowledgment |
| Completed source-window transaction | Complete requested page chain and observed count; a prior same-source window may be merged | Exact current attempt, rather than inference from the merged window |
| Wrapper terminal update | Existing selected-source outcome and timestamp | Atomic consumption of the exact persisted-attempt receipt |
| Recovery notification | Delivery after accepted terminal success | Current authority for notice effects and initial-sync completion |

Before wiring a receipt producer, resolve the meaning of SIGN_INS FULL in the
initial-sync contract explicitly: complete Graph collection under existing
quarantine semantics, or an additional conflict-free integrity requirement.
The latter would require separately scoped integrity proof at certificate
creation and reader validation, not reclassification of the existing collector
or hiding unrelated evidence. Neither choice is implemented by this test/design
step. Missing or unknown epoch/attempt receipts remain ineligible under the
unused validator, regardless of existing collection success.

The next producer proof must cover clean/empty Graph, conflict plus independent
positive evidence, sticky replay, valid limited-source envelopes, invalid rows,
later batch/window/terminal rejection and unknown acknowledgments. Do not
invent epoch receipts from callbacks or timestamps, loosen the existing risk
readiness checks, or duplicate HAW-21 ownership fencing. No runtime, schema,
failure policy, cadence or quota change is made here.

This is a design against source `6d4195b23f6e9c01fcfbc1ae9ec6b9a5c7c26063`,
not a migration or a working durable receipt implementation. It extends the
[initial-sync notice epoch design](haw77-initial-sync-notice-epoch.md).
The held same-millisecond witness remains red. A new connection UUID alone
cannot make timestamp-only resource evidence authoritative.

## Local post-success notification boundary repair — 17 November 2026 UTC

`runSnapshotSync` now completes its collection/terminal-state error handler
before resolving a successful resource's recovery incident. Once collection
and the terminal SUCCEEDED update have both acknowledged success, a later
notification rejection propagates unchanged without rewriting the resource
as FAILED, incrementing collection failures, publishing a new collection-failed
incident or attributing the error to Microsoft. Exchange configuration's
collection-completed memory event records that boundary before notification.
No notification retry or error suppression is introduced. A caller may still
report its overall visit incomplete when the notification rejects.

The synthetic regression first reproduced SUCCEEDED followed by FAILED, a new
failure incident and a replacement exception. It now verifies exact original
error propagation and one unchanged successful terminal update for SIGN_INS,
LICENSES and EXCHANGE_MAILBOX_CONFIGURATION. Separate collector and definite
pre-write terminal rejection controls preserve the existing failure path for
SIGN_INS and LICENSES. The existing limited/initializing/full-success tests
still apply. These controls model a terminal rejection before a stored update;
they do not prove rollback after an uncertain real database commit.

This is only an error-origin repair in the inactive local candidate. It does
not bind records, source windows and terminal state to one epoch/attempt, repair
initial-sync notice races, wire the new proof reader, or establish HAW-21 owner
authority. Unknown commit readback, all required-resource writers and atomic
notice effects remain prerequisites. The held same-millisecond/reconsent
witnesses remain unresolved. No schema, retry/backoff threshold, cadence, quota,
provider permission or deployment change accompanies this step.

The [storage and projection contract](haw77-proof-storage-projection.md) refines
the nullable field/check matrix and coherent reader mapping. It adds a proposed
persisted source-kind field alongside the four identities so full Graph source
is not inferred from timestamps, and pairs the connection epoch with a dedicated
start rather than recomputing it from mutable consent timestamps. It remains
design-only, without installed DDL.

## Inactive pure validator checkpoint

An unused [validator](../src/tenants/initial-sync-completion-proof.ts) now models
this baseline predicate with synthetic tests. It takes a required-only projection
of thirteen scoped resources, the current scoped connection/epoch boundary,
tenant eligibility status and an explicit observation time. It rejects missing,
duplicate, foreign or unexpected resources; null/malformed/mismatched IDs;
nonterminal, limited or unknown coverage; and invalid, inverted or future times.
Valid same-millisecond completion is accepted only with matching epoch/attempt/
persisted/completed identities. Different resources may have different attempts
within the same epoch. SIGN_INS additionally requires full GRAPH_SIGN_INS.
A retained non-null collection error also keeps a resource incomplete; the
future guarded full-success write must clear that error atomically with proof.

`coverage` and `authenticationSource` are proposed projection fields for this
pure contract, not new persisted columns or proof derived from existing success
timestamps. FULL must come from the complete guarded producer boundary described
below, including an explicitly committed complete-empty result. An assertion
from an in-memory callback alone cannot populate that authority. The future
reader must project only the thirteen required resources and preserve their
coherent connection/scope snapshot; optional collectors do not become required.

Only the new test imports this validator. No current status/notice/collector
reader calls it, no schema is installed and the held orchestration regressions
remain unresolved. It does not authorize a full-run result or incremental warning
clearance: those paths must additionally compare their returned current-attempt
identities under write authority. Local predicate tests cannot establish durable
source completeness, coherent PostgreSQL reads, timestamp microsecond transport,
all-writer lock order, deployment compatibility or HAW-21 ownership.

## Proposed bounded storage

Use a dedicated, non-reusable `initialSyncEpochId` UUID on `TenantConnection`,
as decided in the epoch design. Keep one current attempt/proof slot on each
existing `SyncState` row; do not introduce an unbounded receipt history or a
new retention policy. Field names below are proposed, not present in Prisma:

| Proposed field | Meaning |
| --- | --- |
| `initialSyncAttemptEpochId` | The connection epoch captured before provider work for this resource attempt |
| `initialSyncAttemptId` | A new UUID for that attempt, independent of timestamps and the tenant visit ID |
| `initialSyncPersistedAttemptId` | Equals the current attempt only after its complete accepted resource evidence has committed |
| `initialSyncCompletedAttemptId` | Equals the current attempt only when terminal full success commits after validating its persisted evidence |

All four fields are nullable for additive rollout. The current tenant/resource
uniqueness and composite tenant/organization foreign key remain the scope
boundary; every lookup and mutation includes that scope. Proposed database
checks must enforce: the attempt epoch/ID are both null or both non-null;
each non-null persisted ID equals the non-null current attempt ID; and each
non-null completed ID equals both the persisted/current IDs and requires
`status = SUCCEEDED`. Explicit null checks are required in SQL constraints.
These checks enforce row shape, not provider completeness or current authority.

The epoch value is compared with the current scoped connection, not foreign
keyed to its mutable current epoch value: rotation must make prior proof
ineligible without relabeling it. Do not copy a new epoch into old attempt
rows. A missing connection, legacy null, scope mismatch or unknown receipt
shape cannot establish completion. Do not infer IDs from timestamps or
backfill old successes into a newly seeded epoch. Database constraints,
indexes/query plans and null/mixed-version behavior still need migration proof.

## Attempt and persistence transitions

1. **Claim.** Under the shared authority/lock protocol, verify a connected,
   active, eligible scoped tenant and the captured non-null epoch. Set a new
   attempt UUID, its epoch and RUNNING; clear both proof IDs atomically. A
   newer attempt invalidates current completion even if a historical
   `lastSuccessfulAt` is retained. Provider I/O takes place outside locks.
2. **Persist.** Every data/checkpoint mutation must be guarded by the captured
   epoch, exact current attempt and the proven HAW-21 owner contract. Only
   after the complete accepted page chain and all required persistence may
   the last required data/checkpoint transaction set the persisted ID. For
   multiple batches, every earlier batch must have committed under the same
   authority and attempt; an unknown batch commit forbids certification.
   A callback resolving or a snapshot timestamp is not a persistence receipt.
   A complete empty result still needs an explicit durable completion boundary.
3. **Finalize.** In a short transaction, revalidate scope, connection, epoch,
   current attempt, owner and exact persisted ID, then atomically set SUCCEEDED,
   its success timestamp and completed ID. Either combine this with the final
   persistence transaction or consume its durable marker; never fabricate the
   marker in a later status-only update based on an in-memory return value.
   Only the matching RUNNING attempt may terminalize; a retry of a known
   committed outcome reads that exact outcome. A later notification error
   cannot rewrite a terminal resource success as a collection failure.
4. **Partial/failure.** Initialization, limited fallback, bounded backlog,
   budget exhaustion and failure cannot set a completed ID. Clear it while
   retaining the existing nonterminal/failure classification and backoff policy.
   Every terminal/error update compares the same attempt identity, so an old
   attempt cannot overwrite a replacement attempt's success or failure.
5. **Superseded/unknown.** Zero matching rows means superseded, not success.
   An uncertain commit stops dependent completion/notice work. Read back the
   exact scoped epoch/attempt/marker and current eligibility before accepting
   durable state; absent or replaced proof stays unproved. A superseded slot
   cannot reconstruct a historical commit. Do not manually replay provider
   work, compensate, rewrite IDs or reset another attempt. Normal later
   scheduling retains its configured behavior.

The stored marker is a certificate produced by guarded code, not a digest of
all tenant data. Any competing writer that can replace/invalidate the certified
resource baseline must participate in the same attempt protocol or atomically
invalidate its proof. A field-only migration with old unguarded writers is not
safe to activate. This contract depends on HAW-21's all-write-path authority;
it does not implement a second tenant lease, takeover or recovery protocol.

## Concrete writer boundaries to migrate

The required resource set stays exactly the thirteen entries in
[`initial-sync-status.ts`](../src/tenants/initial-sync-status.ts), including
SIGN_INS and M365_AUDIT. Optional collectors must not silently become required.

| Source path at the audited head | Proof boundary required |
| --- | --- |
| `tenant-sync.service.ts:claimTenantUsersLease`, `synchronizeUsers`, USERS terminal transaction | Claim/batched directory writes/full-rebuild cleanup/final delta checkpoint must share an attempt. Certify only the complete accepted delta or rebuild chain and committed directory changes; retain existing delta semantics. Current batch writes, cleanup and terminal update are separate. |
| `runSnapshotSync`, `saveSnapshot`, `saveEntraSnapshot` and their required-resource callers | Bind the authoritative snapshot and any inventory/change-evidence writes to the attempt in their persistence transaction. The later wrapper success consumes that exact marker. The wrapper's accepted-partial path currently advances a success timestamp while RUNNING; it must not certify full completion. |
| `syncSignInLogs` and `identity-risk/authentication-window-collector.ts:persistCompletedAuthenticationWindow` | Bind record persistence and the completed window to the same current attempt. Certify only a complete, validated GRAPH_SIGN_INS collection and its exact window. A merged retained window from another attempt/epoch and M365_AUDIT_STS fallback cannot substitute. The current window transaction and wrapper terminal update are separate. |
| `syncDirectoryAuditLogs` (AUDIT_LOGS) | Bind the accepted complete directory-audit collection, records/evidence and checkpoint to the attempt before the wrapper finalizes; append-only records alone do not certify the requested collection. |
| `m365-management-activity.service.ts:syncTenant` | A real current attempt must finish discovery, enabled subscriptions and all required content with no pending/processing/retry/failed backlog before certification. Read/validate those facts at a coherent guarded terminal boundary; today's pre-transaction counts are insufficient under concurrent writers. Budget/backlog/failure stays incomplete. A recent-success early return creates no new proof and cannot relabel an old epoch. |

Within the snapshot family, cover LICENSES, DOMAINS, GROUPS,
AUTH_REGISTRATIONS, CONDITIONAL_ACCESS, AUTHENTICATION_STRENGTHS,
APPLICATIONS, SERVICE_PRINCIPALS and SHAREPOINT_SITES individually. Audit
direct/manual/internal entry points as well as the scheduled dispatcher;
partial field updates and source-window replacements cannot bypass provenance.
This inventory does not claim that those paths are already guarded.

## Readiness, notice and reader contract

For each required resource, current readiness requires a non-null current
connection epoch E; matching attempt epoch E; matching non-null attempt,
persisted and completed IDs; SUCCEEDED; and the existing complete-source and
valid-time conditions. Keep time ordering/future rejection as sanity checks,
not as identity. Require all thirteen distinct scoped resources. A fresh
SIGN_INS result alone cannot repair eleven old-epoch proofs. Equal-millisecond
success with a new matching identity may be valid; old identity is rejected
even when every timestamp matches.

Readiness may combine independently completed resources from different visits
within E, as the incremental-clear path already intends. Do not require all
receipts to have one visit ID, or their old owner's lease to remain live forever.
Owner validity is proved when each guarded write commits. By contrast, a
full-run SUCCEEDED result retains its existing stricter requirement that each
required resource completed an accepted attempt in that run; compare returned
attempt identities instead of `lastAttemptAt >= now`. Incremental clearance
must compare the exact current Graph attempt with the reread SIGN_INS proof,
then verify the whole current-epoch baseline.

Extend `TenantSyncTarget`, scheduled and readable/manual loaders, every proof
selection and `deriveInitialSyncStatus` input with the durable identities.
The bundle's initial-sync status must read current connection and proofs from
one coherent database snapshot rather than pair newly read states with a
previously loaded connection. Tenant suspension or pending/error consent
suppresses a current completion claim even before another epoch is issued.

All three notice paths (initial publish, full warning clear, incremental
warning clear) must reread/validate this predicate while holding the shared
authority boundary through the notice write. Notification event-type change,
stored notice epoch and recipient-state reset are atomic. Every epoch writer
from the linked design rotates/invalidates under that same protocol. Readers
must distinguish old resolved history from current readiness and apply one
coherent visibility predicate to items/counts/unread/pagination. No generic
history filter or stale in-memory predicate satisfies this contract. An old
completed notice can only describe history if current readiness has since
become incomplete; it must not override a newer RUNNING/FAILED proof.

## Locking and rollout limits

Proposed shared ordering is existing managed/HAW-21 authority locks, tenant,
connection, affected SyncState rows in a deterministic resource order, existing
resource advisory/data locks, then notification and recipient rows. This is an
integration requirement, **not a verified existing global order**: reconcile
it against HAW-21 and all managed-authority writers before coding guards.
The current USERS terminal transaction takes SyncState before connection;
snapshot/window transactions take advisory/data locks without that parent
boundary. All participating paths must be migrated together. Locking only
existing proof rows does not cover an absent row; the common parent lock and
required uniqueness must serialize first creation too. Do not use SKIP LOCKED
to call a missing proof complete. Do not hold a transaction across provider I/O.

A normal read-committed transaction can observe different committed states
across successive queries. Use one statement or an explicitly shared read
snapshot for read-only projections; guarded writers need current locked
authority, not merely an old repeatable snapshot. PostgreSQL documents the
[snapshot behavior](https://www.postgresql.org/docs/16/transaction-iso.html)
and [consistent lock-order requirement](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-DEADLOCKS).
These are design premises, not evidence that the candidate passed race tests.

An additive nullable schema alone leaves readers inactive. Activate only after
all epoch writers, resource producers, terminal/error paths and readers use
the protocol, legacy state is explicitly incomplete, and the whole package is
reviewed and proven. Mixed old/new writers could retain or overwrite proof;
there is no rolling-deploy safety claim. Until then retain protected main as
fallback. Any eventual rollback after activation needs its own reviewed
compatibility plan; do not assume an older binary understands populated proof
columns. No manual database recovery is authorized here.

## Required falsifiers and next bounded step

Before activation, registered disposable-PostgreSQL CI must prove:

- Same-millisecond old/new epoch rejection and genuine same-millisecond new
  success; missing/null/foreign scope; duplicate resource cannot satisfy coverage.
- Every required resource's claim/persist/finalize, complete empty result,
  partial/budget/failed result and recent-success no-op; historical success
  remains ineligible during a newer attempt.
- New attempt or epoch winning before old persistence, terminal success,
  terminal failure and each notice mutation; opposite commit orders too.
- Partial multi-batch persistence, crash between persisted marker and terminal
  success, unknown acknowledgments at both boundaries, exact readback and
  replacement-before-readback. Unproved/superseded results must not publish.
- SIGN_INS current Graph window versus stale merged window/limited fallback,
  M365 concurrent backlog/discovery changes, and all competing baseline writers.
- First-row creation, deterministic multi-resource locking, no USERS/connection
  inversion, transactional rollback, HAW-21 takeover/recovery integration,
  and actual bundle/notification/count/unread/page truth after both commit orders.

The unused pure proof validator and identity/null/scope/time/status tests are
now prepared locally, retaining the current held orchestration witnesses.
It models proposed fields without wiring readers or creating migration authority.
The companion storage/projection contract now specifies the additive checks and
mapping; next implement/prove the nullable storage and registered witnesses,
then writer integration as an inactive package. Pure tests cannot prove
durability, lock order, current PostgreSQL visibility or tenant-wide fencing.

No production behavior or schema change, physical database run, source publication,
CI, merge or release is part of the unused-validator step. HAW-77 remains In Progress and
inactive; complete authorized source review and exact-head CI are still absent.
