# HAW-70: inactive saved-health snapshot participation

## Exact source boundary

This unpublished child of the saved-input dependency checkpoint adds statement
triggers for `tenant_entra_snapshots` rows whose resource is AUTH_REGISTRATIONS or
RISKY_USERS. The [dependency audit](haw70-persisted-input-dependencies.md) traced
both payload and observation time into the actual saved health/freshness payload.
This is an implementation candidate, not a deployed or physically proved writer.
Installing its migration changes existing processes' writes immediately, even
while the future health reader and automatic reconciliation remain unwired.

For INSERT and DELETE, distinct relevant organization/tenant pairs are invalidated
once per statement event. UPDATE unions relevant OLD and NEW pairs before taking
authority locks in organization/tenant order. Moving out of the included resource
set still invalidates the old scope; moving in invalidates the new scope. Included
no-op updates conservatively invalidate; zero-row changes and excluded resources
do not. A mixed upsert follows its actual INSERT and UPDATE transition events, not
an assumed one-event-per-statement total. Within one event, multiple rows for the
same pair coalesce.

Each existing live authority advances its revision and clears the current pointer
and observation sequence in the source transaction. There is no authority insert
or resurrection. Missing/dead authority remains untrusted; overflow aborts the
source write. The function is an invoker with fixed catalog search path and
`row_security=off`, which rejects authority writes hidden by RLS instead of silently
leaving an old pointer. It does not grant the caller broader access. PUBLIC,
anonymous and authenticated direct function privileges are revoked as for the
other candidate writers.

TRUNCATE cannot provide a per-resource transition set. The existing refusal
function is therefore attached to the entire mixed-resource snapshot table as an
ENABLE ALWAYS trigger, including replica mode. DML triggers retain ordinary
origin behavior; this slice does not prove replication, disabled-trigger or
privileged bypass admission. The complete reader/protocol must reject unsupported
writer configurations. No new field-state trigger is introduced.

## Writer and lock boundary

Normal MFA registration, MFA fallback and risky-user collections all call
`saveSnapshot`. Those selected calls have no inventory callback and no risk-UTC
attestation write. They acquire their resource advisory lock, read the baseline,
optionally write change evidence, then upsert the snapshot. RUNNING and terminal
sync-state writes are separate transactions. Static audit found no direct
sync-state/health-authority cycle on these paths; it did not prove the complete
lock graph. The other SIGN_INS and DIRECTORY_ROLES publication writers normally
touch excluded resources, while direct resource/scope corrections are covered by
OLD/NEW membership.

The existing registered parent-deletion witness now includes audit, sync-state
and relevant snapshot rows together. Each source can be held by the writer while
an independent tenant or organization deleter actually blocks. The test demands
authority remain available, then checks source mutation and independent commit
visibility, deletion commit/rollback, sibling isolation and actual catalog cascade
order. That witness covers held existing-row update/delete schedules only.

Four additional registered top-level cases now prepare 42 snapshot-statement
schedules across tenant and organization deletion. The variants are a fresh MFA
INSERT, a fresh risky-user UPSERT and an MFA UPSERT that conflicts with an existing
snapshot. Each fixture includes audit and sync-state children, current health
history, a same-organization sibling and an outside tenant. Three independent
sessions perform the writer, deleter and observer roles.

- Writer first: the source statement finishes inside an open transaction, the
  parent DELETE must actually block on that writer, and source commit/rollback
  is checked independently from deletion commit/rollback. This has 24 schedules.
- Deleter first: the parent DELETE and its cascades finish without committing;
  the snapshot statement must actually block on that deleter. Parent commit must
  produce a snapshot foreign-key failure followed by writer rollback. Parent
  rollback permits the source statement, then its own commit/rollback is checked.
  This has 18 schedules.

Blocking is observed with the actual blocking-session relationship, not a timed
sleep or an assumed FK/tuple lock. A conflicting upsert may block on a cascaded
child row or transaction; the witness does not prescribe which lock is acquired.
Tenant deletion must leave dead authority with an advanced revision and cleared
pointer. Organization deletion must remove authority, including the same-org
sibling, while the outside tenant remains unchanged. Revision advance on deletion
is deliberately not fixed at one: child invalidation and the tombstone can both
participate. A failed source transaction rolls back before final assertions, and
cleanup releases the known blocker before awaiting the competing statement.

These schedules are prepared but unexecuted. The deleter-first cases begin after
cascade work completes; they do not establish every in-flight cascade interleaving.
No barrier trigger or extra lock is inserted. This tests the source-statement
boundary, not the full collector's earlier advisory lock, baseline read or change
evidence transaction. It does not prove all writer ordering, retries, takeover or
recovery, and it does not change the candidate migration.

The separately documented customer-managed connection lock dependency remains
open. This slice does not implement HAW-21 ownership, reader admission, time/model
invalidation, complete reconciliation or the remaining source dependencies.

## Registered witnesses and remaining gates

The already registered
[`tenant-health-source-authority.database-integration.test.ts`](../src/tenants/tenant-health-source-authority.database-integration.test.ts)
adds/extends these hosted disposable-PostgreSQL cases:

- Both selected resources: insert, payload-only, observation-only, no-op and
  delete, with separate-session visibility before and after commit.
- Mixed bulk changes, fresh/conflicting and mixed-path upserts, DO NOTHING, zero rows, excluded
  resources, old/new resource membership, same/different organization moves and
  rollback. Authority invalidation is exact per affected pair and event.
- Source rollback on INSERT/UPDATE/DELETE overflow, excluded-resource independence,
  and missing/dead authority without resurrection.
- Restricted source access with hidden authority, old/new resource membership,
  separate ACL failure and excluded writes without authority privileges.
- Mixed-source parent deletion schedules, fresh/conflicting snapshot write races
  in both stated orderings, and whole-table truncation refusal as
  owner/restricted role, including replica mode and parent CASCADE.

The local gate deliberately skips physical cases. Passing TypeScript, lint,
synthetic dependency tests and static review must not be reported as physical
PostgreSQL proof. Registration does not mean execution. The new migration has not
been installed locally, in CI or in production. A future exact-source-authorized
CI run must exercise this child and apply all migrations before these assertions.

Before activation, execute these exact registered FK/deletion schedules and extend
coverage for any remaining production-writer interleavings. Add and pass failed-save
outcome witnesses (no success receipt/notification after snapshot failure, including
a failing terminal sync-state update). Prove every
remaining writer, authority reader/recovery admission and fleet-scale behavior.
The existing historical reconciliation receipt is not extended by this slice.
No full protocol or Baseline completion is claimed.

## Fallback

Keep protected main operational and public draft #372 frozen at its approved green
head until exact newer material is authorized for publication. Retain the isolated
candidate, branch and verified bundle. If the source boundary or physical schedules
fail review/CI, revise only this inactive child; do not bypass the guards or use
manual database recovery. Protected merge and configured automatic release still
require authorized independent source review, exact-head CI, actual health and an
authenticated canary. No provider, cadence, quota, infrastructure or UI changes.
