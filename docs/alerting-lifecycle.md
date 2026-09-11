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

**`conditionClears` IS NOT YET CONSULTED BY ANYTHING.** Nothing reads it outside
this catalogue and its type. `applyObservation` takes the evidence and a
`conditionCleared` boolean the caller computed, and never looks at the
declaration. So at step 01 the field gates construction and states intent — an
alert type that cannot say what makes it stop still cannot be added — but it does
not enforce that a caller's `conditionCleared` was computed the declared way.

Said plainly because the alternative is that 02's author reads a declaration and
assumes a mechanism. Connecting the two is their work, and a declaration that
looks load-bearing and is not is exactly the shape this plan keeps finding.

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

## The privileged-change policy, approved with corrections

The plan lists "which directory changes are privileged?" as an open question that
must be answered before step 01 can finish, and names role assignment,
authentication policy and application permission grants. That list is now in
`PRIVILEGED_DIRECTORY_CHANGES` — in code, because a policy in a document is one
nobody can diff.

**Approved, with six corrections** — two of which were defects rather than
refinements. The decisions are implemented in `privileged-change.ts` and described
under *Classifying a privileged directory change* below; this block remains the
statement of why each kind of change is on the list at all. The classifier says
what happens; this says what it is for.

### Expectedness is not applied anywhere in this policy

Each entry originally carried a **context** test — suppress when the change matches
a recorded onboarding or change window. Both are gone, and the second reason is the
one that decides it.

**The failure direction.** HawkView does not know what an MSP planned, so any
expectedness test is a guess, and a guess here fails as *silence during a real
compromise* — the failure this whole plan exists to remove. A privileged role
granted during genuine onboarding costs an MSP one dismissed notification; the
reverse mistake costs them a tenant. There is no volume argument to justify the
trade either: the urgent tier measures **25 events across 68 days and 5 tenants**.
There is no burst to suppress.

**And there are no recorded change windows.** The feature does not exist. So the
clause suppressed nothing at all while reading exactly like a safeguard — a guard
that cannot fire, sitting in the document steps 02 through 05 will be built from.
That is worse than a wrong rule, because it looks handled.

Each entry now carries only what can be decided from evidence HawkView holds:
**persistence** and **urgency**. `alert-catalog.test.ts` asserts the absence of a
`context` field, because an absence only stays absent if something checks.

One finding from the measured replacement worth carrying: tenant-wide admin consent
was going to be urgent on its own evidence, and it **fires 47 times** in production
— consent on behalf of all users is simply how an administrator approves an
application. It is now a multiplier on a sensitive permission rather than a
trigger. Reasoned as exceptional, measured as the ordinary path.


## Every declared condition is satisfiable, and that is checked

The stated-condition sweep in `alert-catalog.test.ts` is **a spelling test**, and
it is labelled as one. `assert.ok(condition.kind)` passes on any non-empty string,
including a kind naming a state the system can never be in; the sentence-length
checks prove the prose is real and cannot prove that what it names is reachable.

`alert-clearing.test.ts` is the check. For every declared kind it exhibits **one
state that satisfies it and one that does not** — both, because a witness that
always returned true would report every condition satisfiable, which is the same
vacuity one level up.

This matters in one direction especially. A condition too strong to satisfy
produces an alert that never auto-clears, and **this feature exists because 353
alerts never cleared.** Strictness was the right call on `tenant_disconnected`; the
unchecked half of it was a phone-tier page that could never close.

**Nothing is allowed to weaken a condition to pass this control.** Weakening
`EVERY_COVERED_SOURCE_READABLE` back toward `COLLECTOR_REPORTS_SUCCESS` would make
the control green by restoring the defect it was ruled out to fix — so that path is
itself asserted against: the mutation fails a test in `alert-catalog.test.ts`. If a
condition ever cannot be satisfied, the finding is a defect in the declaration.

**A vacuous truth found while writing it.** `every` over an empty list is true, so
a tenant whose every source is unlicensed or permission-blocked would have
satisfied "every covered source is readable" while HawkView could see nothing at
all — a page claiming visibility came back, closing on a tenant it cannot see.
`everyCoveredSourceReadable` requires at least one covered source.

## Classifying a privileged directory change

Approved with corrections and implemented in `privileged-change.ts`. Three
outcomes, not two.

| Outcome | Means | Routes |
|---|---|---|
| `URGENT` | a privilege path, on evidence | `ACT_NOW` |
| `ROUTINE` | recognised and ordinarily unremarkable | `RECORD_ONLY` |
| `UNCLASSIFIED` | **we do not know** | `ACT_TODAY` — with one exception |

**`UNCLASSIFIED` exists because unlisted is not the same as harmless.** A
permission missing from the sensitive list is not thereby read-only; an
unresolvable role id, a custom role, an unfamiliar permission string and an
unparseable policy change are all *unknown*, and falling through to routine would
be absence of evidence read as evidence of absence. The product already refuses
that everywhere else — a count that cannot be determined is `NOT_AVAILABLE`, never
zero. Each unclassified outcome carries the token nobody could classify, so the
set can be surfaced and **shrunk** rather than accumulating.

It routes at email tier because otherwise every permission string Microsoft invents
rings somebody at 2am, and the tier decays in exactly the way this plan exists to
prevent. **The exception: an unresolvable role on a role-assignment activity is
urgent.** The activity has already told us it is a privilege grant; only the
magnitude is unknown, which is not a reason to wait.

### HawkView is not exempt by application id

Suppressing every grant to our own registration would make HawkView the single
blind spot in the tenant — an unexpected permission increase to our own AppId, or a
credential added to it, is the most alarming event there is, and we would have said
nothing. The exemption is our AppId **crossed with the permissions we actually
request**, which is a precise allow-list rather than a heuristic and is strictly
narrower.

That set is **derived from `MICROSOFT_APPLICATION_PERMISSIONS`**, not copied, so it
cannot drift from what HawkView requests. A credential added to our own
registration is evaluated like anyone else's, because the exemption covers
permissions and a credential is not one.

### Sensitivity and scope are evaluated together

Tenant-wide scope **multiplies a sensitive permission and never promotes a routine
one.** The policy previously said both — one row raised any permission to urgent on
a tenant-wide consent type, and a correction two rows below said tenant-wide
consent is not urgent by itself. There is now one rule, and a test asserts the two
cannot disagree again.

Measured: tenant-wide admin consent fires **47 times** in production, because
consenting on behalf of all users is simply how an administrator approves an
application. Reasoned as exceptional, measured as the ordinary path.

### Two escalation paths, described correctly

`Application.ReadWrite.All` confers **credential management** — the holder can add
a credential to another registration and then authenticate as that application,
assuming whatever privileges it already holds. It does *not* let an application
grant itself every other permission; that was the example the original argument
rested on and it was wrong. The permission that manages permission grants is
`AppRoleAssignment.ReadWrite.All`. Both are sensitive, by different mechanisms.


### Urgency says how soon to look, not that something is wrong

Neither `UNCLASSIFIED` nor the unresolvable-role case may be worded as though it
asserted wrongdoing. Unclassified means **nobody has decided what this permission
is**; an unresolved role means **an identifier did not resolve**. Neither is a
finding about a person.

This is the discipline the plan already holds for lockouts — *suspected*, never
confirmed — applied one layer down, and the drift is easy: two of the strings
failed it when the whole set was read against it. *"Unrecognised is not harmless"*
asserts that it **is** harmful, in four words. And describing a permission as
*"exfiltration and forgery in one permission"* claims an act rather than a
capability; what the permission confers is that the holder **can** read and write
mail, which is the honest sentence and the more useful one.

`privileged-change.test.ts` sweeps every unclassified path against
accusation-shaped language, with a positive control proving the pattern matches
such language when it is present.
### Nothing is asserted benign

Registering an authentication method and an administrator resetting a password are
**routine by default with contextual escalation** — not guaranteed benign. MFA
registration is also how somebody holding stolen credentials registers their own
authenticator, which is a standard persistence move.

And no claim is made anywhere about what the credential-attack detector covers. An
earlier version said one of these cases was "caught by the credential-attack
detector, not here" — an unverified claim about another component, which is the
mechanism-instead-of-effect failure. A test asserts no such claim reappears.

### Removing a grant control does not always weaken a policy

Microsoft's grant controls combine with `OR` or `AND`:

- **`OR`** — any one control satisfies the policy, so removing one removes an
  *alternative* and makes the policy **harder** to satisfy.
- **`AND`** — every control must be satisfied, so removing one removes a
  *requirement* and weakens it.

Where the direction cannot be determined, the outcome is **"change detected; impact
unknown"** rather than a silent pass — the same rule as an unrecognised permission,
for the same reason. That covers missing before/after values, an unknown combination
operator, a grant set empty on one side (where `AND` and `OR` invert), and a
denial control moving (where every rule above reads backwards).

**Routine requires positive evidence, not the absence of a modelled change.** The
first version ended with a fallback saying the policy changed *without* removing a
control, adding an exclusion, or being disabled — true, and the conclusion does not
follow. It caught every change to a dimension the comparison does not model and
called them all routine, which is **the unlisted-is-not-harmless rule surviving one
function deeper**, written while implementing that very rule.

It was not hypothetical: one of the seven production conditional-access changes has
`sessionControls` and no `grantControls` at all, and landed on routine by falling
off the end. Session controls are where a sign-in session is extended from an hour
to weeks.

Three things now stand between a change and `ROUTINE`:

- **Every modelled dimension of the grant controls is actually compared** — the
  operator in both directions, controls added as well as removed. This was the third
  thing only after QA found that it was not: the operator was modelled and never
  compared, and three weakenings were filed as records underneath the two bullets
  below. See *The grant operator was modelled and never compared*.
- **Session controls are modelled far enough to notice they moved, and no
  further.** Their direction depends on values not captured — `persistentBrowser:
  always` weakens a policy and `never` strengthens it — so inferring a direction
  from presence would repeat the grant-control error one dimension across. A
  session-control change is `UNCLASSIFIED`.
- **`unmodelledFingerprint` is a digest of everything the comparison does not
  model.** Of the *unmodelled* part specifically, not the whole policy: a whole-policy
  digest differs whenever anything changes, so it cannot tell a dimension we
  understand from one we do not, and it would make the OR-removal case unreachable.
  That was my first attempt, and a test now fails if it comes back.

A weakening still outranks an unknown, and a modelled change that does not weaken
does not vouch for an unmodelled one that happened alongside it.
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

### Rules that must govern step 02, recorded here because this is where its author will be standing

None of this is built. All three came from QA breaking their own reference against
the plan, which is the evidence that the plan's sentences are not sufficient on
their own.

- **The episode span is a watermark that advances with EVERY event in the episode**,
  never a value stamped when the episode opens. QA set it only at open and the
  second event of an episode then fell outside its own episode's span, so a
  backfill landing between the first and second read as new — a live attack
  manufactured from a late delivery.
- **Episode boundaries are decided by the event's own time, not by arrival order.**
  An event delivered *after* a backfill whose own time is later still opens an
  episode. **`EventInstant` does not cover this**: it stops an implementation
  reading the wrong *timestamp* and does nothing about one treating
  most-recently-delivered as newest. `compareByEventTime` and `newestByEventTime`
  are the primitives for it, and they are the only part of the episode work that
  exists today.
- **"Covered" means the sources HawkView expects to be readable for THIS tenant,
  given its licensing and its consent** — not every collector configured for it.
  That invention is the one that produces a page nobody can close, and production
  has 147 collectors with 10 failed and 7 stale beyond a week, so the tenant it
  would break exists today. Not covered: `NOT_LICENSED` (no product — nothing to
  see and nothing to fix), `PERMISSION_REQUIRED` (a consent gap, its own alert with
  its own action, fixable in minutes), `UNSUPPORTED` (Microsoft does not expose it —
  a capability statement about Microsoft, and global rather than per-tenant, so
  counting it would make the condition unsatisfiable for *every* tenant), and
  `NOT_CONFIGURED` (never set up, and covered means what HawkView **expects** to be
  readable — confirmed from the code: `collectorStatus` returns it only when no sync
  row exists, so a collector that was working and stops becomes `FAILED` or `STALE`
  instead, never this). Everything else is covered.
  The distinction the rule rests on: **"HawkView
  cannot see this tenant" is a different fact from "HawkView was never allowed to
  see this part of it."** The first is an emergency; the second is a task. One alert
  for both makes the emergency unclearable and buries the task. `coveredSources` in
  `alert-clearing.ts` is the implementation — use it rather than re-deciding.
- **The `NOT_CONFIGURED` exclusion is conditional, and the condition is step 05's.**
  Excluding it means this alert can report visibility restored while HawkView
  collects a fraction of what is available. That is a real overstatement, and a
  different claim needing a different alert — *"collecting three of ten available
  sources for this tenant"* is worth telling an MSP and has its own action. The
  exclusion is conditional on that coverage gap being **visible somewhere rather
  than silently dropped**, which is the plan's own requirement that coverage gaps
  are shown rather than silent. If 05 ships routing without it, this exclusion has
  traded a page that could never close for a gap nobody can see.
  **Three siblings, and only the first is a page:** cannot see is an emergency, was
  never allowed to see is a task, was never set up to see is a task.
- **Event-level idempotency stays a separate layer from incident grouping.** A
  replayed event id must add neither a notification nor an occurrence. The event
  id in the dedupe key is doing a necessary job; grouping is a second layer on top
  of it, not a replacement for it.

And the reader note from above, repeated here because it will bite in this code
rather than in the lifecycle: a three-valued investigation state read by
two-valued code fails in one direction. Ask `investigation === 'RESOLVED'`, never
`!== 'OPEN'`, or a record reads as resolved.

## The grant operator was modelled and never compared

Found by QA on the conditional-access path, confirmed from the code, and the sweep
for siblings found two more. Three weakenings were classified `ROUTINE`:

```
AND [mfa, compliantDevice]  ->  OR  [mfa, compliantDevice]    operator relaxed
OR  [mfa]                   ->  OR  [mfa, compliantDevice]    alternative added
AND [mfa]                   ->  OR  [mfa, compliantDevice]    both at once
```

The first is close to the clearest relaxation available short of disabling the
policy: a user who needed MFA **and** a compliant device now needs either. It was
filed as a record.

The mechanism is small and visible. `grantOperator` appeared three times in the
file — the declaration and two reads, both of `before.`, both gated on
`removed.length > 0`. `after.grantOperator` was never read, and `removed` was the
only thing computed from the control sets. So the only transition the function
could see was *a control disappearing from an AND policy*. The operator itself, and
every control **added**, were invisible.

### Why nothing caught it, which is the part that generalises

`grantOperator` is a **modelled** field, so a correct producer excludes it from
`unmodelledFingerprint` by construction. The unmodelled guard — the thing built
specifically so "we did not look at that" can never resolve to "it was fine" — is
*designed* not to fire here.

**The better the producer, the more certainly this slips through.** A safety net
covering everything except what you decided to handle yourself leaves the handled
part uniquely undefended, and it cannot be widened to cover that part without
destroying what makes it useful: a digest including the modelled fields would
differ whenever anything changed at all, which is the mistake that made the
OR-removal branch unreachable the first time. So the only defence inside the
modelled set is that every modelled dimension is actually compared. That is now one
function, `grantChangeVerdict`, rather than a condition per case.

The irony is instructive rather than embarrassing: this function exists because of
the correction that *removing a grant control does not always weaken a policy* — a
statement **about the operator**. The operator was modelled precisely to get that
case right, and a change *to* it was never classified.

### The full transition matrix

`AND(S)` needs every control in `S`; `OR(S)` needs at least one. A policy is weaker
when more sessions pass it.

| transition | direction | before | after |
|---|---|---|---|
| AND → OR (≥2 controls) | **weakens** | routine | urgent |
| control added to OR | **weakens** | routine | urgent |
| AND → OR *and* a control added | **weakens** | routine | urgent |
| control removed from AND | weakens | urgent | urgent |
| AND → OR *and* a control removed | weakens | urgent | urgent, both reasons named |
| control removed from OR | tightens | routine | routine |
| control added to AND | tightens | routine | routine |
| OR → AND | tightens | routine | routine |

A weakening is `URGENT`, not `UNCLASSIFIED`. `UNCLASSIFIED` means *changed, impact
undetermined*; for these transitions the impact is determined exactly, and
understating what we know would be its own inaccuracy.

### The degenerate cells, where a correct-looking fix breaks something that worked

On a **single** control the operators are equivalent — "all of [mfa]" *is* "any of
[mfa]" — so neither `AND [mfa] → OR [mfa]` nor its reverse weakens anything. Both
were correct before this fix **by accident**, because no operator comparison
happened at all. The natural fix, "AND to OR is urgent", says exactly the wrong
thing here. This feature has now produced a defect at each edge.

The record says why, rather than just returning routine: *"the two are the same
requirement: all of one control is any of one control."* A reader who sees an
operator change filed as a record needs that sentence to trust it.

### Two things the matrix does not cover

**`AND [mfa, cd] → OR [mfa]` was already urgent — for a reason unrelated to the
operator.** The removal rule tripped before the operator was ever considered. A fix
that changed which rule fires would keep the verdict green while the reason moved
underneath it, which is the changed-subject failure we have hit twice. So a
weakening now reports **every** rule that fired rather than the first, and a test
asserts both sentences are present. A list cannot have that failure.

**A denial control has no direction under these semantics.** `block` is a grant
control in Microsoft's model and HawkView already renders it as "Block access", so
it can arrive in the same array as `mfa`. It is not an alternative way to *satisfy*
a policy, so every rule above reads backwards for it: removing it from an OR set
weakens the policy where removing anything else strengthens it. That is the silent
direction — a record, not a page.

How Microsoft combines a denial with a grant is not something this comparison has
evidence for, so it does not guess: a change involving one is `UNCLASSIFIED`. Same
discipline as session controls, and the same reason. **This is not in QA's matrix or
in the report** — it came from sweeping for the shape rather than fixing the
instance, and it is the only finding here that was not handed to me.

### Empty grant sets, and casing

`AND` over no controls requires nothing and admits everything; `OR` over no
controls admits nothing. **The operators invert at the empty set**, so every rule
would read the wrong way round. Microsoft does not permit a policy with neither
grant nor session controls, so a grant change with an empty side is reported rather
than interpreted. An *unchanged* empty set is not a grant change at all and still
falls through to the session-control comparison — the production event that made
the old fallback wrong had exactly that shape.

Controls are compared case-insensitively, matching `effective-mfa-enforcement.ts`,
which lowercases `builtInControls` before comparing. Without it a casing change from
Microsoft reads as one control removed and another added — on an AND policy, an
urgent page for a change that altered nothing.

**But the comparison normalises and the record does not.** The first version
lowercased both, and an MSP would have read "compliantdevice" in a sentence written
for them to act on — a name that does not appear in their portal. Caught by the
routine-wording test, not by the tests written for casing.

### What to check first when this breaks

- **A policy change filed as a record that should have paged.** Read the `because`
  string first. It now names which dimensions were compared, so the absent dimension
  is visible in the record itself. That is the whole reason the old sentence — "none
  of them weakened it", a positive safety claim over a dimension never compared — was
  replaced rather than reworded.
- **An urgent page for a change that altered nothing.** Check the casing of the
  control names on both sides, then check that the normalisation is applied to both
  the set and the probe. Normalising one side makes every camelCase control read as
  removed; a mutation of that line turned six unrelated tests red for a reason none
  of them named.
- **A verdict that is right with the wrong reason.** Every weakening lists each rule
  that fired. If a record shows one reason where two apply, the collection step was
  short-circuited.
