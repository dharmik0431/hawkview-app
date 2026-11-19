# HAW-75 coverage-gap recovery order

Status: inactive recovery design, reconciled 19 November 2026. The additive storage and transfer components at public head `57177ee486211dcb205c6db1cf43ec848fddadfa` passed registered CI and component-scoped Claude review. See the [exact proof and limits](haw75-gap-transfer-reader-contract.md#exact-component-proof-and-its-limits). This documentation follow-up has no new hosted result or Claude review. No writer, reader, retention policy or deployment is activated by this document; installing the candidate DDL would change database behavior.

## Verified inputs

The source baseline is protected main `a15951997b6734b9fc612717cf965c9f9651176c`. The clean recovery parent `3fbd54412f765e41fd52e5bd5aada9ab4b867df0` adds only the inactive fair-turn helper and its five synthetic tests. That helper has no production caller and does not reserve capacity.

Nineteen orphaned HAW-75 files survive in a local archive with SHA-256 `ea5bb4bca18a83f92a0e76ba302a4f44703c467990b0a15163ff31aa483fd33b`. This is evidence for individual files, not a complete historical patch or testable checkout. Do not copy the archived service, full Prisma schema, deployment configuration or physical test suite wholesale into the recovery branch.

The following archived components were inspected by content hash:

| Component | SHA-256 | Recovery dependency |
| --- | --- | --- |
| Coverage-gap SQL migration | `e815f953db982baa68280be75261e64ae8f3b746a02da7d3cb17fe35e0fea433` | Combines new storage with an existing content-column contract change. |
| Gap transfer and completed-URL scrub helper | `494c42057c8743d92c02080ae8b0006d30868184d4f9a0e852ba3f7971481df7` | Requires new storage, a real owner/tenant lock and compatible content writers. |
| Gap-aware discovery helper | `98b3aee2e6f00b0eeeb786d1ef52adc09d5f6be9bcae574b7253ab4b7e1bb01c` | Requires the same storage and serialization contract as transfer. |
| Gap purge helper | `9e93ec2eac20c613734490dbe4456984b57508e2a217d75d8d098b77998dfc29` | Requires a durable tenant marker and a reader that respects it. |

## Concrete missing boundary

Current main's `backend/prisma/schema.prisma` requires `M365ActivityContent.contentUri` and has neither coverage-gap model. The archived migration both creates the gap/state tables and makes the existing content URI nullable, allowing null only for completed checkpoints. Restoring the new tables does not require changing that existing column; the latter belongs to the separately proved completed-checkpoint scrub path. Do not infer a current compilation failure or production null-URL incident from this source difference.

In current main's `backend/src/tenants/m365-management-activity.service.ts`, the final `blocked` result is derived from content/subscription/discovery backlog. The subsequent cleanup deletes expired content rows without persisting a gap marker. Neither this reader nor its surviving archived service counterpart reads the new coverage-state table. The archived transfer and purge helpers have no production caller in those source cuts. Merely restoring their files cannot repair the current outcome calculation.

This creates a specific integration gate: once an unresolved expired row is transferred or purged, a later visit must still report incomplete coverage even when ordinary content counts are zero. A sticky marker without an outcome reader is insufficient. The desired reader/cleanup negative control must fail on the current path; an empty-store migration check cannot substitute for it. This is a source-level dependency finding, not a newly observed database or customer incident.

## Next bounded reconstruction

The new gap/state storage has been recovered as a separate additive local foundation, with only the corresponding Prisma models and relation fields. The existing non-null content URI contract remains intact. The candidate includes digest/status/reason/time/generation constraints, tenant-plus-organization foreign keys, uniqueness, indexes and restricted table access. It remains uninstalled. Do not claim that installing DDL is inactive merely because no application helper calls it.

The storage slice has a new disposable-PostgreSQL schema witness registered in both source inventories and the runner contract; its three cases passed at the exact public head above. This establishes storage behavior for that candidate, not production integration. It requires both integration/disposable markers and the strict hosted-job identity. The archived budget suite is absent from current main's database test inventory and includes older single-opt-in cases; it is not a drop-in registered test. Local schema/type/inventory checks remain non-physical evidence.

The [transfer and sticky-reader contract](haw75-gap-transfer-reader-contract.md) identifies the current writer/reader boundaries and remaining integration witnesses. The [expired-content selection contract](haw75-gap-selection-contract.md) specifies bounded lossless traversal and the cleanup negative witness without choosing durable fairness or turn-advancement policy. Recover transfer, discovery and purge individually with their synthetic tests, keeping all callers absent until the integrated contract is proved. Recover nullable completed-URI storage and scrubbing together with completed-ID deduplication and compatibility checks, rather than importing the archived whole schema. This order changes no approved retention or capacity policy.

## Activation contract shared by the recovered pieces

The owner-supplied retention remains 30 days for URL-free gap records, measured as 720 hours from `first_observed_at`, with an incomplete-coverage marker surviving beyond that until verified recollection closes it. Repeated transfer/upsert of a retained gap preserves this first-observed timestamp; provider expiry does not start or shorten the gap-retention clock. After purge, the marker retains neither the digest nor its first observation; the transfer/reader contract specifies that limitation and prohibits inferred clearance. Provider URLs retain their separately approved earliest provider, ledger and immutable discovery-age deadline. Restoring ordering or gap storage does not approve a new quota, cadence or fairness guarantee.

The HAW-21 package supplies the real scoped live-owner contract. Do not recreate it here or treat an arbitrary successful callback as evidence of ownership. Transfer, discovery, purge and later repair must serialize on an existing scoped tenant before consulting optional state/gap rows. A `FOR UPDATE` query locks the rows it returns; a missing state/gap row does not supply a common row lock. This is why the archived callback's tenant-lock obligation matters even for first-gap creation. See [PostgreSQL 16 row locking](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS).

Keep provider requests outside the database transaction. Evaluate expiry using database time after relevant waits. Compare the selected content URI/attempt under the lock, and commit the marker/gap change with the conditional content removal. Discovery must honor retained gap identity and cannot resolve it; cursor advancement and even empty discovery pages still need the real owner check. Integrating this contract requires reviewing all competing writers and cascades, not just the order of statements in one helper.

Before any activation, registered physical witnesses must establish:

1. On first-gap creation, concurrent discovery cannot resurrect the URL after transfer; prove both commit orders with initially absent state and gap rows.
2. Unresolved transfer followed by an empty ordinary backlog remains incomplete on the next visit. After 720 hours, gap deletion still leaves the marker and the reader incomplete. Passing a fake transaction test alone is insufficient.
3. Failure between marker creation and content deletion, or between sticky-state update and gap deletion, rolls back all related changes. A lost result can be retried without false repair or duplicate accounting.
4. Resolved-gap retention and completed-URL scrubbing preserve content-ID deduplication. Ordinary rediscovery never clears an incomplete marker or double-charges accepted records.
5. Stale owner, takeover, tenant/organization deletion, unsupported role and scope mismatch cannot commit gap/state/content changes. No local physical test, manual tenant repair or provider call is part of this proof.

## Fallback and limits

Keep this branch local and inactive; protected main is the release fallback. The HAW-70 exact-source upload question remains separate and does not authorize publishing this new HAW-75 material. No full SYNC, three-tenant fairness or Baseline completion follows from this design. Complete-source review, exact-head registered CI, normal protected merge/configured release, health and authenticated canary remain required for an active package.
