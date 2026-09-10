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
