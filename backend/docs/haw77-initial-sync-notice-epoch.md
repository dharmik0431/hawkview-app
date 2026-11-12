# HAW-77 initial-sync notice epoch: inactive transaction design

The local held witness proves three stale-notice paths after customer-managed
reconsent: an old visit can publish `tenant.initial_sync_completed`, and a later
full or incremental visit can clear an incomplete warning using a connection
snapshot loaded before consent changed. No notice fix is active in this branch.

## Required contract

1. Capture a non-reusable connection/consent epoch with the visit's initial
   connection snapshot. A timestamp alone is insufficient: customer-managed
   consent writers use JavaScript `Date`, so two grants can share a millisecond.
   The existing nullable `collectionIncarnation` is read by consent operations
   but is not reseeded by every customer-managed consent path. Either prove and
   update its full lifecycle or add a dedicated revision; do not infer an epoch
   from `consentedAt` alone or treat legacy null as a reusable generation.
2. For any initial-sync notice mutation, use one scoped database transaction.
   Lock the current tenant connection row, verify organization, tenant,
   connection mode/status, exact epoch and onboarding/consent fields, and (once
   HAW-21 supplies one) the live visit owner. Only then mutate the notice. A
   read before the transaction or a second read just before a standalone write
   leaves the same time-of-check/time-of-use race.
3. The completed-notice upsert and its notification-user-state reset must
   commit or roll back together. Full and incremental warning clearance must
   filter the event type and unresolved state inside that same guard. Persistence
   errors must not be converted into a successful completion claim. The
   existing generic `publishIncident` upsert and typed resolution are separate
   writes and swallow errors; they are not sufficient for this guarded path.
   A guarded upsert must set `eventType` on an existing dedupe row as well as a
   new row. Prove warning-to-completion and completion-to-in-progress
   transitions, including the warning-clear event-type filter.
4. The opposite ordering matters too. If the old visit wins the connection
   lock and commits completion just before an epoch advance, every epoch writer
   must invalidate that completed notice in the same transaction as advancing
   the epoch, or readers must refuse a notice tagged with an epoch different
   from the current connection. This includes customer-managed reconsent and
   onboarding completion: `initialSyncEpochStart` uses the later of those two
   timestamps. Otherwise the completed notice remains visible after the
   advance. The generic upsert does not update `eventType` on an existing
   dedupe row, so republishing an in-progress title alone is insufficient.
5. A stale epoch or owner is a superseded result, not a successful notice
   publication or clearance. The aggregate status must not claim the old
   epoch's coverage as current. Existing coverage proof reads also need a
   coherent owner/epoch boundary; this design does not authorize moving them
   under a connection lock without checking lock order.
6. Define current-epoch notice recovery after invalidation. The full-run
   `initialSync` branch is keyed to an absent prior USERS success, while
   re-onboarding's `markInitialSyncDue` does not erase that prior success.
   Therefore a reconsent that resolves an old completion may not cause the
   next full visit to publish a replacement. Either publish a guarded
   current-epoch in-progress notice or prove that the derived readiness and
   reader path truthfully show the new incomplete epoch without one. Do not
   assume the next full visit will repair it automatically.

## Lock order and falsifiers

`TenantSyncService` currently writes USERS `SyncState` before updating
`TenantConnection` in one transaction. A new notice transaction that locks
the connection and then locks sync-state rows could invert that order and
deadlock. Specify a shared order or use a completed-proof receipt before
implementation. HAW-21 admission/renewal is separate work; this design does
not add or activate it.

Registered disposable-PostgreSQL CI must use two clients and a controlled
boundary to prove both commit orders: reconsent or onboarding wins before
publish/clear, and notice commits before either epoch advance invalidates it.
Also prove stale-owner
takeover, same-millisecond grants with distinct revisions, legacy-null
handling, rollback after notice upsert but before read-state deletion,
ordinary persistence failure propagation, both dedupe-row event-type
transitions, unchanged-epoch positive cases,
and all three full/incremental notice paths. Verify the actual reader cannot
show a completed old-epoch notice after reconsent or onboarding completion,
and that a new incomplete epoch has a truthful visible state. No local or live physical
database is permitted for this proof.

This is a design checkpoint only. The held synthetic witness remains red,
there is no registered physical result on this exact head, and HAW-77 is not
ready for source upload, protected merge or automatic release.
