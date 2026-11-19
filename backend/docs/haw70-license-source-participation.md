# HAW-70: license inventory participation contract

Design-only checkpoint, 18 November 2026. Reviewed parent:
`8623cf401f54e5497d01d287b278399b517115ea`, based on protected main
`a15951997b6734b9fc612717cf965c9f9651176c`. No trigger, query, schema, permissions,
receipt generation or runtime behavior changes here. The cumulative candidate
remains inactive; installing its existing migrations would affect writers.

## Decision

Follow-up test preparation: the existing registered
[`tenant-health-source-authority.database-integration.test.ts`](../src/tenants/tenant-health-source-authority.database-integration.test.ts)
now specifies one modeled multi-SKU/direct-writer cycle. It uses actual license
and authority rows, with explicit client-side authority updates at the proposed
AFTER-trigger position; it installs no trigger and calls no collector. A holds
its resource advisory lock, changes SKU 1 and authority; B changes SKU 2 and must
be observed waiting for A's authority. A savepoint/NOWAIT probe must independently
show SKU 2 is locked, then A's second source write forms the cycle. Exactly one
real deadlock SQLSTATE and one successful statement are required; either victim
is accepted, while timeouts are failures. Both transactions roll back, including
the survivor; complete fixture source/history/authority state, sibling isolation
and released row/authority/advisory locks are checked. A serialized rollback-only
control exercises the same updates without a competitor.

Execution update, 18 November 2026: the exact reviewed candidate
`6d254b0308b82d6b75d8fc2eec59f93407501bda` passed
[registered disposable CI](https://github.com/dharmik0431/hawkview-app/actions/runs/44396832428),
including this modeled cycle and its rollback/released-lock controls. The model
does not reproduce an installed trigger or real `saveSnapshot` transaction and
does not prove a correction, commit-loss recovery, parent deletion, permission
boundary or collector outcome.
Its explicit client-side invalidation is a model of proposed placement, not an
application writer to ship. The existing fixture rejects nonregistered/local
physical targets before constructing clients. No runtime/DDL/migration/workflow
change or new fixture trigger is introduced. Full-collector and parent schedules
below remain required. The new [collector qualification decision](haw70-license-collector-qualification.md)
defines the next smaller actual-adapter transaction witness before selecting an
admission-lock implementation; that witness remains design only.

Treat license inventory as a saved-health source, but do not copy the existing
snapshot invalidator onto it without resolving the full transaction's lock order.
This checkpoint specifies the desired mutation semantics and the acceptance
witnesses. It does not select or approve a locking implementation.

The [dependency tests](../src/tenants/tenant-health-input-dependency.test.ts)
exercise the actual mapper and history writer with synthetic storage and a frozen
clock. They show that row presence and service-plan evidence affect risk availability
and resource applicability. Quantity-only and plan-order controls preserve the
current saved projection. Those 13 passing cases are local dependency evidence,
not a PostgreSQL race reproduction or proof of future model behavior. See the
[dependency trace](haw70-persisted-input-dependencies.md).

For an initial candidate, prefer conservative whole-row INSERT/UPDATE/DELETE
participation over interpreting service-plan JSON inside SQL. This deliberately
invalidates quantity-only, last-seen-only and no-op updates, despite their current
projection equality. It avoids silently excluding legacy, malformed or future
plan representations. This is a proposal, not permission to ignore revision churn:
the real collector updates every returned SKU on every successful visit. Measure
authority write count, lock occupancy and fleet cost before accepting the design.
A selective optimization would need a separate exact dependency/equality contract.

The LICENSES snapshot is a baseline for change evidence, not a substitute for
the selected inventory relation. Adding LICENSES to the snapshot resource filter
alone would miss direct inventory corrections/deletions. This design does not
expand that resource filter or assert a new saved-health dependency on its payload.

## Full writer boundary

At this parent, `syncLicenses` in
[`tenant-sync.service.ts`](../src/tenants/tenant-sync.service.ts) validates the
complete subscribed-SKU response, then calls `saveSnapshot` with an inventory
callback. Source order is:

1. Persist RUNNING sync state before collection, outside the inventory transaction.
2. In `saveSnapshot`, acquire the tenant/LICENSES transaction advisory lock and
   read the previous snapshot; reject an organization mismatch.
3. Build difference evidence and insert any events, then call the inventory callback.
4. Upsert each validated SKU separately, in returned-row order. Delete absent SKUs
   using the organization/tenant scope after the loop.
5. Upsert the LICENSES snapshot and commit this transaction.
6. Only after the awaited save completes, write terminal sync state separately;
   normal success then resolves the recovery incident. Failure handling can fail
   separately and is not changed by this design.

The snapshot transaction contains inventory, change evidence and the baseline,
but not the RUNNING or terminal state. Existing sync-state invalidation cannot
stand in for inventory participation between these commits. There is no provider
request inside this snapshot transaction; the provider result was obtained before it.

[`TenantLicense`](../prisma/schema.prisma) has nullable service-plan JSON, a unique
tenant/SKU key, an organization foreign key and a composite tenant/organization
foreign key. The [creation migration](../prisma/migrations/20260730233000_tenant_licenses_domains/migration.sql)
sets both foreign keys to cascade on delete/update. Direct DML, FK cascades and a
future writer may bypass the collector's advisory lock. The current LICENSES
snapshot upsert is excluded from the [two-resource snapshot invalidator](../prisma/migrations/20261116024500_tenant_health_input_snapshot_source_revision/migration.sql),
but still participates in ordinary snapshot row/unique/FK locking.

## Required mutation semantics

The following describes a candidate's required behavior, not installed behavior.

| Operation | Required source-authority effect |
| --- | --- |
| INSERT / DELETE | For each distinct affected organization/tenant pair, advance existing live authority and clear its current pointer and observation sequence in the same transaction. |
| UPDATE | Union OLD and NEW scope pairs; cover same-scope changes, same-organization tenant moves and cross-organization moves permitted by the foreign keys. Conservative no-op updates participate. |
| Bulk statements | Deduplicate pairs within each transition event, then explicitly visit them in stable organization/tenant order. This orders authority acquisition within that event only. |
| Upsert | Cover actual INSERT and UPDATE transition events, including fresh, conflict and mixed paths. Do not assume one increment for an entire upsert or a whole collection transaction. |
| Zero affected rows / DO NOTHING | An empty transition set must not advance any authority. An already-empty license inventory replaced by empty input has no inventory mutation; its separate sync-state path still participates. |
| Missing or dead authority | Do not create, resurrect or trust authority. Existing missing/dead semantics remain untrusted; do not mistake zero matching live rows for successful current-health admission. |
| Failure | Overflow, FK, privilege or required authority-visibility failure must abort the relevant source transaction, including earlier SKU/evidence/baseline writes within it. Do not swallow errors or signal collection success. |
| Parent deletion | Tenant deletion must leave a dead, cleared authority; organization deletion removes its scope. Child invalidation and tombstoning can both advance revisions, so do not demand a total increment of one. |

Statement triggers can fire with no affected rows; conflict handling can invoke
more than one statement event. Transition relations describe the rows of those
events. Cascaded actions also fire applicable triggers; their event grouping must
be observed instead of assumed to equal the initiating statement. These are reasons
to count distinct scopes per actual event, not per service call.
[PostgreSQL 16 trigger behavior](https://www.postgresql.org/docs/16/trigger-definition.html),
[CREATE TRIGGER](https://www.postgresql.org/docs/16/sql-createtrigger.html).

Retain the [writer permission boundary](haw70-writer-permission-boundary.md): an
invoker function with qualified names, fixed catalog search path and error-on-RLS
authority access, without new grants, policies or SECURITY DEFINER privileges.
Prove genuinely permitted source mutations against hidden live authority separately
from source denial, missing ACL and legitimate missing/dead authority. Function ACLs
alone do not attest installed-trigger execution or production role containment.

TRUNCATE has no row transition set. The candidate must refuse direct and cascading
license truncation, including mixed table orders, through an ALWAYS refusal guard.
Test effective permitted restricted roles as well as the fixture owner. Ordinary
DML trigger modes do not protect against authorized trigger disabling or replica
bypass; keep trusted DDL/maintenance and deployed-identity attestation as gates.
The existing historical reconciliation receipt cannot authorize this added source.

## Lock-order hold: an AFTER trigger alone is insufficient

There is a concrete source-derived cycle to investigate before adopting the naive
statement-trigger design. The explicit client-side model of this cycle has now
executed in registered CI; the corresponding installed-trigger/actual-collector
schedule remains unproved:

| Step | Collector transaction A | Direct writer B |
| --- | --- | --- |
| 1 | Holds its LICENSES advisory lock; changes SKU 1; a proposed trigger locks health authority. | |
| 2 | | Changes existing SKU 2; its proposed trigger waits for A's authority. |
| 3 | Next upsert needs SKU 2 and waits for B. | Still needs A's authority. |

The resource advisory lock serializes two cooperating collectors, but B does not
acquire it. Sorting authority pairs inside a trigger cannot remove the earlier
license-row locks or the later SKU acquisition. Taking that advisory lock only
after B has changed its row would still be too late for this cycle.

Parent deletion adds separate interactions. It holds a parent row while cascading
children; existing audit/sync-state/selected-snapshot triggers may already acquire
authority during those cascades. The tenant tombstone is
[AFTER DELETE STATEMENT](../prisma/migrations/20261113021500_tenant_health_tenant_deletion_tombstone/migration.sql).
A writer already holding authority can later need a fresh SKU's parent check or
the final snapshot upsert while deletion waits on its earlier row/authority locks.
Organization deletion also cascades authority itself. An existing-row update,
a fresh insert and a conflict upsert need distinct schedules; do not assert a
specific FK lock or cascade order solely from the source text.

PostgreSQL row locks persist to transaction end, and advisory locks require
cooperating callers. Consistent ordering must cover the complete transaction,
not only one trigger loop. Database deadlock detection aborting a victim is not
proof of a reliable successful collection path.
[PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html).

Do not fix this by adding a late trigger lock, acquiring authority first without
auditing every source/parent writer, sorting only SKU input, deferring invalidation
without a complete admission proof, or granting broad privileges. No retry,
timeout, cadence or failure-policy change is authorized by this design. Preserve
the separate customer-managed connection lock dependency and HAW-21 ownership work.

## Registered disposable-PostgreSQL acceptance plan

These are specifications only: no new executable test or database run is added.

| Family | Required witness and controls |
| --- | --- |
| Dependency gap | A permitted inventory-only change must commit while an old pointer survives in an intentionally unguarded disposable fixture; inspect actual source and authority from another client. Restore test-only guards before fixture commit/cleanup. |
| Atomic invalidation | Insert, plan/null/legacy update, quantity/no-op update and deletion; inspect pointer, sequence, revision and unchanged sibling before/after commit and rollback. Fresh/conflict/mixed upserts, bulk and zero-row controls count actual transition events. |
| Scope and failures | Same/cross-organization moves, composite-FK rejection, missing/dead authority, and overflow on an early and a later SKU. Later failure must undo all preceding transaction changes and release locks. |
| Actual collector transaction | Call the real save path with synthetic complete collection data and real registered database storage. Cover existing/fresh/conflict SKUs, differing input order, absent-SKU deletion, zero and multiple change events, and final snapshot upsert. Assert evidence, inventory and snapshot commit/rollback together. |
| Multiple writers | Force the three-step inferred cycle with two sessions and observed blocking edges. Then require the selected ordering correction to complete or reject before unsafe partial work, with no torn authority or success signal. Include direct UPDATE/DELETE, reverse multi-scope statements and both cooperating collectors. A timeout alone is not proof. |
| Parent races | Tenant and organization deletion against the entire inventory transaction, both orders, commit/rollback, and in-flight cascade boundaries. Observe actual blockers with independent sessions. Include existing children, fresh SKU insertion and final snapshot writes; preserve sibling/outside scope and inspect installed FK/trigger order. |
| Roles and bypass | Source denied versus source allowed with hidden authority, separate missing privileges, allowed scope moves and owner positive control. Direct/parent CASCADE TRUNCATE in both table orders and replica mode must refuse atomically. Verify fixture role/grant/policy restoration and separately retain deployed-role/DDL gates. |
| Outcome and admission | Inventory failure or uncertain completion cannot become terminal success/recovery by assumption. Extend the actual license wrapper controls without changing failure policy. A future coherent reader must reject an old revision/current pointer after source commit; history deduplication, lost-result recovery and time/model aging remain separate required proof. |

Use distinct asserted sessions, explicit held boundaries and observed blockers;
avoid sleeps as synchronization. Release known blockers before awaiting queued
work during cleanup, and inspect fresh-client state after rollback/commit. Reuse
the [registered database inventory](../src/prisma/native-alert-test-database.inventory.test.ts)
and [workflow](../../.github/workflows/quality-gates.yml); never execute on local or
live physical databases. Any new physical fixture remains PREPARED until exact-head
authorized disposable CI logs demonstrate that it ran without skips. A one-SKU
statement test is insufficient for the full collector graph.

## Next step and fallback

The modeled cycle now has a passing registered execution. Before selecting a
production trigger candidate, qualify the actual collector transaction using the
[bounded witness specification](haw70-license-collector-qualification.md), then
prove a complete compatible order with actual direct-writer and parent boundaries.
Any experimental fixture must stay test-only and unpublished until exact-source
approval; this design does not authorize public
upload or Claude review. Do not extend the partial receipt or activate a reader.

Keep public draft PR #372 at approved `6d254b0308b82d6b75d8fc2eec59f93407501bda`;
its green CI tests the modeled license cycle, not an installed license guard or
complete collector/parent protocol. The newer qualification document is local only.
Preserve this isolated child, its parent and archives. If the design fails review, revise
only the inactive child; protected main is the operational fallback. No manual
database, migration-history or release recovery. Complete source participation,
authorized independent source review, exact-head CI, protected merge, configured
automatic release, actual health and an authenticated canary remain required.
HAW-70, Baseline and full SYNC are incomplete.
