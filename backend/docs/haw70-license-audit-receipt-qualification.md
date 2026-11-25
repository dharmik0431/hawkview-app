# HAW-70: license audit receipt qualification

Prepared physical witness, 21 November 2026, on the inactive owned-collector
candidate `2b5aa6c77767973acebe1cf6ab0c8c53c9992c4d`. It has not executed against
PostgreSQL. No runtime, schema, migration, workflow, cadence or retry policy
changes are included.

## Added boundary

The existing [authority suite](../src/tenants/tenant-health-source-authority.database-integration.test.ts)
retains its original named ownerless and owned cases and their five controls.
One additional named owned audit case reuses that helper with an audit revision.
It calls the real LICENSES collector, real Prisma transaction, owner check,
snapshot writer and difference-evidence builder. Provider responses and
notification sinks remain synthetic. It does not invoke the full replay
dispatcher or a concurrent audit producer.

A scoped delegate hook invokes the actual audit-work `updateMany` exactly once
and inspects its returned count while the same transaction is still open.
It verifies the exact organization, tenant, resource and revision predicate,
and that one real baseline upsert has already returned. Neither the receipt
operation nor its result is fabricated. The earlier cases still observe their
original pre-baseline boundary.

The new case observes inventory, baseline, evidence, the complete receipt row,
sync state and health authority from the transaction and a separate committed
session. Successful completion's timestamp must equal the baseline observation
at stored PostgreSQL precision, using a database-side comparison rather than
only JavaScript Date milliseconds. The committed receipt must match the exact
row observed inside; rollback must retain the full prior row.

## Nine sequential controls in one physical declaration

| Control | Receipt result |
| --- | --- |
| Matching revision 2 | One row acknowledged with the source transaction. |
| Known failure after revision 3 acknowledgment, before commit | The exact injected error is observed before service translation; source and receipt roll back. |
| Positive revision 3 retry | Source and receipt commit together after the known rollback. |
| Selected revision 3 after request advances to 4 | Count zero; new complete source can commit while request 4 stays pending. |
| Current revision 4 after stale selection | Count one; no additional source differences for the unchanged payload. |
| Already completed revision 4 | Count zero; every receipt field stays unchanged while a different complete source can commit. |
| Empty inventory at revision 5 | SKU removal, removal evidence, empty baseline and receipt commit together. |
| Unchanged empty inventory at revision 6 | Completion advances without duplicate removal evidence. |
| Missing exact request row | Count zero; no row manufactured, with matching-number sibling/resource/organization controls intact. |

The fixture advances request revisions monotonically between collector calls;
it deletes the exact row only for the final missing-row control. These fixture
updates do not represent a real audit enqueue, a concurrent writer or scheduler
retry behavior. One physical test declaration contains all nine sequential
controls; they are not nine separately reported test cases.

## Locks, authority and cleanup

The materializer, committed observer and probe connection must have three
different backend PIDs. Existing exact-scope organization/tenant/lease probes
continue through the later receipt boundary. Count-one receipt writes add an
exact-row `FOR NO KEY UPDATE NOWAIT` conflict requiring SQLSTATE `55P03`, with a
one-row free-lock control before the first call and after each count-one outcome.
Every probe uses a savepoint
and rolls back. Count-zero paths do not claim the absence of incidental locks.
The organization probe alone does not identify the explicit owner lock because
foreign-key checks can also take organization locks.

RUNNING and terminal sync-state transactions independently advance health
authority. The expected two advances come from those state writes, not license
or audit-receipt invalidation. No license invalidator is installed by this
candidate. Sibling inventory/receipt, another resource's receipt and another
organization's receipt/authority remain unchanged.

The proxy preserves transaction options and the runtime's default timeout.
Hosted execution must establish that this instrumentation fits it; the older
audit-atomic fixture's twenty-second override is not used. Hooks clear in
finally, exact-owner release must succeed, clients disconnect even if release
fails, and the existing fixture cleanup removes its scoped organizations.

## Evidence and remaining work

This is test preparation only. The suite now declares 36 physical top-level
cases plus its separate synthetic adapter case. Local import/skip execution
cannot prove these new database outcomes. Existing SYNC tests already specify
LICENSES post-receipt rollback/retry, all-resource dispatch and takeover; they
are retained and must run on the eventual integrated head, not duplicated or
credited from an older revision.

Real producer-before-publication and producer-blocked-by-publication schedules
remain separate future work. A direct collector can succeed while a newer
request remains pending; the enclosing dispatcher's final pending check is not
exercised here. Lifecycle renewal/loss, direct/bulk writers, parent deletion,
unknown commit outcome, installed license invalidation, actual notification
persistence, full reader/recovery, permission and fleet-cost proof remain open.

Keep this HAW-70 package inactive. Registered disposable-PostgreSQL CI must
prove the actual candidate checkout, required named cases without skips,
fresh-install and current-main upgrade migration paths, and all configured
checks. Authorized independent review, normal protected merge, automatic
release, health and authenticated canary are later gates. Protected main is
the fallback; no partial migration deployment or manual recovery. HAW-21 and
20-minute SYNC activation remain separate.
