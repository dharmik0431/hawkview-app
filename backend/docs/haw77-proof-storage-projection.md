# HAW-77 proof storage and coherent projection: inactive contract

Contract originally designed against `3aa4c4e0757149412713c1441c9a05044490556d`.
This refines the [resource proof contract](haw77-resource-completion-proof.md)
and its unused [validator](../src/tenants/initial-sync-completion-proof.ts).
The local storage candidate below remains uninstalled and adds no runtime
queries or callers. The held orchestration defects remain unresolved.

## Local single-statement reader candidate — 16 November 2026

The next unused component now supplies the mapper from one parameterized SELECT.
`readInitialSyncProof` captures and freezes the authorized organization and tenant
before awaiting its injected executor. Invalid scope causes no query; read errors
propagate without retry or a fabricated empty result. The static query receives
fifteen bound values: the two scope IDs and the shared thirteen-resource inventory.
No production caller, database client, writer, notice mutation or lease is wired.

The query explicitly qualifies all three public tables and the resource enum.
It scopes the tenant, then left-joins its connection and each expected resource,
without filtering away failed, legacy or stale receipts. A missing tenant yields
no rows and cannot pass validation; a missing connection or state stays visible
as null evidence. The fixed expected-resource list bounds the projection to
thirteen slots under the existing uniqueness constraints. One materialized
statement observation supplies the database clock. Time predicates compare
finite timestamps at database precision, and CASE guards restrict UTC formatting
to AD years 0001–9999 before emitting six-decimal text. This avoids aliasing BC
years through a year-only formatting template.

Five hosted-only physical cases are registered in the existing disposable test
inventory. They are prepared but unexecuted:

- Real PostgreSQL query and mapping for all thirteen receipts with changed
  session time zone, DateStyle and search path; exact microsecond text, one
  observation and unchanged optional role/state rows.
- All thirteen missing slots, unrelated sibling isolation, foreign/absent tenant,
  absent or ineligible connection and suspended tenant.
- One-microsecond attempt/epoch and retained-success/attempt inversions within
  the same Date millisecond; future success/epoch; infinity, BC and out-of-range
  transport rejection. The persisted-only inversion does not bypass storage's
  completed-time constraint. Future-time cases use a far future instant, not a
  deterministically scheduled one-microsecond boundary against the live clock.
- Legacy success, old epoch, new running attempt retaining historical success
  and failed persisted-only evidence, without falling back to old completion.
- Two clients with a read-only reader: uncommitted replacement is invisible,
  rollback preserves old facts, committed epoch replacement makes old resources
  stale, and a previously returned snapshot remains merely historical evidence.
  This does not schedule a commit during the SELECT, reserve notice authority,
  or exercise actual producer, epoch-transition or takeover protocols.

Five ordinary adapter tests and the existing mapper/validator tests pass locally;
the five physical cases skip, and separate hosted-context/local-port probes
reject execution before constructing a client. Source inventory and launcher
checks, strict scoped types and lint pass. These are preparation evidence only:
actual SQL execution, migrations, Prisma raw transport, restricted runtime roles,
query plan/lock effects and all guarded mutation/recovery races remain unproved.
Next is the real Prisma transport and remaining hosted precision/scope/race
witnesses plus complete review before any exact-source CI handoff. Keep this
candidate inactive and the migration uninstalled.

The statement observation and single-query snapshot choices follow the
[PostgreSQL time functions](https://www.postgresql.org/docs/16/functions-datetime.html)
and [read-committed semantics](https://www.postgresql.org/docs/16/transaction-iso.html).
UTC text uses the documented
[formatting patterns](https://www.postgresql.org/docs/16/functions-formatting.html).

## Local strict mapper candidate — 16 November 2026

The earlier unused `validateInitialSyncCompletionProjection` helper decodes a proposed
single-statement rowset before invoking the existing pure validator. This step
implements only the mapper and ordinary adversarial tests, not the SQL projection
or a database adapter. It has no runtime callers, connection or write effects.

The raw boundary expects exactly thirteen `expectedResourceType` slots, including
slots whose LEFT JOIN state is absent. Each slot repeats tenant and connection
scope, eligibility, connection identity, paired epoch ID/start, statement
observation time and a nullable `contextTimeValid` boolean. Joined state fields
include their own identity/scope/resource, all five stored receipt fields, status,
both error fields, attempt/success UTC text and nullable `proofTimeValid`. An
absent state's fields must all be null and cannot carry a true time predicate.
Every field must be present with its exact primitive type. Repeated context must
agree exactly; duplicate, optional, foreign or relabeled slots fail closed.

Only literal true database time predicates are accepted. The mapper also checks
the full timestamp order independently, using canonical four-digit-year UTC
six-decimal text and integer microseconds before invoking the Date-based validator. Invalid
calendar dates, zero/out-of-range years, infinity, omitted precision, session
date formats and offsets are rejected. The transport is deliberately limited to
years 0001–9999. A one-microsecond epoch/order/future violation remains invalid
even when all decoded Dates would have identical milliseconds. No rounded
snapshot escapes: the helper returns validation only, not mutation authority.

Stored source kind, current epoch, matching non-nil attempt/persisted/completed
identities, terminal success and both null errors are mandatory to derive FULL.
Legacy success, persisted-only attempts and limited/non-Graph sign-ins remain
unproved. Caller-supplied coverage/authentication flags are ignored. Missing
joined states remain missing rather than being populated from expected slots.

Local tests cover these mapping boundaries and valid controls, including all
thirteen missing/duplicate slot cases and same-millisecond microsecond errors.
They do not prove the origin or coherence of the supplied facts. The actual
single scoped query, database predicates, UTC formatting under non-default
session settings, Prisma decoding, query plan, restricted-role visibility and
concurrent replacement still need registered disposable-PostgreSQL witnesses.
Do not wire this helper into notices or declare the coherent reader complete.

## Local storage candidate — 16 November 2026

The subsequent inactive implementation now includes the seven nullable Prisma
fields and additive migration `20261116191000_initial_sync_completion_proof_storage`.
Twelve named checks are added NOT VALID and then validated within one transaction,
with a five-second lock timeout and sixty-second per-statement timeout. All-null
legacy rows retain their existing behavior; no defaults or backfill mint proof.
The transaction retains its DDL locks through commit: NOT VALID followed by
VALIDATE here does not create a lower-lock online deployment phase. Actual scan
cost, lock duration and upgrade compatibility remain unmeasured.

The registered storage suite covers metadata, all 32 receipt-null combinations,
required/optional legacy writes, every required resource's positive receipt,
non-nil/matching identities, connection pairing, source kinds, terminal errors,
finite timestamps and a one-microsecond completion inversion. It also checks
existing scope/uniqueness/cascades and preservation of DIRECTORY_ROLES fields.
These SQL fixture transitions do not exercise actual collectors or prove that
stored assertions are truthful. They do not establish migration-on-populated-data
compatibility, restricted-role visibility, coherent reads or takeover safety.

Local validation can only check registration, types, syntax and guarded skipping.
No physical database has run this migration or suite. The suite is wired into
the existing hosted disposable database inventory and refuses local execution.
Keep the entire candidate uninstalled, unpublished and unmerged until separately
authorized review/CI and all activation prerequisites are satisfied. The future
writer, projection and notice work below remains outstanding; the historical
“to implement” text describes the contract implemented locally, not deployment.

## Exact existing boundary

At the design baseline, `backend/prisma/schema.prisma` defined:

- `CustomerTenant`: UUID tenant identity, organization and tenant status.
- `TenantConnection`: composite tenant/organization relation and uniqueness,
  status/mode, consent/onboarding timestamps and nullable collection incarnation.
  There is no dedicated initial-sync epoch. Do not reuse collection incarnation.
- `SyncState`: composite tenant/organization relation, unique tenant/resource,
  current status, nullable attempt/success timestamps at PostgreSQL precision six,
  and errors. Existing DIRECTORY_ROLES receipt columns remain separate; they do
  not certify this required-resource baseline and must not be repurposed.

The initial connection and sync-state foundation migrations provide those
scope/uniqueness boundaries. The public-schema lockdown migration enables RLS
and revokes broad grants; its historical role comments are not current deployed
role evidence. No grant, policy, role or provider permission change is proposed.

The current bundle in `tenant-sync.service.ts` combines a previously supplied
connection with sync states fetched in `Promise.all`, then calls
`deriveInitialSyncStatus`. Incremental warning clearance separately reads its
attempted resource and full baseline. Neither existing path is the coherent
future projection described below; no production query is changed here.

## Additive fields and source authority

Keep the four proposed nullable UUID fields on `sync_states`:
`initial_sync_attempt_epoch_id`, `initial_sync_attempt_id`,
`initial_sync_persisted_attempt_id`, `initial_sync_completed_attempt_id`.
Add nullable `initial_sync_persisted_kind` (Prisma
`initialSyncPersistedKind`, bounded text of length 32). On `tenant_connections`,
add the separate nullable UUID `initial_sync_epoch_id` and paired nullable
`initial_sync_epoch_started_at` (`timestamptz(6)`, Prisma
`initialSyncEpochStartedAt`). All seven columns have no generated/default
authority and no backfill.

The paired start makes epoch provenance explicit. Existing consent/onboarding
times can move independently (including repeat Exchange grants); do not keep
one epoch UUID while silently recomputing its start from those mutable fields.
A real epoch transition sets both new UUID and finite database observation time
under shared authority after waits, in the same transaction as consent/notice
effects. The existing epoch-writer inventory must define which events are real
restarts; this field addition does not change consent or restart policy. Never
backfill a new ID/start onto old proof. A legacy/null pair stays incomplete until
the reviewed transition establishes a genuinely new cycle.

The fifth sync-state field closes the projection gap: the unused validator's
FULL and GRAPH_SIGN_INS facts cannot be fabricated from status/time. The kind
is written atomically with the persisted attempt marker at the final accepted
data/checkpoint boundary. Its only allowed non-null values are:

| Resource | Persisted kind | Required producer fact |
| --- | --- | --- |
| SIGN_INS | `GRAPH_SIGN_INS` | Entire accepted Graph collection/window and all required persistence committed for this exact attempt; retained merged evidence and audit-feed fallback cannot substitute |
| Other twelve required resources | `FULL_RESOURCE` | Their entire accepted resource-specific persistence/checkpoint boundary committed for this exact attempt, including an explicitly complete empty collection |

There is no LIMITED/UNKNOWN kind: incomplete collection leaves the persisted
marker/kind null and keeps its existing classification elsewhere. A failed
attempt may retain a known complete persistence marker for diagnostic/readback
purposes but cannot acquire a completed marker. No row count, callback result,
old success timestamp or provider response alone mints this stored certificate.
The kind records a guarded writer assertion, not a checksum or independent
verification of all underlying data. Every invalidating writer must participate
in the attempt protocol; the field cannot compensate for an unguarded writer.

Generate a new non-nil UUID only at a guarded real epoch/attempt transition.
Reject reuse of a captured prior identity and retry with the same identity only
for exact known-outcome readback. UUID syntax/uniqueness does not prove a correct
rotation lifecycle. No foreign key points at the mutable current epoch: epoch
rotation must leave old resource rows visibly stale instead of relabeling them.
No new history/retention policy or cross-tenant epoch lookup is introduced.

## Row-shape constraints to implement and physically falsify

Use named, row-local checks with explicit null tests. PostgreSQL permits a
CHECK result that is NULL, so an equality alone does not enforce this shape.
Do not check a mutable connection or other table through a CHECK function.
These are now properties of the local migration, not executed DDL.
[PostgreSQL constraints](https://www.postgresql.org/docs/16/ddl-constraints.html).

For short notation, E/A/P/C/K are the five sync-state fields above, respectively.
The migration must enforce all of these simultaneously:

1. Each present UUID is non-nil. Connection epoch and start are either both null
   or both non-null, with non-nil ID and finite timestamp when present.
2. E and A are both null or both non-null: `(E IS NULL) = (A IS NULL)`.
3. P is null, or A is explicitly non-null and P equals A.
4. P and K are both null or both non-null. Present K must be exactly one allowed
   value and match resource type: SIGN_INS/GRAPH_SIGN_INS; one of the other
   twelve required types/FULL_RESOURCE. Optional resources cannot carry these
   receipt fields; require E/A/P/C/K all null for every optional resource.
5. C is null, or A and P are explicitly non-null and C equals both, status is
   SUCCEEDED, and both collection error code and message are null. P/K pairing
   therefore also holds.
6. When A exists, `last_attempt_at` is non-null and finite. When C exists,
   `last_successful_at` is non-null and finite, and success >= attempt. The
   historical success time may be retained while a newer RUNNING attempt is
   incomplete; do not enforce success >= attempt for that incomplete state.

Use explicit `(P IS NULL OR (A IS NOT NULL AND P = A))` and the analogous
completed form, not nullable equality chains. Test every partial-null vector,
including non-null P/C with null A and K without P. Finite timestamp checks
exclude PostgreSQL infinity; future-time and current-epoch comparisons belong
in the coherent read/current guarded write, not a wall-clock-dependent CHECK.
[PostgreSQL date/time functions](https://www.postgresql.org/docs/16/functions-datetime.html).

| Allowed row shape | Authority it establishes |
| --- | --- |
| E/A/P/C/K all null, any legacy status/history | None; old writes must remain possible before activation |
| E/A set, P/C/K null, RUNNING or other existing classification | Attempt only, no completed proof |
| E/A/P match, K valid, C null | Persisted boundary only; crash-before-finalize remains incomplete |
| E/A/P/C match, K valid, SUCCEEDED/no error/ordered finite times | Row-local full completion certificate; current connection/eligibility/owner still must be checked |

Do not make SUCCEEDED imply C: old successful rows stay valid but untrusted.
Do not clear retained historical timestamps as a rollout shortcut. Claims clear
P/C/K atomically while replacing E/A; full finalize clears collection error code
and message and sets C in the same transaction. Failures cannot rewrite another attempt or
a known committed success. Any SQL rejection rolls back the complete intended
transition; do not suppress constraint errors into a successful sync outcome.

## One coherent, bounded read

The future adapter takes authorized organization and tenant IDs; it does not
accept preloaded connection authority as truth. A single scoped SELECT should
read customer tenant, its connection, and the thirteen expected resource rows.
Build the expected list from the same versioned required-resource inventory as
`INITIAL_SYNC_RESOURCE_TYPES`, then LEFT JOIN sync states by organization,
tenant and resource. Keep missing rows visible as absence. Do not prefilter on
SUCCEEDED, non-null proof, matching epoch or valid time: doing so can hide the
current failed/replaced row and accidentally fall back to old evidence.

Select raw IDs, K, status/error and timestamps alongside connection status,
mode and the dedicated epoch ID/start pair. Map `epochStartedAt` from that paired
stored start only; old consent/onboarding times remain lifecycle inputs and
diagnostics, not a substitute. Reject missing/unpaired/invalid/nonfinite epoch
boundaries. Existing timestamp-only loaders remain unwired and insufficient.
No row or no connection yields incomplete context; duplicate required rows are
an error even if all duplicates look complete. Optional rows are projected out
deliberately, never substituted for a missing required resource. Avoid joined
child tables that multiply rows, or assert exact cardinality before decoding.

Read-committed successive statements can see different commits. A transaction
wrapper around multiple default-isolation queries alone does not supply one
snapshot. Use the single statement, or separately prove an explicitly shared
snapshot that includes connection, eligibility and all proof rows.
[PostgreSQL isolation](https://www.postgresql.org/docs/16/transaction-iso.html).

Evaluate finite/order/epoch/future predicates at full PostgreSQL timestamp
precision in that same statement against one statement observation time. A JS
Date loses sub-millisecond distinction: an attempt one microsecond before the
epoch or a success one microsecond before attempt must not become valid after
decoding. Return a null-safe database time-valid result with the raw projection;
the mapper must reject false/null before calling the pure validator. Return
bounded UTC six-decimal text where exact evidence comparison is needed. The
validator's Date checks remain additional sanity checks, not a replacement for
database-precision evaluation. Never rewrite invalid times to force acceptance.

Only a fully shaped, current-epoch completed certificate projects coverage FULL.
For SIGN_INS only matching K=GRAPH_SIGN_INS projects that authentication source;
all other shapes remain unproved. Compare exact non-null IDs, status, scope and
kind before this projection; no permissive default/coercion. The present pure
validator is unchanged and its existing tests do not prove this mapper or SQL.
Full-run returned attempt identities and incremental current Graph attempt are
additional checks at their respective callers; baseline readiness alone cannot
authorize either mutation.

A coherent read describes a snapshot. It does not reserve notice authority
until a later write. All three notice paths must revalidate current locked
authority and proofs through their atomic event/read-state mutation. Conversely,
an epoch advance must invalidate old completion visibility atomically. Use the
HAW-21 authority protocol and reconcile existing USERS state/connection lock
inversion; this design neither adds a lease nor claims a proven lock order.

## Migration and rollback boundaries

Installing the additive migration changes real database behavior even while helpers
are unused. Keep it inactive until reviewed with its compatibility tests. The
all-null legacy path must work for every existing required and optional writer.
Once populated, old writers may violate new checks or leave stale certificates;
there is no mixed-version or post-activation rollback safety claim.

Adding nullable columns without authority defaults avoids inventing proof, but
DDL still acquires locks. A NOT VALID CHECK skips its initial scan, yet applies
to subsequent writes; VALIDATE still scans and acquires its documented lock.
Treat both phases as registered migration tests with bounded failure and measured
lock effects, not a promise of zero downtime. No manual recovery is authorized.
[PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html).

Retain current composite scope/FKs and unique tenant/resource key. No new index
is presumed necessary for one tenant's fixed required set; measure the actual
query plan in registered CI before claiming the existing key suffices. Add no
grants or RLS bypass. Test privilege denial and restricted-role visibility
separately; an administrator CI connection does not prove deployed role access.
Keep protected main as the pre-activation fallback, preserving this candidate.
Any later schema rollback needs a separately reviewed compatibility plan.

## Required registered-CI evidence and next step

The nullable schema, named row-shape checks and registered storage witness are
now prepared locally. The strict mapper and unused single-statement reader have
also been prepared with ordinary tests and five registered PostgreSQL cases.
Physical execution, actual Prisma transport and remaining role/race witnesses
are still outstanding. Storage upgrade and
restricted-role evidence remain prerequisites too. No runtime activation or
source upload is authorized by this design. Required cases are:

- All-null old rows and ordinary old updates accepted for required and optional
  resources; every partial-null/mismatch/nil-ID/kind/resource/status/error/time
  invalid vector rejected without partial effects; legacy SUCCEEDED never read
  as a certificate. Include unpaired connection ID/start and stale error message.
  A valid full-resource and Graph row are positive controls.
- Complete empty collection, failed/limited/budget outcome, crash after persisted
  marker, finalize error clearing, new attempt invalidation and uncertain commit
  readback; these require actual producer/transaction integration, not shape alone.
- One-microsecond inversion/epoch/future boundaries, equal-millisecond distinct
  epochs, non-default time zone/DateStyle and actual Prisma raw decoding/mapping.
- Missing/foreign/duplicate projection fixtures, optional-only and partial lists,
  zero connection, pending/error consent and suspended tenant; exact thirteen
  resources, actual query plan and unchanged unrelated role receipts.
  Existing tenant/resource uniqueness prevents duplicate base rows: test that
  constraint separately, and duplicate joined/adapter output at the projection
  boundary rather than bypassing the database constraint to create a fixture.
- Two-client epoch/attempt replacement before and after the coherent read and
  guarded notice mutation; first-row creation, rollback, unknown acknowledgment,
  both commit orders and all item/count/unread/page truth. HAW-21 owner takeover
  remains a separate prerequisite, not a substitute for these reader checks.
- Every real epoch writer rotates the ID/start pair atomically; unchanged-epoch
  repeat consent/verification cannot mutate that pair or manufacture completion.
  The consent/onboarding classification decision remains part of writer review.

Physical execution is allowed only in registered hosted disposable PostgreSQL.
Local design checks, prior predicate tests and historic migrations prove none
of these cases. HAW-77 stays In Progress/inactive; no merge or release, and no
Baseline or full-SYNC completion claim follows from this contract.
