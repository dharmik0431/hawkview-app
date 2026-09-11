# Risky Users — QA acceptance gate

Independent QA artifacts from the 2026-09-10 review. They are written as
assertions about **observable behaviour**, never about mechanism, so they judge
any implementation — including one sharing none of the internals they were
written against. That is deliberate: they were written before the rebuild was
designed, and they are meant to outlive it.

**Several of these fail on purpose.** A failure here is a documented defect, not
a broken test. See the table below before concluding anything is wrong.

## How to run

```
export DATABASE_URL="postgresql://<user>:<pw>@127.0.0.1:<port>/hawkview_qa"
export HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1
./node_modules/.bin/tsx --test src/identity-risk/qa-<name>.test.ts
```

A disposable loopback database only. The fixtures refuse to run otherwise: they
assert the host is loopback and the database name matches `/test|qa|hawkview_ci/`.
The server must be in **UTC** — a non-UTC server produces false failures with an
exact timezone offset, which cost real time to diagnose.

## The gate: `qa-security-events-never-zero.database-integration.test.ts`

Four scenarios, one rule. Each seeds a tenant whose mailbox evidence is complete
and matches nothing, so the **only** variable is how sign-in events are classified.

| Scenario | Window | Expectation |
|---|---|---|
| `UNRECOGNIZED` | codes the classifier does not know | MUST_WITHHOLD |
| `NON_QUALIFYING` | entirely out-of-scope codes | MUST_NOT_SHOW_BARE_ZERO |
| `PRE_EXISTING` | only `50076`, out-of-scope before any of this work | MUST_NOT_SHOW_BARE_ZERO |
| `MIXED` | 8 of 12 excluded, 4 genuinely assessed | MUST_NOT_SHOW_BARE_ZERO |
| `CONTROL` | fully assessed, nothing excluded, no matches | MUST_REPORT_EXACT_ZERO |

### Which scenarios are branch-independent — read before comparing results

The scenarios seed **error codes**, and what a code *means* is decided by the
classifier on the branch under test. So the same gate legitimately produces
different results on different branches, and that is not drift.

- `PRE_EXISTING` (only `50076`) and `MIXED` (`50076` + `0`) are
  **branch-independent**. `50076` has been out of scope since long before this
  work. These two are the load-bearing ones.
- `NON_QUALIFYING` also uses `50140`, which is only out of scope on branches
  carrying `0b3929c`. On `origin/main` it is UNKNOWN, so it caps coverage and
  the scenario correctly reports WITHHELD — a pass, and **not** evidence the
  defect is fixed.

Observed on `origin/main` (`d3791cb`): 3 pass, 2 fail — `PRE_EXISTING` and
`MIXED` trap. Observed on the lane-fix branch: 2 pass, 3 fail — `NON_QUALIFYING`
additionally traps. Both are correct readings of the same gate.

**If you are checking whether the defect is fixed, look at `MIXED`.** It is
branch-independent, it fires at any exclusion rate, and it is the live
production defect.

The rule is an **implication**, not a fixed shape:

> If the assessment claims an exact zero, something a user can see must disclose
> that events fell outside the assessed scope.

Withholding the count also passes. A bare unqualified zero is the only failure.
Corollary: a zero may never be captioned "No findings in evaluated evidence"
while undisclosed out-of-scope events exist.

### Why CONTROL exists — read this before changing it

CONTROL is the regression guard, and it is the least obvious of the five.

An earlier version of this file applied one blanket rule to every scenario:
"if it claims an exact zero, something must disclose." Applied to CONTROL, which
excludes nothing, that rule **fails the correct behaviour** — and worse, the
failure would have looked like evidence that withholding everywhere was the safe
answer. A test that quietly argues for the wrong fix is more dangerous than one
that misses a bug, because it recruits the person reading it.

**Trading a false zero for no zero at all is the worst available outcome.** A
product that can never say "zero" tells customers nothing. CONTROL asserts
positively that a genuinely clean tenant still reports `EXACT 0`. If CONTROL
fails, the fix has overcorrected.

In six months the other four scenarios will be self-explanatory. This one will not.

## The defect these document

Reproduced on `origin/main` at `d3791cb`, against real Postgres, through the
real evaluator, controller and production frontend helpers:

- A window of only out-of-scope events renders `capability FULL`, count
  `{value: 0, accuracy: 'EXACT'}`, headline `"0"`, captioned
  "No findings in evaluated evidence" — with **nothing** disclosing that every
  event was discarded.
- It does **not** require a fully-excluded window. `MIXED` (8 of 12 excluded)
  behaves identically. There is no exclusion-rate threshold anywhere in the logic.
- `50076` is the MFA-required interrupt, and every non-interactive sign-in is
  also out of scope. So the discarded population is ordinary traffic, and the
  share of a tenant's window that vanishes **grows with how thoroughly they have
  enforced MFA**.
- Every pre-existing signal reads healthy in the failing case: `gapCount` 0,
  `latestEventAt` populated, `assessedIdentities` 1. No existing field
  distinguishes "N events, none of which any rule could match" from "N events,
  all evaluated and clean".

The last point is why a counter is not the expensive option — it is the only one.

**Reporting counts is not the same as gating on them.** An implementation that
surfaces exclusion counts but still lets the headline claim a clean zero has
reproduced this defect with better instrumentation, and will look *more* correct
in review because the instrumentation reads as diligence. `MIXED` is the
scenario that catches it, because it fires at any exclusion rate rather than only
at total exclusion.

## Supporting artifacts

- `qa-zero-truthfulness.database-integration.test.ts` — two tenants differing in
  exactly one variable: whether there was human sign-in evidence to assess.
  Establishes the difference is representable in the payload but absent from the
  headline, so this is a summary-logic gap, not a contract gap.
- `qa-reader-lane-contention.database-integration.test.ts` — the original
  lane-contention defect, plus authorization checks (cross-tenant and disabled
  identity) that must hold **while the lane is contended**.

## Probes

Diagnostics, not tests. Each answers one question that reading could not settle.
They target the lane-fix branch (`agent/fix-risk-reader-lane-contention`) and
reference APIs that do not exist on `main` — they will not compile here. Kept as
method, not as running code.

- `qa-probe-read-lane-race.ts` — 300 rounds aligning waiter deadlines with the
  exact hand-off instant; 1800 waiters, both paths exercised, lane never stranded.
- `qa-probe-early-reject.ts` — an early reject must release the lane, let queued
  readers through, and never execute the rejected work.
- `qa-probe-lane-boundary.ts` — proved an assertion could not distinguish "ran
  inside the lane" from "short-circuited before it".
- `qa-probe-lane-test-specificity.ts` — proved a test passed because the call
  *threw*, not because it succeeded.

The pattern worth keeping: **three vacuous tests in this workstream were found by
mutation, none by review.** Tests are weakest exactly where their author is most
confident, because confidence is what stops you imagining the failure.

## What this method cannot catch

Everything here is synthetic. The one class of defect it structurally cannot
find is a predicate that is reasonable in theory and false against real provider
data — a check that matched 100% of Graph rows including humans would have
reported every tenant clean having examined nothing. Only a distribution check
against real data with a human-cohort control finds that. Validate any predicate
about Microsoft payload shape that way **before** it ships.

## The monotonicity harness

`backend/src/evaluation-core/qa-monotonicity-harness.ts` and its proof.

`Detector.monotonic` declares that adding events can never remove a finding.
That property is what makes a detector safe to run on a **truncated** window,
and getting it wrong on an absence-keyed rule does not lose a finding — it
**fabricates** one, because the disconfirming event is exactly what truncation
removes. So it is the last place a self-declaration should go unchecked.

The harness runs a detector over random nested pairs `S ⊆ S'` and asserts every
finding from `S` survives in `S'`. It is **generic over the event type**, so it
needs no knowledge of Microsoft fields and works for every detector, present and
future. Seeding is deterministic: a failure reproduces from its seed alone.

Two properties it was built with, both learned the hard way here:

- **`findingsSeen` must be non-zero.** A harness whose detector produced no
  findings reports `held: true` while proving nothing. That is the vacuity
  failure this workstream hit three times; insist on the count, not the verdict.
- **A decline is not a violation.** If the larger run returns `INAPPLICABLE` the
  finding is gone, but the detector never claimed to have looked — and some
  declines are correct by construction, such as refusing a truncated window.
  Reported as `LOST_TO_DECLINE`, separate from `LOST_WHILE_RAN`, and tolerable
  via `declineIsViolation: false`. Collapsing the two would make a correct
  decline read as a defect, which is the same collapse this project exists to
  remove.

The proof file demonstrates the harness **discriminates** rather than assuming
it: a presence-keyed detector holds (519 findings observed surviving), an
absence-keyed one mis-declared monotonic fails at trial 1 with a named
counterexample, and a declining detector is reported as `LOST_TO_DECLINE`.

Like the probes, these import the rebuild's `evaluation-core` contract and will
not compile on this branch. Kept here because a QA instrument is stronger when
it is not maintained by the author whose declarations it checks.

---

## Re-verified against `main` (`1142232`)

An earlier pass of this section was written against `4250a27`, the integration
tip PM named. `main` is 47 commits beyond it and carries both PM's revert of
this gate and a further contract change, so that pass was measuring a commit
nobody is shipping. Everything below is `main`.

`tsc --noEmit` is clean. The cleanliness is accounted for: all 14 QA files are
in the compiler's program (`--listFiles`), an injected type error is caught,
and it disappears again when removed.

### Repaired, and this gate can show it

| Scenario | Result on `main` |
| --- | --- |
| CONTROL — 20 successes, nothing excluded | EXACT 0, scope supports it |
| MIXED — 4 assessed / 8 `KEEP_ME_SIGNED_IN` | EXACT 0, exclusions travel with the count |
| FULLY EXCLUDED — 0 applied / 12 excluded | NOT_AVAILABLE / `NOTHING_APPLICABLE` |
| AUDIT, `Z` and bare timestamps | accepted, EXACT 0 |
| AUDIT, `+05:00` offset | rejected, count NOT_AVAILABLE — not a zero |
| TIMESTAMP COHERENCE | **COHERENT** |

Three findings this gate raised are closed:

- **Timestamp incoherence.** A finding no longer carries one `observedAt`.
  Each signal carries its own count and `latest`, and the gate now reads
  `LOCKED_OUT_AFTER_REPEATED_FAILURES` count 6 latest 10:05 alongside
  `PASSWORD_REJECTED` count 1 latest 20:00 — ten hours apart, each stamped
  from its own evidence. The gate identifies which signal is which **by count**
  (six lockouts, one rejection) rather than by name, so it does not pass
  silently the day the vocabulary changes.
- **Under-reporting.** `assessed + declined === handed` is now enforced
  (`evaluate.ts:373`). A detector claiming it assessed 5 of 1000 is rejected;
  the probe moved from `GAP` to `CLOSED`.
- **The zero-assessed veto.** A detector may report `assessed: 0` with
  everything declined and still support a claim. CONTROL shows `assessed: 0,
  declined: {NOT_A_CREDENTIAL_FAILURE_OUTCOME: 20}` reaching EXACT 0. The
  earlier version of this guard told every clean tenant "we cannot tell you."

### Not repaired: none of it is reachable

**Nothing outside `risky-users-wiring/`, `risky-users-normalization/` and
`evaluation-core/` imports any of them.** Checked repo-wide across
`backend/src`, `app`, `lib` and `components`; the only reference anywhere is a
test script in `backend/package.json`. `app.module.ts` still registers
`IdentityRiskModule`, and `identity-risk.controller.ts` still serves
`identity-signals/assessment` and `identity-signals/summary` from the old
engine.

Driven through that old engine — the path a customer actually reaches — this
gate still fails PRE_EXISTING and MIXED: a confident exact zero over 12
security-relevant events, with nothing disclosing they fell outside the
assessed scope. Reproduced on `4250a27` and again on `main`, same two scenarios
both times, with CONTROL passing in the same run.

The repair is real, it is well built, and at `1142232` it is dead code. A
customer loading Risky Users today sees exactly what they saw before.

### The harness was retargeted without being weakened

Removing `observedAt` removed part of the finding identity `checkMonotonic` was
keying on. The replacement is NOT `max(signals.latest)` — that value moves as
events are added, so keying on it would make every monotonic detector look
broken the moment a newer event arrived. Identity narrowed to the subject.

Narrowing an identity key means drawing fewer distinctions, and a quieter
harness reads as a greener product. So signal survival became its own check
(`SIGNAL_LOST_WHILE_RAN`): a finding may gain signals, but losing one is a
basis vanishing under a claim that survived, which the identity check cannot
see because the finding is still there.

That check is proved able to fail. A detector that keeps the same finding and
drops a signal as the window grows is caught; the same detector with its
signals held constant is not. The original discrimination still holds too —
519 findings survive for the presence-keyed detector, the mis-declared
absence-keyed one fails at trial 1, and a decline is still reported as
`LOST_TO_DECLINE` rather than as a violation.

### Two probes of mine were wrong, and the guards caught both

`qa-mixed-decision-layer.ts` excluded rows using code `53004`. In the merged
provider facts that code is `NOT_OBSERVED` and classifies as RISK, so every row
applied, nothing was excluded, and the probe went inert. The `inputCanFail`
guard reported INCONCLUSIVE rather than a pass.

Retargeted at `50140`, it then reported `BARE ZERO` — also wrong. Its `totalOn`
summed only top-level numbers, and `setAside` is an array of
`{vocabulary, reason, count}` records, so the probe read 0 from a layer that was
disclosing all eight exclusions. Fixed with a deep sum, and confirmed to still
discriminate: deleting `setAside` from the inspected scope flips it back to
`BARE ZERO`.

Both have one root. `provider-facts.ts:74` names `53004` as one of two past
errors in this workstream — sound readings of Microsoft's documentation for
events nobody has ever seen. A fixture built on a code the provider does not
emit tests the documentation, not the product.

### Deleted

`qa-probe-{read-lane-race,early-reject,lane-boundary,lane-test-specificity}.ts`
and `qa-reader-lane-contention.database-integration.test.ts` targeted
`runInReadMemoryLane`, which does not exist in this lineage.
`qa-zero-truthfulness.database-integration.test.ts` targeted the v1 assessment
`summary`. They could not be ported, only rewritten against a different design.

`qa-security-events-never-zero.database-integration.test.ts` was NOT deleted.
It is the only thing here that tests the path a customer actually reaches, and
it is the only thing here that still fails.

### Added: `qa-probe-signal-truthfulness.ts`

Two claims the per-signal contract makes that nothing else here checked.

**`capped`.** Over budget, `evaluate` truncates to the most recent slice before
any detector sees it, so every count from that window is a floor. Pool of 40,
budget 10: every signal comes back `capped: true` and the claim is `AT_LEAST`,
not `EXACT`. The same detector over the whole window is `capped: false` and
`EXACT`.

**Evaluated-and-none vs never-evaluated.** `latest: null` means the signal was
evaluated and none occurred; a signal absent from the array was never
evaluated. A core that dropped zero-count signals would collapse the two while
every count stayed correct. It does not: the zero-count signal survives and the
absent one stays absent.

Both verified by mutating the product source and restoring it:

| Mutation to `evaluate.ts` | Result |
| --- | --- |
| `cappedWhenTruncated(finding, false)` | capped check FAILS, other check unaffected |
| drop signals with `count === 0` | looked-vs-didn't check FAILS, capped check unaffected |

Each mutation fails the check that should catch it and no others, so neither
PASS is a check that cannot fail.

One thing checked and found sound rather than defective: `capped` is stamped
from the `evaluate` budget alone, so a count truncated further upstream would
carry `capped: false`. In this path it cannot happen — `read-tenant.ts` puts no
`take` on the query, `rowsFetched` is the true fetched count, and
`assertAccountsForEveryRow` holds it against the classifier. Worth re-checking
if a query limit is ever added.

### Retargeted again for `SignalRecency` (`2c23a97`) — and this commit is contract-coupled

`DetectorSignal.latest` became `null | { at, kind: 'EVENT_OCCURRED' | 'STATE_OBSERVED' }`.
The fixtures take `{ at, kind }`; the coherence gate reads `latest.at`.

**These files will not compile on a tree without `2c23a97`.** They must land
with it, not before it. Verified by typechecking them against `main` without
that commit rather than assumed.

### Added: `qa-probe-recency-kind.ts`

The invariant that spans two detectors, which neither detector's own unit test
is positioned to see:

```
repeated-credential-failure   must only ever say EVENT_OCCURRED
external-mailbox-forwarding   must only ever say STATE_OBSERVED
```

It does not stop at the label. A label is a claim, and the defect being guarded
against was a read time wearing an event time's clothes — so it also asks
whether `latest.at` came from where the kind says it came from: an
`EVENT_OCCURRED` value must equal the time of an event in the input, a
`STATE_OBSERVED` value must equal the artefact's own `observedAt`. The
forwarding artefact is stamped six months old on purpose, because a read time
is always recent and an input where both are recent cannot tell them apart.

Mutation-verified against the product source, then restored (diff-clean):

| Mutation | Result |
| --- | --- |
| credential rule claims `STATE_OBSERVED` | kind check FAILS, value check unaffected |
| forwarding stamps `new Date()` instead of `observedAt` | **kind check PASSES**, value check FAILS |

The second row is why the probe goes past the label. That mutation is the
original defect exactly — the label stays honest and only the value is wrong —
and a check that read `kind` alone would have passed it.

### Added: `qa-run-harness-credential-failure.ts` — the blocking precondition

The stale-evidence ruling gates on `monotonic`, and that flag had never been
checked for `repeated-credential-failure`, the detector that carries it. This is
that run. `held: true` is not the result; three things hold together:

| | |
| --- | --- |
| lockout branch (`lockouts > 0`) | held, **1448** findings surviving |
| threshold branch (`rejections >= 5`) | held, **1450** findings surviving |
| mixed, with successes and an excluded code | held, **1362** findings surviving |
| absence-keyed counterexample, same pool | **caught at trial 2**, `LOST_WHILE_RAN` |

Both firing branches get their own pool. A pool that only ever trips the lockout
branch leaves the threshold branch unverified while the summary line still says
the detector holds — findings seen, but all from one arm.

The counterexample is the part that makes `held: true` mean anything. A quiet
instrument and a correct detector produce identical output, so the run includes
a deliberately absence-keyed rule over the same events with the same
declaration. The harness catches it at trial 2, which is what licenses reading
the three green rows as a result rather than as silence.

Reading the detector first: it fires on `lockouts > 0 || rejections >= threshold`
and always emits both signals, including one the subject never produced. Nothing
in it is keyed on an absence. The declaration is earned.

### Fourth reconciliation (`265e61f`): `syncStatus` is now per feed

`Readonly<Record<NormalizationSource, CollectorSyncStatus>>` rather than one
status. The five database gates pass both feeds explicitly.

### `qa-gate-collector-mapping.ts` — acceptance test for the `COLLECTOR_FOR` fix

| commit | `COLLECTOR_FOR.M365_AUDIT_STS` | applies | verdict |
| --- | --- | --- | --- |
| `265e61f` | `M365_AUDIT` | 0 of 15 | **VETO** |
| `10d1116` | `SIGN_INS` | 15 of 15 | **PASS** |
| `1bf4a1f` | `SIGN_INS` | 15 of 15 | **PASS** |

The fix is verified independently. The PASS is accounted for: the same gate
reports VETO one commit earlier, with integrity clean and the guard satisfied
in both runs, so the difference is the mapping and nothing else.

**The first attempt at this gate was testing the wrong level.**
`qa-gate-freshness-asks-the-right-collector.ts` calls `readTenantAssessment` and
*injects* `syncStatus` itself. The mapping lives one level above it, in
`syncStatusPerFeed`. So that gate reproduces the consequence of a wrong status
and is blind to which collector was asked — it would have reported the veto
unchanged after a correct fix and blocked it. **A test that injects the value
under test cannot check how that value is chosen.** Both are kept: one shows
the harm, one tests the fix.

**And the first run of the corrected gate was also wrong.** It reported VETO
because the fixture stamped `ingestedAt` before the events, so all fifteen rows
came back `UNPROCESSABLE / INGESTION_PRECEDES_EVENT` — `applies: 0` with the
evidence read perfectly well, which looks exactly like the veto. Caught by
dumping the raw persisted coverage instead of trusting the verdict line. The
gate now guards on it: rows fetched is not enough when every row can fail
integrity.

One honest limitation: the `UNREADABLE_NOW` / `NEVER_COLLECTED` marker check
never fires in either run, so the discrimination rests entirely on `applies`.
That is demonstrated rather than assumed, but the marker check is currently
inert and should not be read as contributing.

### `qa-gate-name-resolution-isolation.ts` — gates Engineer 2's merge, not the backend push

Asks whether subject-name resolution can pull a sibling tenant's person into an
authorized tenant's answer. Verified in both directions against `f107802`:

| | |
| --- | --- |
| unmutated | **PASS**, 2 of 2 |
| `customerTenantId` dropped from the resolver's `where` | **CROSS-TENANT LEAK**, 3 of 3 |

Scope is stated in the file: authorization is stubbed to an already-authorized
tenant, because the controller delegates that to `authorizeRiskyUsersRead`. A
PASS here does not mean cross-tenant *access* is safe.

**The fixture took three attempts, and the two failures are the useful part.**

1. **Both tenants hold a row for the same id.** Non-deterministic — the widened
   query returns two rows, `named.set` keeps whichever Postgres returned last,
   and there is no `ORDER BY`. Against broken code it reported PASS once and
   CROSS-TENANT LEAK the next run. A gate that catches a real leak half the time
   is worse than none, because the half that passes is the half that gets quoted.
2. **Only tenant B holds a row.** Deterministic and completely inert — with no
   directory row of its own, tenant A's subject binds by UPN, carries no
   directory id, and never enters the resolver's lookup set. PASS three times
   against broken code. *The absence being relied on also removed the lookup key.*
3. **What shipped.** Tenant A holds the row during evaluation so the subject
   binds, then it is deleted before the read — leaving tenant B's as the only
   candidate. Also a real state: a person removed from a directory after a run.

**A separate bug in the probe, caught by the same mutation.** The verdict
originally checked the `inputCanFail` guard *before* the leak. Under the mutation
the leaking row overwrote tenant A's name, which removed the guard's own input —
so the verdict line read INCONCLUSIVE while `responseLeaksTenantBName: true` sat
directly above it. **An absent guard input is not evidence of safety when the
thing that removed it is the leak.** Leak is now checked first.

One incidental confirmation: names are role-gated on `evidenceDetailAllowed`, and
the response carries `subjectsNamed` so a surface can say "your role does not show
names" rather than rendering blanks.

### Reading the shipped screen without the preview harness

The preview harness (`preview-risky-users.mjs`) does not run against `d3932fa`:
it has no module-map entry for `@/lib/identity-risk/native-view`, and beneath
that it mocks `./identity-risk-hooks` while the component now imports
`useNativeRiskyUsersRead` from `./risky-users-assessment-hooks`. It was green for
weeks while the screen rendered the old engine and broke when the wire moved —
**stale at exactly the seam the 52 UI tests are stale at.**

So these two tools read the screen a different way, and found two customer-facing
defects in fifteen minutes on a path where every suite is green:

- `qa-dump-native-response.ts` captures a **real** native response from the
  shipped backend path (`evaluateAndPersistTenant` → `RiskyUsersController`) on a
  disposable database. `QA_MODE` selects `positive` / `zero` / `unavailable` /
  `atleast` / `unnamed`.
- `qa-render-native.mjs` runs that response through the frontend's own
  `adaptNativeAssessment` and `nativeRiskyUserList` and prints what the screen
  says.

Using a real response rather than an authored fixture matters twice over: no
native fixture exists anywhere in the repo, and a fixture written from reading
the type would have encoded the same misunderstanding as the code.

**What they cannot show:** visual grouping, what is above the fold, what sits
beside what. Two of the five known instances of this feature's defect were
exactly that, so a clean result here does not clear the screen.

#### What the count vocabulary says — all correct

| state | headline | reads as |
| --- | --- | --- |
| EXACT 0 | "Risky users 0" | scoped zero; caption says every event was assessed or accounted for |
| WITHHELD | "Not counted — no evidence was in scope for any check" | explicitly "not a zero and not an all-clear" |
| AT_LEAST | "Risky users, at least" · `≥1` · `listCoverage: PARTIAL` | a floor, with truncation explained |

`evidenceCountCapped: true` propagates to each signal. `priority: null` is
deliberate and documented — the engine rates nothing and inventing a sort key is
refused. None of these read as failures.

#### The two defects, both one root cause

**The frontend still speaks the old engine's vocabulary while the backend ships
the new one.** Every individual field is correct on both sides.

1. **Every row renders "Identity not resolved" while the name is in the payload.**
   The controller spreads `displayName` / `userPrincipalName` at the finding-item
   level; `native-assessment.ts:229` reads them from inside `subject`. So
   `native-view.ts:91` returns its fallback. `subjectsNamed: true` sits in the
   same response. **This is the defect the subject-name resolution was built to
   remove**, arriving one layer up.
2. **"Risky users 4" beside "A check this build of HawkView does not recognise."**
   `presentation.ts:639` keys its evidence-shape table on the old engine's rule
   ids; the shipped detector id is `repeated-credential-failure`, so
   `findingEvidenceShape()` returns `UNRECOGNISED`. **It appears on every state
   including the clean zero and the withheld** — so a legitimate EXACT 0 is
   undercut by a sentence saying a check was not recognised.

**Consequence of (1) worth stating separately:** the named and unnamed roles
render *identically*. A technician whose role may see names and one whose role may
not see the same screen, and both read as "HawkView could not identify these
people" rather than "your role does not show names."

**Latent, same file, same edit:** `native-view.ts:106` hardcodes `kind: null`,
discarding the `latest.kind` the backend now sends, and the section re-derives
occurrence-versus-observation from `findingEvidenceShape(ruleId)` — a client-side
table. That is the convention `2c23a97` removed ("the kind travels with the value
instead"). Invisible with one detector; it becomes the read-time-as-event-time
defect again the moment `external-mailbox-forwarding` ships.
