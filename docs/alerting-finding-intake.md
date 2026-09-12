# Step 04: the seam between the engine and the queue

The Risky Users engine produces findings every five minutes and tells nobody. Steps 02 and 03
built the queue. This step wires them together.

**Nothing is implemented yet, deliberately.** What exists is the seam — the shape of the
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
string — was caught every time, **all six at compile time.** A wiring built on a collapsed
seam would not build.

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
the engine's own runs: `lastCompletedRunArrivedAt` is the field a freshness property would
read.

## Two decisions taken in the open rather than buried

**Coverage on an incident is the least complete any contributing finding was reached on.** When
re-emission moves FULL → PARTIAL, the incident reports PARTIAL: an incident partly built on
incomplete evidence is not a complete one, and taking the latest would let one good run launder
every earlier gap. The alternative — carry every value and let the reader decide — is
defensible and noisier. Per-notification coverage is kept either way, so the choice is
reversible without losing information.

**Arrival time appears exactly once, and it is about the engine.** `IntakeRun.at` and
`lastCompletedRunArrivedAt` are arrival, named so they cannot be mistaken for event time;
"is the engine still running" is a question about the engine, not about the events. Every time
a decision could be made on is an `EventInstant`.

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
   against `lastCompletedRunArrivedAt`. If they move together across a backfill, something is
   stamping on arrival.
3. **Did coverage arrive as FULL for everything?** That is the signature of coverage being
   dropped at the seam rather than of a genuinely clean tenant.
