# HAW-70: sync-state participation before current-health activation

## Scope and decision

This is a local design, based on source at
`f3b47f37d859b78ec6ceb232724ff0e2394ea176`, not an installed migration or a
release approval. The next writer slice is `sync_states`: its rows affect every
collector's health, including a failure or loss of freshness without new audit
activity. Keep the existing lifecycle/audit candidate inactive. Do not connect
the current-health reader or expand the experimental reconciliation receipt's
meaning as part of this slice.

Use database-level, transactional invalidation for old and new writers. An
application helper alone would miss existing Prisma operations, raw SQL and
cascade deletion. Prepare the source invalidator and its registered database
witnesses together. Connection-source participation needs the additional lock
ordering correction described below before that later trigger is installed.

## Observed input and writer inventory

The read chain is `tenantSelect` -> `mapTenant` -> collection readiness and sync
freshness -> `deriveTenantHealth`, in
[`tenants.service.ts`](../src/tenants/tenants.service.ts) and
[`tenant-health.ts`](../src/tenants/tenant-health.ts). It selects all resource
types' status, last attempt/success, error code/message and consecutive failures.
Changing the resource type or either scope key also changes which tenant's
evaluation sees that evidence. Absence of a formerly present row is a change.

| Writer in the inspected source | Sync-state mutations | Transaction boundary to preserve |
| --- | --- | --- |
| `claimTenantUsersLease` in `tenant-sync.service.ts` | USERS claim/update or first create | Short UTC transaction; provider work happens later |
| `syncConnectedTenantWithinMemoryLane` in the same file | USERS success/failure and delta state | Customer-managed success writes USERS before the connection timestamp; managed success skips that connection write |
| `runSnapshotSync` in the same file | Create/upsert, RUNNING, SUCCEEDED, FAILED and failure counters | Existing resource outcome transactions; an unsuccessful resource must not become a successful collection |
| `M365ManagementActivityService.syncTenant` | M365_AUDIT state upsert and terminal outcomes | Preserve independent audit failure and retry semantics |
| `TenantsService.markInitialSyncDue` | Initial USERS IDLE upsert | Separate transaction after connection setup |
| `publishConnectionVerification`, `publishCapturedConnectionRefresh` | Raw DIRECTORY_ROLES attempt invalidation/status update | Managed authority, tenant and connection locks precede the role row |
| `consent-operation-store.ts`, `directory-role-receipt-store.ts` | Raw role creation, attempt, terminal and scope/receipt changes | Existing exact owner/scope conditions must remain intact |
| Tenant/organization deletion and direct maintenance SQL | Cascaded or explicit DELETE; scope/resource corrections | Source deletion and health invalidation must commit or roll back together |

This inventory is anchored to the inspected head, not a claim that future
writers are covered. Before implementation, repeat the search for Prisma and
raw-SQL mutation paths. Do not execute the existing QA seed/dump scripts against
a database as part of that search.

## Required invalidation semantics

1. INSERT, UPDATE and DELETE use affected rows, not caller-supplied tenant IDs.
   For UPDATE include both old and new `(organization_id, customer_tenant_id)`
   pairs. A resource change within one pair still invalidates that pair.
2. For each distinct affected live authority, advance `source_revision` and
   clear both `current_snapshot_id` and `current_observation_sequence` in the
   same transaction as the source mutation. Preserve the incarnation. Do not
   publish a replacement snapshot from the trigger.
3. Coalesce per statement/event, not per row or per transaction. A statement
   affecting no rows, or an INSERT conflict skipped without UPDATE, must not
   advance any authority. An upsert's INSERT/UPDATE trigger events must be
   tested separately; do not assert exactly one increment for a transaction
   that contains several source statements.
4. Invalidate conservatively for no-op updates and fields outside today's
   reducer projection. This avoids an allowlist silently becoming incomplete
   when a later reader consumes a new sync-state field. Measure the resulting
   revision churn before activation; an increment is not successful collection.
5. Preserve dead-authority tombstones. Never recreate or revive authority from
   a child write. Missing authority remains unavailable to a future reader and
   must be repaired by the reviewed automatic generation, not opportunistically
   trusted. The slice cannot make legacy rows authoritative.
6. An invalidation error, including revision overflow, rolls back the source
   mutation; never swallow it or issue an unconditional compensating success.
   Prove the existing caller outcome handling before release. Do not introduce
   a new retry, cadence, provider or failure policy in this change.
7. Inspect application-role permissions and bulk maintenance. Row-transition
   triggers do not specify TRUNCATE behavior. Before activation prove that
   TRUNCATE/trigger bypass cannot bypass the protocol, or design and test their
   explicit invalidation/refusal semantics. No production privilege changes
   are authorized by this document.

## Exact lock graph and the connection dependency

Do not infer a row-lock cycle merely from reverse table order. USERS and
DIRECTORY_ROLES are different sync-state rows. Moreover,
`captureConnectionVerification` rejects customer-managed connections, while
only customer-managed USERS success performs the connection timestamp update
inside its sync-state transaction. Those two cited paths are not a demonstrated
existing same-tenant deadlock.

There is a concrete **prospective** conflict when both sync-state and connection
invalidation are present. For one customer-managed tenant, let S be its USERS
row, C its connection row, and H its health authority:

| Transaction | With both proposed invalidators |
| --- | --- |
| USERS success | Write S -> sync-state trigger locks H -> update C |
| Customer connection verification | Lock tenant -> lock/write C -> connection trigger requests H |

If verification holds C while USERS success holds H, each can wait for the
other. `publishCustomerConnectionVerification` is the reachable second writer;
it does not need to write any sync-state row. This is a predicted interaction
of future triggers, not a reproduced production incident. A sync-state-only
trigger does not establish this particular cycle.

Before adding connection invalidation, require the customer-managed terminal
transaction to acquire the applicable tenant/connection locks before its first
sync-state write can acquire H, and preserve/recheck the captured ownership
conditions. Coordinate that source-path change with HAW-21; this backlog design
does not implement another visit lease or weaken its receipt. The exact
publication/connection writers and lifecycle cascades must share a reviewed
order. Do not declare the whole graph safe just because these two paths agree.

The future health reader must not lock H and then acquire source/parent write
locks in the opposite order. Bulk and scope-moving statements also require a
stable order for all affected authority pairs; an unordered UPDATE over a set
of pairs is not proof of lock order. Audit the whole transaction, including
later statements and deferred foreign-key checks, not only the trigger body.

## Registered disposable-PostgreSQL witness specification

Use the existing registered source-authority integration suite and its strict
hosted disposable guard. No local/live database, provider call or manual sync.
Seed an exact tagged snapshot pointer and a second unaffected tenant. Observe
through an independent database connection while the writer is held open;
promise completion or a mocked callback is not commit evidence.

| Witness | Required observation |
| --- | --- |
| First create, claim, success, failure, correction and delete | Old pointer/revision visible externally before commit; committed source and invalidated exact authority visible together afterwards |
| Bulk, zero-row and conflict-skipped writes | Affected pairs only, coalescing at the documented statement/event boundary; unrelated tenant unchanged |
| Resource/scope move | Old and new pairs invalidated; no tenant obtains another tenant's current pointer |
| Rollback, overflow and missing/dead authority | No partial source/pointer changes; dead authority stays dead; missing authority cannot produce trusted current health |
| Tenant/organization cascades and concurrent audit changes | No resurrection or stale pointer; forced actual lock overlap, with rollback and final state checked independently |
| Same-tenant customer USERS success versus verification | Once both trigger slices exist, use the real publication path and real terminal transaction with controlled statement barriers; verify actual blocking edges, then both corrected outcomes without a hidden retry or swallowed deadlock |
| Bulk/cross-tenant ordering | Two clients acquire overlapping source/authority sets in opposing input order; prove the selected order and bounded outcomes, not just sequential execution |

The prospective two-trigger witness needs the second trigger installed in the
registered fixture; it cannot pass meaningfully today by omitting that edge.
Before a fix, it must demonstrate the stated contention or fail its setup,
rather than accept an unrelated error as a successful reproduction. Once fixed,
reject timeouts/deadlocks unless a separately reviewed existing automatic retry
contract explicitly covers and measures them. No such retry is added here.

## Remaining activation gates and fallback

`sync_states` is only one uncovered input. `tenant_connections` and tenant status,
selected `tenant_entra_snapshots`, usage `tenant_collection_field_states`, license
service plans and `m365_activity_subscriptions` all feed the current mapper.
Connection/consent and tenant-scope changes must participate too. Complete tagged
snapshot publication, coherent evidence reads, bounded per-tenant audit reads
and the current-reader admission gate remain separate unfinished work.

Passage of time can make unchanged source data stale. A source revision alone
cannot authorize an indefinitely cached HEALTHY result: the reader design must
validate the evaluation's freshness boundary against its evaluation time/model
and report incomplete/unknown when that proof is absent.

The current experimental lifecycle/audit reconciliation generation checks a
fixed partial lock/migration/trigger inventory. Do not reuse its receipt to
claim this slice or the complete writer set is installed. A later reviewed
complete generation must cover every source and exclusion boundary, with
automatic historical repair and all failure witnesses proved in registered CI.
Retain the existing exact generation and witnesses unchanged in this step.

Release still requires complete-source independent review, exact-head registered
CI, measured 1001-tenant capacity and bounded contention, protected merge,
configured automatic API/cron release, actual health and authenticated canary.
Operational fallback is protected main with the current-health protocol inactive.
Keep this design and its parent archive for continuation; do not deploy a
partial migration or manually repair production to make an admission check pass.
