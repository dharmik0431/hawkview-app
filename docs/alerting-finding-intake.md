# Step 04: the seam between the engine and the queue

The Risky Users engine produces findings every five minutes and tells nobody. Steps 02 and 03
built the queue. This step wires them together.

**The wiring now exists — see *The wiring* below.** What came first was the seam — the shape of the
wiring's input and output — plus a gate proving each of the seven pre-registered properties is
**expressible** through it. That check is free now and expensive later, and it has already
found one thing.

## The reference wiring was not read

QA's contract contains a reference wiring, labelled twice as not a proposed implementation. It
was not opened, and neither was their pre-registration.

A pre-registration is only independent if it was not the specification the implementation was
built from. **It does not matter whether a shared origin arrives as a bug or as a helpful
example** — a check derived from the thing it checks agrees by construction either way, and
the helpful-example route is worse because nobody involved feels like they cut a corner. The
vocabulary below comes from steps 01–03 and from the `IdentityRiskFinding` model.

## The gate: a seam that cannot express a property cannot pin it

QA found this in their own draft. `QueueState` exposed no time, so a wiring that timestamped on
arrival produced a state **identical** to one using `observedAt`. P7 was unpinnable, and the
check written for it silently tested something else — catching two unrelated variants while
missing its own. Six green checks and a property nobody was testing.

So for each of the seven, `finding-intake.test.ts` constructs the two states the property is
meant to separate and asserts they are **distinguishable**. Comparison is structural rather
than field-by-field, so a property is not declared expressible on the strength of a field the
test happens to name.

**And the gate was checked against itself.** Collapsing each property in the seam — removing
notifications, removing the event times, reducing coverage to one value, removing the
finding-to-notification trace, making a failed run an empty one, flattening the subject to a
string, sharing one time across both run arms, dropping the run total, reducing the freshness
marker to a timestamp — was caught every time. **Ten collapses, all at compile time.** A
wiring built on a collapsed seam would not build.

| property | what the seam must carry for it to be expressible |
|---|---|
| P1 one incident per account-rule | the account **and** the rule on the incident, not just inside an opaque key |
| P2 re-emission notifies once | notifications as their own countable thing — strip them and the two states become equal |
| P3 absence does not clear | a **sequence of runs** on the input, and `OPEN`/`CLEARED` on the output |
| P4 subject is the account, no merge | `ResolvedSubject`, so "unattributable" stays distinct from the empty string |
| P5 no finding reaches another org | a notification traceable to its finding, or a cross-org leak is just a notification |
| P6 coverage survives | all three of the engine's values, on the incident and on the input |
| P7 the time used is `observedAt` | `EventInstant` on the incident and the notification |

## The finding: a failed run is not an empty one

This is the sibling of QA's own fix, one level up, and it is not among the seven.

Their first draft took a flat list of emissions, which cannot express absence at all. The fix
was a sequence of runs. **But if a failed run arrives as `emitted: []`, a crashed engine is
indistinguishable from an engine reporting that everything is fine** — and the rule about to
read that input is precisely the one deciding whether absence clears an incident.

An engine that dies would close every open incident in the queue, quietly, and the only trace
would be a gap nobody was counting. The same input shape that could not express absence cannot
express failure, and the second costs more than the first.

So `IntakeRun` is a union of `COMPLETED` and `FAILED`, and a consumer must handle both to
compile. **Failure handling was listed as not covered because the semantics did not determine
an error surface; it is now expressible, which is the flag PM asked for.** So is freshness of
the engine's own runs: `lastCompletedRun` is what a freshness property reads, and
`STALE_AFTER_MS` is the threshold it reads against.

## Two decisions taken in the open rather than buried

**Coverage on an incident is the least complete any contributing finding was reached on.** When
re-emission moves FULL → PARTIAL, the incident reports PARTIAL: an incident partly built on
incomplete evidence is not a complete one, and taking the latest would let one good run launder
every earlier gap. The alternative — carry every value and let the reader decide — is
defensible and noisier. Per-notification coverage is kept either way, so the choice is
reversible without losing information.

**Every arrival time is about the ENGINE, and each is named for the question it answers.**
`IntakeRun.completedAt`, `IntakeRun.failedAt`, `QueueState.lastCompletedRun.completedAt` and
`QueueState.lastRunAttemptedAt` are all arrival, and none of them is reachable by a consumer
that has not said which it meant — see Ruling 1. "Is the engine still running" is a question
about the engine, not about the events. Every time a DECISION could be made on is an
`EventInstant`.

**What the type catches and what it does not.** `EventInstant` is constructible only through
`eventInstant`, which reads `occurredAt` — so a wiring cannot reach the queue's time fields by
grabbing the nearer `Date`, and the test asserts that a bare `Date` is rejected. What the type
does **not** stop is the deliberate version, `eventInstant({ occurredAt: arrival, receivedAt:
arrival })`. **The type catches the slip; the property catches the choice.** Both are needed,
and saying which does which is the difference between a guarantee and a hope.

## What is deliberately absent

`EmittedFinding` is field-for-field from the producer's model, including fields the queue has
no use for. A seam that accepts a tidied-up struct pushes the tidying into the producer, and
the tidying is where a field quietly stops being carried.

No rule ids, module names, trigger, batching or transaction shape — none of those are pinned by
the pre-registration and none are assumed here.

## What to check first when this breaks

1. **Did a run fail and get read as absence?** `failedRuns` is the first thing to look at when
   incidents close in a batch. A cluster of clearings with a failed run in the same window is
   the signature.
2. **Is the queue's time the event's or the run's?** Compare an incident's `latestEventAt`
   against `lastCompletedRun.completedAt`. If they move together across a backfill, something
   is stamping on arrival.
4. **Is the engine dead, or just failing?** `lastCompletedRun` answers the first and
   `lastRunAttemptedAt` the second. A stale `lastCompletedRun` with a fresh
   `lastRunAttemptedAt` is a scheduler running into failures — restarting it fixes nothing.
3. **Did coverage arrive as FULL for everything?** That is the signature of coverage being
   dropped at the seam rather than of a genuinely clean tenant.

## Ruling 1: `completedAt` and `failedAt`, accepted — and the consumer that does exist

QA is right, and the reasoning generalises: **a discriminated union forces a branch only where
the field DIFFERS between arms.** A shared `at` left the hole one field over from the one the
union closed — the freshness marker, the exact value the staleness property is about, could be
computed across every run with no branch, no discriminant and no error, counting a failed run
as evidence the engine is healthy.

**There IS a legitimate consumer of an outcome-blind time, and it is not freshness — it is
LIVENESS.** "The scheduler is firing but every run fails" and "the scheduler has stopped" are
different conditions with different remedies, and only the second is fixed by restarting a
schedule. Fold them together and an operator gets sent to restart a scheduler that is running
perfectly well.

So the answer is not to take the noise back. That consumer gets `QueueState.lastRunAttemptedAt`
— **named for what it answers**, which is what stops the question returning as an argument for
a common `at`. The question is real; reaching for the nearest `Date` is still the wrong way to
answer it.

## C and D, and they are not the same kind of problem

**C — counting runs as `input.length` — was NOT caught.** A wiring reporting every run as
completed is internally consistent: the failures are still in `failedRuns`, so the
record-the-failure property is satisfied, while the count quietly says the engine has never
missed a cycle. Nothing contradicted it because there was **no total to contradict**.
`runsSeen` is now carried, and the identity `runsSeen === completedRuns + failedRuns.length`
makes it expressible. Same repair as step 03's arithmetic identities, arriving for the same
reason.

**D — a dead engine reported as current — is only partly catchable here, and the limit is the
answer.** The crude form is now hard to write: `lastCompletedRun` carries **the run**, not a
timestamp claiming to describe one, so the marker is a projection of something that had to come
from the input and a fabricated one must be consistent with the incidents it claims to have
produced.

But a marker that is merely **wrong** — a plausible recent time, every other field agreeing —
is internally consistent, and **no property over the state alone can catch it.** The staleness
check has to be **relational**: it must read the run sequence the state was built from. A
property that takes only the state is testing self-consistency and calling it freshness. That
is a constraint on how P9 is written, not a gap in the seam, and it is better known now.

## Expressibility and writeability are different sweeps

The gate proves the seven properties **can be represented**. It says nothing about which
**defects can be written**. Those are different questions and this run separated them.

Collapsing the seam so a property becomes inexpressible was caught every time — ten collapses,
all at compile time. But restoring the shared `at` as an **optional** field was **not** caught,
and correctly so: a common time makes no property inexpressible; it makes a defect writeable.
A first attempt at that mutation added `at` as *required* and was "caught" only because the
fixtures did not supply it — an unfaithful mutation flattering the gate.

**A seam needs both sweeps.** Expressibility asks *can the check see the difference*;
writeability asks *can the wrong thing be written down*. QA's `at` finding came from the second
and no amount of the first would have produced it.

## Ruling 2: stale after 30 minutes, and the fact worth more than the threshold

Twice the worst gap ever observed. The distribution travels with it in `OBSERVED_RUN_GAPS`
rather than the conclusion alone, on the rule set for episode intervals — a threshold whose
provenance is lost becomes a number nobody may change. The p50 of 0.1 min is runs clustering
inside a cycle rather than the cadence, so 14.9 min is what the margin is measured against;
quoting the median would make it look far larger than it is.

**Zero failures in 5,166 runs.** The `FAILED` arm — the one the union now forces every consumer
to handle — **has never fired in production.** Nothing in the observed history would ever have
taught anyone that failures exist, which makes this an argument *for* type-level enforcement
rather than against it: **the defect was invisible to experience, not merely unnoticed.** No
amount of care, review or familiarity with the data would have surfaced it, because the data
has never contained an instance.

It also means the first failure arrives on a path no production data has ever traversed. That
is the case for requiring the failure to be **recorded** rather than merely not-misread: the
one time it matters, nobody will have seen it work.

## The wiring

`intake(runs)` builds the queue; `freshnessOf(runs, now)` answers whether it is current. Both
pure, no clock inside `intake`, no Prisma, no environment — the same shape as steps 02 and 03.

**It never clears anything, and that is structural rather than a rule.** A finding's
disappearance from a later completed run is not evidence the risk ended. Clearing requires the
resolving condition in `alert-clearing.ts` and the evidence that rule asks for, none of which
is in a finding stream — so `intake` produces `OPEN` incidents and **no sequence of runs can
produce a cleared one.** P3 is satisfied by there being no path, not by a check somebody could
weaken.

**A notification is created in exactly one place**, the branch that creates the incident. The
re-emission path cannot reach it, so "notifies once" is a property of the shape.

**Freshness is not a field and not a function of `QueueState`.** A state reporting a dead
engine as current is internally consistent, so a check reading only the state is testing
self-consistency and calling it freshness. `freshnessOf` reads the run sequence, which is the
only thing that knows. `NEVER_COMPLETED` is distinct from `STALE`: a schedule that was never
configured and one that stopped need different people.

### Two decisions made rather than assumed

**`SubjectRole` gained `ACCOUNT`.** The nearest existing role, `TARGET`, reads as "the account
or resource acted upon" — and a Risky Users finding concerns an account nobody has necessarily
touched. Keying an assessment as a TARGET would put a true-sounding sentence in the wrong
company: a reader seeing TARGET concludes somebody did something to this account, which is
exactly what the finding does not claim. **Merging was never the risk** — the role sits in the
key beside the type id, and a risky-user rule has its own id, so no choice here could have
joined these to an audit incident. The risk was the label, which is the half a person reads.

The addition produced one compile error, in step 03's `subjectFor`, which is the list of places
that had to decide. A migration row predates account-subject findings, so it resolves to
nothing rather than reaching for the audit target.

**`incidentGrouping` was narrowed to what it reads** — `{ id, subject }` — rather than
fabricating an `AlertTypeDeclaration` for a rule. A rule is not an alert type declaration, and
a fake one means inventing a severity, a summary, escalations and a clearing condition to
satisfy a parameter that reads none of them. **Every invented field is something a later reader
may believe.** `AlertTypeDeclaration` satisfies the narrower type structurally, so no existing
caller changed and none can now pass less.

### Twelve variants injected, twelve caught — and one finding about the checks

Every named defect variant was injected into the wiring and caught: incident-per-emission,
reemission-notifies, absence-clears, a failed run read as absence, subject-rederived,
key-omits-organisation, coverage-dropped, coverage-takes-latest, uses-arrival-time,
ordering-by-arrival, failure-not-recorded, and staleness measured from the last attempt.

**The attribution is the useful output, not the count.** It showed the P8 variant — a failure
handled but not recorded — being caught by the P3 test and the identities test, and **never by
the test named for P8.** That test was called "P8 a failure is recorded, and P9 freshness…" and
only ever exercised P9. A check whose name claims a property it does not test is the same
defect as a check that passes for a moved reason: **it makes the property look covered.**
Renamed to P9, with P8 asserted where the failure record is actually read.

It also shows the checks are not one-to-one — the P1 variant trips five tests, because a defect
in incident identity moves everything downstream. That is expected and is why each check
declares which variants it expects rather than being forced to fire alone.

## Two markers, two meanings of "latest"

`lastRunAttemptedAt` took a max, `freshnessOf` took a max, and `lastCompletedRun` took
whatever came last in the array. **Three places in one module, two meanings.** For
`[completed@t9, completed@t1]` the state reported `t1` while `freshnessOf` reported `t9`, so a
reader deriving freshness from the state got STALE and one reading the runs got CURRENT.

The direction was safe — it over-reports staleness, never under-reports — but the disagreement
is not, and the realistic trigger is mundane: **a query returning runs without an `ORDER BY`.**
Fixed to take the max, and pinned by a test that feeds the runs out of order.

**And it means the runs-versus-state separation was briefly true for the wrong reason.** With
the markers disagreeing, freshness genuinely could not be derived from the state — but that was
a bug, not an argument. Fixed, the two now always agree for any state `intake` produces, and
the separation has to stand on something else. It does, and the reasoning is worth stating
precisely because it is easy to state loosely:

> A `QueueState` reporting a dead engine as current is **internally consistent**. A check
> reading only the state cannot distinguish a state `intake` produced from one it did not — a
> fabricated marker, or one from a future version whose derivation has drifted off the runs the
> way `rowsWithoutEventTime` drifted off the rows in step 03. Reading the run sequence is not a
> stronger version of the same check; it is a check against a **different source**.

## The producer dependency nothing recorded

An unattributable finding does not group, so it stands alone keyed on the row id — and that
means **the consumer depends on the engine keeping the id stable across runs.** If the id
moved, the same finding would become a new incident and a new notification every five minutes:
three runs, three notifications, measured.

It is stable today because the engine upserts rather than re-creating, so this is **latent, not
live.** It becomes live the day findings are re-created instead, and nothing on either side
would catch it: the producer would be doing something reasonable, and the consumer would be
doing what it says. Now recorded on `EmittedFinding.id`, and pinned by a test that asserts the
churn as **current behaviour rather than desired behaviour** — if that assertion starts failing
because the key changed, that is an improvement and the test should be rewritten, not restored.

**Raised and not acted on:** `dedupeKey` is stable by construction — being stable is what it is
for — so keying the ungrouped path on it would remove the dependency rather than document it.
Not changed, because the instruction was to document, and because it alters which findings
count as the same one when an account cannot be named, which is a product question.

## A pre-registered property is only as wide as its inputs

QA's P2 fixture used an **attributed** finding, so the check named "re-emission does not notify
again" never exercised the path where a finding stands alone. Not a wrong fixture — an
**unrepresentative** one, and only the real wiring revealed the difference. That gap is now
covered from this side too: re-emission on the ungrouped path is one incident and one
notification, same as when attributed.

Fourteen variants injected, fourteen caught, including both orderings of the marker fix.
