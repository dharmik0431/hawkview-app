# Alerting, step 01: the lifecycle and what severity means

## What was wrong

HawkView already alerts. Measured in production across five tenants:

```
364 notifications · 353 unresolved · none ever acted on
301 of them one event type that cannot deduplicate
  0 from the findings most worth acting on
```

Adding email to that would send 317 unclosable duplicates to somebody's phone.
Four defects underneath it: events are deduplicated but incidents are not grouped,
nothing ever resolves, severity is decorative, and nothing leaves the application.

This step builds none of the delivery. It defines **how an alert ends**, and
writes it as code the later steps cannot ignore.

## Three independent axes, not three states

```
Ownership           unacknowledged · acknowledged        set by a person
Observed condition  active · cleared · unknown           set by the system, from evidence
Investigation       open · resolved · none               set by a person, for security findings
```

`none` on the investigation axis means this alert never opened one — a record. It
is not a third way of being closed, and it exists because **neither other value is
correct for a record**, which only became visible once records were allowed to
escalate. `open` would put every routine directory change in the queue nobody can
empty, which is the 301 defect rebuilt. `resolved` is worse and quieter: it reads
as "a person closed this", and the recurrence rules would then open a new linked
episode on *every* recurrence — an episode manufactured per event.

**A three-valued state read by two-valued code fails in one direction.** Anything
that asks "is this resolved?" and treats *not OPEN* as yes will read a record as
resolved. There is no second reader today, so this is not a defect — it is a note
for whoever writes 02 through 04, because that reader is coming. Ask
`investigation === 'RESOLVED'`, never `!== 'OPEN'`.

They are orthogonal. An acknowledged investigation can have an active condition. A
cleared condition does not close an investigation.

**Written as a product type, not a union.** As `type AlertState = 'ACKNOWLEDGED' |
'CLEARED' | 'RESOLVED'` the axes become mutually exclusive by construction, and
every later reader has to guess which combinations are legal. As three fields all
eighteen combinations are representable, and each transition function names the
single axis it touches — so independence is a property of the type rather than a
rule in a comment. `alert-lifecycle.test.ts` sweeps all eighteen.

Today's `notifications.resolvedAt` is one nullable timestamp doing all three jobs,
which is why "went quiet" and "was dealt with" are currently the same value.

## Missing collection moves the condition to UNKNOWN and touches nothing else

The rule the whole plan turns on. **Lockouts stop when an attack stops, and they
also stop when collection stops** — the events are identical in both cases,
because in both cases there are none.

So auto-clearing requires *fresh, readable evidence that the condition cleared*.
Absence of events is not that. Without readable evidence the condition is
`UNKNOWN`, which is a different sentence and a different colour from `cleared`,
and **ownership and the investigation are left exactly where they were**. Someone
who acknowledged an incident still owns it when the feed goes quiet.

`applyObservation` takes its evidence from **`evidenceFromSync`** — the same
function the Risky Users engine uses to decide whether a stream may be read at
all. Reused deliberately: a second notion of "can we still see" living here would
drift from the first, and then two layers would disagree about whether a tenant
was quiet or dark.

## Operational may auto-close. Security may not. This is a compile error.

A collector that succeeds has demonstrably recovered, and holding that open is
noise that teaches people to ignore the queue. An account that stopped being
attacked has **not been shown to be safe** — a cleared condition is evidence the
activity stopped, never evidence the account is clean.

Declaring a `SECURITY` alert type that closes itself does not typecheck. Verified
by trying it: changing the credential-attack declaration to
`AUTOMATICALLY_WHEN_CONDITION_CLEARS` exits `tsc` non-zero. The rule cannot be
lost to a careless copy-paste of an operational declaration.

Note the two halves stay separate even for security types: the **condition** still
clears on evidence, because that is an observation and it is true. Only the
**question** stays open.

## What every alert type declares before it may exist

| Field | Why it is required |
|---|---|
| `conditionClears` | An alert type that cannot say what makes it stop is not ready to be built. |
| `escalations` | What new evidence materially changes what this is. |
| `category` | Decides whether it may auto-close. |
| `severity` | Defined by **required action**, not by how bad it sounds. |
| `opensInvestigation` | Whether it belongs in a queue at all. |

**Severity is `ACT_NOW · ACT_TODAY · RECORD_ONLY`,** and the routing tier follows
from it rather than being chosen separately. The current vocabulary is `info ·
low · medium · high · critical`; 301 alerts are marked `high` and have been unread
for weeks. A severity nobody acts on is not a severity — it described the author's
feeling about an event rather than what the recipient should do. These names cannot
be read that way.

**There is no `OCCURRENCE_COUNT` escalation signal, and that absence is the rule.**
More of the same updates quietly; escalation is for evidence of a different
character — a success following the failures, a privileged subject, corroboration,
spread. A type that could escalate on volume would reproduce exactly what turned
301 events into 301 notifications.

**No member of `ConditionClearedWhen` means "went quiet".** The one that is about
an absence says `NO_FURTHER_EVENTS_IN_READABLE_WINDOW` in its own name, and
`applyObservation` will not act on it without readable evidence — so a type cannot
opt out of the silence rule by wording its resolving condition carefully.

## Recurrence: six cases

| Situation | Behaviour | Notifies |
|---|---|---|
| More of the same on an open incident | Update quietly | No |
| Evidence that **changes what this is** | Same incident, escalated | Yes — **one** per signal, however many events crossed it |
| Activity after the condition cleared | Reactivate the condition | Yes |
| **Activity after a collection gap** | Resumed after gap | **Yes** — see below |
| A **record** gains escalating evidence | Becomes an investigation | Yes |
| Activity after a **resolved** investigation | New linked **episode** | Yes, never a silent reopen |

The resolved case is checked first and outranks everything, including an
escalation that has already been reported. Without that, an attack next month
silently joins last month's closed incident and nobody is told.

**A new episode starts UNOWNED.** It does not inherit the prior acknowledgement.
Ownership means a person said they own *this*; carrying it forward is the system
deciding somebody owns a thing they have never seen, and it hides the new episode
from the one queue built to catch it. The starting lifecycle is returned on the
outcome rather than left to the grouping step, because it is the kind of detail
that otherwise gets filled in with whatever was convenient.

### A gap must not become a way to silence an incident

Activity arriving after a period HawkView could not see **notifies**, and it is
checked before escalation deduplication so a signal already reported for this
episode cannot swallow it.

I first wrote this the other way — quiet — reasoning that otherwise every
collector catch-up would send a notification. **The reasoning was wrong, not
merely debatable.** `decideRecurrence` runs only when matching evidence *arrives*,
so the branch never fires on a quiet recovery; it fires exactly when activity
reappears after a blind spot. Under that rule, breaking collection was enough to
make an incident go silent when it came back — looking away was a way to silence
it, which is the opposite of what the `UNKNOWN` condition exists for.

It has its own action rather than borrowing reactivation's, because the message
differs: nothing cleared, we simply stopped being able to look.

## Episode and urgency come from the event's own time

One collector is 400 hours behind. A backfill landing at once must not read as an
attack happening now.

**Enforced by the type, not by convention.** The first version took
`occurredAt: Date` and relied on callers passing the right one — but `receivedAt`
is also a `Date`, so the wrong one typechecked. That is arrival time being
*present and ignored*, which is the arrangement that decays: the next person sees
two Dates and reaches for whichever is in scope.

`urgencyOf` now takes an `EventInstant`, produced only by `eventInstant()`, which
reads only `occurredAt`. `urgencyOf(time.receivedAt, now)` does not compile. The
test asserts this with a `@ts-expect-error`, so if the parameter is ever widened
the directive goes unused and **the build fails** — verified by trying it.

A deliberate `as` cast still defeats it; nothing in TypeScript survives that. What
it prevents is the way it would actually happen.

`collectorLagMs` exists for diagnostics and returns a duration rather than an
urgency, so the two cannot be confused at a call site. A live event from a lagging
collector is still live — lateness is a property of the feed, not of the event.
Arrival time is still recorded, because it is genuinely useful; the constraint is
on the **decision path**, not on the system.


### What counts as cleared must not be weaker than what was claimed

`monitoring.tenant_disconnected` says *"HawkView cannot see this tenant"*. It
clears on `EVERY_COVERED_SOURCE_READABLE`, and it previously cleared on
`CONNECTION_VERIFIED`, which was wrong in a way worth recording.

A verified connection is positive evidence rather than an absence of complaints —
that part was right. But *collection can resume* is a weaker claim than the one the
alert opened on. The inverse of cannot-see is **evidence arrived**, not the
handshake works. The failure is concrete: a tenant reconnects with narrower
consent, or reconnects cleanly while one collector still returns
`PERMISSION_REQUIRED`. The connection verifies, the alert closes, and an MSP has
been told their visibility came back when part of it did not.

`COLLECTOR_REPORTS_SUCCESS` would not have fixed it either: it is satisfied by
**any one** collector succeeding, which is the same partial visibility in different
words. The plural in `EVERY_COVERED_SOURCE_READABLE` is the whole content of it.

**How long that leaves an ACT_NOW open**, measured from the scheduler rather than
estimated:

| Path | Latency after reconnect |
|---|---|
| Incremental (`USERS`, sign-ins) | ~5 min — `USER_INCREMENTAL_REFRESH_MS` is 5 min and the heartbeat is 5 min |
| Daily anchors (`LICENSES`, `DOMAINS`) | due immediately if >24h stale, but attempts are spaced by `DAILY_INVENTORY_FAILURE_RETRY_MS` — so up to ~1h |
| Bounded transient-retry resources | 30 min base, doubling to a 6h cap, after repeated transient failures |

A tenant disconnected long enough to raise an `ACT_NOW` is already past the 24h
daily window, so its anchors are due at the next heartbeat. There is no five-hour
schedule anywhere; the only route to hours is the transient-retry backoff, and
permission-shaped failures are explicitly excluded from that set.

**The two-stage version needs no new machinery, because the axes already separate
it.** "Stop paging" is a notification decision and belongs to routing in step 05;
"resolve" is the condition and investigation axes. A connection verifying can stop
the paging without clearing the condition, and nothing here has to change for that
to become possible later.
### Arrival *order* is a second, subtler mistake

Using arrival **time** is caught by the brand. Using arrival **order** is not: an
event delivered *after* a backfill, whose own time is later, is the newer event —
the arrival order of the two is identical, and only the event times differ. Code
that treats "most recently delivered" as "newest" is correct on every in-order
feed and wrong on exactly the feed we have.

`compareByEventTime` and `newestByEventTime` read `occurredAt` only, so a caller
that sorts with them cannot accidentally sort by delivery. **Episode boundaries
are step 02's to compute; these are the primitives to compute them with**, placed
here because it is the same rule as the urgency one and belongs beside it rather
than being reinvented there.

## Two things found by building it

**1. A `RECORD_ONLY` security event would have been unclosable.** The plan puts
routine directory activity in the in-app tier and says security investigations may
only be closed by a person. Those two rules together put every routine record into
a queue only a person can empty — which is precisely what 301 of the current
alerts are. So `RECORD_ONLY` types open no investigation at all: they have an
owner and an observed condition, and belong in a searchable list exactly as the
plan says a record should. The pairing is asserted in `alert-catalog.test.ts`.

This is the degenerate-input check applied to a plan rather than to a rule. Both
rules are individually correct and were reviewed; **combining them produced a
broken one**, and reviewing them one at a time could not have found it.

**"Records do not open investigations" is a DEFAULT, not a prohibition.** When a
record gains evidence that crosses an escalation threshold — corroboration from a
second source, spread across subjects — it becomes an investigation and somebody
is told. Without that, a routine change that turns out to be the first step of
something would be structurally un-investigable, and we would have traded one dead
end for another.

Two details follow, both tested. The promotion opens **unowned**, for the same
reason a new episode does: nobody has yet looked at this *as* an investigation,
and pre-filling an owner hides it from the queue it just joined. And the
escalation-deduplication list is deliberately **not** consulted for a promotion —
crossing a threshold for the first time on a record is the moment it stops being a
record, and deduplication has no business answering that question.

**A promotion belongs to an episode, not to the type.** A record that promoted
once must not have every later episode born as an investigation. That defect was
real and is now tested: after promotion the lifecycle reads `RESOLVED` once a
person closes it, which is indistinguishable from an ordinary resolved incident —
the lifecycle no longer remembers having been a record. The new episode therefore
opened as an investigation, so **one escalation promoted every future routine
change on that incident key with no escalating evidence of its own.** Escalate
once, escalate forever, which is the 301 problem re-entering through the fix for
it. `decideRecurrence` now takes `opensInvestigationByDefault` from the
declaration, because the lifecycle genuinely cannot answer it.

That also settles why skipping the deduplication list for a promotion is safe
rather than merely tidy. Promotion happens at most **once per episode** — after it
the investigation is `OPEN` and the record branch is unreachable — and
`alreadyEscalated` is scoped per episode too, so it can never legitimately hold a
promotion belonging to the episode being decided. A later episode may promote
again on its own evidence, which is correct.

**2. I got the collection-gap rule backwards, and QA caught it.** I had activity
arriving after a gap update *quietly*, reasoning that otherwise every collector
catch-up would notify. That premise is false — the function only runs when
evidence arrives — so the rule I wrote made a collection gap into a way to silence
an incident. It now notifies, with its own action. The corrected rule and the
reason are above; it is recorded here because the mistake is more instructive than
the fix: the argument sounded like noise-reduction and was actually a hole.

## The privileged-change policy is PROPOSED, not settled

The plan lists "which directory changes are privileged?" as an open question that
must be answered before step 01 can finish, and names role assignment,
authentication policy and application permission grants. That list is now in
`PRIVILEGED_DIRECTORY_CHANGES` — in code, because a policy in a document is one
nobody can diff.

**It needs sign-off before step 05 routes anything on it**, because it decides
what rings a phone. Each entry carries the three tests revision 3 requires of a
phone-tier candidate: **context** (was this expected?), **persistence** (has it
lasted?) and **urgency** (does delay make it worse?). Without the context test, a
privileged role assigned during a scheduled onboarding would ring a phone.

## What to check first when it breaks

**Symptom: an alert resolved itself and nobody believes it should have.** Check
the declaration's `category`. A `SECURITY` type cannot auto-close, so if one did,
either the category is wrong for that type or `mayAutoClose` is being passed
`true` by a caller that decided for itself instead of reading the declaration.
`applyObservation` takes `mayAutoCloseInvestigation` rather than a category for
exactly this reason — there is one place that derives it.

**Symptom: something went quiet and the alert cleared.** That should be
impossible: clearing requires `evidence.read === true`. Check what
`evidenceFromSync` returned for the collector behind it — a `FAILED` or `STALE`
collector must produce `UNKNOWN`, not `CLEARED`. If it produced `CLEARED`, the
caller is synthesising an evidence disposition instead of deriving one from sync
state.

**Symptom: a burst of notifications after a collector caught up.** Check whether
urgency is being taken from `receivedAt`. It cannot be through `urgencyOf`, which
has no such parameter — so look for a caller computing its own age.

**Symptom: the queue is filling with things nobody can close.** Check
`opensInvestigation` on the type. A `RECORD_ONLY` type that opens an investigation
is the 301 defect returning, and `alert-catalog.test.ts` fails if one does.

## Out of scope for step 01, deliberately

Nothing here publishes, groups, migrates or delivers anything.

- **Event deduplication and incident grouping, with episode boundaries** — step 02.
  This step defines what an episode *means* for recurrence; computing boundaries is
  02's, and needs its own tests before anything depends on it.
- **Reconciling the existing 364** — step 03, dry run and reversible mapping first,
  and no historical alert delivered during migration.
- **Connecting Risky Users findings** — step 04.
- **Routing, recipients, email, SMS** — 05 through 07.

The existing `notifications` table is untouched. Mapping these three axes onto
storage is part of 02, and it will need a migration: `resolvedAt` alone cannot
express them, and `notification_user_states` carries `readAt`/`dismissedAt` rather
than an acknowledgement.
