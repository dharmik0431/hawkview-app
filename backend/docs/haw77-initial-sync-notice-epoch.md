# HAW-77 initial-sync notice epoch: inactive transaction design

The companion [resource completion proof contract](haw77-resource-completion-proof.md)
specifies proposed bounded storage, attempt transitions and reader requirements.
Both documents remain inactive designs; neither supplies schema or runtime proof.

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
   advance. The generic upsert now updates `eventType` on an existing dedupe
   row, but it neither binds that row to an epoch nor makes the consent advance
   and notice replacement one atomic operation.
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

## Source audit: choose a separate, non-reusable initial-sync epoch

The notice/coverage epoch should be a dedicated UUID on the tenant connection,
not `collectionIncarnation`. The latter is nullable for legacy connections and
is already an authority fence for managed consent, connection verification and
directory-role receipts. Those paths can rotate it without a new initial-sync
consent epoch; a repeated managed Exchange grant advances `consentedAt` without
rotating it. Customer-managed reconsent and onboarding can also advance
`initialSyncEpochStart` without rotating it. Reusing it would either miss a
real restart or invalidate unrelated collection receipts. The dedicated value
is still only a **candidate field**: no migration or runtime guard exists yet.

The current source has these writes that can advance or affect the epoch. Each needs an atomic
decision about UUID rotation and old-notice invalidation under the existing
authority lock order, not a later cleanup call:

| Current writer | Existing boundary | Required proof before activation |
| --- | --- | --- |
| New customer-managed connection and suspended-tenant reconsent (`tenants.service.ts`, `createForIdentity`) | Creates or advances `consentedAt`; reconsent now replaces an owned old completion inside its transaction | Seed or rotate the dedicated UUID in the same write; reject stale publisher after reconsent, including an absent notice |
| Customer-managed Exchange grant (`tenants.service.ts`, Exchange callback) | Advances `consentedAt` in a standalone connection update | Determine whether this is an initial-sync restart; if it is, rotate and invalidate atomically; otherwise stop treating this timestamp as an initial-sync boundary |
| Onboarding completion (`tenants.service.ts`, `completeTenantOnboardingForIdentity`) | Sets `onboardingCompletedAt` only when its conditional update wins; it affects the current timestamp boundary when later than consent | Rotate and invalidate only when it creates a new initial-sync boundary; preserve audit rollback and prove completion-before/after-notice ordering |
| Managed consent terminalization (`microsoft/consent-operation-store.ts`, `finishConsentOperation`) | Rotates `collectionIncarnation`; on success advances `consentedAt` under managed authority | Rotate the separate epoch on the successful consent transition and invalidate old completion in that transaction; a failed/replayed terminal result must not invent a new epoch |
| Managed verification or Exchange refresh (`tenants/connection-verification-store.ts`) | Verified consent can advance `consentedAt`; Exchange refresh advances it on every grant, but rotates `collectionIncarnation` only if the permission was absent | Distinguish consent from routine verification and repeat grants; rotate/invalidate exactly for a real initial-sync restart, without reusing a routine collection-incarnation change |

Managed consent issuance can also move a connection to `PENDING_CONSENT`
without advancing either timestamp. The current-state reader must not present
an old completion as current while consent is pending or the connection is in
error, even before a new successful grant establishes the next epoch.

`TenantSyncTarget` and both tenant loaders currently carry the two timestamps
but no non-reusable epoch. Capture the dedicated value before provider work and
compare it while holding tenant then connection locks in every notice writer.
The three current mutation sites are the initial publish, full-pass warning
clear, and incremental warning clear. An epoch mismatch must supersede the
old result even when no notification row existed at capture time.

This UUID alone does not prove *coverage*. `SyncState` stores attempt and
success times but no initial-sync epoch; `deriveInitialSyncStatus` accepts a
success whose attempt equals the epoch-start millisecond. Thus a prior success
can satisfy a same-millisecond reconsent unless each required resource's
durable success is bound to the captured epoch (or an equivalent fenced
receipt). The HAW-21 visit-owner work is separate; use its receipt only after
its exact authority and recovery semantics are proven. Until then, a guarded
notice row must not be promoted to “completed” from timestamp-only evidence.

For legacy NULL epochs, refuse a current completion claim. An upgrade must
establish a new epoch and incomplete state under the tenant/connection lock,
then collect new bound resource proofs. Do not backfill a UUID onto an old
completed row and silently treat historical successes as current. A nullable
additive migration, writer rotations, visit capture, proof binding, guarded
notice writes and reader truth should be reviewed as one inactive package;
no schema-only step authorizes activation.

### Held same-millisecond resource-proof regression

The synthetic `tenant-sync-bounds.test.ts` witness named
`same-millisecond reconsent cannot reuse old required-resource successes to clear a warning`
is held behind `HAWKVIEW_HAW77_SAME_MILLISECOND_COVERAGE_WITNESS=1`.
It calls the real full and incremental orchestrator with synthetic collectors,
storage and notification boundaries. A limited first pass opens the warning;
then a fresh Graph pass supplies current SIGN_INS evidence. The fixture also
reflects the full pass's actual USERS claim/success in its baseline read, so
that row is not incorrectly modeled as an old untouched success.

Other required resources retain the modeled old success times. Evidence one
millisecond before reconsent keeps the warning open, but evidence equal to
the reconsent millisecond wrongly clears it. The held equality assertion fails
at the warning sink; a separate positive control with later timestamps clears
the warning. Assertions inspect the actual baseline read, including the fresh
USERS/SIGN_INS rows and unchanged other resource timestamps, before checking
that sink. The two controls pass on the current local candidate.

This diagnoses timestamp-only reuse; it does not perform an actual consent
write or prove that the modeled history occurred in PostgreSQL. The later-time
control exercises existing timestamp behavior, not a new durable epoch receipt.
Changing `>=` to `>` alone is not a complete repair: valid new-epoch attempts
can also share the consent millisecond. The missing non-reusable identity and
resource provenance must distinguish those histories. The witness remains
held until that protocol exists; current schema, production behavior, consent
policy, physical race proof, reader/count truth and HAW-21 ownership are unchanged.

## Reader and history contract

The current notification list returns resolved rows and still sends their
original title with `resolved: true`. Marking an old
`tenant.initial_sync_completed` row resolved during reconsent therefore does
not remove its old success title from the API. This is a separate gap from the
old visit publishing after reconsent. A scoped consent-side replacement of the
deduped initial-sync row with a current-epoch in-progress state is one possible
repair; an epoch-aware reader is another. Either repair must make the **current
tenant state** unambiguous without hiding unrelated resolved history. A blanket
`resolvedAt: null` list filter would silently change all notification history
and is not an acceptable shortcut.

If the reader filters or labels a stale initial-sync notice, it must compare a
persisted notice epoch with the current tenant connection's epoch from one
coherent database view. An exclusion must use the same current-epoch predicate
for items, `total`, `unreadCount`, and pagination; `unreadCount()` delegates to
this list. The current list's batched transaction alone does not establish a
shared snapshot for a future multi-query epoch comparison. If history remains
visible with an explicit stale label, the counts must agree with that visible
set and the row must not claim current completion.
Legacy notices with no epoch must not be treated as current completions after
an epoch advance. A consent-side replacement must also reset recipient read
state in the same transaction so the new incomplete state is visible to every
eligible recipient. These rules apply to every epoch writer, including
customer-managed reconsent, onboarding, and Exchange consent.

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
and that a new incomplete epoch has a truthful visible state. For the reader,
also verify unrelated resolved history remains available; initial-sync item,
total, unread count and page boundaries agree after either commit order; and
a same-millisecond or legacy-null epoch cannot resurrect the old completion.
Mocked reader rows cannot establish query filtering or count/pagination truth:
these cases require the registered disposable-PostgreSQL path. No local or live
physical database is permitted for this proof.

This is a design checkpoint only. The held synthetic witness remains red,
there is no registered physical result on this exact head, and HAW-77 is not
ready for source upload, protected merge or automatic release.
