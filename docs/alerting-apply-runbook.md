# Step 03 apply — runbook

**Operator: Dharmik. Nothing here runs automatically and nothing runs from an agent session.**

> **THESE COMMANDS HAVE NOT BEEN RUN AGAINST A DATABASE.** This worktree has no `psql`, no
> Docker and no `DATABASE_URL`, so the pure functions are tested exhaustively against fixtures
> and **the commands themselves are untested**. What that means concretely is at the bottom
> under *Before you trust this*. Read that first if you are about to run it on production.

## The two schema findings that determine the shape

Asked for repeatedly and repeatedly not delivered, so they lead here.

**1. The migration cannot re-key. It can only annotate.** `Notification` carries
`@@unique([organizationId, dedupeKey])`. 317 rows consolidating to 71 incidents would need 317
rows sharing 71 dedupe keys — the constraint forbids it — or 246 rows deleted, which breaks
*the underlying events are preserved*. **So consolidation is many rows sharing a new
`incident_key` column, not fewer rows existing.**

**2. `NotificationUserState` is the second reason.** Read and dismissed state is per
notification id and cascades on delete, so merging rows would **silently discard which alerts a
person had already read** — invisible until an MSP's list came back unread.

**Does this permit an atomic single-transaction apply?** Yes, and it makes it easier. The write
is two nullable columns on at most 364 rows — a small single-statement-per-row update inside
one transaction, no schema change during the run, no locking of anything a request path needs
for long.

**And it is what closes the delivery requirement for free.** The apply and revert contain **no
assignment to `occurrenceCount`, `resolvedAt` or `lastOccurredAt`** anywhere. The indirect
route — a notifier watching those fields, turning a migration into 364 messages with nothing
called — is not avoided by discipline; there is nothing to avoid. **A revert cannot restore
`occurrenceCount` because the apply never changed it.**

## The four artefacts

| artefact | when | why |
|---|---|---|
| `mapping.json` | saved **before** apply | what was approved, on disk, not recomputed at run time |
| `preflight.txt` | before apply | the abort report, or confirmation there are no differences |
| `receipt.json` | written **by** apply | enough to undo the run **without consulting the database** |
| `verify.txt` | after apply | the checklist output |
| `revert-receipt.json` | written **by** revert | which rows went back and which were left alone -- what makes a partial revert legible rather than silent |

Keep all four together. The receipt is the only thing that makes the revert safe.

## Step 1 — save the approved mapping

```powershell
cd C:\Users\Dharmik\.codex\.chatgpt-projects\g-p-6847a104091c8191870e79dfbb556813\hawkview-api-rate-limiting\backend
node --import tsx scripts/alerting-apply.mts save-mapping --out ..\artefacts\mapping.json
```

**Expected output — success:**

```
Read 364 notification rows.
Mapping: 364 entries, 71 episodes (62 attributed, 9 standing alone), 47 unrecoverable.
Wrote ..\artefacts\mapping.json
```

**If the figures differ from 364 / 71 / 62 / 9 / 47, stop.** The approval was for a mapping,
not a procedure. Send the new figures to be re-approved before going further.

## Step 2 — preflight (writes nothing, ever)

```powershell
node --import tsx scripts/alerting-apply.mts preflight --mapping ..\artefacts\mapping.json --out ..\artefacts\preflight.txt
```

**Expected output — clear to proceed:**

```
No differences. The mapping still describes the data.
364 rows would be written. 0 already applied.
PREFLIGHT PASSED - safe to apply.
```

**Expected output — aborting:**

```
ABORTED - 3 difference(s). Nothing was written.

1 changed since the mapping was saved:
  9f2c...  saw 12:security... now 12:security...

2 in the table but not in the mapping (arrived after the mapping was saved):
  a41b...
  c7d0...

PREFLIGHT FAILED - do not apply. Re-run step 1 and have the new figures approved.
```

**Any difference at all stops the run.** One is enough. That is stricter than the QA contract,
which refuses the individual row and continues — the strictness is deliberate, because a
partial migration is the state where the table holds two keying schemes at once, and this makes
it unreachable rather than merely detectable.

## Step 3 — apply

```powershell
node --import tsx scripts/alerting-apply.mts apply --mapping ..\artefacts\mapping.json --receipt ..\artefacts\receipt.json
```

**Expected output — success:**

```
Preflight re-run inside the transaction: no differences.
Applied 364 rows in one transaction.
Watched fields disturbed: none.
Wrote ..\artefacts\receipt.json (364 changes, 0 untouched)
APPLY COMPLETE.
```

**Expected output — refusing:** identical to the preflight abort, followed by
`APPLY ABORTED - nothing was written.` The preflight runs **again inside the transaction**, so
a change between step 2 and step 3 still stops it.

**If it fails partway:** it cannot. One transaction — the table is either fully migrated or
untouched. If the process is killed mid-run, Postgres rolls back and step 2 will tell you the
table is unchanged.

## Step 4 — verify

```powershell
node --import tsx scripts/alerting-apply.mts verify --receipt ..\artefacts\receipt.json --out ..\artefacts\verify.txt
```

**The checklist, and what each line means:**

```
[ok] 364 of 364 receipt rows carry the incident key the receipt records
[ok] 71 distinct incident keys across the migrated rows
[ok] 47 rows have episode NULL (unrecoverable), 317 have a number
[ok] no incident key is shared across two organisations
[ok] occurrenceCount, resolvedAt and lastOccurredAt unchanged for every receipt row
[ok] 0 rows carry an incident key that is not in the receipt
VERIFY PASSED.
```

Any `[--]` line is a failure. **The last two matter most:** the fifth is the delivery
guarantee, and the sixth catches a second migration having run.

## Revert

```powershell
node --import tsx scripts/alerting-apply.mts revert --receipt ..\artefacts\receipt.json
```

**It reads the receipt and touches only the rows that run changed, only where they still hold
exactly what it wrote.** Never a blanket update, and it writes its own receipt.

**Expected output — complete revert:**

```
Checked 364 rows from receipt run-2026-09-12T10:00:00Z.
Reverted 364 rows in one transaction. Refused 0.
Watched fields disturbed: none.
Wrote ..\artefacts\revert-receipt.json
REVERT COMPLETE - all 364 rows put back.
```

**Expected output — partial revert. THIS IS A SUCCESS, NOT A FAILURE:**

```
Checked 364 rows from receipt run-2026-09-12T10:00:00Z.
Reverted 363 rows in one transaction. Refused 1.

1 refused - no longer this run's to undo:
  9f2c...  holds somebody-elses-later-key/1  this run wrote hawkview.../1

Watched fields disturbed: none.
Wrote ..\artefacts\revert-receipt.json
REVERT COMPLETE - 363 put back, 1 left alone. 364 of 364 accounted for.
```

**Read the last line.** Reverted plus refused must equal the receipt's row count; that is what
says the state is fully described rather than partly unknown. A refused row is one somebody
else changed after the migration — **leaving it is correct**, and overwriting it would destroy
their work.

New occurrences arriving since the apply do **not** cause a refusal. That is the system
working, and a revert that refused on them would be un-runnable — see the two scopes below.

### Revert refuses PER ROW — ruled, and I argued the other way first

I built wholesale and recommended it. **The argument against it is better and I have changed
the implementation.**

What I missed is the asymmetry. **The apply aborts wholesale because a partial migration is
dangerous FOR BEING SILENT** — the table holds two keying schemes and nothing records which
rows are which, so it reads as finished. **A partial revert has no such silence:** the
receipt names every row the run changed, and the revert receipt names which of those were put
back and which were declined. The two lists account for the whole receipt. The state is
described rather than inferred, and that is what makes per-row safe rather than merely
convenient.

And a declined row is not half-done work. **It means somebody changed that row after the run,
so it is no longer ours to undo** — leaving it alone is the correct answer. Refusing the other
363 as well would block a recovery action over a row the revert was right to skip, during an
incident, which is when reverts happen.

**With the narrow version check below, a refusal is genuinely exceptional** rather than
routine — which is what makes per-row tolerable in the first place.

### THE TWO VERSION CHECKS HAVE DIFFERENT SCOPES, and this is the trap

| | scope | why |
|---|---|---|
| **apply** | every mapping input — `dedupeKey`, `occurrenceCount` | if anything moved, the mapping describes a situation that no longer exists |
| **revert** | `incidentKey` and `episode` **only** | occurrences arriving in between are normal and expected |

**Reusing apply's check for revert makes the revert un-runnable by design.** A row reading
301 at apply time reads 305 an hour later; apply's digest covers `occurrenceCount`, so the
revert would refuse every row within five minutes of any new event — **precisely when somebody
needs it.**

I had exactly that bug. `validateRevert` called `digestOf`, which is apply's check, and
**reusing it looks like consistency** — which is why it is a trap rather than an oversight. It
is now pinned by a test that fails if the check is widened again.

### A revert restores only the FIELDS the apply changed

**Not the row as the receipt found it.** Occurrences arrive between apply and revert — that is
the system working. Writing the snapshot back rolls `occurrenceCount` from 305 to 301 and
**four real events are gone**; and because `occurrenceCount` is watched, the same write can
deliver. Both failures are one mistake: reading *restore the prior state* as *restore the prior
row*.

**The receipt makes this easier to get wrong, not harder**, because the old values sit in it
looking authoritative. It exists to make revert safe and it is the thing that would tempt
somebody into the unsafe version. Pinned by a test asserting the four events survive.

**Revert aborts wholesale, matching apply — and I recommend keeping it that way, with the
counter-argument stated because it is real.**

*For wholesale:* a partial revert leaves the same mixed state the apply's abort rule exists to
prevent. The operator is a person reading a report, not a scheduled job, so an abort costs a
minute and a decision rather than an outage.

*Against:* **revert is the emergency path.** If you are reverting because the migration was
wrong, one unrelated row that somebody touched should arguably not block rolling back the other
363. Blocking the safety mechanism at the moment it is needed is a real cost.

*Why I still recommend wholesale:* the escape hatch should be an explicit separate command
(revert only the rows still exactly as the receipt left them), not a flag that quietly weakens
this one. A flag gets used by reflex; a differently-named command is a decision. **That command
does not exist yet — say the word and it is small.**

## The version check must be ONE SQL STATEMENT, not a read then a write

**Measured against a real Postgres by QA, and it is a constraint on the runner rather than a
reassurance:**

- Version computed **in SQL**, so check and write are a single statement: two connections
  racing, 25 rounds, **exactly one winner every time.**
- The naive read-in-the-application-then-write: **both writers through in all 25 rounds.**

The second is the control, and it is what makes the first mean anything — the harness
genuinely produces a race, so the single winner is the conditional write rather than lucky
timing.

> **If the runner reads the version in TypeScript and then writes, it is not the conditional
> write — it is the naive control, which lost every round.**

Same shape as the delivery guarantee: not *we checked*, but **there was no gap in which to be
wrong**. The pure functions in `apply-mapping.ts` compute the decision for testing; **the
runner must still express each write as one conditional statement** whose WHERE clause carries
the expected version. Say so at the call site — the difference between correct and worthless
is invisible at a glance and catastrophic in production.

## One statement, not a loop — and you do not need a maintenance window

**Measured at 364 rows:**

| | loopback | + 14.5 ms per round trip |
|---|---|---|
| per-row `UPDATE` | 395 ms | **5,623 ms** |
| one statement | 12 ms | **12 ms** |

**The driver is round trips multiplied by latency, not row count.** Per row, going from 364
to 5,000 rows is 395 ms to 1,034 ms — under 3× for 14× the rows. The shape matters more than
the size.

**Production is not loopback.** The database is Supabase in `ca-central-1` and the backend
runs on Render, so there is a real network hop and **nobody has measured it.** That is not a
gap to close before shipping — it is the argument for the shape that does not depend on the
number.

> **You do not need a maintenance window if the window is twelve milliseconds.**

That is a structural mitigation rather than an operational one. The alternative was a runbook
telling you to pick a quiet moment, which is a worse answer that also has to be remembered.

**Everything Dharmik required survives the change.** Still all-or-nothing — the runner
compares the returned row count against the expected count and rolls back on any difference.
Still version-checked per row: **the check moves into the join condition** rather than a loop,
so check and write remain one statement. Still refusing moved rows, still abort-before-write.

**How to tell the runner is right:** `applyStatement()` emits the SQL, and a test asserts it
is one statement for 1, 10, 364 and 5,000 rows, that the version predicate is in the WHERE
clause, and that values travel as parameters. **If somebody replaces it with a loop, that test
fails** — the constraint is checkable rather than advisory.

### The measurement, with its bounds

Loopback, one machine, Postgres 15, medians of 3–5 samples, and **a sleep rather than a real
network** — so it models per-round-trip cost and not jitter, packet loss or connection setup.

**And the latency figure itself was nearly wrong in the flattering direction.** The delay was
requested as 1 ms; Node's timer floor on that machine is ~14 ms, so it was never 1 ms.
Reporting it as 1 ms would have **understated the effect by an order of magnitude**. It was
caught by arithmetic: 364 × 1 ms should be 364 ms and the figure was 5,377 ms — **the numbers
did not close.** The latency is now derived from the measurements twice independently and the
two derivations agree.

The rule from it is worth keeping: **a simulated parameter must be measured, not assumed,
because the simulation is part of the instrument.**

## One transaction means locks are held for the whole run

All-or-nothing means row locks are held until commit, so **every concurrent writer touching an
already-written row stalls behind the migration for its full duration.** The engine's own
writes queue behind it.

Measured at 117–199 ms against a ten-row run with a deliberate delay. **With the
single-statement apply the whole transaction is about twelve milliseconds**, so the stall is
shorter than the delay used to measure it. Stated because it is a property of the design
rather than a defect.

**The number that matters is the transaction's wall-clock length, not its row count.** More
rows, a slower link, or a retry inside the transaction, and **the engine backs up rather than
the migration failing** — which would present as the collector being slow rather than as the
migration doing anything. That is the quiet failure mode to watch for if this is ever run at a
larger size.

**The quiet failure mode, in one line:** if the apply ever grows, **the engine backs up rather
than the migration failing — and that looks like the collector being slow rather than like the
migration doing anything.** Nobody would attribute it to this.

## One decision to overrule here rather than in code

**The staleness digest covers the mapping's inputs — `dedupeKey` and `occurrenceCount` — and
deliberately excludes `resolvedAt`.**

A row resolved since the mapping was saved still maps to the same incident, so refusing it
would abort a correct migration on ordinary churn. Under all-or-nothing that is not one refused
row; **it is the whole migration never completing** while alerts keep resolving underneath it.

QA's contract says the digest covers *the mutable fields*, which would include `resolvedAt`.
**I have implemented the narrower version and am flagging it rather than quietly choosing.**
The two concerns are separate: the delivery guarantee is about what the migration *writes*; the
digest is about whether the mapping is still *true*. If you want the wider version it is a
one-line change to `digestOf`.

## Before you trust this

**What is tested:** the pure functions — validate, apply, revert, the receipt, the abort report
— against fixtures, with **twelve deliberate defects injected and every one caught**, including
both indirect-delivery routes, every abort condition dropped one at a time, a receipt missing
its digest, and a revert turned into a blanket update. One mutation survives and is
**predeclared as equivalent**: hardcoding the receipt's `previous` to null is indistinguishable
on every reachable input, because only a null-keyed row is ever written. That is the weakness
QA identified in A2, demonstrated rather than asserted.

**What is not tested, and this is the gap that matters:**

- **The commands in this document have never been run.** No `psql`, no Docker, no
  `DATABASE_URL` in the engineering worktree.
- **The runner script does not exist yet.** The pure logic it will call does.
- **Atomicity, a crash mid-write, and concurrent writers between the check and the write are
  unpinnable in memory.** A single-threaded fixture demonstrates the *shape* of optimistic
  concurrency, not that Postgres enforces it.

**What would close it:** run steps 1–4 and the revert end to end against the disposable
Postgres, with a second connection writing to a row between preflight and apply to prove the
in-transaction re-check refuses it. Until somebody has done that, this runbook is a design
that has been reasoned about carefully — **not a procedure that has been performed.**
