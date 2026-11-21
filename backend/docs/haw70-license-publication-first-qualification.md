# HAW-70: license publication before the audit producer

Prepared physical witness, 21 November 2026, based on inactive candidate
`c23798f8e1fffc0e129e1aedb67837c95ead43b9`. It has not executed against
PostgreSQL. It adds no runtime, migration, workflow, cadence or retry changes.
Earlier qualification documents describe their earlier frozen candidates.

## One blocked-producer schedule

The [authority suite](../src/tenants/tenant-health-source-authority.database-integration.test.ts)
adds one physical case for the opposite ordering to the preceding producer-first
witness. The actual owned LICENSES collector publishes a complete synthetic
inventory, difference evidence and baseline, and acknowledges revision 2 through
its real completion delegate. Its transaction is held immediately after that
delegate returns one affected row. The real baseline upsert must already have
completed once. Inside sees the new source and completed revision 2; a separate
committed observer must still see the old source and pending revision 2.

While that transaction is open, a second Prisma client invokes the actual owned
directory-audit producer. Its real event must route only to LICENSES and have no
security-notice classification. The transaction wrapper captures its connection
identity before forwarding the real callback. The observer requires a real
`pg_blocking_pids` edge from that producer to the materializer. An unfinished
promise or elapsed delay alone cannot pass this check. The producer's exact
tenant `FOR NO KEY UPDATE` query must have started and not returned; its raw
insert delegate must not yet have been reached. All three sessions are distinct.
Old source, receipt, raw/evidence and authority remain visible outside while
publication is held and the producer is blocked.

The held callback returns without awaiting the producer. Real Prisma commit or
rollback releases the holder. There is no independent test latch to strand the
transaction. Both producer outcomes are captured immediately, and the producer
must settle before lease release and fixture cleanup even when an assertion
fails. The default transaction options and existing bounded blocking observer
are retained. Meeting those time budgets is still a physical CI requirement.

## Required outcomes

After both operations finish, the real producer must have inserted exactly one
raw event and its directory evidence, and incremented requested revision to 3.
The completed revision stays 2, with a stored completion timestamp equal to the
published baseline timestamp. The source and two expected difference events are
present, the resource is SUCCEEDED, the blocking edge is gone, and sibling-tenant
and other-organization observations remain unchanged.

The first operation calls the actual collector directly. A dispatcher's final
pending-work read could race the producer after publication commits; this test
does not invent a deterministic first-dispatcher outcome. Once both commits are
settled, a normal empty replay must select the remaining revision 3 under the
existing SUCCEEDED-work policy and acknowledge it exactly once. It must leave
source contents and both evidence sources unchanged. No forced resource, new
event, scheduler clock edit or cooldown change is involved.

Authority observations distinguish the prior RUNNING commit, the producer's raw
audit insertion and the collector's terminal state. Neither license publication
nor its receipt is credited as installed license invalidation. Their order after
the materialization commit is not assumed. The second replay adds only RUNNING
and terminal state advances.

## Limits and qualification

This is one prepared ordered schedule, not all lock orders or a load/stress test.
Inventory comparisons cover SKU, part number and consumed/enabled units; earlier
owned-collector checks cover broader fields. Providers and notification sinks
are synthetic. Direct/bulk writers, parent deletion, takeover, unknown commit
outcomes, actual provider freshness, notification persistence, installed license
invalidation, reader/recovery and fleet cost remain separate requirements.

There are now 38 physical top-level declarations and one synthetic adapter case
in the suite. Skipped local declarations are not PostgreSQL execution evidence.
The shared fixture rejects non-registered disposable PostgreSQL before clients
are constructed. Existing physical cases are retained unchanged.

Keep HAW-70 inactive. Applicable exact-source authorization, frozen-candidate
registered physical CI, fresh/current-main-upgrade migration qualification,
independent review, normal protected merge, configured automatic release, actual
health and authenticated canary remain required. Protected main is the fallback;
no partial migration deployment or manual recovery. HAW-21 and 20-minute SYNC
activation remain separate.
