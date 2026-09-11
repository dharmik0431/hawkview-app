# Alerting, step 02: deduplication and incident grouping

Step 01 is in `alerting-lifecycle.md`. That document is the authority for which
changes matter and what tier they sit in; the code is the authority for how a
rule behaves. This one follows the same split.

**Status: partial.** The two pieces below are built and tested. The incident key
is not, and the reason is at the bottom — five decisions are product decisions
rather than implementation ones, and filling them in with whatever is convenient
is how step 01's defects would have shipped.

## What was wrong: one field doing two jobs

The existing system has a single `dedupeKey`, and its behaviour depends on
whether whoever wrote the string happened to include an event identifier:

| key shape | contains event id | measured result |
|---|---|---|
| `tenant:{id}:sync:{resourceType}` | no | 334 occurrences → 15 alerts |
| `security:directory-audit:{microsoftAuditId}` | yes | 301 events → 301 alerts |

Same field, opposite behaviour. The one that groups cannot deduplicate; the one
that deduplicates cannot group. Both jobs are necessary, so both get a key.

## Layer one: the event key is idempotency, and cannot group

`backend/src/alerts/alert-event-key.ts`. Answers "have we already processed this
exact event" and is deliberately unable to answer "which incident is this". A
test asserts the inability, because a key that quietly acquired grouping powers
would reintroduce the defect above.

It is not redundant with the storage constraint.
`directory_audit_logs.@@unique([customerTenantId, microsoftAuditId])` stops the
same audit row being *stored* twice. It says nothing about whether an alert was
already *raised* from it.

Components are length-prefixed (`5:org-1`) rather than joined by a separator.
A plain `a:b:c` join is ambiguous the moment a component may contain the
separator: organization `x:y` + tenant `z` produces the same string as
organization `x` + tenant `y:z`. In an idempotency key that is a cross-tenant
collision, and its symptom is a real alert silently suppressed in one
organization because an unrelated event was seen in another — not an error
anybody would see. Microsoft identifiers are not obviously colon-free, and
assuming costs more than prefixing.

## Layer two: the episode boundary

`backend/src/alerts/alert-episode.ts`. Built before anything depends on it,
because grouping without a boundary is its own bug: an attack next month
silently joins last month's closed incident and nobody is told.

**The span is a watermark that advances with every event.** It is never stamped
when the episode opens. This arrived from QA as a binding rule rather than a
suggestion, and the reason it needed stating is that the stamped reading is the
easier one to build: its consequence only shows up on the *second* event, which
falls outside its own episode's span. A backfill landing between the first and
the second then reads as new — a live attack manufactured out of a late
delivery, which is the precise failure the no-arrival-time rule exists to
prevent.

**The span grows in both directions, and that is a decision.** The watermark
rule names the forward edge. An out-of-order event earlier than `firstEventAt`
is the other one, and leaving that edge fixed would mean a backfilled event that
plainly belongs to an episode opens a second one beside it — the same
manufactured-episode failure arriving from the other side. So an event joins
when its own time is within the quiet interval of the span on *either* side.

**Boundaries are decided by event time, explicitly not arrival order.** The
`EventInstant` brand is only half the protection: it stops an implementation
reading the wrong timestamp and does nothing about one treating
most-recently-delivered as newest. Nothing here consults order of any kind, and
a test feeds the same events in three delivery orders and asserts one answer.
A second test varies `receivedAt` wildly — including a backfill received three
years late — and asserts the episodes do not move.

**The quiet interval is a parameter, not a constant.** See D2.

### Mutation results

Green tests are not evidence until they fail for the right reason. Each rule was
reverted and the suite re-run:

| mutation | killed by |
|---|---|
| watermark never advances (span stamped at open) | the watermark test, the second-event test, the order test |
| span does not grow backwards | the backfill test |
| `episodesOf` respects delivery order (sort removed) | the order-independence test |
| off-by-one at the quiet boundary | the quiet-interval test |
| `quietMs` ignored, 24h hardcoded | the quiet-interval test |

Each guard also has a demonstrated non-firing: the watermark test asserts a
genuine gap still *ends* an episode, and the backwards-growth test asserts a far
enough backfill still opens a separate one. Otherwise "advances" would be
indistinguishable from "never closes", and "grows backwards" from "swallows
history".

## Five decisions that are not mine to make

These are outstanding with PM. The incident key and the quiet interval both
depend on them, so neither is written.

- **D1 — subject of the incident key: target or actor?** `DirectoryAuditLog`
  carries both `initiatedBy` and `targetResources`. Keying on the target groups
  "this account was attacked"; keying on the actor groups "this account is
  attacking". They produce different incidents from the same events and there is
  no key that does both. *Leaning target, loosely.*
- **D2 — what quiet interval closes an episode?** Recommend deriving it from the
  type's declared `NO_FURTHER_EVENTS_IN_READABLE_WINDOW.windowHours` (24h for
  the credential attack type) rather than introducing a second notion of quiet
  beside the one each type already declares. A second constant would be free to
  drift from the first, and the drift would show up as incidents that resolve
  and regroup.
- **D3 — does an episode span grow backwards?** Implemented symmetric, reasoning
  above. Recorded as a decision rather than buried, because it is reversible and
  someone should disagree with it now rather than after data exists.
- **D4 — does a resolved investigation open a new episode regardless of timing?**
  Step 01's `decideRecurrence` already says yes (case 1, `OPEN_LINKED_EPISODE`)
  and PM approved it. Treating it as settled unless told otherwise.
- **D5 — scope.** Staying with pure functions as step 01 did; the `notifications`
  table has no episode column and a migration is step 03's. Taken as settled by
  "scope to the alerts folder and docs".

## What to check first when this breaks

- **An incident that should have split, didn't.** Check the quiet interval being
  passed, not the boundary logic — `placeEvent` reads its parameter and a test
  proves it.
- **An incident split that shouldn't have.** Check whether the events actually
  share a subject before suspecting the boundary. Two subjects is two episodes
  by construction, and that is the layer above this one.
- **A burst of incidents appearing at once.** Look at `collectorLagMs` before
  assuming an attack. `arrivedLate` exists to tell a reader "these arrived
  together because a collector caught up" — the episodes themselves are already
  placed by event time and will be spread across the real dates.

## Two things found after the boundary was built

### The separator earns its place, and a shape test would not have shown it

`joinUnambiguously` now lives in `backend/src/alerts/alert-key-encoding.ts`
rather than inside the event key, because the incident key needs the same
guarantee and a copied security primitive is the arrangement where one copy gets
fixed.

Mutating it four ways exposed a weakness in the tests rather than in the code.
Three mutations — plain colon join, no delimiter, length in characters — died to
collision assertions. The fourth, *keeping* the length prefix but dropping the
`:` between prefix and content, died only to a test asserting an exact output
string. That is a shape assertion, not a behaviour one, and it would have gone
green the moment anyone reformatted the encoding.

So the question was whether `${len}${part}` is actually unsafe. An exhaustive
search over short components said it was injective, which was the uncomfortable
answer — the separator might have been decoration. Extending the search to
strings with multi-digit lengths produced the pair:

```
['1','1','1','1','1','11']  and  ['11111111211']
both encode as "1111111111211"
```

Two distinct tuples, one key. The separator is load-bearing, and there is now a
test that says so by exhibiting the collision rather than by pinning a string.
It is not a pair anybody would have thought of; it came out of a search.

### Episode duration is unbounded

Raised by QA, confirmed here against the built code:

| events | episodes |
|---|---|
| two, 30 days apart | 2 |
| the same two, with a 23h trickle between them | **1, spanning 30 days** |
| the same two, with a 25h trickle between them | 29 |

A dense enough trickle keeps the watermark advancing and merges arbitrarily
distant activity into one incident. This is inherent to any quiet-interval rule
and is **not** an argument against symmetric growth — a forward-only span does
exactly the same thing. The third row is the control: it is the interval doing
this, not merging being unconditional.

The code does what it says. The open question is a product one — whether a
single incident spanning a month is a useful thing to hand an MSP, or whether
episode duration needs a cap. **D6**, and the answer is not the engineer's.

A characterisation test records the current behaviour, so that adding a cap is a
change that visibly breaks a test rather than a silent redefinition of what one
incident means.
