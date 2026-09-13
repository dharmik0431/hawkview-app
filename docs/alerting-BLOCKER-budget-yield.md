# BLOCKER — the budget yield strands an alert permanently, and silently

**Found at `0a62f8d`. Reproducible from a clean checkout in about five minutes.** The record of
how it was found is here because the fix will make the symptom disappear and the shape will not.

## What it is

`runIntake` does three things in order: write incidents, check the clock, write jobs.
`finding-pipeline.ts:341`, `:344`, `:351`. The check between them is commented as **"the safe
direction"** — a yield there leaves incidents recorded and no job.

**That state is unrecoverable.** `decide()` at line 234 then skips the finding as
`INCIDENT_ALREADY_OPEN` on every subsequent run, so the job is never written. The email is never
sent, and **nothing reports it**: `neverSent()` enumerates jobs that exist, and this incident has
none.

**It is not a crash path.** It is the designed cascade behaviour — intake yielding rather than
borrowing from the collectors' budget — so it fires whenever intake runs out of budget after
writing incidents, which is when the system is busiest.

## Reproducing it

```bash
# a disposable cluster, UTC, and the schema from the commit
createdb -h 127.0.0.1 -p 55432 -U postgres hvflow
cd backend && DATABASE_URL=postgresql://postgres@127.0.0.1:55432/hvflow npx prisma migrate deploy
```

Then seed an organization, a customer tenant, a user with `email_enabled`, an evaluation run, a
matched result, and one `OPEN` finding with a mappable rule id (`HV-ID-AUTH-001.v1`) observed
after the watermark. **The integration suite does not do this for you — see the clean-database
finding.**

Drive `runIntake` with a clock that expires **only after the incident write**. The important part
is that the clock must not expire earlier; a stub keyed on call count yields before anything is
read and produces the harmless case:

```ts
let incidentsCommitted = false            // set inside the store's writeIncidents
const clock = () => (incidentsCommitted ? deadline + 1 : Date.now())
await runIntake(store, watermark, T0, deadline, readSince, clock)
```

## Measured

```
first run  : yieldedOnBudget=true   incidentsWritten=1   jobsWritten=0
recovery   : jobsWritten=0          skipped=[INCIDENT_ALREADY_OPEN]
database   : 1 incident, 0 jobs — permanently
```

The recovery run is a healthy store with the same findings and no budget pressure. It still
produces nothing.

## Why the obvious fix is wrong

**I proposed treating "incident open with no job" as a case to act on. That is wrong and it would
send the entire backlog.** PM caught it and the reasoning is theirs; I verified it against
`decide()` at 210-255 and it is exact.

**Four paths produce incident-with-no-job, and the incident is written before any of the three
checks that skip:**

| path | incident | job | must it ever send? |
|---|---|---|---|
| `BEFORE_WATERMARK` | written | withheld | **never** — this is the whole point of the watermark |
| `RECORD_ONLY` | written | withheld | **never** — the MSP said so |
| `NO_ELIGIBLE_RECIPIENT` | written | withheld | never, until somebody can receive it |
| **the budget yield** | written | **owed** | **yes** |

A recovery keyed on the shape cannot tell them apart, so the first run after such a fix would
deliver every backfilled incident the watermark deliberately silenced. **The cheapest fix
rebuilds the worst bug in the feature.**

## The ruling, and what it also fixes

**A yield may give up work; it may never leave work half-done.** Decide everything, then write
incidents and jobs in one transaction, with the budget check before the write phase rather than
inside it. A yield then leaves the finding untouched and still `OPEN`, and the next run redoes it
from the top — a path already proven to work, rather than a new recovery path reconstructing
intent it never recorded.

**And it covers the case neither of us raised first: a process crash between the two writes
strands an alert identically**, and no recovery logic inside `runIntake` can catch that, because
the process is gone. One transaction covers both.

**So the seam changes.** My reading that `PipelineStore` cannot express the fix was right; the
conclusion is that `writeIncidents` and `writeJobs` become one atomic call or the store gains a
transaction handle — not that the recovery moves.

## The green test does not cover it

`INTAKE YIELDS RATHER THAN BORROWING FROM THE COLLECTORS` asserts `findingsRead: 0` and
`incidents: 0`. **It exercises the yield that happens before anything is read** — the harmless
instance of the same branch. The dangerous yield is the one the comment reasons hardest about,
and no test goes near it.

That is the general shape worth keeping: **a green test proves the path it took**, and here the
path it took was the safe instance of the branch that contains the defect.

## The accounting invariant, checked in both directions

The module states that every finding appears exactly once across the jobs and the skips.
Asserting that on mapped input only proves it holds where nothing is unusual, so it was checked
against the negative control the database makes possible — **a real rule id the pipeline
deliberately does not map**. `HV-ID-MBX-001.v1` and `HV-ID-APP-001.v1` satisfy
`identity_risk_finding_rule_check` and have no entry in `RULE_PREFIX_TO_TYPE`.

Three findings in — one mappable `AUTH`, one `MBX`, one `APP`:

```
findingsIn 3, jobs 1, skipped 2, sum 3
everyFindingAccountedForExactlyOnce: true
each named: dddddddd NO_ALERT_TYPE, eeeeeeee NO_ALERT_TYPE
unmappedRules: ["HV-ID-APP-001.v1", "HV-ID-MBX-001.v1"]
accountingProblems: []
```

**And it fires.** Removing the `NO_ALERT_TYPE` skip from `decide()` produced:

> `3 findings in, 1 accounted for (1 produced a job, 0 named as skipped) — a finding must appear
> exactly once, or one vanished without anybody being able to say why.`

Quiet on clean input, loud on a vanished finding. The file was restored; `git diff` empty.

**What the invariant does not do**, stated because it reads stronger than it is: it is a
self-reconciliation over one pass. It proves nothing vanished. **It cannot prove anything was
classified correctly** — a finding wrongly skipped as `RECORD_ONLY` still counts exactly once,
and the books still balance. It is a tripwire against a future edit that adds a `continue`
without a skip, which is worth having and is not the same as a correctness check.

## Corrections to my own earlier reports, in this record because they were wrong in it

- I said `unmappedRules` might be unreachable. It is reachable. My negative control used
  `HV-XX-UNKNOWN-9.v1`, which the database refuses — **a search over invented ids, which is the
  leak-encoding mistake in a new place.** The real unmapped ids are `MBX` and `APP`, permitted by
  the constraint and unmapped by the pipeline.
- I reported three bare catch-alls in `wrapped-risk-key-store.ts`. There are four — 124, 138, 143
  and 174. My count came from my own diagnostic patch, which matched `} catch {` and missed the
  one beginning `catch {` on its own line. **The number came from my instrument rather than from
  the file**, which is the same mistake in miniature as the thing being reported.
