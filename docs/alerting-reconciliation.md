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

**Remaining work in this step, in order:** the three unwired clearing producers —
`eventsInWindow`, `connectionVerified`, `configurationRestored`. That is the rest of the audit
finding: all five inputs were supplied only from tests, and four fail open on their cheapest
wrong value. Each gets the treatment `sources` already has — decide what the degenerate input
means *before* writing the producer, and make it the refusing answer.

### Push status

`origin/agent/alerts-step-01` is at `57ea2e8`, verified identical to the local tip;
`origin/main` untouched at `5488ad6`. Verified by `git ls-remote` rather than taken from the
message that reported it, on the same rule as everything else here: a ruling is a decision,
the file is the fact.


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
