# Directory-audit incident recovery contract (inactive design)

This document tracks the inactive HAW-21 audit-alert write path and the
remaining recovery contract. It is not a production guarantee or an
authorization to enable tenant-wide visit fencing.

## Failure that the current partial cannot repair

Earlier visits saved raw rows and published security notices in separate
operations. The inactive current candidate now writes each observed security
notice in the **same owner-checked transaction** as its raw audit batch. A
failed notice rejects that transaction; duplicate rows use insert-if-missing
without changing an existing notice. This prevents a new raw-only event through
the owner-bearing path, subject to physical transaction proof. Ownerless legacy
behavior is unchanged, and historical raw-only rows can still exist.

`logSyncStart` uses the latest saved audit timestamp minus ten minutes, so a
later Graph page can omit a historical raw-only event while its six-month raw
row remains. The held absent-page witness in
`tenant-visit-audit-incident-recovery.test.ts` reproduces this: the successor
publishes zero incidents because the collector has no persisted-row scan.

The current indexes make `notifications(organization_id, dedupe_key)` unique and
`directory_audit_logs(customer_tenant_id, microsoft_audit_id)` unique. A fixed
`findMany(take: N)` scan over audit rows is not a recovery algorithm: already
notified rows can fill every page while a missing incident remains outside it.
Replaying every raw row with the ordinary publisher is also invalid: that
publisher increments occurrence counts, reopens resolved notices, and deletes
reader state.

## Remaining historical recovery transition

1. Select retained security audit rows whose exact organization-scoped dedupe
   key has no matching notice, ordered oldest first and limited by a measured
   batch size. The selection must be tenant- and organization-scoped and must
   not let already-notified rows fill the page. A mismatched existing notice
   must be selected for collision validation, not treated as repaired.
2. Reuse the shared incident mapping and owner-checked insert-if-missing writer
   for each selected row. Existing occurrence, resolved, read and dismissed
   state must remain unchanged. A lost owner leaves the row available for the
   successor. A backlog larger than one batch must make progress without a
   false success or starvation; no cadence or failure policy is chosen here.
3. Decide and prove the retention boundary before activation. Raw audit rows
   are pruned after six months. An unresolved missing notice must not disappear
   silently with its only reconstructable source. A compact pending marker or
   coverage record may be needed if a measured anti-join cannot provide this
   guarantee; its retention and payload require separate review.

## Required falsifiers before activation

- The absent-page held witness passes through a persisted-row recovery path,
  including a successor that sees an empty provider page.
- A predecessor paused before its raw/notice commit cannot write after
  successor takeover. A predecessor that commits just before takeover leaves
  both raw row and notice; a failed notice commits neither.
- Duplicate provider pages, retries, two competing visitors, a pre-existing
  read/dismissed/resolved notice, and a colliding dedupe key have exact expected
  outcomes. A backlog larger than one batch makes forward progress without a
  false success or starvation.
- Registered disposable-PostgreSQL CI runs the two-client transaction and
  retention races at the exact reviewed head. Synthetic tests alone do not
  establish physical lock or crash behavior. Production owner admission and
  every other SYNC writer remain separate gates.

Fallback is to leave this design and all partial fencing inactive; the current
protected branch remains the deployed source. No manual sync or production
database recovery is part of this design.
