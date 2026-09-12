# Alerting, step 03: reconciling the existing 364

Steps 01 and 02 are in `alerting-lifecycle.md` and `alerting-deduplication.md`. The dry
run writes nothing, no historical alert may be delivered during migration, and
consolidating must preserve the underlying events — the 301 are real, they are simply not
301 problems.

**Status: the input audit is done and it changes the shape of this step.** The dry-run
report itself is not written, and the boundary on that is at the bottom.

## Status, and a standing hazard about how this work reports

**If there is a gap between commits and no message, check the branch before assuming a
stall.** Cross-session messaging pauses after roughly ten sends until the user types in the
engineer's session, and the pause is invisible from the other side. Three reports have been
refused so far. From outside, a delivery failure and a stalled build look identical.

**The commits are the reliable channel; the messages are not.** Everything reported in a
message has also been written here, in the same commit as the work it describes. That is
deliberate and it is the reason this document is long.

### Answers to the open questions, as of `57ea2e8`

**Nothing is blocked on a ruling.** The two items outstanding from the last exchange are both
already settled in commits:

- **The incident-tier report shape** — settled above. Tier-by-most-urgent and tier-by-majority
  are the same number for every grouping the generator produces, so the dry run reports one
  and says why rather than printing two identical columns.
- **Whether the reconciliation needs a migration for the episode column** — **no.** Step 02
  ruled pure functions, and the dry run writes nothing. The episode column belongs to step
  03's *apply* phase, and only if the mapping is approved. Nothing about producing the report
  requires a schema change.

**Remaining work in this step, in order:** the unwired clearing producers.
`eventsInWindow` is now done, together with `windowReadableThroughout` — see *One window, not
two* below for why it could not be done separately. Left: `connectionVerified` and
`configurationRestored`. That is the rest of the audit
finding: all five inputs were supplied only from tests, and four fail open on their cheapest
wrong value. Each gets the treatment `sources` already has — decide what the degenerate input
means *before* writing the producer, and make it the refusing answer.

### Push status

**This section was stale, and it was stale about the one thing it exists to record.** It
read "`origin/agent/alerts-step-01` is at `57ea2e8`, verified identical to the local tip".
The remote has since moved to `d1830e5` and the local tip has moved much further, so both
halves of that sentence were false while the sentence still carried the words "verified
identical". A status line that is only true on the day it is written is a trap for whoever
reads it next, and the rule it invoked — the file is the fact — is what makes it worse: the
sentence borrowed the authority of a check it was no longer the result of.

**Verified by `git ls-remote` at the time of writing:**

```
refs/heads/agent/alerts-step-01   d1830e5
refs/heads/main                   5488ad6   (untouched)
```

**Six local commits are not on the remote:** `865630a`, `84281a3`, `0f86b02`, `2a9694e`,
`6560e57`, `fbd06df`. PM listed four; the last two landed after their fetch.

**Nothing here will be pushed.** The release hold is active, one unauthorised push has
already happened (`d1830e5`, docs-only) and has not been resolved, and a request to push on
another session’s behalf because its own push was blocked is not something a peer can
authorise. It needs Dharmik. **Check this section against `git ls-remote` rather than
believing it.**


## The input audit, and it found more than one trap

The standing question — *for every input the dry run reads, what computes it in
production, and is anything supplied only from a test?* — was pointed at
`windowReadableThroughout` because QA named it. Asked of **every** field of
`ClearingObservation`, the answer is the same for all five:

| field | produced by | cheapest wrong value | fails |
|---|---|---|---|
| `windowReadableThroughout` | ~~nothing~~ `windowWentQuiet`, from `QuietWindow` | ~~`true`~~ none: no boolean to pass | **closed** |
| `eventsInWindow` | ~~nothing~~ `windowWentQuiet`, from `QuietWindow` | ~~`0`~~ none: no number to pass | **closed** — and the mis-scoped query it warns about was a second, separate defect: see *One window, not two* |
| `connectionVerified` | nothing | `true` | **open** |
| `configurationRestored` | nothing | `true` | **open** |
| `sources` | nothing | `[]` | **closed** — see below |

*(Table as first written; the two struck cells were closed later in this step.)*

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


## Measured, on production, across five tenants and two months

Run by PM, who has read-only access. Nine shapes, 364 alerts.

```
security:directory-audit:Directory_{id}              268    268 occ    268 unresolved
security:directory-audit:SSPR_{id}                    45     45 occ     45 unresolved
tenant:{id}:sync:{RESOURCE}                           20    346 occ     10 unresolved
tenant:{id}:sync:{RESOURCE}:recovered:{count}         17     17 occ     17 unresolved
tenant:{id}:onboarding-authorized                      5     12 occ
security:directory-audit:PIM_{id}                      3
tenant:{id}:initial-sync                               3
tenant:{id}:connection                                 2
security:directory-audit:Authentication Methods_{id}   1
                                                     364
```

**Both defects appear in the same table, two rows apart.** The recovery shape is 17 alerts
holding 17 occurrences — exactly one-to-one, because the counter is inside the identity, so
every recovery is its own alert and always will be. Directly above it, 20 sync alerts hold
**346** occurrences. A key that cannot deduplicate and a key that cannot group, side by side.
That is the clearest available argument for two layers rather than one.

**Every one of the 317 directory-audit rows joined to an audit record. Zero unjoined**,
which says the key parses cleanly — and is a better result than expected, since a
notification outliving the evidence it was raised from is a plausible failure.

### D1 is vindicated on the data

```
                        incidents
BY ACTOR (declared)         68
BY TARGET (comparison)     116
```

Keying on the actor nearly halves it. The ruling was made on reasoning — a compromised admin
touching twelve accounts is one incident, not twelve pages — and the measurement agrees.
35 distinct actors; 9 unattributed events, so the unresolvable-subject path is reachable and
rare, which is the shape it should have.

### 68 IS A FLOOR, NOT THE ANSWER

Worth stating because the number will be quoted. The incident key contains the **type id**,
and one actor's privileged change is correctly a different incident from their routine one.
So a count over the 317 cannot be exact until each is classified, and the generator reports
two numbers accordingly:

- `declared` — groups only rows whose type the key shape determines. Excludes all 317. Honest
  and unhelpful.
- `assumingSingleType` — every undetermined row counted under one nominated type. Computable,
  and a **lower bound**: classification can only split an actor's events across two types,
  never merge them.

So the real figure is 68 **or higher**. Quoting it without that is an understatement
presented as a measurement.

### The audit category is in the key, and was not in the code

The ids Microsoft issues carry a category prefix, which the key inherits verbatim:
`Directory_`, `SSPR_`, `PIM_`, `Authentication Methods_`. Found in the data rather than the
source, so the parser now extracts and reports it.

It is the **only signal in the key about what the change was** — which is precisely the
question the shape could not answer. `PIM` is Privileged Identity Management and is the
strongest candidate for the privileged type. It is reported, never mapped: a category is a
hint about subject area, not a classification, and mapping from it here would be the same
shortcut as defaulting the type.

The whole remainder still serves as the event id, because that is what joins to
`microsoftAuditId` — and all 317 joining confirms substituting the category would have broken
a parse that demonstrably works.

## The tier question, as first raised (settled below)

**Not stated anywhere.** `routingTier` maps one severity to one channel, and nothing derives a
severity for a *group* — but the group is what gets routed. An incident holding one urgent
event and nine routine ones has no defined tier.

**The recommendation, and the reasoning is the part that matters:** an incident takes the tier
of its **most urgent member**. Anything else lets volume dilute urgency — an average or a
majority would let nine routine events outvote one weakening, and step 01 deliberately has
**no `OCCURRENCE_COUNT` escalation signal** precisely so volume could not drive severity.
Averaging would reintroduce volume as a signal, inverted: instead of noise promoting itself,
noise would demote a real finding.

The cost is accepted rather than hidden: a phone call can arrive carrying 299 routine events
alongside the one that earned it. That is the correct direction — the alternative is not
hearing about the one.

PM's note that the tier rows sum past the incident count is the same observation from the
other side, and it is what surfaced the gap.


## The tier ruling: checked before building, and it is already structural

**The ruling** (Dharmik, via PM): an urgent event is pageable. Nine routine events and a
tenth that is urgent — you page. So an incident takes the tier of its **most urgent
member**, and it **never goes back down**.

Checked rather than implemented, and for **declared** severity it is not a mechanism at
all — it is impossible to violate:

> Severity is declared **per type**. The incident key contains the **type id**. So every
> event in an incident shares a type and therefore shares a severity. **There is no
> mixed-tier incident to take the maximum of.**

A test sweeps every pair of catalogue types with different severities and asserts their keys
differ for the same subject and scope, with a positive control that two events of the same
type do share an incident.

### The one real tier change, and it was already one-directional

A `RECORD_ONLY` type can be **promoted** into an investigation — that is a genuine tier
change inside one incident, and it is the case the ruling bites on. All three properties were
already guaranteed by step 01 rather than needing anything new:

| property | already guaranteed by |
|---|---|
| pages **once**, not per subsequent event | `ESCALATE_INTO_INVESTIGATION` sits behind `investigation === 'NONE'`, so after it fires the branch is unreachable for that episode; `alreadyEscalated` covers the plain `ESCALATE` case |
| **never downgrades** | `openInvestigation` is the only way `NONE` is left, and nothing returns to it — `resolveInvestigation` goes `OPEN` → `RESOLVED`, never to `NONE` |
| the reason travels | the outcome carries its `signal` |

Verified by mutation: forcing `resolveInvestigation` to produce `NONE` fails three tests,
including the one that exists for this ruling. And every combination of `applyObservation`
input is swept against a promoted lifecycle — none can return it to `NONE`.

So the ruling is **a test and a sentence**, which is the outcome PM hoped for and the reason
for checking first. Implementing it again in a second place would have created two mechanisms
that can disagree.

### A correction to the measurement that raised it

PM's tier rows summed past the incident count, which is what surfaced the question. **That is
an artefact of the approximation, not a reachable state.** Their hand-classification grouped
events without the type in the key, so one group could hold several tiers. Under the real key
it cannot.

Which answers the worry directly: **the act-now count cannot rise because of this ruling.**
Tier-by-most-urgent-member and tier-by-majority are *the same number* for every grouping the
generator produces — the declared path and the `assumingSingleType` bound both put one type in
each group. Reporting two identical columns would imply the comparison was meaningful, so the
dry run reports one and says why.

The act-now count may still move once the real classifier replaces the approximation — 3 was
measured against a hand-written policy reading, and `PIM` alone is 3 rows that are strong
candidates for the privileged type. It will not move because of tier aggregation.

### The part that is not a mechanism

**The reason must travel with the tier, in the interface.** An MSP opening a paged incident
that holds one urgent event and nine routine ones must see the urgent one first, and the
reason must name it. A correctly-tiered incident that opens on a list of password resets has
technically done its job and practically failed.

That is a presentation obligation for step 06/07 and cannot be enforced here — the outcome
carries the signal, and whether anything renders it is the part this layer cannot see. It is
recorded with the other handoff obligations for exactly that reason.


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

## Three corrections from QA, and one from PM

**`occurrencesPreserved` was vacuous, and its label was the worse half.** It compared a loop
accumulator against a reduce over the same array with the same addition — both sides equally
wrong and therefore always agreeing. Searched for a falsifying input: ordinary, zero,
negative, `MAX_SAFE_INTEGER`, fractional values where addition is not associative, 200,000
random sets. Nothing, bar `Infinity + -Infinity` giving `NaN`, which is an artefact.

The comment claimed the events are preserved *"so that applying the mapping can be checked
against it rather than trusted"* — which reads as a check on consolidation, when **the
mapping was not in the computation at all**. Its sibling one line up honestly calls itself a
tripwire; this one did not, so a reader comparing them would take the unlabelled one for the
stronger and it was the weaker.

Fixed by making it real rather than by relabelling: the mapping now carries each row's
occurrence count — which the apply phase needs anyway — so the two sides come from different
places. Verified by corrupting a mapping entry, which fails a test the old form could not
have. The reported boolean is still hardcodable, because no input falsifies it, and that is
now said in the file.

**The floor label travels with the number.** `declared` excludes every directory-audit row,
so the only populated counts are the bounds — and a figure printed as "incidents" that is
really "a floor over all rows" is what gets quoted into a decision and relied on. The output
now carries an `incidentsNote` stating which rows each number covers and that the bounds are
floors.

**And a like-for-like pair was missing.** The production figures were computed with SQL
filtered on the directory-audit key prefix; `assumingSingleType` covers *every* row.
Comparing those two would find a disagreement that was never there. The report now also
gives the bound restricted to directory-audit rows, which is the number to compare — and a
test asserts the restricted count never exceeds the wider one, so they are comparable rather
than merely adjacent. **Treat the SQL figures as a rival instrument: if they disagree, one of
us is wrong and it is worth finding before either number is used.**

**`notJoined` could only over-report, and that makes the measured zero stronger.**
`auditIds` was not deduplicated while `findMany` returns one row per distinct id — and
`dedupeKey` is unique **per organization**, not globally, so two organizations holding the
same audit id produced a phantom shortfall. Now compared against the distinct count.

The consequence is the better half, and it came from reasoning about the direction of the
error rather than from measuring again: because the metric can only over-report, a measured
**zero** establishes both that every id joined **and** that no audit id is shared across
organizations. The second fact was never measured.

**Accounting correction, from PM:** there are **six** key shapes covering nine production
forms. `Directory_`, `SSPR_`, `PIM_` and `Authentication Methods_` are audit *categories*
inside one shape, which the parser extracts separately — two levels conflated in the earlier
count.

## Episodes: the incident key carries none, and the reconciliation had none

Found by running the generator against real rows and comparing it with a SQL count: **34
against 68**, and the whole gap is episodes.

**The incident key identifies a STREAM** — type, organization, tenant, subject — and
deliberately contains no episode component. So an incident count answers *"how many distinct
subjects are involved"*, not *"how many separate bursts of activity happened"*. Across a
two-month window those are very different numbers, and reporting the first as the second
would produce exactly what episodes exist to prevent: every change by one actor over two
months collapsed into one incident, so an attack next month joins last month's closed
incident and nobody is told.

Neither instrument was wrong. They answered different questions, and only one is the question
the plan asks.

### Episode what can be episoded, and say so for the rest

The constraint is real for some rows and not others, and that split is the ruling:

| rows | event time | episodes |
|---|---|---|
| directory-audit (317 of 364) | `event_date_time` on the joined audit record, one-to-one | **exactly reconstructable** |
| the aggregate shapes | `occurrenceCount: 42` at unknown individual times — first/last give the span and nothing inside it | **unrecoverable** |

So `ExistingAlertRow` gained an optional `occurredAt`, counted with step 02's `episodesOf`
rather than a second implementation, at the interval the nominated type declares — reported
alongside the count so the number is auditable rather than asserted.

**An incident whose episodes cannot be recovered is reported as unknown, never as one.**
Counting it as a single episode would understate the migration by precisely the thing
episodes were built to catch, and inventing a time would be fabrication. Same refusal to
collapse `NOT_AVAILABLE` into a value that this product makes everywhere else.

**The event's own time comes from the audit record, not the notification.**
`first_occurred_at` is when HawkView raised the alert — arrival time, which every episode
rule in this feature refuses to decide on.

### What the numbers now mean

- `incidents.*` — how many streams. Answers "how many subjects".
- `episodes.counted` — how many bursts, where every row in the stream has its own time.
- `episodes.incidentsWithUnrecoverableEpisodes` — streams whose burst count is unknown. **Not
  one each.**
- `episodes.countedDirectoryAuditOnly` — the like-for-like figure against a key-prefix-filtered
  SQL count.

Two counters were being accumulated on separate statements and only one was asserted, so a
mutation replacing `spans.length` with `times.length` — every event its own episode — survived
until the wider counter was pinned too. The fixture-cannot-discriminate shape wearing different
clothes: two siblings, one tested.

### The residual six, and they were mine

After the episode component landed, the counts were **62 against 68** — the bulk of the gap
explained, six episodes still not. Three candidates were checked, in the order PM proposed:

| candidate | verdict |
|---|---|
| `placeEvent` splits on `>= quietMs` where the SQL used `> 24h` | **ruled out** — it splits on `at > span.lastEventAt + quietMs`, strictly greater, the same boundary |
| the nominated type's declared interval is not actually 24h | **ruled out** — `security.routine_directory_change` declares `hours: 24` and the report prints `quietIntervalHours: 24`, which is why it prints it |
| unattributable rows excluded rather than counted as singletons | **the cause** |

The episode accumulator sat behind `if (boundGrouping.groups)`. A row whose actor cannot be
determined does not group, so it was bucketed **nowhere** and contributed **zero** episodes —
while the SQL coalesced those same rows onto one literal `'UNATTRIBUTED'` actor and got
several. The reasoning that nearly closed this off was that coalescing makes the *other*
count lower and therefore cannot open a gap in that direction. True, and it missed the larger
term in the same expression: one side merged, the other **discarded**, and discarding is the
stronger effect. **When two instruments disagree, account for what each one drops, not only
for what each one merges.**

Two rulings came out of the fix:

**An ungrouped row is still an incident.** Each one keys on its own notification id, so two
unattributable events are two incidents of one event each — exactly what `wouldGroupTogether`
already refuses to merge, now honoured in the episode count instead of reintroduced a layer
down. Note that `incidents.unattributed` could not have caught this: that counter runs only
for rows whose alert type the key shape determines, and a directory-audit shape determines
none, so those rows `continue` before reaching it. Every counter that might have noticed sat
downstream of a verdict these rows never get.

**One event is one episode, and that is knowable without its time.** The time is only needed
to *split* several events; a single event forms exactly one burst whenever it happened.
Reporting it as unrecoverable was over-refusing — the mirror image of counting a genuinely
unknowable incident as one, and both are the same failure to distinguish *cannot be computed*
from *computed*. Many events at unknown times stays unknown, because forty-two events could
be one burst or forty-two.

Six mutations, no survivors: the original defect restored; all ungrouped rows merged onto one
bucket (the SQL's behaviour); the single-event rule removed, widened to `>= 1`, and keyed on
`times.length` instead of `events` (the right count in the wrong dimension — a timeless single
event has zero times); and the interval ignored.

**The arithmetic this predicts, which needs one query to confirm.** With ungrouped rows
counted, the same input yields 62 + *n* where *n* is the number of unattributable rows, each
now worth one episode. If the SQL's coalesced `'UNATTRIBUTED'` stream produced exactly six
bursts, that closes 62 → 68 precisely and the residual was never anything else. The two
numbers then *diverge again by design*: the SQL merges those rows and splits by time, this
count refuses to merge events whose subject is unknown. **Both figures are defensible and they
answer different questions — but they must not be compared without saying which.** The check
is one query: episodes among rows whose actor is null. It has not been run here; this worktree
has no production access and the release hold stands.

## One window, not two: `eventsInWindow`, and why it could not be fixed alone

The audit table above lists `eventsInWindow` and `windowReadableThroughout` as two separate
unproduced inputs. They are two halves of one condition, and treating them as two problems
was itself the larger defect.

**The cheap wrong value first, since that is what the table predicted.** `eventsInWindow` was
a bare `number`. The cheapest way to clear an alert was to pass `0` — which is also exactly
what a caller who never ran the query would pass. **Zero events found and zero events looked
for are the same value and opposite facts.** So the count stopped being something a caller
supplies: `EventTally` is `COUNTED` with the event times, or `NOT_COUNTED` with a reason.
There is no number to pass, on the same rule that left no boolean to pass.

**And then the one the table could not see.** Auditing field by field asks *is this field
produced?* of each field alone, and both halves can be individually beyond reproach while the
pair is meaningless:

> Count the events over the last hour. Establish coverage over the last month. The condition
> reads as satisfied — quiet recently, watched for ages — and the event three weeks ago that
> the alert was raised for is invisible to both halves.

Nothing in the old shape required the two fields to describe the same period, and **no test of
either field could have found it**, because neither field is wrong. `QuietWindow` carries the
window **once**, with the tally, the coverage and the tolerance, and `windowWentQuiet` derives
both halves from it. The mis-aimed pair is now unexpressible rather than merely discouraged.

**A per-field audit finds fields that are wrong. It cannot find pairs that disagree.** When a
rule reads two inputs, ask what relationship between them the rule assumes, and put that
relationship in the type — here, the shared window.

Two smaller rulings that came with it:

- **Uncounted is checked before coverage.** A caller holding perfect attempt history and no
  event query still clears nothing. Checking coverage first would let a `NOT_COUNTED` tally
  through on the strength of the other half.
- **The window boundary is inclusive at both ends.** An event landing exactly on `from` or
  `to` is inside and keeps the alert open. The conservative direction on purpose: reading a
  boundary event as outside means an alert closing on the very event it was raised for, while
  reading it as inside costs one more cycle before it clears.

Eight mutations, no survivors: the uncounted refusal removed; the coverage half dropped; each
boundary made exclusive; the trailing bound dropped entirely; `some` swapped for `every` (an
empty tally stops being quiet); the explanatory sentence stopped naming the uncounted case;
and the condition wired to a constant instead of to the evidence.

### Confirmed on production, and the count now has a name

PM measured it: **62 attributed episodes, identical to `countedDirectoryAuditOnly`.** Nine
unattributable rows, six episodes under their coalescing, 68 total. The two instruments agree
to the row once the difference is accounted for — and **zero gaps land exactly on 24h in the
data**, so the boundary convention could not have mattered even if the two had differed.

Both original answers were wrong, in opposite directions, against a step-02 ruling that
already said what to do:

> An event whose declared subject cannot be resolved does not group. It stands alone,
> labelled unattributed. Merging on "unknown" asserts a relationship we have no evidence for;
> standing alone asserts nothing.

Nine singletons — not zero, and not six. `incidentGrouping` implemented that ruling correctly
all along; only the reconciliation diverged. **One module right, one module wrong, and nothing
tying them together.** So the fix carries a coupling test that partitions the rows using step
02's own `wouldGroupTogether` and requires the reconciliation to produce exactly that many
episodes. The expected number is derived from the other side of the boundary rather than
written down, because a literal agrees with whichever side you copied it from.

**`rowsStandingAloneBecauseSubjectUnresolved` is now reported beside the episode counts.**
QA's point holds independently of what the count turned out to be: such a row is counted in
`total`, in `byShape` and in `needingClassification`, and then vanished from the episode
accounting with no number saying how many or why. `incidents.unattributed` **cannot** cover
it — that counter sits after the `declaration === null` branch returns, and every
directory-audit row takes that branch, so it reads 0 for them **by construction rather than
by measurement**. Absence resolving to silence, in the report whose entire purpose is making
absences countable. It is also the figure two instruments will most often disagree about, so
the runner's note now says to compare it *before* comparing totals.

The counter is taken at the point of the grouping decision, not derived from the bucket map,
so a bucketing bug cannot make it quietly agree — verified by restoring the original defect
and confirming the count still dissents.

**A fixture whose two populations are the same size cannot tell a count from its complement.**
The first version of the coupling test used three grouping rows and three unattributable ones,
and a mutation inverting the counter — count the rows that *did* group — survived every
assertion, because three and three read alike. The fixture is now asymmetric and asserts its
own asymmetry, so the next person to edit it cannot silently restore the blind spot.

Five mutations, no survivors: the count never incrementing, counting every row, inverted,
the buckets dropping ungrouped rows again, and all ungrouped rows merged onto one bucket.

## 71, and the reference instrument was the wrong one

The final production figures: **`countedDirectoryAuditOnly` 62 → 71**, and **71 = 62 + 9** —
the nine unattributable rows now standing alone at one episode each, which is the step-02
ruling. The SQL that read 68 coalesced those nine onto a single literal `'UNATTRIBUTED'`
actor and got 6 from them: **inventing a relationship between nine strangers, which is
precisely what the ruling forbids.**

Recorded this way round deliberately. The interesting case for a reader is not *two
measurements agreed* — that is the case where nobody learns anything — but **they disagreed
and the reference was wrong.** A second instrument is only worth building if you are willing
to find out it is the faulty one.

### A metric that corrects itself in silence

`rowsWithoutEventTime` read **22** at `2a9694e` and **47** at `601ba53` on the identical
input, and 47 is the arithmetically correct answer: 364 − 317 = 47. **22 was lying.** Caught
only because a reader happened to have the arithmetic to check it against, which is not a
control.

**The cause, reproduced rather than argued.** Both versions were run over one fixture built
from the production shape — 364 rows, 317 with `occurredAt`, 9 directory rows with no
resolvable actor — and the old code reproduced every observed figure:

| | `2a9694e` | `601ba53` | |
|---|---|---|---|
| `rowsWithoutEventTime` | 22 | 47 | +25 |
| `incidentsWithUnrecoverableEpisodes` | 2 | 5 | +3, the observed delta |
| `countedDirectoryAuditOnly` | 12 | 21 | +9, the nine standing alone |
| `rowsStandingAlone…` | absent | 34 | the observed figure |

The field was computed as `rowsWithoutTime += bucket.missing` over the incident buckets — and
ungrouped rows were never in that map. **So the field silently excluded exactly the rows the
bucketing bug had dropped.** 47 − 25 = 22, where 25 is the standing-alone rows carrying no
time (34 standing alone, minus the 9 directory ones that do carry times from the audit join).
`incidentsWithUnrecoverableEpisodes` moved +3 for the same reason, one rule further on: of
those 25 newly-bucketed rows, the single-event ones now count as one episode each and only the
three aggregates remain genuinely unknown.

**The name was never the problem, so nothing is renamed.** `rowsWithoutEventTime` always meant
"rows carrying no event time"; the code computed something else and called it that. This is
not a field whose subject changed — it is a field that was wrong, and got quietly less wrong.
That distinction matters for the fix: a rename would have preserved the bad derivation under a
more careful name.

**A COUNTER DERIVED FROM A STRUCTURE INHERITS THAT STRUCTURE'S OMISSIONS.** The repair is to
count a row-level fact at the row, where it is known, not by summing something that can decide
a row does not belong to it. `rowsWithEventTime` is now reported beside it so the two must add
to `total`, and `invariants.eventTimeCountsAddUp` says so in the output — the reader should
not have to be the check.

**That invariant is a tripwire, not an input-falsifiable check, and the first version of this
section claimed otherwise.** Both counters are incremented in one pass over the same rows,
exactly once each, so no input can make the identity fail; a mutation hardcoding it empty
survived every test. It defends against a future derivation moving off the row — which is
exactly what went wrong — and that is worth having, but it is not a check and does not get
described as one. Same honest label `occurrencesPreserved` already carries.

### The pair of edits a one-at-a-time harness cannot see

Mutating the derivation alone **survives**, and that survival is correct: since every row is
now bucketed, summing the buckets and counting the rows give the same answer. The defect needed
**two** things at once — the bucket map excluding ungrouped rows *and* the count deriving from
that map. Either alone is harmless.

So the harness now applies **paired edits** and declares its expected survivors up front, which
turns a survival into a prediction confirmed rather than a result explained afterwards. Seven
mutations, no unexpected outcomes: the real two-edit defect (killed), the exclusion alone
(killed, and the row-level count does not move with it), the derivation alone (survives, as
predicted), the row counter never incrementing, the two counters swapped, the breakdown keyed
on a constant, and the breakdown counting every row.

### The 34, made derivable

A bare 34 is a claim, not evidence. `standingAloneByShape` breaks it down, and every reason is
a property of the **key** rather than of the data, so it can be counted independently in SQL:

| shape | why it stands alone |
|---|---|
| `DIRECTORY_AUDIT` | the audit record names no initiator, so the ACTOR subject cannot resolve |
| `TENANT_INITIAL_SYNC` | the key names no resource type, so the COLLECTOR subject cannot resolve |
| `RECOVERY` | likewise — the recovery key carries no resource type |
| `TENANT_ONBOARDING`, `UNRECOGNISED` | the shape determines no alert type, so they reach the nominated type's ACTOR subject with no audit record |

Shapes that do resolve a subject are **absent** from the breakdown rather than present as
zero, so it cannot be misread as a list of shapes that all failed.

## The hardening was reactive, and that is the finding

QA perturbed the report object: **13 of 32 figures move without anything contradicting them,
and they are exactly the numbers a person would quote.** The 19 that *are* constrained —
`byShape`, the `rowsWithEventTime`/`rowsWithoutEventTime` pair, `standingAloneByShape`,
`auditCategories` — are **precisely the ones already caught lying once.**

So the pattern is: **a figure gets a sibling only after it has embarrassed us.** Every number
that has not yet moved is still standing alone, and we now know from `rowsWithoutEventTime`
that it will not be found until it does. That is the argument for doing the rest now rather
than after the next one moves — the alternative is not "no bug", it is "the bug is still
ahead of us".

**The principle, and it needs its bound or it does damage: every reported figure that CAN
decompose should reconcile against another reported figure.** `317 + 47 = 364`,
`62 + 9 = 71`, `9 + 17 + 3 + 5 = 34`. A decomposable figure standing alone is where the next
silent correction will live.

**A figure that cannot decompose gets LABELLED as a cardinality, not given a manufactured
check.** The six incident figures — `declared`, `ifKeyedOnTarget` and the four
`assumingSingleType*` — are set cardinalities over different groupings of the same rows.
They are not partitions of anything, so no two add to a third. Applying the unbounded rule
to them would produce six fabricated identities that READ exactly like the real ones
elsewhere in this output, and **a fabricated check is worse than an honest gap**: a figure
standing alone is visibly unverified, while one standing beside a sum that never meant
anything is miscredited by something shaped like evidence. That is the `occurrencesPreserved`
mistake again, committed deliberately and six times over.

The only relation they support is ordering — each directory-only figure is bounded by its
all-rows sibling, because the narrower set is drawn from the wider one — and that is
reported through `atMost` rather than `adds`, deliberately in a different shape, so a bound
is not mistaken for an accounting.

Three figures fixed under it:

**`occurrencesPreserved` was worse than nothing.** The boolean compared two internal sums and
touched **neither reported field**, so perturbing `occurrencesRepresented` left it reading
true — a reader saw 699 with the word "preserved" beside it and concluded the number was
checked. **A misleading neighbour is worse than no neighbour:** a figure standing alone is
merely unverified, while one standing beside a boolean that looks like a guarantee is actively
miscredited. Replaced with `occurrenceCountsAddUp`, which reads the reported figure.

**`countedDirectoryAuditOnly` was the headline with nothing constraining it.** 71 = 62 + 9 was
reconciled by hand, in a message, using an attributed-episode count the report did not expose
— so the arithmetic that made the headline credible could not be reproduced from the output.
`episodes.fromAttributedRows` and `fromStandingAloneRows` are now printed, and
`invariants.episodeCountsAddUp` states the identity. **A number verified once in a message is
not a verified number.**

**`incidents.unattributed` was unconstrained AND structurally zero for directory rows.** The
increment sits after the `declaration === null` branch returns, and every directory-audit row
takes that branch — so the figure most likely to be read as *"how many could we not attribute"*
was the one figure guaranteed not to answer it. **An unconstrained figure that is also always
zero is the quietest possible place for a wrong number: nothing contradicts it, and its
correct value is indistinguishable from a broken one.** Renamed
`declaredSubjectUnresolvedAmongTypedRows` so the restriction travels with it, and given a
complement and a total that must agree with it.

### What these identities cannot do, which matters more than what they can

**All four are tripwires, not input-falsifiable checks.** Each has both sides computed in one
pass over the same rows, so no input can separate them — a mutation making `adds` always
report agreement survived the entire suite until the helper was unit-tested directly. They
catch a **future derivation drifting off the rows**, which is exactly what happened to
`rowsWithoutEventTime`, and that is worth having. It is not the same thing as verifying the
computation.

This is the same bound QA put on their own method, and it should travel with the result: their
perturbation is applied to the report **object**, so it measures whether the output is
self-checking, not whether the computation is right — and "constrained" means constrained
relative to the eleven identities they wrote, no more.

**Self-reconciliation catches drift. Only an independently derived reference catches error.**
For this report that reference is the SQL count, which is what the 62-vs-68 exercise was — and
it is why the disagreement was worth more than the agreement.

Ten mutations, one survivor, and the survivor is equivalent code: pointing the occurrence check
at `inputOccurrences` instead of `occurrences` is the same check, because both are the same
quantity accumulated twice in one pass. Killed: the reported figure perturbed (the exact case
the old boolean missed), the episode split collapsed into one half, the two halves swapped,
`standingAlone` tagged from the wrong side, `withDeterminedType` counting every row, the
complement never incrementing, and three on the helper itself.

### Adjacency is where a fix goes wrong

The audit named `countedDirectoryAuditOnly`. The fix decomposed **`counted`** — the
all-shapes figure sitting next to it — and left the named one still standing alone, with two
new unconstrained figures beside it. The identity was real (`93 = 63 + 30` holds); it
constrained the wrong number.

**The two differ only in scope, which is exactly why the fix landed on the neighbour.** When
a finding names a figure, the figure to constrain is the one named, and the danger is highest
when an adjacent one looks interchangeable — because the fix then feels complete and even
verifies clean against an identity nobody asked for.

The directory-only split is now printed, so **`71 = 62 + 9` is reproducible from the output**
rather than from a message. The root cause was in the loop: how many episodes a bucket
contributes was decided in **two** places, each repeating the tagging, so the audit-only line
was written *beside* the halves instead of *derived with* them. It is now decided once, as
`gained`, and every total derives from it.

### 34 rows, 30 episodes, and why the obvious guess is wrong

The gap was not derivable from the output, and the natural reading — *rows without an event
time cannot be placed* — **is wrong**. A single timeless event still counts as one episode; a
standing-alone bucket holds exactly one row, so it contributes one episode or none, and none
happens only when that row carries **several** events at unknown times. Many events with no
times is the case that genuinely cannot be computed; one event with no time is not.

So the dividing line is not "has a time" but "has more than one event and no times", which no
combination of the other figures reveals. `standingAloneRowsWithUnrecoverableEpisodes` is now
printed, with the identity **every standing-alone row is either an episode or named as
unplaceable**, and `incidentsWithUnrecoverableEpisodes` is split the same way.

Nine mutations, no unexpected outcomes. Killed: the directory halves fed from the all-shapes
totals (the original miss), each half ignoring the audit-only tag, the two swapped, unplaceable
standing-alone rows counted as attributed, the standing-alone side never recorded, a timeless
single event no longer counting as one, and every bucket gaining exactly one episode.

**Two predicted survivors, declared before the run: removing either new identity from the
invariant list survives, and must.** No input can make an identity fire, so the list is a
tripwire and the kills above rest on the component figures being asserted directly. Predicting
that in advance is what keeps it a property of the design rather than an excuse found
afterwards.

### The instrument is in scope, and a regression is the first place to look for it

The raw perturbation said **14 of 36 figures unconstrained**, up from 13 of 32 — the fix
apparently making things worse. It had not. The instrument perturbs the report **object**, and
the four in-report identity lists are computed **inside** `reconcile`, so flipping a field
afterwards cannot make them fire. They were invisible to it. Corrected count: **9 of 36, down
from 13 of 32** — hardening one figure constrained six and added three already covered.

Twice now the measurement has been the broken thing: the SQL that read 68, and this. **When a
result looks like a regression, check the instrument before checking the code** — and when the
instrument sits outside the computation it is measuring, ask what the computation does that the
instrument cannot see. QA got there by correcting the instrument rather than re-running it,
which is the distinction worth keeping: re-running a broken instrument produces the same wrong
answer with more confidence.

### 34 versus 30, exactly

`bucket.events` accumulates **`occurrenceCount`, not a row count**. A standing-alone bucket is
keyed per row so it holds exactly one row — but the one-event-is-one-episode shortcut fires
only when that row's `occurrenceCount` is 1. Of the four combinations, exactly one produces
the gap:

| occurrences | event time | contributes |
|---|---|---|
| 1 | present | 1 episode |
| 1 | absent | 1 episode — a single event is one burst whenever it happened |
| many | present | 1 episode |
| **many** | **absent** | **0 — unplaceable, and now named** |

So "timeless rows cannot be placed" was half right and missed the occurrence count, which is
why the non-directory figure of 25 did not predict the 4.
