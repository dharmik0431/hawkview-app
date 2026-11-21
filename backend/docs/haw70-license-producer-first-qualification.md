# HAW-70: audit producer before license publication

Prepared physical witness, 21 November 2026, based on inactive candidate
`f79663201cd7b5cb488d9b8b684d3087df1ba1df`. This case has not executed against
PostgreSQL. It adds no runtime, migration, workflow, cadence or retry changes.

## One bounded ordering

The [authority suite](../src/tenants/tenant-health-source-authority.database-integration.test.ts)
adds one named physical case for the producer-first schedule. The real replay
dispatcher selects pending LICENSES revision 2 and commits RUNNING. Before its
synthetic provider response returns, a second real Prisma client invokes the
actual owner-bearing directory-audit producer with a uniquely identified license
event. The real raw insert, evidence projection and work upsert run together.
The producer commits revision 3 while publication has not yet begun.

The event's actual routing must be exactly LICENSES and its security-notice
classification null. Notification sinks are synthetic and reject unexpected
notice/failure publication. Raw insertion, evidence projection, ownership,
receipt SQL, collector, dispatcher and retry eligibility are not mocked.
Connection identifiers distinguish producer, materializer and committed observer.

The observer verifies the committed RUNNING state and old source before the
producer, then the committed raw/evidence/request changes before releasing the
provider result. A duplicate of that same event must return zero inserted rows,
no new requested resource, and an unchanged full observed state. No timer or
unsettled promise is used as proof of ordering. This is a deliberately ordered
interleaving, not a simultaneous write stress test.

## Required outcomes

The real stale revision-2 completion update must affect zero rows. A complete
new SKU inventory, baseline and two difference events can still commit. Every
field of the newer request stays unchanged at requested 3 / completed 0. The
resource is SUCCEEDED and its recovery sink has run, but the enclosing replay
must throw the exact incomplete-work error with no failed resources and pending
LICENSES. The test therefore distinguishes resource success from replay completion.

A subsequent empty replay uses the existing SUCCEEDED-work eligibility policy.
It must select revision 3, acknowledge exactly one row and finish normally with
requested 3 / completed 3. There is no forced resource list, new event, clock
edit, cooldown change or manual production sync. The completed timestamp must
equal the stored baseline timestamp by database-side comparison. Unchanged
inventory and baseline contents add neither raw events nor difference evidence.

Authority deltas are checked at their separate transaction boundaries: first
RUNNING, then raw-audit insertion, then the first terminal state; the second
replay adds only RUNNING and terminal state. Neither license materialization
nor its receipt is credited as installed license invalidation. A sibling tenant
and another organization retain their receipt, inventory, snapshot, raw/evidence,
state and authority observations. The exact owner must release successfully,
both Prisma clients disconnect even on failure, and the shared fixture removes
its isolated organizations. Default transaction and top-level test timeouts are
unchanged.

## Limits and later qualification

The suite now has 37 physical top-level declarations plus its synthetic adapter
case. Counts describe prepared source, not executed database results. Existing
receipt-boundary and SYNC cases are retained unchanged; local import/skip checks
cannot qualify this PostgreSQL schedule or its timing.

The opposite order, where a materializer holds publication and a producer must
block, remains unimplemented. This case neither waits for a conflicting writer
nor proves all lock acquisition orders. Provider data remains synthetic; actual
Microsoft data freshness and notification persistence are outside its scope.
Inventory observations here compare SKU, part number and consumed/enabled units;
the prior owned-collector witness retains the broader business-field checks.
Direct/bulk writers, parent deletion, lease takeover/renewal, unknown transaction
outcomes, installed license invalidation, reader/recovery, permissions and fleet
cost remain separate requirements.

Keep HAW-70 inactive. Physical execution is allowed only in registered disposable
CI after the applicable exact-source authorization. Exact candidate checks,
fresh and current-main-upgrade migration qualification, independent review,
normal protected merge, automatic release, actual health and authenticated
canary remain required. Protected main is the fallback; no partial migration
deployment or manual recovery. HAW-21 and 20-minute SYNC activation are separate.
