# Alerting, step 03: reconciling the existing 364

Steps 01 and 02 are in `alerting-lifecycle.md` and `alerting-deduplication.md`. The dry
run writes nothing, no historical alert may be delivered during migration, and
consolidating must preserve the underlying events — the 301 are real, they are simply not
301 problems.

**Status: the input audit is done and it changes the shape of this step.** The dry-run
report itself is not written, and the boundary on that is at the bottom.

## The input audit, and it found more than one trap

The standing question — *for every input the dry run reads, what computes it in
production, and is anything supplied only from a test?* — was pointed at
`windowReadableThroughout` because QA named it. Asked of **every** field of
`ClearingObservation`, the answer is the same for all five:

| field | produced by | cheapest wrong value | fails |
|---|---|---|---|
| `windowReadableThroughout` | nothing | `true` | **open** — clears on unobserved silence |
| `eventsInWindow` | nothing | `0` | **open** — a mis-scoped query returns 0 and the alert clears |
| `connectionVerified` | nothing | `true` | **open** |
| `configurationRestored` | nothing | `true` | **open** |
| `sources` | nothing | `[]` | **closed** — see below |

So the clearing rule is not "wired except for one flag". **It is entirely unwired**, and
producing all five is part of this step. `windowReadableThroughout` is the one worth naming
first because its cheap wrong answer is the quietest, but four of the five fail open.

**`sources` is the exception and the reason is instructive.** An empty source list makes
`everyCoveredSourceReadable` return false, because that function requires at least one
covered source before it will claim anything — a guard added in step 01 for a different
reason entirely (a tenant whose every source is unlicensed would otherwise satisfy "every
covered source is readable" while HawkView could see nothing). That guard now also makes
the degenerate input fail closed. It is the only field where the cheap wrong answer is the
safe one, and it is the only field where somebody deliberately decided what the degenerate
input should mean.

**That is the pattern for the other four:** decide what the absent or degenerate input
means *before* writing the producer, and make it the refusing answer.

## `windowReadableThroughout` is not derivable from what HawkView stores

Checked rather than assumed, and the answer is no — from either candidate.

**`SyncState` is current state, not history.** One row per `(customerTenantId,
resourceType)`, carrying `status`, `lastAttemptAt`, `lastSuccessfulAt` and
`consecutiveFailures`. A failure inside the window followed by a recovery leaves **no
trace**: the counter resets on success and both timestamps only ever hold the latest value.
Continuity across a window is not recoverable from it at any cadence, by any query.

**`TenantHealthSnapshot` does keep history, and it is worse for this purpose.** Its
producer is `tenants.service.ts` inside `listForIdentity` — the tenant-**list request
path** — and it skips the write when status and freshness signature are unchanged and under
fifteen minutes old. Its own comment says *"without producing a row on every tenant-list
poll"*. So row density is a function of **who opened the tenants page**, not of whether
collection worked, and a tenant nobody looked at for a week has no rows for that week.

That fails in the unsafe direction. Deriving coverage from "no failure rows in the window"
would mark an unvisited tenant as readable throughout — a collector could be dead for a
month and the window would read as covered, which is the exact sentence this flag exists to
prevent.

**The real repair is a collection-attempt history**, which is a schema decision rather than
an engineering one and is not taken here.

### The consequence is narrower than it sounds

Today the only constructible evidence is "no history", so the flag is false and a
`NO_FURTHER_EVENTS_IN_READABLE_WINDOW` condition never auto-clears. **Exactly one declared
type resolves that way** — `security.suspected_credential_attack` — and its investigation
is `ONLY_BY_A_PERSON` regardless. So what is lost is the *condition* axis moving to cleared,
not an incident sitting in somebody's queue. Safe, and visible.

## The producer: there is no boolean to pass

`backend/src/alerts/window-coverage.ts`. QA's warning was that the cheapest way to make an
alert clear is to pass `true`, and every test would still pass because the tests inject it
too. **So the boolean is not an input.** `windowReadableThroughout` takes evidence:

- `ATTEMPT_HISTORY` — per-attempt records, the only variant that can yield `true`
- `NO_HISTORY_AVAILABLE` — carries a *reason*, never a claim

There is deliberately no variant meaning "trust me". A caller without history cannot assert
coverage, not because a rule forbids it but because the type has nowhere to put the
assertion. Eight mutations, and the one that matters — turning the no-history case into
`true` — is killed by name.

The walk requires coverage across the whole window including both edges: a window whose
first success lands halfway through was unobserved for the first half, and one whose
coverage stops early is the collector dying just before the alert would have cleared. A
failed attempt does not cover anything; a failure that recovers inside the tolerance does
not spoil the window, because the question is whether an uncovered *stretch* exists rather
than whether anything ever failed.

`maxGapMs` is a parameter. The tolerance follows from collection cadence — the incremental
pass is roughly five minutes — and the number is a product decision rather than this
function's to choose.

### One correction, found by mutation and settled by search

A mutation removing the out-of-window filter **survived**. Rather than reason about whether
it mattered, I searched: 400,000 random attempt sets plus every triple drawn from the
boundary offsets. The answer never differs. **The filter is a bound on work, not a
correctness guard** — the walk already requires coverage across the window, so an earlier
success only makes the next gap check stricter and a later one only extends past an edge the
final check had cleared.

My test had claimed the filter was what protected us. It is now labelled for what it is, and
the property it was pointing at — a distant success cannot substitute for coverage inside
the window — is pinned against the walk instead, with the straddling case that makes it
concrete.

Third time in this work that a surviving mutation's real finding was that the *prose*
overclaimed while the code was right.

## What is not done, and why

**The generator is built and runnable; I cannot run it.** Reading the 364 live alerts needs
production access this work does not have — the same constraint that meant the episode-interval measurement came
from PM rather than from me. What can be built here is the report *generator* and its
producers, tested against fixtures; producing the actual numbers needs someone with access.

**Flagged rather than decided, per the brief:** the 301 directory-change alerts consolidate
under the incident key, which groups by the subject role the type declares — **actor** for
directory changes. Grouping by actor and grouping by target produce materially different
counts from the same events, and the shape of that answer is the thing to react to. Both
counts should appear in the dry run; `incidentGrouping` takes the declaration, so producing
the target-keyed count as a comparison means constructing a second declaration with
`subject: 'TARGET'` rather than changing anything — cheap, and worth having.

## The dry run: what exists, and how to run it

`backend/src/alerts/reconciliation.ts` is the generator — a **pure function from rows to a
report**, with no client, clock or environment. `backend/scripts/alerting-reconciliation-dry-run.mts`
is the runner: two `findMany` calls and a print.

```bash
npx tsx scripts/alerting-reconciliation-dry-run.mts
```

**It writes nothing.** No `create`, `update`, `upsert`, `delete` or raw execute appears on
any code line — verified by grep over non-comment lines, after a first attempt matched only
the comment that *claimed* the property. The mapping it prints is a proposal; applying it is
a separate step and reversible, because every entry carries its original notification id.

### The six key shapes, taken from the code rather than the data

| shape | key | what it does today |
|---|---|---|
| `DIRECTORY_AUDIT` | `security:directory-audit:{auditId}` | the 301 — carries an event id, so it deduplicates perfectly and groups not at all |
| `TENANT_SYNC` | `tenant:{id}:sync:{resourceType}` | the 334 collapsed into 15 — no event id, so it groups everything and deduplicates nothing |
| `TENANT_CONNECTION` | `tenant:{id}:connection` | |
| `TENANT_INITIAL_SYNC` | `tenant:{id}:initial-sync` | |
| `TENANT_ONBOARDING` | `tenant:{id}:onboarding-authorized` | |
| `RECOVERY` | `{anyKey}:recovered:{occurrenceCount}` | **the counter is in the key** |

The list comes from the `dedupeKey:` literals in the codebase, not from the keys present in
production — a list derived from the data would describe what happens to be there and
silently omit any shape that has not fired yet, then call that coverage.

**`RECOVERY` is the new finding.** The occurrence count is part of the key, so the same
logical recovery produces a **different key every time the count moves**. That is the 301
defect one layer over: a counter embedded in an identity makes the identity non-repeating,
so recoveries cannot deduplicate against each other at all. It is parsed before the shapes
it wraps — a recovery of a sync alert matches the sync pattern too, and checking in the other
order would classify every recovery as whatever it recovered, losing exactly the count this
step needs.

### An audit row is not given a default type

The shape says *a directory change happened*; whether it was **privileged** is a property of
the change, not of the key. So those rows are reported as needing classification rather than
assigned a type. Defaulting to the routine type would file real privileged changes as
records — the 301 problem arriving from the migration instead of from the collector.

### Both counts, from the same rows

The declared count groups on the subject each type declares — **actor** for directory
changes. The comparison count keys the same rows on the **target** instead, by constructing a
declaration with `subject: 'TARGET'` rather than changing anything. The two numbers differ
only in the subject, which is what makes them comparable.

### The report checks its own output

| invariant | status |
|---|---|
| `duplicatedNotificationIds` | **tested** — a bad join returning the same row twice is reachable and caught |
| `rowsMissingFromMapping` | a **tripwire**, not a tested property |
| `occurrencesPreserved` | tested |

`rowsMissingFromMapping` is labelled honestly because no input can make this generator drop
a row — both branches push — so a hardcoded empty array passes every test, and a mutation
doing that survives. It guards a *future* change that adds a skipping branch, which is a real
risk in a migration that will grow cases. An empty list there is the alarm not having gone
off, not evidence the mapping is complete.

These were booleans first, and the mutation that hardcoded the most important one —
"every row mapped exactly once" — survived everything. Naming the offending ids is what made
the duplicate case testable, and the arithmetic it shares is what gives the other list any
assurance at all. Same move as removing the coverage boolean: a list cannot be asserted into
existence as cheaply as a `true`.

### Occurrences are stated, because consolidating must preserve them

A report saying "51 incidents" without saying how many occurrences they represent invites
reading consolidation as deletion. The 301 and the 334 are real events; they are simply not
301 and 334 problems.


## What to check first when this breaks

- **An alert cleared and should not have.** Check which of the five observation fields the
  caller supplied and how. Four of them fail open, so the first question is not "is the rule
  right" but "where did that value come from".
- **Nothing ever clears.** Expected today for the credential-attack type: no attempt history
  exists, so coverage cannot be established and the condition stays active. That is the
  designed refusal, not a defect.
- **A window reads as covered when a collector was down.** Check the tolerance before the
  walk. A tolerance far above the collection cadence lets a real outage pass, and the
  tolerance is a parameter precisely so that it is visible rather than buried.
