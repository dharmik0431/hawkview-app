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

## Six decisions, all ruled

Recorded with the reasoning because the reasoning is what a later reader needs, and
because one answer was neither of the options put forward — which is worth keeping
visible rather than tidying into the answer that won.

- **D1 — subject of the incident key. RULED: declared per type, not chosen
  globally.** The question was asked as "target or actor", and both global answers
  fail in opposite directions: target everywhere turns one compromised admin into
  twelve pages, actor everywhere collapses every attacked account in a tenant into
  one unknown-actor incident and *hides* an attack rather than duplicating it. So
  the role is part of the type declaration, required so the compiler enumerates.
  An unresolvable subject does not group at all. Implemented above; the table of
  roles is in *Layer two, part two*.

  Worth noting as method: the recommendation offered was "target, loosely", and it
  was wrong in a way that only showed up when the two failures were put side by
  side. Asking rather than filling it in is what produced the better answer.
- **D2 — quiet interval. RULED TWICE**, and the second ruling is the one that
  stands. The first said "derive from the declared window, never a second constant,
  fail loudly when there is none". Implementing it exposed that six of the seven
  types state no window, including both directory-change types — so episodes were
  underivable for exactly the types the step exists for.

  The revised rule: **derive where the two numbers mean the same thing, declare
  where they do not.** A type resolving on a quiet timeout derives and may not also
  declare; a type resolving on an observation declares explicitly, with reasoning.
  The rule against second constants is about two numbers meaning ONE thing — and
  "how long until I believe it is over" is not "how long a gap means the next
  activity is a new burst". See *Both paths, and the compiler decides which*.
- **D3 — backwards growth. RULED: keep symmetric**, with a presentational
  obligation attached — an episode span may never be shown as a single date.
- **D4 — a resolved investigation opens a new episode regardless of timing.
  RULED: yes**, and confirmed factually rather than assumed: `decideRecurrence`
  case 1 returns `OPEN_LINKED_EPISODE`, and removing that branch fails three
  independent checks.
- **D5 — scope. RULED: pure functions, no migration.** The `notifications` table
  is step 03's.
- **D6 — episode duration. RULED: no cap.** A cap invents a boundary the evidence
  does not contain, which is a manufactured episode reached from the opposite
  direction. Duration is not the signal; recency is — hence D3's presentational
  obligation. The characterisation test stays, so adding a cap must break a test
  rather than quietly redefine what one incident means.

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

## Layer two, part two: the incident key

`backend/src/alerts/alert-incident-key.ts`. The other half of the pair — it answers
"which incident is this" and contains no event identifier, so it is structurally
unable to deduplicate. The event key cannot group; this cannot deduplicate. Both
inabilities are asserted.

### The subject is declared per type, and both global answers fail

| alert type | subject | why |
|---|---|---|
| `security.suspected_credential_attack` | **TARGET** | the account attacked; failures come from many addresses and often resolve to nothing, so the attacker is not a subject that groups |
| `security.privileged_directory_change` | **ACTOR** | one compromised admin touching twelve accounts is ONE incident |
| `security.routine_directory_change` | **ACTOR** | a bulk operation by one person is one record |
| `monitoring.tenant_disconnected` | **TENANT** | nobody performed it and nothing was targeted |
| `monitoring.consent_expiring` | **TENANT** | consent is granted per tenant |
| `monitoring.collector_failing` | **COLLECTOR** | two collectors failing for two reasons are two fixes |
| `monitoring.recovered` | **COLLECTOR** | recovery is observed per feed |

Neither global answer survives contact with the catalogue, and they fail in opposite
directions. **Target everywhere** turns one compromised administrator into twelve
pages — the 301 problem rebuilt, at the tier that pages, by the step built to
prevent it. **Actor everywhere** collapses every attacked account in a tenant into
one unknown-actor incident, which *hides* an attack rather than duplicating it.

`subject` is a **required** field on `AlertTypeDeclaration`, so the compiler
enumerates every type and nothing inherits a default. Removing one produces
*"Property 'subject' is missing … but required in type 'AlertTypeBase'"*, naming the
type that failed to answer. Same shape as `conditionClears`.

`COLLECTOR` is the one place this extends the ruling, flagged rather than folded in.
The ruling paired "tenant & collector health" under TENANT; the catalogue splits that
across two types, and giving `monitoring.collector_failing` a TENANT subject merges
unrelated collectors into one incident — the 334-into-15 collapse one category over.

**The loss, stated rather than discovered:** cross-class correlation is unavailable.
"Y attacked X on Monday and granted themselves a role on Tuesday" is not expressible
by any per-class key. Deferred, not overlooked.

### An unresolvable subject does not group

It stands alone, labelled unattributed, carrying *why* it could not be resolved.
Merging on "unknown" would say "these are the same incident" on the strength of not
knowing who was involved in either one. Standing alone asserts nothing. Rising
unattributed volume is then a visible signal to fix attribution rather than a silent
merge to find later.

`wouldGroupTogether` returns **false** for two non-grouping events, because the
alternative reintroduces the unknown-subject merge through the back door.

### Why the role is in the key when it is derivable from the type id

A declaration can change. Events keyed under an old role must not join episodes
keyed under the new one — that would merge "who did this" with "who it was done to"
inside one incident, at the moment of a one-word edit.

### Both paths, and the compiler decides which

`alert-episode-interval.ts`. Two ways a type gets an episode interval, and which one
it takes follows from its resolving condition:

| resolving condition | interval |
|---|---|
| `NO_FURTHER_EVENTS_IN_READABLE_WINDOW` | **derived** from `windowHours` |
| any observation (`CONFIGURATION_RESTORED`, `COLLECTOR_REPORTS_SUCCESS`, …) | **declared**, with reasoning |

The first ruling was derive-only, and implementing it surfaced the problem: **six of
the seven types resolve on an observation**, including
`security.privileged_directory_change` and `security.routine_directory_change` —
precisely the 301-alert and 334-occurrence cases this step exists to fix. A
derive-only rule left episodes underivable for the types that needed them most.

What the revision turns on: the rule against second constants is about two numbers
meaning **the same thing**. "How long until I believe it is over" and "how long a gap
means the next activity is a new burst" are different facts about a type, and stating
both is not duplication. For a quiet-timeout type they *are* the same number, so that
type derives and **may not also declare one** — two numbers meaning one thing is
exactly what drifts.

**Both constraints are compile errors, not conventions.** `EpisodeGrouping` pairs the
resolving condition with the interval in one union: `episodeInterval?: never` on the
timeout variant makes declaring a second number unwriteable, and a required
`episodeInterval` on the observation variant makes omitting one unwriteable. Two
`@ts-expect-error` directives hold those, and both are load-bearing — weakening
either variant makes its directive unused and **fails the build**, which is how that
was verified rather than asserted.

`quietIntervalMsOf` is consequently **total**. It used to throw; the guarantee moved
from a runtime check to the type, and a guard reachable only by a deliberate cast is
a guard whose test must fabricate a shape the type forbids.

One implementation note worth keeping, because the compiler taught it: the function
narrows on **the interval's presence**, not on the condition's kind. `conditionClears`
cannot discriminate this union — the observation variant's condition is itself a union
of four kinds, so there is no single literal at that path — and a check on it leaves
`episodeInterval` possibly undefined. The compiler refusing the first version was
right: it could not see that a non-timeout condition guarantees an interval, and nor
could a reader.

### The value is 24 hours, and the measurement is why

Gaps between consecutive directory changes by the same actor, **761 gaps** across the
fleet:

| gap | count | share |
|---|---|---|
| within 1 hour | 595 | 78% |
| 1 to 24 hours | 40 | **5%** |
| beyond 24 hours | 126 | 17% |

p50 0.0h, p90 76h, p95 166h.

**The distribution is bimodal with a valley.** Changes arrive in bursts inside an
hour, then nothing for days. Only 5% of gaps fall anywhere in the entire 1-to-24-hour
range, so **any interval in that range produces nearly the same grouping** — the
choice is robust rather than tuned, which matters more than the number itself.

24h sits at the far end of that valley, for three reasons:

- it errs toward **grouping rather than splitting**, and over-splitting is the
  301-alert problem this work exists to fix;
- it **matches the credential-attack window**, so the product has one notion of quiet
  rather than two;
- the risk over-grouping would normally carry — a new attack silently joining a closed
  incident — is **already closed independently** by D4: activity after a resolved
  investigation opens a new linked episode regardless of timing.

**Four of the six declared intervals are not measured, and they say so.** No gap
distribution was collected for the monitoring types, and this work does not query
production. They take 24h to keep one notion of quiet across the product, which is a
reason rather than evidence. A test asserts every declared interval states which it
is, that the measured ones carry the distribution rather than the conclusion, and that
**an unmeasured one may not cite the measurement** — because a borrowed number and a
measured number should not read alike.

### Presentational obligation, carried here so it is not lost between layers

Episode duration is unbounded by ruling — no cap — because a cap invents a boundary
the evidence does not contain. What makes a long episode safe is recency, not
duration, so: **an episode span may never be rendered as its open date alone.**
"Ongoing since 1 September, last activity two minutes ago" is actionable. "Since 1
September" reads as stale and gets ignored, which is the failure this feature exists
to prevent. This is a requirement on whoever renders an episode.

### What to check first when this breaks

- **Two things that should be one incident are two.** Compare the groupings, not the
  keys — `wouldGroupTogether` exists because the interesting property is a relation
  between two events, and asserting on the opaque string is a shape assertion that
  goes green on any encoding change while saying nothing about whether they group.
- **A flood of single-event incidents.** Check the unattributed rate before the
  boundary logic. An unresolvable subject does not group by design, so a drop in
  subject resolution looks exactly like a loss of grouping.
- **Grouping that vanished after a catalogue edit.** The declared role is part of the
  key. Changing a type's subject re-keys every future episode for that type, which is
  intended and total.
