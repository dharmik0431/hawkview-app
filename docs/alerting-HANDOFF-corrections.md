# Handoff corrections — the superseded statements, with replacements

For whoever edits `docs/alerting-HANDOFF.md` on `agent/alerts-step-01`. **I have not edited that
file**, because two sessions editing one branch is how collisions happen. These are exact, so
they can be applied mechanically.

**Each was true when written.** The point is not that anybody was wrong; it is that a document
which logs its own history reads as current status to somebody arriving cold, and Dharmik asked
for one consistent current status.

## 1. Status table, line 48 — half true, and the half that is false is the load-bearing one

> Apply, revert and the runner are written and typecheck; **nothing has been run against a
> database by anyone**, and **nobody has yet connected to production from an engineering
> machine.**

**The first clause is now false; the second is still true.** Replace with:

> Apply, revert and the runner are written, typecheck, and **have been run end to end against a
> disposable Postgres by QA** — all five commands, both preflight outcomes, a revert with
> occurrences arriving, and a concurrent writer proving the in-transaction re-check rolls the run
> back rather than writing 46 of 47. **Nobody has yet connected to production from an engineering
> machine**, so every figure remains a synthetic-fixture figure.

## 2. Line ~320 — now simply false

> **The migration has never been run anywhere.**

Replace with:

> **The migration has been run against a disposable Postgres**, forward and twice, with the
> runbook's confirmation query returning both columns nullable and the index present. It is
> **idempotent when re-run on a clean database** and **fails destructively on a half-migrated
> one** — see `alerting-LAUNCH-BLOCKERS.md` B1, which is a launch blocker with a one-line fix.

## 3. Lines ~108-112 and ~473-477 — do NOT delete these; they are still mostly true

> **1684 tests, 1588 pass, 0 fail.** The remaining 96 are database-integration tests ...
> **they were never run here** ...

and

> ### Database-integration tests have never been run against any of this
> ... **96 tests, zero runs.**

**"Zero runs" is superseded; "not a safety net" is not.** Replace the claim, keep the warning:

> The database-integration tests **have now been run once, by QA, against a disposable Postgres:
> 42 pass and the remainder fail on environment prerequisites** — `IDENTITY_RISK_SOURCE_UNAVAILABLE`
> and `IDENTITY_RISK_KEY_UNAVAILABLE` — **that no document specifies in full.** One documented
> trap, a non-UTC server, accounted for eleven of them. **None of the failures has been shown to
> be a product defect and none should be quoted as one.** The pass count above still must not be
> read as covering this suite, and **the suite cannot currently be taken to a green run by
> anybody**, which is why it is a blocker on the release checklist rather than on the code.

## 4. Line ~347 — true of production, no longer true of the mechanism

> **But the ruling does not reach every recovery, and nobody has counted which.**

Replace with:

> **The ruling does not reach every recovery.** A recovery of a connection or an audit alert
> still names no resource type. **QA has confirmed the shortfall is measurable rather than
> theoretical**: at a synthetic canonical shape the NEVER-writable line reads exactly 3, and when
> five recoveries were rewritten to recover connection alerts it read 9 and writable fell to 38.
> **So the line is an instrument, and 44 remains an upper bound until step 1 is run on production
> data** — which nobody has done.

## 5. My own, already corrected in `alerting-QA-METHOD.md`

Both were mine and both were false by the time anyone read them:

- *"L1, L2 and L4 are unbound — the limit function does not exist yet"* — they were bound at
  42622d1, 135 enumerated cases, 0 breaches.
- *"No database, no production data, no integration tests"* — a disposable cluster exists and the
  apply has been run against it. No production data remains true.

**And the one I carried longest:** I reported *"the runner does not exist"* for several rounds
after Engineer had written it. Nobody caught it but me, and only because I re-checked before
repeating it. That is the argument for this whole file: **a status claim should be re-read before
it is repeated, not after somebody acts on it.**
