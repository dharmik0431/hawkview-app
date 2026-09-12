# Step 03 apply — runbook

**Operator: Dharmik. Nothing here runs automatically and nothing runs from an agent session.**

> **THIS MIGRATION KEYS ABOUT 44 ROWS, NOT 364. If you were told 364, that was us.**
>
> **What changed:** the previously stated figures — 364 / 71 / 62 / 9 / 47 — answer *how many
> incidents are in this data*, computed under the nominated type. They are correct for that
> question. **They are not the answer to the question an operator is asking, which is how many
> rows this run is authorised to key today.** Two questions that were never the same number,
> read as one, in every status report given on this migration.
>
> **Why 44.** `TYPE_FOR_SHAPE` maps `DIRECTORY_AUDIT` to `null` on purpose: the key shape does
> not determine the alert type, and defaulting it would file real privileged changes as
> routine. Those 319 rows reach the mapping as EXCLUDED, and the apply writes only what the
> mapping authorises. **That is the ruling, not a limitation** — see the section below. Three
> more are unkeyable by construction and will never be writable.
>
> **Beware two different 47s.** Until this correction the writable count and the count of
> incidents with unrecoverable episodes were both 47, by coincidence, and appeared in adjacent
> sentences. The writable count is now 44; the episode figure is still 47 and is unrelated.
>
> **Read the split, not the total.** `save-mapping` now prints three groups under three
> headings, each labelled by the question it answers. If any one of them is read as the
> answer to another, that is this same mistake happening again.
>
> **What has been run, and by whom.** QA has run all five commands end to end against a
> disposable Postgres — once before the migration existed, and again on the migrated schema,
> including the concurrent-writer rollback. The migration itself has been applied to a
> throwaway PostgreSQL 15 from four starting states (see step 0). **Nothing has been run
> against production, and nothing has been run from an engineering worktree with real data.**
> Details under *Before you trust this*.

## What this run is for — a rehearsal, not the fix

**Approved by Dharmik at this scope, on this basis, and the basis is the part to keep.**

**The 44 rows are monitoring rows. The 301 unclosable alerts — the thing that prompted all of
this — are all in the other 319.** Keying 44 rows changes almost nothing an MSP would notice.

So this is a **proving run**: the apply, the receipt, the revert and the verification exercised
against real production data at low stakes, before the same machinery touches rows that include
real privileged changes. He asked *what is this number for* before approving it, and chose it
as a rehearsal rather than as a result.

**Do not let 44 be read as the benefit.** If somebody later reports this migration as having
fixed the alerting problem, it did not: it proved the mechanism that will. The fix is the 319,
and it needs the classifier pointed at historical audit rows first.

## The figures, and when they were true

Measured against production on **2026-09-12**:

```
366 rows total
319 awaiting the classifier
  3 initial-sync    NEVER writable - no segment could carry a resource type
 17 recovery        writable under the ruling below, where what they recover names one
 44 writable today
  5 tenants touched
```

**Three exclusion facts, and they stay three.** Awaiting-classification, permanently-unwritable-
by-shape and refused-because-moved are different things: the first clears when the classifier
reaches historical audit rows, the second never clears, and the third is not an exclusion at all
but an abort. One "left alone" number tells an operator to wait for something that is not coming.

### The recovery ruling — subject from what it recovers, type stays its own

**A recovery row takes its subject from the key it recovers, and keeps `monitoring.recovered` as
its type.** The distinction is the whole ruling: **the recovery-first rule is about the TYPE, and
this is about the SUBJECT.**

`parseDedupeKey` still classifies `tenant:t1:sync:SIGN_INS:recovered:8` as a RECOVERY, and must —
checking recovery first is what stops every recovery being classified as whatever it recovered,
and the count of recoveries is exactly what this step needs to see. Reading `SIGN_INS` out of the
recovered key **for the subject** reclassifies nothing.

**It does not merge a recovery into what it recovered.** An incident key carries the type id and
the two types differ, so a recovery becomes **its own record-tier incident** — which is what the
tiering already says it is: a searchable record of the recovery, not a second alert. The
alternative was 17 rows sitting outside the scheme permanently.

> **THE RULING DOES NOT REACH EVERY RECOVERY, AND NOBODY HAS COUNTED WHICH.** A recovery of a
> CONNECTION or a DIRECTORY_AUDIT alert still names no resource type, because **what it recovers
> does not have one either.** Only recoveries of sync alerts resolve.
>
> So "17 become writable" is a claim about which alerts those 17 recover, not about the ruling.
> **If any of them recover a connection or an audit row, they stay permanently unwritable and 44
> is too high.** The runner reports them under `NEVER writable` when that happens, so step 1
> measures it — but the figure above should be treated as an upper bound until it does.
>
> **The line is a working instrument, demonstrated:** rewriting five recoveries to recover a
> connection alert gave 38 writable and 9 never, so a shortfall lands exactly where the runner
> says it will. What that cannot establish is what production’s 17 actually recover.

### Where the recovery finding came from, and who has checked it

**This is recorded precisely because 44 depends on it.** The recovery shape was found by the
engineer, while writing the migration; it was then counted against production by the PM, which
is where 17 comes from; and the ruling that a recovery takes its subject from what it recovers
is the PM’s.

**Nobody has independently verified it.** It was briefly attributed to QA, which would have
meant an independent check existed — QA corrected that rather than accepting the credit, and
their reason is the one worth keeping: **a finding recorded against the party who would have
checked it is a finding nobody checked.**

So the chain behind 44 is: one party found it, one party measured it, and the reasoning has had
no second pair of eyes. The tests pin the behaviour; they cannot supply the review.

### The hop limit reports UNKNOWN, not NEVER

`resourceTypeFor` follows a recovery to what it recovers for at most eight parses. Exhausting
them is reported as **`RECOVERY_CHAIN_TOO_DEEP` — unknown** — and not as "never writable",
because for a deeper chain that label would be wrong in a specific way: **the key may well name
a subject; the walker stopped before reaching it.**

**It cannot happen today.** Recovery keys are built in one place and every caller passes a
freshly-built non-recovery key, so the maximum depth in production is 1 against a limit of 8.
The limit exists so that a future change to how recovery keys are composed cannot turn a key
parser into a hang — a failure nobody would attribute to a key parser. The walk cannot loop
either way: each hop strips a suffix, so the key strictly shortens.

**366, not the 364 quoted everywhere else in this document — two rows arrived during the
conversation in which the figure was being discussed.** That is the photograph problem, not as
a hypothetical but as an observation: a mapping is a picture of a table that is still moving,
and the gap between measuring and writing is where a correct migration goes wrong.

**So do not treat any number here as an expected value.** Two of them changed while a sentence
was being written. What holds regardless is the identity: **writable + left-alone = rows read**,
and `save-mapping` prints all three so it can be checked at the moment it matters. The only
reason to compare against the figures above is to notice a change big enough to ask about.

## What the apply is allowed to key — ruled: (b), the typed rows only

**44 rows now, 319 when the classifier reaches historical audit rows, and 3 never.** The
migration lands in two parts and the second is not blocked forever: the classifier exists, it
is simply not wired to those rows yet, which is scoped work rather than an open question. The
three are not part of either wave.

**(a) — keying everything under the nominated type — is off the table, and not because it is
riskier.** It contradicts a decision already made. It assumes a single type for rows whose type
is undetermined, which is exactly what `reconcile` refuses to do, in a comment saying that
defaulting would file real privileged changes as routine. A classifier was built precisely so
those rows are not routine by default. **Migrating them as routine would be the original defect
re-entering through the migration built to clear it.**

**The smaller first part is an advantage rather than a consolation.** It proves the apply, the
receipt and the revert against 44 real rows before 319 depend on them.

## Unwritable is not refused, and the run depends on the difference

With 44 writable rows among 366 present, **322 rows are expected to be unwritable.** If those
read as refusals the preflight aborts every time by design and the apply can never run.

**That is not hypothetical — it was the state of the code when the ruling arrived.** The
mapping was a list of writes, so the scope of the run was *inferred* as "everything in the
table", and every row deliberately left out arrived at the final check as `ROW_UNEXPECTED`. On
production: 322 differences, on a clean table, every time.

**The fix is that the mapping states its scope instead of the table implying it.** A mapping is
now a decision about every row it saw — `WRITE` or `EXCLUDE`, one per row, in one list so there
is no pair of fields that can disagree. Then:

| what | how it reads |
|---|---|
| a row the mapping excluded | **a decision.** Counted, reasoned, never a difference |
| a row that moved since the mapping | `ROW_CHANGED` — aborts |
| a row the mapping never saw | `ROW_UNEXPECTED` — aborts, unchanged |
| a row we excluded that is keyed anyway | `EXCLUDED_BUT_KEYED` — aborts |
| a row decided about twice | `MAPPED_TWICE` — aborts |

**The original property is intact.** An alert that arrived after the mapping was saved was
never measured, no digest speaks for it, and it still stops the run. What changed is that the
thing it is measured against is now stated rather than inferred.

The last two are new. An exclusion is a decision about what **we** write and never a promise
about what the row holds, so a row we said to leave alone that is carrying an incident key is
the two-keying-schemes state arriving through the rows nobody was watching.

**The two exclusion reasons are carried separately** because they clear at different times:
`TYPE_UNDETERMINED` waits on the classifier, which is scoped work; `SUBJECT_UNRESOLVED` waits
on the row’s own subject becoming resolvable, which may never happen. One count would make the
second look like it is coming soon.

> **A NOTE ON EVERY 364 BELOW THIS LINE.** They are ROW counts — rows in the table when the
> figure was taken, rows QA ran the emitted SQL against, rows the timing was measured at.
> **None of them is a write count**, and the live row count is now 366. The write count is
> about 44 and appears only where it is labelled as one.

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

## Connecting — and this has its own section because it is a defect, not an omission

**Nobody has connected to production from an engineering machine.** Two connection strings were
reconstructed by hand during the attempt and one of them was wrong. **A credential was pasted
into a chat message in the process and is being rotated.**

**Copy the connection string from the Supabase dashboard, verbatim.** Do not assemble it from a
host, a password and a port — it was assembled twice and was wrong once, and a wrong one fails
as a DNS or auth error that reads like a network problem rather than like a typo.

**Put it in the environment, never in a message.** No connection string belongs in this
document, in a commit, or in a chat window — including a redacted-looking one.

**Use the session-mode pooler on port 5432** — `aws-0-<region>.pooler.supabase.com`.

**The direct host will not resolve for you.** `db.<ref>.supabase.co` is **IPv6-only**, and most
home and office connections have no IPv6 route to it. That is the failure Dharmik hit. The
pooler is reachable over IPv4.

### Why session mode — and the usual reason given for it is wrong

**Transaction mode on 6543 would not "break the single transaction".** It pools *by*
transaction: a `BEGIN … COMMIT` is exactly the unit it keeps on one server connection, and this
apply is one statement inside one transaction, which is the most pooler-friendly shape there is.

The reason is worth correcting rather than letting stand, because a rule with the wrong
justification attached gets applied where it does not hold and dropped where it does.

**The real hazards in transaction mode are session-level:** named prepared statements, `SET`,
advisory locks, `LISTEN`. The familiar Prisma symptom — *prepared statement "s0" already exists*
— comes from the first. **This runner is less exposed to that than a Prisma application usually
is**, because it goes through the `@prisma/adapter-pg` driver adapter and `pg` sends unnamed
statements unless you name them. That is a reason transaction mode would probably work; it is
not a reason to choose it.

**Session mode is right for a reason that does not depend on any of the above.** This is a
one-shot script. It gains nothing from pooling and it loses the guarantee that the connection it
begins on is the connection it ends on. For a process that writes to production once, fewer
moving parts between it and the database is the entire argument.

**None of this has been tested from anywhere.** No connection has been made. Treat the port and
the mode as the recommendation with the fewest unknowns, not as a verified configuration — and
if it fails, that is a finding for this section rather than a mystery.

**The first real test of the connection is step 1, and step 1 is read-only.** There is no need
to prove the connection some other way first.

## Step 0 — apply the migration that creates the columns

**This step did not exist, and without it the runbook cannot be followed to the end.**
`incident_key` and `episode` were referred to by the runner, by `apply-mapping.ts` and
throughout this document, and were **in no migration and not in `schema.prisma`**.

**The failure was delayed and pointed at the wrong thing.** `save-mapping` reads through Prisma
and never selects either column, so step 1 **succeeds** and writes a mapping file, and step 2
dies with `column "incident_key" does not exist`. An operator would get a clean-looking artefact
and then a schema error, in that order, and would reasonably suspect the runner.

```powershell
npx prisma migrate deploy
```

`20260912120000_notification_incident_key` adds two nullable columns and one index. **It reads
no row, writes no row and deletes nothing** — every existing row gets NULL in both, which is
exactly the state the apply expects to find and exactly the state a revert returns them to.

**Running it twice is safe from any starting state, and this was measured rather than argued.**
Against a throwaway PostgreSQL 15:

| starting state | result |
|---|---|
| clean | applies; both columns and the index present |
| already fully applied | exit 0, three `NOTICE ... skipping` lines, nothing changed |
| **columns created by hand, migration never recorded** | exit 0, converges, index created |
| `incident_key` created by hand as `text` | **refused**, named, and **nothing added** |

**The third row is the one that mattered.** With bare `ADD COLUMN` it raised `42701`, and Prisma
then records a FAILED migration that blocks every later migration with `P3009` until somebody
runs `prisma migrate resolve` by hand. **That is a wedged database produced by running a
migration twice** — and it was reachable, because the workaround DDL in the first-run record
creates exactly those columns by hand.

**The fourth row is what `IF NOT EXISTS` costs and why it is not the whole fix.** It matches on
NAME alone, so a hand-made column of the wrong type would be silently adopted and the database
would disagree with `schema.prisma` with nothing saying so — the apply would then write incident
keys into a column that truncates them. The migration checks the type first and stops before any
DDL runs, which is why the failing case leaves nothing behind.

**Confirm it landed before going on:**

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'notifications' AND column_name IN ('incident_key', 'episode');
```

Two rows, both `YES` for nullable. If you get none, step 2 is the one that will tell you, and
it will look like a runner problem.

**Both columns are in `schema.prisma` as well as in the migration, and that was a ruling.** A
column absent from the schema is invisible to every consumer except a raw query — so routing,
and anything that reads incidents, could not see the key at all, which defeats the purpose of
many rows sharing one.

## Step 1 — save the approved mapping

**Start by confirming where you are.** This step used to open with an absolute path into one
agent’s worktree — `...\hawkview-api-rate-limiting\backend` — which is not necessarily the
checkout you want to migrate from, and a wrong one here is silent: the script would read the
same production database from the wrong branch’s code.

```powershell
git rev-parse --show-toplevel   # which checkout
git branch --show-current       # which branch
git log --oneline -1            # which commit
cd backend
npx tsc --noEmit -p tsconfig.scripts.json   # the scripts typecheck; see the note below
node --import tsx scripts/alerting-apply.mts save-mapping --out ..\artefacts\mapping.json
```

The typecheck line is there because **`tsconfig.json` covers the `src` tree only, so
`npx tsc --noEmit` never read either script and exited 0.** That false green hid a real one:
the dry-run
script called `new PrismaClient()` with no arguments, which **Prisma 7 cannot construct** — so
its database path had never executed, and any figure attributed to it came from somewhere else.
`tsconfig.scripts.json` closes the class; both scripts now take a `PrismaPg` adapter.

**Expected output — success:**

*Figures below are the 2026-09-12 measurement, shown so the shape of the output is readable.
They will have drifted — see* The figures, and when they were true.

```
Read 366 notification rows.

  HOW MANY ROWS THIS RUN WOULD KEY
    44 writable, across M incidents
    U of those carry no episode number (unrecoverable)

  HOW MANY IT WOULD LEAVE ALONE, AND WHY - decisions, not refusals
    319 waiting on the classifier (the key shape does not type)
    3 NEVER writable - the key cannot name what its subject reads
    0 typed, but this row’s subject did not resolve

  HOW MANY INCIDENTS ARE IN THE DATA - a different question, under the nominated type
    71 incidents, 71 episodes (62 attributed, 9 standing alone)
    47 incidents whose episode count cannot be recovered

Wrote ..\artefacts\mapping.json
```

**Three groups, three questions, and they are not interchangeable.** The grouping is the
headline rather than a detail because reading one group as the answer to another is the
mistake that put 71 into every status report as though it were a write count.

**What to check, per group.**

1. **Rows this run would key.** About 44 on 2026-09-12. **If it comes back near the total,
   something changed in `TYPE_FOR_SHAPE`** and that is a bigger conversation than this runbook.
2. **Rows left alone.** About 319 waiting, 3 never. **The middle line is the one to read.** It
   counts rows no classifier will ever reach, and **if it is larger than 3, recoveries have
   landed in it** — meaning some of the 17 recover something that names no resource type, and
   the writable count is correspondingly lower than 44. That is the measurement the ruling
   above is waiting on. A non-zero third line is a different finding: rows whose subject is
   resolvable in principle and absent in fact.
3. **Incidents in the data.** This is where 71 / 62 / 9 / 47 belong. A change here is not a
   reason to stop by itself — rows keep arriving — but a change **larger than the row count
   moved** is, because then something other than new data has changed.

**Groups 1 and 2 must sum to the rows read.** That identity is the check; the individual
figures are a photograph. Group 3 does not participate in the sum and is not supposed to.

## Step 2 — preflight (writes nothing, ever)

```powershell
node --import tsx scripts/alerting-apply.mts preflight --mapping ..\artefacts\mapping.json --out ..\artefacts\preflight.txt
```

**Expected output — clear to proceed:**

```
No differences. The mapping still describes the data.
44 rows would be written. 0 already carry it and would not be written again.
3 NEVER writable - the key cannot name what its subject reads
319 waiting on the classifier - the key shape does not type
PREFLIGHT PASSED - safe to apply.
```

**Those middle lines are the ones to read twice.** A large number there is the design working;
the same number appearing as differences above it would be the run aborting. See *Unwritable is
not refused*.

**They are printed broken down rather than summed, and that is a fix rather than a flourish.**
Step 1 prints three headings and this step used to print their total — so the distinction it
preserved was decision-versus-refusal, and the one it lost was **waiting-versus-never**, at the
step an operator reads immediately before authorising a write. The consequence is delayed and
specific: **when the classifier lands, somebody who remembers 322 will expect 0 and get 3.**

The write count must equal the writable count from step 1. A second number here means the
mapping file and the database have diverged, which is what the preflight exists to catch.

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
Applied 44 rows in one statement, in one transaction.
Left alone by decision, not by refusal - these were never candidates:
  3 NEVER writable - the key cannot name what its subject reads
  319 waiting on the classifier - the key shape does not type
Watched fields disturbed: none
Wrote ..\artefacts\receipt.json - 44 changes, 0 untouched. THE REVERT NEEDS THIS FILE.
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
[ok] 44 of 44 receipt rows carry the key the receipt records
[ok] M distinct incident keys across 44 keyed rows
[  ] X keyed rows carry an episode number, Y carry null - compare both against the
     save-mapping figures rather than reading either as a pass
[ok] no incident key is shared across two organisations (0 are)
[  ] Z receipt rows now have a different dedupeKey or occurrenceCount than when they were
     written - expected to be non-zero on a live system, and not a failure
[ok] 0 rows carry an incident key this run did not write
VERIFY PASSED.
```

Any `[--]` line is a failure. **`[  ]` is not a check and does not become one by being read**
— those two lines report figures that have no correct value the runner can know, and dressing
either as a pass is the mistake the whole document is built against. The episode split has to
be compared by a person against step 1; `Z` is expected to be non-zero, because occurrences
keep arriving after an apply, and it is printed only to explain why the revert does not check
that field.

**Of the real checks, the last matters most:** it catches a second migration having run.

Note what is NOT in this list: a line asserting `occurrenceCount`, `resolvedAt` and
`lastOccurredAt` are unchanged. An earlier draft of this runbook printed one, and it could
not have been true — occurrences move on a live system between apply and verify. The delivery
guarantee is not that those fields never move; it is that **this migration never writes them**,
which is established by there being no assignment to them anywhere in `apply-mapping.ts`, and
by `Watched fields disturbed` in step 3 measuring the window when the apply itself ran.

## Revert

```powershell
node --import tsx scripts/alerting-apply.mts revert --receipt ..\artefacts\receipt.json
```

**It reads the receipt and touches only the rows that run changed, only where they still hold
exactly what it wrote.** Never a blanket update, and it writes its own receipt.

**Expected output — complete revert:**

```
Checked 44 rows from receipt 4f1c8e2a-....
Reverted 44. Refused 0.
Watched fields disturbed: none
Wrote ..\artefacts\revert-receipt.json
REVERT COMPLETE - 44 put back, 0 left alone, 44 of 44 accounted for.
```

**Expected output — partial revert. THIS IS A SUCCESS, NOT A FAILURE:**

```
Checked 44 rows from receipt 4f1c8e2a-....
Reverted 43. Refused 1.

ABORTED - 1 difference(s). Nothing was written.

1 already carries a different incident key:
  9f2c...  holds somebody-elses-later-key/1  mapping says hawkview.../1

A refused row is not half-done work: somebody changed it after the apply, so it is no
longer this run's to undo. Leaving it alone is the answer, not a partial one.
Watched fields disturbed: none
Wrote ..\artefacts\revert-receipt.json
REVERT COMPLETE - 43 put back, 1 left alone, 44 of 44 accounted for.
```

**The `ABORTED - ... Nothing was written` line inside a successful revert is a wart.** The
refusal report is shared with the preflight, where nothing IS written, and it says so in its
first line. Here it is describing the rows the revert declined while the others were put back.
Left as-is rather than papered over with a second formatter, and named here so nobody reads it
as the revert having failed.

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

**Stated positively, because it is a decision and not an omission: a row that was resolved
between the mapping and the apply is NOT refused.** It is keyed, with the incident key it was
mapped to. That is narrower than "the row is the row that was mapped", and deliberately so —
the mapping does not depend on whether a row is resolved, so a change there does not make the
mapping untrue. If you want resolution to block a row, that is a different requirement from
staleness and it needs its own predicate.

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

- **Nothing here has touched production.** No `DATABASE_URL` for it exists in any engineering
  worktree, and no connection to it has been made from one.
- **The five commands HAVE been run, by QA, against a disposable Postgres** — twice, the second
  time on the migrated schema, including the concurrent-writer rollback. This line previously
  said they never had; that was wrong, and it was wrong in the flattering direction for a
  document whose job is to under-claim.
- **The migration HAS been applied, to a throwaway PostgreSQL 15**, from four starting states,
  by the engineer. See the table in step 0. It has not been applied to any database holding
  real data.
- **The runner has never been run by the engineer who wrote it.** Everything the engineer knows
  about its behaviour comes from QA running it or from the pure functions it calls.
- **44 has one source.** The recovery finding behind it has not been independently reviewed by
  anyone — see *Where the recovery finding came from*.
- **The number of rows the apply would write is unmeasured.** See the open decision at the top.
  Every "364" in this document below that point is a row count, not a write count.
- **Neither script had ever been typechecked** until `tsconfig.scripts.json` existed, and the
  first run of it found that the dry run could not construct its database client at all. Assume
  the same class of defect anywhere else a script is only exercised by being read.
- **Atomicity, a crash mid-write, and concurrent writers between the check and the write are
  unpinnable in memory.** A single-threaded fixture demonstrates the *shape* of optimistic
  concurrency, not that Postgres enforces it.

**What would close it:** run steps 1–4 and the revert end to end against the disposable
Postgres, with a second connection writing to a row between preflight and apply to prove the
in-transaction re-check refuses it. Until somebody has done that, this runbook is a design
that has been reasoned about carefully — **not a procedure that has been performed.**
