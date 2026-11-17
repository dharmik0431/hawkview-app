# HAW-77 uncertain terminal outcome: inactive recovery contract

Design against `495afb5246021f19625700d8a83dc76b01c41f85`; no runtime, schema,
retry/cadence, migration or activation change. This refines the
[resource completion contract](haw77-resource-completion-proof.md) and
[storage/projection contract](haw77-proof-storage-projection.md). The held
lost-result regression is still failing. Source/independent design review is
not physical evidence or release approval.

## Local diagnostic implementation checkpoint

The unused [`classifyInitialSyncTerminalEvidence`](../src/tenants/initial-sync-terminal-evidence.ts)
now decodes one supplied raw observation against copied operation identity. It
recognizes exact matching completion, persisted-only evidence with its observed
status, or a coherent replacement connection/epoch/attempt; other evidence stays
UNKNOWN. It checks scope, receipt shape and six-decimal UTC ordering without
coercion or derived validity flags. Returned identity/provenance scalars are
copied and frozen; there are no action permissions or authority booleans.
After epoch rotation, retained resource rows keep their original attempt epoch
and timestamp. The diagnostic preserves both observed epochs and recognizes
the replaced connection boundary without relabeling the old row or comparing
its historical attempt against the new epoch start. A current-epoch caller
cannot reuse that old receipt as completion.

This is only the stored-observation axis. It does not establish authoritative
read provenance, owner identity/expiry, eligibility at mutation time, operation
settlement or definite non-write. Superseded here means a valid replacement
storage identity, not inferred ownership loss. Ineligible context stays UNKNOWN.
HAW-21 must supply the separate authority protocol; even matching completion
after owner loss cannot authorize a later effect. No query, caller, lifecycle,
error handler or notification path uses the helper.

The [local tests](../src/tenants/initial-sync-terminal-evidence.test.ts) inject
synthetic rows to exercise all thirteen resources, copied identity, malformed or
missing evidence, replacements, retained persistence, delayed-result ordering
and microsecond boundaries. They do not model or verify database transactions,
role visibility, actual late arrival, owner takeover or wire-result loss. The
held wrapper regression remains unresolved. Next is real scoped adapter and
producer integration, with settlement/ownership evidence and registered
disposable-PostgreSQL proof before any runtime use.

## Observed defect and scope

The real `runSnapshotSync` wrapper in
[`tenant-sync.service.ts`](../src/tenants/tenant-sync.service.ts) admits RUNNING,
calls collection, then writes SUCCEEDED separately. Its catch cannot distinguish
collection failure, rejected terminal write and lost terminal result. The held
case in [`sign-in-provisioning.test.ts`](../src/tenants/sign-in-provisioning.test.ts)
saves modeled success before throwing; the catch overwrites it as FAILED.
The pre-write and acknowledged-success controls pass. No real unknown commit
or production occurrence was exercised.

Limit this contract to interpreting an uncertain resource terminal operation.
It supplies neither HAW-21 tenant ownership nor a new provider-retry strategy.
Claim, batch, final-persistence and notification ambiguities have their own
boundaries; terminal success cannot resolve an earlier uncertain batch or
certify data whose producer marker is absent.

## Immutable operation context

Capture before the asynchronous operation, and never relabel after an error:

- Organization, customer tenant, required resource and scoped connection ID.
- Non-nil connection epoch E, resource attempt A, and expected persisted source
  kind. A is created by the guarded claim, never by the error handler.
- The HAW-21 owner/fence identity supplied by that protocol, plus the intended
  terminal transition. Do not manufacture a second lease or reuse timestamps.
- The operation boundary reached: not dispatched, dispatched/awaiting result,
  definitively rejected, or acknowledged. These are local observations, not
  certificates of commit; adapter evidence must justify stronger conclusions.

No existing in-memory target or timestamp contains this complete context.
The nullable storage candidate and unused reader are insufficient until all
writers obey the attempt protocol. Legacy or missing identities stay unproved.

## Evidence and permitted effects

These are proposed internal decision names, not new database statuses or a
public API. Each decision is scoped to the captured operation. Readback failure
must never be replaced by a fabricated successful row or an empty result.

| Decision | Required evidence | Permitted action |
| --- | --- | --- |
| DEFINITE_NON_WRITE | Operation was rejected before submission, or the exact terminal transaction is conclusively known to have rolled back and has no outstanding execution | Preserve genuine failure classification only under a fresh exact-attempt/owner guard with state still RUNNING, no completed marker, and no outstanding same-attempt terminal operation. Do not erase earlier committed source batches/window. |
| MATCHING_COMPLETION | Coherent authoritative read shows captured scope/connection/E/A, matching persisted and completed A, correct kind, SUCCEEDED, cleared errors and valid full-precision times | Report the observed saved result with provenance. Do not issue another terminal update, refresh success time or reset counters. A later effect needs current guarded authority again. |
| PERSISTED_ONLY | Exact current E/A and source marker exist but no matching completion marker | Does not prove success or non-write. Stop dependent completion/notices. Any later finalization needs a separately proved settled-operation rule and the normal guarded transition. |
| SUPERSEDED | A current authoritative read proves connection/epoch/attempt replacement, tenant ineligibility or loss of caller's owner authority | No old-operation writes or notices. Do not claim that the historical operation either committed or failed. |
| UNKNOWN | Read unavailable, timed out, malformed, hidden by role visibility, missing/legacy proof, incomplete context, ambiguous operation liveness, or insufficient remaining deadline | Preserve uncertainty for the caller. No compensating FAILED, counter increment, source deletion, synthesized success or recovery notice. |

Positive completion evidence describes storage; it does not grant a lease.
If the saved completion still matches but the caller's authority is gone,
preserve that historical observation while the caller's effect decision is
SUPERSEDED. Baseline readers may accept a valid current-epoch completion from a
past owner, as the existing resource contract permits; they must not require
that owner's lease to remain live forever. Conversely, this old invocation may
not use that observation to mutate a notice or declare a new visit successful.

Prior success, a complete merged authentication window, an equal timestamp,
an error class/message, a zero-row conditional update, or a resolved callback
alone is never sufficient evidence. A conditional update returning zero is
not success and does not by itself identify which authority check failed.

Evidence about one rejected invocation cannot override a matching completion
already saved by another invocation of A. Always validate current authority
and stored outcome before choosing an effect. Even with DEFINITE_NON_WRITE,
an already completed A is not rewritten; an already terminal failed A is not
counted as another failure. Partial/initializing states are not terminal failure
certificates. Error persistence and counters need the same guarded, single-effect
transition semantics as success; this design does not add a failure journal.
After waits, the failure write must still match scope/E/A/owner, RUNNING and a
null completed ID. Its zero-row result permits no increment or retry; require
fresh readback or leave UNKNOWN. Settling one invocation is not proof that a
concurrent invocation of A has settled; absent that proof no failure write is
authorized, even if the first invocation was definitely rejected.

PERSISTED_ONLY describes the absence of completed evidence, not a terminal
status. The current shape permits retained persisted evidence on FAILED as
well as RUNNING. Preserve those distinct observed statuses; infer neither
terminal success nor failure from the persisted marker alone.

## Fresh readback and transaction boundary

1. Stop dependent terminal/notification effects when the operation becomes
   uncertain. Preserve its captured identity and original sanitized error.
   An arbitrary rejected promise after dispatch is UNKNOWN, not DEFINITE_NON_WRITE.
   Do not infer server rollback from cancellation, timeout or connection loss.
   Dispose/quarantine a broken transaction through the adapter's verified
   lifecycle; no query is issued on an abandoned or aborted transaction.
2. Read through a healthy authoritative database path using the existing
   bounded execution budget. No provider call, manual sync, new scheduled job,
   retry loop, longer deadline or new quota is authorized. If the existing
   budget cannot support safe readback, leave UNKNOWN and surface it.
3. For a read-only observation, use a coherent scoped snapshot and retain the
   captured operation identity in the comparison. The existing
   [`readInitialSyncProof`](../src/tenants/initial-sync-proof-reader.ts) returns
   aggregate validation only: it neither exposes an exact terminal-operation
   outcome nor holds mutation authority. Do not reuse its boolean as recovery
   permission. A dedicated projection/adapter must retain the necessary facts
   and distinguish unavailable visibility from a proved replacement.
4. Before any permitted state/notice effect, acquire the shared authority and
   parent locks, then connection and SyncState locks in the reconciled HAW-21
   order. The earlier proposed ordering is not yet verified globally; existing
   USERS/state-before-connection and resource-advisory paths remain blockers.
   Scope and authority must be reread after waits, with a fresh statement under
   the locked boundary, before comparing E/A and complete evidence. Recheck
   eligibility and owner validity according to HAW-21, including expiry after
   waits. Locking only an existing SyncState cannot serialize an absent row;
   common parent authority and scoped uniqueness must cover first creation.
5. Keep those guards through an allowed mutation and commit. No check-then-write
   gap, SKIP LOCKED-as-success or writes from an old repeatable snapshot. No
   transaction spans provider work. If this transaction's result also becomes
   uncertain, surface UNKNOWN rather than starting recursive recovery.

PostgreSQL Read Committed statements use snapshots taken when each statement
starts; successive reads may observe different commits. Row-locking statements
can wait and return an updated matching row. This motivates explicit post-wait
checks rather than assuming one transaction implies one coherent earlier read.
[PostgreSQL 16 isolation documentation](https://www.postgresql.org/docs/16/transaction-iso.html)
and its [lock-order guidance](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-DEADLOCKS)
describe the database behavior, not verification of this proposed integration.

## Absence is not rollback; the original operation may still run

A read showing RUNNING/no completed marker cannot prove that a dispatched
terminal command will never commit. The command may still be executing or may
arrive after that read. Even acquiring a row lock does not prove that no delayed
request will later acquire it. Do not route PERSISTED_ONLY or absence into the
failure handler merely because an early read saw no completion.

Any future action from PERSISTED_ONLY needs proof that the original invocation
has settled, or a separately reviewed idempotent conditional protocol that
prevents a delayed invocation from conflicting. This step chooses neither an
extra operation receipt nor a new replay mechanism. Until that proof exists,
the safe action is no mutation/notice, with caller uncertainty retained. A
definite pre-write rejection is local evidence for that invocation only; it
cannot compensate for other outstanding writes or uncertain earlier batches.

The current storage design has one mutable attempt slot, not an immutable
outcome history. Once another attempt replaces it, an old caller cannot recover
the old result by matching a success time, cached row or source contents.
Classify it superseded/unproved and leave the new attempt untouched. Do not add
an unbounded journal or retention policy. If future requirements need historical
outcome reconstruction, stop for a separate bounded storage/retention design.

## Notification and error-origin separation

An acknowledged or correctly observed terminal success is never rewritten as
collection failure because a later notice fails. The existing local notification
boundary repair covers acknowledged success only; it does not solve lost results.
A recovery notice still requires the exact current operation plus applicable
baseline predicate under current guarded authority. Initial publication, full
warning clearance and incremental clearance must keep their existing distinct
resource/visit requirements. A matched resource alone cannot certify all thirteen.

Notice persistence/recipient mutations must be atomic with their authority
check, and an uncertain notice commit needs its own exact identity/idempotency
proof. Do not blindly republish or resolve after an error; source success alone
does not prove delivery or current notice visibility. A failed readback is an
internal uncertainty, not evidence of a Microsoft collection failure. Preserve
genuine collector-failure classification and configured backoff; do not swallow
errors or introduce a new user-facing failure policy in this design step.

## Required falsifiers before implementation can activate

| Boundary/control | Required result |
| --- | --- |
| Acknowledged terminal success | Exact result once; no extra finalization/counter reset; ordinary notice path only with its authority |
| Definite rejection before terminal submission | Existing genuine failure behavior guarded to the same attempt; earlier committed source evidence retained |
| Same-A completion or failure already saved; concurrent same-A finalizer outstanding | Definite rejection of one invocation cannot overwrite success, increment an existing failure again or race the other invocation; zero-row update stays unproved |
| Terminal rollback vs commit with result lost | Distinct physical transaction evidence; committed success never downgraded; unknown result stays visible until proved |
| Delayed terminal operation, readback before/after its commit | Early absence cannot become failure; positive matching result recognized only after commit; no conflicting retry |
| Same timestamps but different E/A, foreign scope, legacy/null or hidden row | No success/failure reconciliation from status/time or absence |
| New attempt/epoch/owner wins before readback | Old caller produces no state or notice mutation; no historical outcome invented |
| Valid readback followed by replacement before effect | Mutation guard blocks stale effect; opposite order leaves the later transition truthful |
| Owner expires during lock wait, first-row creation and reversed lock path | No stale effect or unsupported missing-row success; bounded waits and consistent ordering |
| Readback error, malformed output, missing budget or second uncertain result | UNKNOWN; no loop, false failure increment, manufactured success or provider replay |
| Terminal success followed by notice failure/unknown notice commit | Source outcome preserved; no false failure or duplicate notice; current reader/count/unread/page semantics remain consistent |

First implement an unused evidence classifier and adversarial local cases,
without making it a runtime authority boundary. Its inputs must preserve the
difference between observed completion and current mutation permission; boolean
caller assertions must not masquerade as database certificates. Then build
the real scoped projection/adapter and producer/owner integration with registered
disposable-PostgreSQL tests. Keep the held regression explicit until a real
protocol fixes it; a fake reader supplied with desired answers is not closure.

## Inactive rollout and fallback

All proof producers, lifecycle/error writes, consent/epoch changes and notice
paths must participate before activation; mixed old/new writers can invalidate
this reasoning. Restricted-role visibility, transport, migration/locks and both
commit orders remain unproved. No SQL or physical test ran for this design.
Protected main is the pre-activation fallback; preserve local candidates and
evidence without manual recovery. Complete authorized source review, exact-head
registered CI, normal protected merge, configured automatic API/cron release,
actual health and authenticated canary remain required. Baseline/full SYNC are
incomplete. HAW-70/75 prior approved CI is unchanged; HAW-21 remains separate.
