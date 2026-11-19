# HAW-70: qualify the actual license transaction before choosing admission locks

Execution and review checkpoint, 18 November 2026 (19 November UTC). The approved
public candidate `e000addb662714919d43052bf477907ff7917277`, tree
`ba9462c1da98a64e9e618da751915bfa0205b2d6`, is based on protected main
`a15951997b6734b9fc612717cf965c9f9651176c`. No runtime, migration, permission,
test flag, retry or cadence changes are selected here.

**APPROVED PARENT EXECUTED; LOCAL FOLLOW-UP UNPROVED:**
[registered run 44456717177](https://github.com/dharmik0431/hawkview-app/actions/runs/44456717177)
passed at the exact approved parent and its identical-tree merge. The actual
collector case passed in 310.514597 ms, with acknowledged commit, a known
precommit throw after staged inventory/evidence, positive retry after that known
rollback, complete empty deletion and unchanged empty collection. These are five
sequential controls within one top-level case. Claude independently verified the
exact source and matching execution evidence in the authorized review.

This local follow-up protects early test setup with client cleanup and explicitly
rejects unsupported transaction call forms. Those newer test changes have not
run in hosted CI or received a new Claude review. The parent result must not be
reported as exact-head execution of this revision. Neither version installs a
license invalidator or proves direct-writer, bulk, cascade, unknown-result or
recovery races.

## Evidence and decision

The earlier [modeled-cycle run](https://github.com/dharmik0431/hawkview-app/actions/runs/44396832428)
executed all 33 focused physical top-level cases and 70 nested cases without
skips; the complete physical phase passed 531 cases. Its verified merge tree
matches its approved `6d254b0308b82d6b75d8fc2eec59f93407501bda` parent.
In particular, the modeled license lock cycle ran:
one participant failed with an actual deadlock, both attempts rolled back, and
serialized and lock-release controls passed. This is evidence against a naive
AFTER-source authority lock. It neither installs a license trigger nor runs the
real license collector in that cycle. The [existing contract](haw70-license-source-participation.md)
still supplies mutation, role, truncation and eventual ordering acceptance.

The newer approved run executed all 34 physical HAW-70 top-level cases and the
same 70 nested cases without skips, plus the separate synthetic adapter case
that forbids database connections. Its complete database phase passed 532 cases;
ordinary tests passed 3,394 with two documented legacy skips. Migrations, builds,
launcher and dedicated image checks passed. Existing warnings and the conditional
pre-image smoke skip remain recorded; this is not a warning-free claim.

This executable slice qualifies the **actual license collection transaction and
its outcome boundary** at the approved parent, before experimenting with admission
locks. Its measured CI timing is not a production latency or worst-case margin
guarantee. The held observer assertions must still fit the unchanged interactive
transaction lifetime on each tested revision. The modeled deadlock is not a
correction or a production guard.

## Source boundaries to preserve

| Boundary | Source evidence at the reviewed head | Consequence for the witness |
| --- | --- | --- |
| Provider/validation | `syncLicenses` in [tenant-sync.service.ts](../src/tenants/tenant-sync.service.ts), around line 3002, obtains and validates the complete response before `saveSnapshot`. | Supply a synthetic complete response at the fetch boundary; refuse unexpected real network use. Do not replace the inventory callback or `saveSnapshot`. |
| Initial state | `runSnapshotSync`, around line 2800, saves RUNNING before calling the synchronizer. | This separate committed state change and its existing authority invalidation are outside the inventory rollback. Record a baseline after RUNNING when assessing that transaction. |
| Inventory transaction | `saveSnapshot`, around line 5153, takes the resource advisory lock, reads the baseline, builds/inserts change evidence, runs the SKU upsert/delete callback and saves the new baseline. | Forward every database operation to the real transaction; compare inventory, evidence and snapshot together. Evidence insertion can precede the first SKU. |
| Parent participation | [Schema](../prisma/schema.prisma) models `ChangeEvidenceEvent`, `TenantLicense` and `TenantEntraSnapshot` reference tenant/organization parents; [license FKs](../prisma/migrations/20260730233000_tenant_licenses_domains/migration.sql) cascade. | A later lock inserted only before the first SKU does not precede every possible parent/source interaction. Use zero-evidence and nonzero-evidence fixtures separately in future parent races. |
| Terminal state | `runSnapshotSync` awaits collection, then separately writes SUCCEEDED and resolves the incident; its catch records failure. | An inventory commit is not an atomic terminal-state or notification commit. Do not require their rollback as if they belonged to `saveSnapshot`. |

The [existing synthetic license tests](../src/tenants/license-validation.test.ts)
check incomplete inputs and a simulated commit failure, but their mutable storage
double does not establish real database visibility or rollback. The approved actual-collector witness closes that narrow transport/transaction
gap for its tested controls; the local follow-up still needs exact-head execution.

## Why an early-lock shortcut is not selected

The following are qualification failures, not newly observed production faults.
They follow from the current source boundaries and the already-executed model.

| Proposed shortcut | Missing proof / counterexample that remains |
| --- | --- |
| Lock authority before the first SKU, only in `syncLicenses` | A direct writer can own a later SKU and wait for authority already held by the collector. The collector then needs that row. Moving its acquisition earlier does not make the direct writer cooperate. Parent/evidence operations also remain outside this proposed first-SKU boundary. |
| Sort all input SKUs | Direct DML, multi-scope work, absent-SKU deletion, existing source triggers and parent cascades do not acquire their locks from this input list. The earlier modeled direct writer still owns the later SKU. |
| Put authority acquisition in a per-row BEFORE trigger | Its scope is the current row, not the complete transaction's later statements or OLD/NEW scopes. Even without assuming the exact internal row-lock timing, it does not demonstrate a compatible global order across parents, prior sources and future rows. Require an actual installed-fixture witness before crediting an improvement. |
| Use one bulk upsert, or sort authority pairs inside one statement | This changes statement shape, not proof of a whole-transaction order. Conflict processing, parent checks, subsequent deletion/baseline writes and competitors must still be observed. |
| Take a common advisory lock late in every source trigger | A caller may already hold a source or parent row before waiting for the advisory lock. Advisory locks require compatible participation; a late wait can retain the original inversion. |
| Use a universal early lock or deferral | A parent-first admission protocol or other global serialization requires a complete writer/role/parent interface and cost analysis. Deferred invalidation additionally needs a coherent admission/read proof. Neither is justified by the current component pass. |

PostgreSQL distinguishes statement and row trigger timing, and triggers execute
inside their source transaction. Those facts do not specify a transaction-wide
order for this application. Advisory locks rely on cooperating use; retained
locks and conflicting acquisition orders can form a deadlock. These general
facts are documented in [PostgreSQL 16 trigger behavior](https://www.postgresql.org/docs/16/trigger-definition.html)
and [explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html).
The HawkView conclusions above are source-based inferences, not a new physical
reproduction. No timeout or retry-policy change is a substitute for the proof.

## Registered witness contract

Extend the already registered
[authority suite](../src/tenants/tenant-health-source-authority.database-integration.test.ts).
Use its hosted-disposable guard before constructing any client, a real
[PrismaService](../src/prisma/prisma.service.ts) and separate observer connections.
Keep all physical execution restricted to the existing registered CI job. Do not
add a migration, fixture invalidation trigger, application caller or workflow flag
for this transport slice.

Construct `TenantSyncService` with actual change-evidence construction and the
real database adapter. Stub only provider I/O, external notification sinks and
unrelated constructor dependencies; reject unexpected calls. Invoke the actual
license method and wrapper, not an imitation of the SKU loop. A test-only wrapper
around transaction methods may expose awaited barriers or throw a known error,
but must preserve arguments, transaction/session identity, return values, and
commit/rollback behavior. It must not manufacture successful database results or
suppress exceptions. Verify the queried fixture tenant/session identities.

Fixture: one existing changed SKU, one absent SKU to remove, one newly returned
SKU, a populated old LICENSES baseline, prior successful sync state, and a sibling
with the same SKU identities in a different tenant. Use valid UUIDs and complete
service-plan objects accepted by the real validator. Preserve actual event keys
and counts from the real difference builder; use a separate empty/unchanged
control rather than inventing evidence for the first observation.

| Case | Gate and required observation |
| --- | --- |
| Acknowledged commit | After real inventory writes/delete and evidence insertion, hold immediately before the final baseline upsert. On the transaction client, prove staged rows; on an independent reader, prove old committed inventory/evidence/baseline and RUNNING state remain visible. Release the gate, await the full call, then verify exact new inventory, matching baseline and deduplicated real change events. Terminal SUCCEEDED and one recovery resolution must occur only after acknowledged collection completion. |
| Known precommit failure | At the same boundary, throw a unique test error after verifying staged changes. After the actual transaction rejects and rollback settles, inspect from a fresh reader: inventory/evidence/baseline equal their pretransaction values, no leaked new SKU/event, and sibling unchanged. The wrapper must reject and not resolve recovery; prior `lastSuccessfulAt` remains. Its FAILED-state write is separate and may advance authority through the existing sync-state trigger. |
| Positive control | Repeat the failure fixture without injection and require actual commit and normal recovery. This prevents an inert method or fixture error from satisfying the rollback assertions. |
| Empty/unchanged control | Exercise the real callback for complete empty and unchanged inventories. Check deletion/retention and saved baseline without invented change evidence or claims of a new inventory invalidation guard. |

For the failure case, compare the authority tuple at correctly labeled points:
before RUNNING, after RUNNING, during the held inventory transaction, after its
rollback, and after the separate FAILED update where observable. Do not claim
license invalidation from the wrapper's existing sync-state increments. The
inventory itself has no installed license guard at this head. Do not require the
final authority tuple to equal the pre-call value. Terminal fields are semantic
assertions, not assumed transaction participants.

Record that the intended injection boundary was reached after staged writes;
an unrelated early rejection must not satisfy the rollback case. The outer
wrapper may translate the error into a gateway exception, so do not require
the caller's exception object to be identical to the injected one. The prepared
test instead captures the real Prisma transaction's rejection before that
translation and requires the exact injected cause, excluding a substitute
transaction timeout or rollback error.

The local follow-up enters `try/finally` immediately after successful Prisma
client construction, so setup/validation failures also disconnect it. The held
callback is declared outside that scope so cleanup can clear it on every exit.
The transaction proxy explicitly refuses non-callback invocations before calling
the real adapter. Current `saveSnapshot` uses the callback form; array-form calls
elsewhere in the service are outside this witness's license path. A future change
to that path requires a deliberate witness update, not a fabricated success.

Evidence identity includes `baselineObservedAt.toISOString()`. Current application
baselines and JavaScript `Date` reads use millisecond precision. Preserve that
contract in this fixture; assess any future raw-SQL microsecond baseline before
changing expected evidence IDs. No runtime timestamp or evidence-key change is
part of this follow-up.

Use barriers with bounded failure cleanup, not sleeps. A paused interactive
transaction must fit its existing configured lifetime; finish observer queries
promptly and release gates in `finally` before waiting for dependent work. Do not
change production transaction timeouts to accommodate the test. Restore wrapped
methods, disconnect every client and verify fixture cleanup. Retain unmodified
migration/trigger catalogs and sibling/outside-scope state. Test fixture cleanup
is not production recovery.

A known throw before commit is **not** an unknown commit result, lost acknowledgement,
late completion or uncertain-result retry witness. A successful single-collector run is **not** a
concurrent collector/direct-writer/parent schedule. The later installed-fixture
ordering experiment must still cover observed blocker edges, both parent orders,
existing/fresh/conflict writes and zero/nonzero evidence before a production
protocol is selected. No additional whole-transaction lock order is proved here.

## Completion boundary and fallback

The approved public parent has actual collector component proof and independent
review. This child adds only test cleanup/call-form safeguards and status notes;
its newer physical test bytes remain unexecuted in registered CI. The public draft
and approved evidence remain unchanged. This local revision has not been uploaded
or sent to Claude, and no application or schema deployment has occurred.

Require applicable exact-source approval before sharing this revision, then
registered exact-head disposable execution and authorized independent review
before extending the execution claim to it. Full license/source participation,
actual writer/parent ordering, reader/recovery, time/model aging, deployed
identities and fleet cost remain separate release gates. Keep HAW-21 ownership
work separate. Preserve protected main, the public draft, parent branch and
archives. Incomplete candidates remain unmerged; no manual database, sync or
release recovery. HAW-70, Baseline and full SYNC are incomplete.
