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
exactly what it wrote.** Never a blanket update.

```
Checked 364 rows against the receipt: no differences.
Reverted 364 rows in one transaction.
Watched fields disturbed: none.
REVERT COMPLETE.
```

**If a row has moved since:**

```
ABORTED - 1 difference(s). Nothing was written.
1 already carries a different incident key:
  9f2c...  holds somebody-elses-later-key/1  mapping says hawkview.../1
REVERT ABORTED - nothing was written.
```

### The design question, and my recommendation

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
