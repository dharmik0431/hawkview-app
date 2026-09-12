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

### Nothing calls this classifier yet

`ConditionalAccessState` and `classifyConditionalAccessChange` are referenced only
from their own tests and from QA's probes — nowhere in `backend/src` outside
`src/alerts/`. The operator defect above was real and fixing it before wiring is
cheaper than after, but **no MSP has seen a relaxed policy filed as a record,
because nothing is classifying anything yet.**

Recorded because this section is where someone goes to judge how urgent the gap
was, and because overstating exposure spends attention a real gap elsewhere needed.
The honest claim is: the defect existed in code that is not yet reachable.

### The `unmodelledFingerprint` producer: the decision, and how it was resolved

**Resolved — the producer exists, in `conditional-access-model.ts`.** See *The mapper
and the fingerprint, sharing one declaration* below for what was built. This section is
kept because the reasoning that got there is the part worth re-reading, and because one
of its findings still stands.

At the time of writing, `unmodelledFingerprint` was declared, read by the classifier,
and **produced by nothing** — every reference outside `privileged-change.ts` was a
fixture supplying `'same'`, `'before'` or `'after'`. So the coupling the field's doc
comment describes — digest the unmodelled part, never the whole policy — was
unverifiable and rested on that comment.

QA delivered `auditProducer()` as the contract, proven against a whole-policy digest
and a constant one. Both are real failure directions and the audit catches both.
**But its signature cannot describe the producer we need.**

`FingerprintProducer` is `(policy: ConditionalAccessState) => string`, and
`ConditionalAccessState` is a closed interface of six fields — it cannot carry an
unmodelled dimension. So the audit's silent-direction case is constructed as:

```ts
{ ...base, someDimensionMicrosoftAddedLater: 'changed' } as ConditionalAccessState
```

The cast adds a field the type forbids, which makes the audit prove a property about
a shape that cannot exist. It is the *test cannot check what it injects* form with
the type system as the thing bypassed: a producer taking the **mapped state** has
nothing to miss, because the unmodelled dimensions were dropped before it was
called. A real producer must digest **the collected Graph policy.**

That is what makes this a decision rather than a task. The producer needs the
correspondence between each modelled field and its Graph path — `grantOperator` ←
`grantControls.operator`, and what was then a single `excludedPrincipals` field ←
`conditions.users.excludeUsers` and its siblings (that field has since been split into
three, for reasons recorded below) — and that is a second list which must agree with the
first, with
nothing forcing it to. Exactly the coupling class that produced three defects in a
week.

**It may not need to be a new list.** `change-evidence.service.ts` already
canonicalises `CONDITIONAL_ACCESS` policies, with unordered-array handling for
`builtInControls`, `termsOfUse`, `authenticationStrength` and the exclude-lists.
That is an existing production notion of "the collected policy, canonicalised", and
deriving the digest from it would make the fingerprint evidence-based rather than a
parallel declaration.

Two reasons it is not done here: it reaches into `backend/src/changes/`, outside the
alerts-and-docs scope this work was given; and that directory has pre-existing
uncommitted changes in another worktree that are not ours to touch. Both need a
ruling before the producer is written.

Until it exists, `unmodelledFingerprint` is a contract the classifier honours and
nothing supplies — which is safe in the sense that no change can slip past a guard
that no data reaches, and unsafe the moment the first producer is written carelessly.

## Rule identifiers: MSPs choose what they are alerted on

A product decision: **HawkView's tiering is the default, not the law.** If an MSP
wants a privileged role grant to ring a phone at 2am, that is their call; if they
want it in the digest, also their call.

This invalidates nothing in the catalogue, and the reason is the seam that already
exists: **the classifier states HawkView's opinion, routing maps that opinion onto a
channel.** An MSP disagreeing with the routing does not change the opinion. So the
routing work is step 05 and the declarations stand.

One piece is not step 05, because doing it later costs a migration.

### The configurable grain is the rule, not the alert type

`ClassifiedChange` carried `classification`, `because`, `severity` and `unknown` —
and no stable identifier for *which rule fired*. The finest grain available to a
settings screen would have been the seven catalogue ids, and every privileged
directory change collapses into `security.privileged_directory_change`. That is "all
of it or none of it": *page me for a role grant but not for an authentication
method* would have been unexpressible, and nobody would have found that out until
the first person tried to configure it.

So `rule` is now a **required** field on `ClassifiedChange`, one per branch, with the
identifier as the first argument of each constructor so a branch cannot be written
without naming itself. Twenty rules across two functions.

**Why now rather than in 05:** these become the keys MSP preferences are stored
against. Once a preference row points at an identifier, changing it is a schema
migration and a conversation about somebody's saved settings. Naming them while the
branches are fresh costs nothing.

### Treated as a wire contract

- **Stable, never renamed to read better.** A test pins the exact list. Adding a rule
  needs one line there; renaming one fails loudly and tells the next reader why.
- **The type is derived from the array** (`typeof CHANGE_RULES[number]`) rather than
  declared beside it. Two lists that must agree is the coupling shape that produced
  three defects in a week; one list cannot drift from itself. A consequence worth
  knowing: renaming a rule in the array while a branch still uses the old string is a
  **compile** error, not a test failure.
- **Every declared rule is reachable**, proved by a table of one input per rule, which
  is also the reachability proof. A rule nobody can trigger is a switch in a settings
  screen that does nothing — worse than a missing switch, because it reads as
  coverage.
- **A new branch cannot ship unnamed.** Verified rather than asserted: adding a branch
  that calls `routine()` without a rule is rejected by the compiler.

### The rule is finer than the classification, deliberately

The three undetermined grant reasons — unknown operator, empty control set, denial
control — are all `UNCLASSIFIED`. A classification-level identifier would collapse
them into one switch, and an MSP who wants to hear about a denial control moving but
not about an unknown operator needs them apart. The distinction already existed in
the `unknown` token; the rule must not be coarser than what the function already
knows. A test asserts all three stay distinct, and another asserts no classification
maps to a single rule — if one did, there would be nothing to configure below the
tier, which is the coarseness this identifier exists to remove.

### Three routing constraints, recorded for step 05

Not built here. Recorded because a deferral that drops its constraints rebuilds the
bug.

- **Silencing a notification must never silence the record.** An MSP may turn any rule
  down to record-only; they may never make an event not be recorded. The evidence stays
  searchable whatever they choose. This protects them and it protects us.

  **This is a type-level obligation, not a UI rule, and the distinction is the whole
  point.** A settings screen that only offers choices down to record-only is a rule
  enforced by the absence of a control, and the control reappears the first time
  somebody adds a bulk-edit endpoint, an import, a migration backfill, or an
  admin-only override — each for a plausible local reason, none of them looking like
  the decision being reversed. A type where the record is not a thing a preference can
  address cannot be reversed that way, because there is no code path to add. Same
  technique as `EventInstant` and the required `subject`: make it unexpressible
  rather than forbidden.

  Concretely, what step 05 must not be able to write is a preference that ranges over
  delivery *and* recording. So a preference addresses only the channel:

  ```ts
  /** What an MSP may change about a rule. Recording is absent BY CONSTRUCTION —
   * there is no value of this type that suppresses it. */
  type RulePreference = Readonly<{
    rule: ChangeRule
    /** The loudest channel this rule may use for this MSP. `NONE` still records. */
    notifyAtMost: RoutingTier | 'NONE'
  }>
  ```

  The load-bearing part is what is **missing**: no `record: boolean`, no `suppress`,
  no `enabled`. `'NONE'` is the floor and it means "tell nobody", never "store
  nothing". A reviewer cannot be relied on to notice a fourth field arriving later, so
  the obligation for 05 is a test that the recording path takes no preference argument
  at all — a function that cannot see a preference cannot be changed by one.

  **And the reasoning has to travel with the rule**, because the rule on its own reads
  like an arbitrary restriction. Somebody will eventually propose `suppress: true` for
  a good-sounding reason — storage cost, noisy tenant, a customer who asked. The answer
  is that an MSP who silenced something and later needs to know what happened has only
  the record to find it in, and the moment recording is optional the product cannot
  answer that question for the cases where it matters most.
- **The settings screen states plainly what they will NOT hear about.** The plan's own
  "coverage gaps shown rather than silent", and the reason "make it configurable" does
  not become "everybody turns it off and blames HawkView". If tenant-disconnected has
  been silenced, the product says so where they will see it.
- **Preference changes are recorded with who and when.** An MSP who silenced something
  and later asks why they were not told gets an answer with a date on it. One audit
  row, and it turns a liability argument into a support conversation.

### What to check first when this breaks

- **A preference that appears to do nothing.** Check the rule is reachable before
  checking the routing: the reachability table is the list of inputs that trigger each
  one, so if a rule has no entry there it was never firing.
- **An MSP configured one thing and a different thing went quiet.** Two branches
  sharing a rule id. The reachability test catches it, because the duplicate steals
  the other's expected rule.
- **A rule id in the database that no longer exists in the code.** That is the
  migration this section exists to prevent. The pinned-list test is the thing that
  should have failed first.

## The mapper and the fingerprint, sharing one declaration

`backend/src/alerts/conditional-access-model.ts`. `unmodelledFingerprint` was declared,
read by the classifier, and produced by nothing — every reference outside the
classifier was a fixture supplying `'same'`. It now has a producer, and the mapper that
builds a `ConditionalAccessState` from a collected policy lives beside it.

**One declaration of what is modelled, two consumers.** The mapper reads the state from
the declared paths; the fingerprint digests what is left. Two lists would be the
coupling that produced three defects in a week, and putting the mapper and the producer
on opposite sides of a module boundary would split that list from one of its consumers
— the same defect with more distance in it.

**It lives in the alerts folder, and the deciding argument is not ownership.** A mapper
in the collection layer would absorb each new Graph shape and hand alerts a stable type
— which sounds clean and would silently defeat `unmodelledFingerprint`, whose entire
purpose is that a new Graph dimension cannot pass unnoticed. A collector that
normalises Graph changes away is the safety net removing its own reason to exist. The
cost is that a Graph shape change now touches this folder, which is right: whether we
model a new policy dimension is an alerts decision and should cost a deliberate edit.

**The collected field list comes from the other side of the boundary.**
`COLLECTED_POLICY_FIELDS` is taken from `CONDITIONAL_ACCESS` in
`tenant-sync.service.ts`, not written from memory — a list derived from my reading of
the collector would agree with my reading and nothing else. A test asserts every
modelled path sits under a field the collector actually stores.

### Fidelity: which paths may be excluded from the digest

This is the part where a silent gap would live, and it is the operator defect one level
down.

A path may only be excluded from the digest if the state captures it **losslessly**.
Otherwise the part the projection discarded is invisible to *both* layers at once: the
classifier never mapped it, and the fingerprint excluded it as "modelled". So a lossy
projection keeps its path **in** the digest. The cost is noise — a change there can
report unclassified when a modelled verdict already covers it — and noise is the safe
direction.

| path | fidelity | note |
|---|---|---|
| `state` | **lossless** | three values plus UNRECOGNISED; was a boolean |
| `grantControls.operator` | **lossless** | OR/AND plus ABSENT and UNRECOGNISED |
| `grantControls.builtInControls` | **lossless** | carried as-is |
| `conditions.users.excludeUsers` | **lossless** | its own array |
| `conditions.users.excludeGroups` | **lossless** | its own array |
| `conditions.users.excludeRoles` | **lossless** | its own array |
| `sessionControls` | lossy | only the **names** are modelled; the values stay in the digest |

Five of these were lossy in the first version and were made lossless, because a lossy
projection forces a choice between noise and a silent gap and neither is acceptable
where the fix is cheap.

**`state` was not merely lossy — the boolean produced a wrong sentence.**
Enabled-to-report-only read as *"the policy was disabled"*. It was not: it still
evaluates and still logs, it just stops enforcing. Saying more than the evidence shows is
what this file refuses everywhere else. And report-only-to-disabled read as
false-to-false, no change at all, while being a real loss — the policy stops even
logging. Both transitions now have a verdict:

| transition | verdict | why |
|---|---|---|
| ON → OFF | urgent, `policy_disabled` | protection stops applying and it stops evaluating |
| ON → REPORT_ONLY | urgent, `policy_stopped_enforcing` | access it previously blocked is now allowed |
| REPORT_ONLY → OFF | routine, `policy_stopped_reporting` | nobody's access changes; **our** visibility is what is lost |
| any ↔ UNRECOGNISED | unclassified, `policy_state_unrecognised` | a word we do not know — Microsoft changed |
| any ↔ UNAVAILABLE | unclassified, `policy_state_unavailable` | the field was not there — our collection degraded |
| the strengthening directions | routine | turning a policy on must not look like turning one off |

`REPORT_ONLY → OFF` is **not** a weakening under the policy semantics, and calling it one
would be the same overreach: a report-only policy already allowed every session and a
disabled one allows the same set. What ends is the evaluation log. Routine by default and
configurable on its own rule, which is what the rule identifiers are for.

**UNRECOGNISED is the fourth member and it is what keeps the exclusion honest.** This
path is lossless and therefore excluded from the digest, so mapping an unknown state to
`OFF` would assert "not enforcing" about something we do not understand — with the safety
net switched off for exactly that case.

**The exclude lists are three arrays because merging them lost the blast radius, not a
label.** Excluding one named account and excluding a group are different sizes of event
on the tier that rings a phone. Three rules, so an MSP can hear about group and role
exclusions without hearing about every individual account. `role_excluded` is checked
first, then `group_excluded`, then `user_excluded` — widest reach first, so a policy edit
that adds several kinds at once reports the largest.

**One rule identifier was deleted**, which the wire-contract discipline otherwise
forbids. `conditional_access.principal_excluded` became unreachable the moment the
exclude lists stopped being merged, and a deletion is permitted here only because nothing
is wired and no preference row exists. After wiring, the same change would be a migration
and a conversation about somebody's saved settings — which is the whole reason the
identifiers were named before the settings screen was built.

**One of seven paths is lossy now, and that is the end state rather than an accident.**
Five were made lossless once the first version surfaced the choice. `sessionControls`
stays lossy deliberately: making it lossless would mean modelling values whose direction
we agreed not to infer — `persistentBrowser: always` weakening and `never` strengthening
is the OR/AND error waiting one dimension across — so the fingerprint firing there is
designed behaviour, not noise.

**The fidelity claim is witnessed rather than declared.** Each path carries two policies
differing only at it, and the two fidelities make opposite predictions: a lossless path
must change the state and must NOT move the digest; a lossy path must leave the state
identical and MUST move the digest. Mislabelling an **existing** path in either direction
fails a test.

**What the witness does not do, corrected.** This section previously said a
lossy-and-excluded path "cannot be written again by accident". **That was false**, and it
is corrected rather than softened, because this is the paragraph somebody reads when
deciding whether excluding a path is safe — and an overstated guarantee is worse than
none, since it stops the next person looking.

A witness is **one pair, chosen by the same hand and on the same row as the label it
checks.** LOSSLESS is a claim about **every** pair, and an existential cannot establish a
universal. QA defeated it directly: add a path, project a structured subtree onto a
boolean, label it LOSSLESS, and choose absent-versus-present as the witness. The boolean
moves, so the pair passes and the path leaves the digest — then a later change *inside*
that subtree moves neither the state nor the digest and reads routine, with a `because`
true as written and false in effect. Nothing went red. That is the grant-operator defect
one dimension across.

No stronger witness fixes this, because the defect is in the quantifier rather than in
the example. What a witness is worth is narrower and still real: it forces an author to
exhibit a concrete pair instead of asserting a label, and it kills a careless relabel of
a path that was already correctly witnessed.

**The constraint that does close it is on the target type, not on the example:** a
projection may be LOSSLESS only if the state field it feeds can represent *"there was
more here than I captured"*. `state` has `UNRECOGNISED`; `grantOperator` has `UNRECOGNISED`; a
boolean over a structured subtree has no such member, so QA's path could not have been
labelled LOSSLESS at all. That is checkable at authoring time and an author cannot
satisfy it by choosing a convenient example.

### The constraint that closes the witness gap

The witness cannot establish LOSSLESS, for the reason above. What can is a property of
the **target type**, checked when the path is written rather than when a pair is chosen:

> **A projection may be LOSSLESS only if the state field it feeds can represent "there
> was more here than I captured."**

Three shapes qualify, and `CanSayUnread` in `conditional-access-model.ts` is the
predicate: a `null` member, an `UNRECOGNISED` member, or an `unreadable` count.
`LosslessCapableField` maps that over `ConditionalAccessState`, and `ModelledPath`
becomes a union where the LOSSLESS variant accepts only those fields.

**QA's defeat was replayed against it and is rejected at authoring time.** Adding their
path — a structured subtree projected onto a boolean, witnessed absent-versus-present —
now fails to compile with *"Type `"hasGuestRestrictions"` is not assignable to type
`LosslessCapableField`"*. There is no witness to choose, because the label is unavailable.
Such a path would stay in the digest, and the widening that previously read routine
surfaces as unmodelled.

An author cannot satisfy this by picking a convenient example, which is the whole
difference between it and the witness. The witnesses are kept — they force a concrete
pair instead of an assertion, and they kill a careless relabel — they just no longer
carry a claim they cannot support.

### Lists say what they could not read

`strings()` filtered out every entry that was not a string and said nothing, in four
places, **all of them excluded from the digest**. So a structured entry arriving where a
string used to be was unreadable by the comparison and invisible to the fingerprint at
the same time. Four copies of a silent drop is a shape rather than an instance, and the
likelihood being low does not change the shape.

Those four fields are now `ReadList` — `{ values, unreadable }` — which is also what
makes them eligible to leave the digest under the constraint above. Three cases, and the
middle one is what a bare filter gets wrong:

| collected | read |
|---|---|
| absent | no values, nothing unread |
| `['mfa', {authenticationStrength: …}]` | `['mfa']`, **1 unread** |
| not a list at all | no values, **1 unread** — never "nothing was there" |

**An unread entry is a distinguished value exactly as `UNRECOGNISED` is**, so it gets the
same treatment: the verdict is impact-unknown, on either side, for any of the four lists.
It outranks the weakening rules, which is the opposite of the precedence a weakening
normally gets and is deliberate — a weakening is something we determined, and an unread
list means the determination itself cannot be trusted, *including* the one that says
weakened.

The count is reported rather than the content, because what was dropped is by definition
something this comparison could not interpret; printing it would be guessing at a shape.

### What the distinguished-value rule does not yet cover

`grantOperator`'s `null` conflates **absent** (no grant controls configured — normal for
a session-controls-only policy) with **unrecognised** (Microsoft sent an operator we do
not understand). The rule is not applied to it, because today that would report
impact-unknown for every policy with no grant controls. Splitting those two is the
remaining piece of this repair, and it is the same shape as everything above: a
distinguished value that means two different things cannot carry the rule.


### Precedence: an unknown in another dimension never silences a finding

The headline is QA's and it is the right way to say it: **the worse collection gets, the
quieter alerting gets.**

The state-readability check ran first. The reasoning was sound about the rules that *do*
read state — none of them should treat an unreadable value as one of the three it
understands — and I applied it to the whole function, which preempted the three exclusion
rules and the grant verdict. **None of those reads state at all.** A role exclusion that
is urgent on its own came back impact-unknown the moment anything else was unreadable.

And it was reachable without Microsoft changing anything. An **absent** `state` field
mapped to the same value as an unknown one, so a merely truncated snapshot downgraded a
real, unambiguous role exclusion. Absence of evidence quietly becoming evidence of
absence — the defect this entire feature exists to remove, pointing at itself.

**The rule, and it is sharper than "a weakening outranks an unknown":**

> **An unknown in the SAME dimension as a verdict invalidates that verdict. An unknown in
> a DIFFERENT dimension does not.**

That resolves both directions of the ordering, which a precedence list alone does not:

| unknown | sits | because |
|---|---|---|
| an unreadable grant or exclusion list | **above** the grant and exclusion rules | those rules read it; a weakening computed over an incomplete list is a guess with a confident sentence attached |
| an unreadable policy state | **below** them | they never touch it, and the exclusion they found is as real as it was before the state went missing |

A table binds every weakening against every other-dimension unknown, individually and
all at once, with a control showing those unknowns still decide the verdict when no
finding is present — so it is a precedence rather than the unknowns having been made
inert.

### UNAVAILABLE is not UNRECOGNISED

Two different facts, and collapsing them produced a false sentence: *"a state we do not
recognise"* when the truth was *"we did not get the state"*. The same class as reporting
report-only as disabled, and **the product already refuses this conflation everywhere
else** — `EXACT 0` versus `NOT_AVAILABLE` is the same distinction and one of the oldest
rules here.

They differ in consequence, which is why they are separate rules rather than one with a
longer sentence. An unrecognised vocabulary is **Microsoft changing** — an engineering
signal. An absent field is **our own collection degrading** — a monitoring fact somebody
should hear about in its own right, not as a modifier on a security verdict. An MSP may
reasonably want those on different channels, and now they can be.

**One test defect worth recording, because it is the shape not the instance.** Every test
for this set `state: 'UNAVAILABLE'` on the mapped object, so none exercised the *mapper's*
distinction — and a mutation putting an absent field back onto `UNRECOGNISED` survived all
of them. Asserting the classifier's behaviour while injecting the value the mapper was
supposed to choose is the instrument sitting below the level where the value is decided.
The test that catches it goes end to end from a truncated payload.

### The grant operator's null, split the same way

`grantOperator` was `OR | AND | null`, and that `null` carried two facts: **ABSENT** (the
policy states no operator) and **UNRECOGNISED** (Microsoft sent one we could not read).
The conflation is why the distinguished-value rule could not be applied here — absent is
the *normal* state of a session-controls-only policy, so forcing impact-unknown on the
shared value would have fired on every one of them. Noise generated by a safety rule is
how safety rules get removed.

Now four values. ABSENT is a fact about the policy; UNRECOGNISED is a fact about our read,
and only the second is inherently undirectable.

**An operator is only needed where there are controls to combine**, which is what makes
the split safe — and my first version of it missed that. Checking `UNRECOGNISED` alone let
every ABSENT case through, so a control removed from an operator-less policy reported
**routine**: no weakening rule matches when the operator is neither AND nor OR. Four tests
caught it. ABSENT does not mean harmless; with controls present it is as undirectable as an
unreadable operator.

| situation | verdict |
|---|---|
| no operator, no controls (session-controls-only) | no grant dimension — no grant verdict |
| no operator, controls present | unclassified, `grant_operator_absent` |
| unreadable operator, controls present | unclassified, `grant_operator_unknown` |
| controls appearing or disappearing entirely | unclassified, `grant_controls_absent` |

Two rules rather than one, for the same reason absent and unrecognised are separate for the
state: the sentences are different facts. One is the policy not saying; the other is us not
reading.

**And a correction to my own reasoning, because a mutation caught the comment rather than
the code.** I wrote that the controls-present guard stops a session-controls-only policy
reporting. It does not — a policy whose grant dimension did not move returns before
reaching that check at all. What the guard actually prevents is a **false sentence**:
without it, a policy gaining its first grant controls would be described as *"states grant
controls but no operator"* about the side that has neither. The verdict was never at risk;
the sentence was. Same discipline as report-only versus disabled.

### Severity of the unclassified conditional-access rules

**`ACT_TODAY`. The proposal to raise them to `ACT_NOW` was put, argued against, and
WITHDRAWN** — recorded that way rather than as "not overruled", because a decision
reconsidered on its merits and a decision nobody returned to are different facts about how
much weight this record carries.

**The test for when an unknown earns a phone call**, which came out of working out why the
analogy failed and is the transferable part:

> An unknown earns a page when **every resolution of it is consequential** — not when it
> attaches to an activity whose class is usually urgent.

`directory.role_unidentified` passes: a privilege was definitely granted and only the
magnitude is open, so every resolution is bad or neutral. An unclassified conditional-access
change fails it: **half the resolutions are a tightening.** The original reasoning was "an
unknown on an urgent-class activity", which is a different property and the weaker one.

The case for raising them was that analogy — `directory.role_unidentified` is urgent
because the activity *is* the consequential thing. That does not transfer: "a conditional
access policy
changed" is mostly routine administration, and for these rules the direction is unknown in
both senses. Tightenings and weakenings arrive through the same door.

The deciding argument is that **the cases where we cannot determine direction are exactly
the cases where waking somebody cannot help them act**, because there is nothing
determinate to act on. `ACT_TODAY` is defined in this file as "real and worth knowing, and
nothing changes between 2am and 8am", which is that sentence.

Against the instinct to fail noisy here: 364 notifications, 353 unresolved, none ever acted
on, 301 of them marked `high`. Alert fatigue is the founding defect this work exists to
remove, and the weakenings themselves are already urgent — this only ever concerned the
cases where we do not know there was one.

The three collection-degradation rules — `policy_state_unavailable`,
`list_partially_unreadable`, and `state_unavailable` — should route to a **monitoring**
channel rather than a security one, which the separate rule identifiers now make possible.
They are facts about our own sight, not findings about the tenant.

**Two obligations that come with that, for step 05 rather than now.**

**Routing them to monitoring is only correct if a fleet-wide degradation produces one
message per MSP, not one per tenant.** This is the plan's own rate-limit correctness
requirement, and it is the case where getting it wrong is roughly 1,500 messages — because
the conditions that make collection degrade are precisely the conditions that make it
degrade everywhere at once. A per-tenant fan-out here would turn a single outage into the
301-alert problem at fleet scale, on the channel we just decided was the calm one.

**An MSP may reasonably want UNAVAILABLE and UNRECOGNISED on different channels.** One is
our collection degrading and is theirs to chase with us; the other is Microsoft changing
vocabulary and is ours to fix. The separate rule identifiers permit that split, and nothing
downstream should collapse them back into "unclassified".

**And a note against failing noisy for undetermined findings.** "If it is noisy, the noise
means collection is degrading" sounds principled and is the reasoning that produced 353
unresolved alerts nobody ever acted on. Fail-noisy is right for a **determined** finding and
wrong for an undetermined one: the weakenings are already urgent, so raising the unknowns
buys no additional coverage of anything determined — pure noise cost against zero security
gain.


### Standing trap for step 03: `windowReadableThroughout`

**Not a bug today, and it will be the moment step 03 wires it.**
`alert-clearing.ts` declares it, `conditionSatisfied` reads it, and **nothing produces
it** — every reference outside the module is a fixture, defaulting to `false`, which is
the right default.

QA's warning is exact: when step 03 comes to wire it, **the cheapest way to make an alert
clear will be to pass `true`, and every test will still pass, because the tests inject it
too.** The instrument sits below the level where the value is chosen, which is the oldest
rule here and it is sitting in the file waiting.

**The most persuasive argument for this obligation is that I committed the same defect
while writing it down.** Every test for the state split set `state: 'UNAVAILABLE'` on the
mapped object, so none exercised the mapper's own distinction, and a mutation putting an
absent field back onto `UNRECOGNISED` survived all of them — asserting the classifier's
behaviour while injecting the value the mapper was supposed to choose. That is this exact
trap, one field over, found in the same hour as documenting it. If it can be written by
someone actively warning about it, a default of `true` will not be noticed by someone who
is not.

**Hard requirement for step 03:** derive it from sync state — successful-collection
coverage across the window, gaps included — and test the **producer**, above the level
that picks the value. Otherwise a correct rule becomes a flag that is always true, the
alert clears because the collector died, and that is precisely what the two-halves check
was built to stop.


### What HawkView cannot see: role-based exclusions

Recorded because it is larger than the decision that surfaced it, and because nothing in
this feature can fix it.

**A role exclusion's effect changes when role membership changes, with no policy edit at
all.** "Exclude Global Readers from this policy" covers whoever holds that role today;
grant the role to somebody tomorrow and the policy silently stops applying to them. The
policy document is byte-identical, so there is no change for the collector to collect and
no event for any of this machinery to classify.

The exclusion itself is caught — `role_excluded` is urgent, and its sentence says the
covered set moves without further edits. What is **not** caught is the later membership
change. That is a real gap in what the product can observe rather than a defect in this
comparison, and it belongs in an honest statement of coverage rather than in a fix nobody
can write here.

### The canonicaliser is injected, and that moves a risk rather than removing it

The collection layer already canonicalises conditional access policies, including
order-insensitivity for the arrays Microsoft returns in arbitrary order. That function
is module-private and its file is being edited, so this module states what it needs —
`(value: unknown) => unknown` — and the wiring supplies it. Same shape as `quietMs` and
the seen-set: the layer declares its dependency instead of reaching across a boundary.

**A compile-time import is at least the right function. An injected one can be wired to
an identity function**, and the fingerprint then degrades *silently* toward everything
reading routine — the unsafe direction. A test demonstrates exactly that: with the real
canonicaliser, a reordered `includeUsers` array does not move the digest; with identity,
it does.

**Obligation on whoever does the wiring, for step 05:** the producer audit must run
against the **production-wired** function, not only against what a test supplies. If it
only ever audits a test double, the coupling has moved from an import somebody can see
to a wiring nobody checks, and the audit becomes a check sharing an origin with what it
checks. The loose end — exporting `canonicalize` from `change-evidence.service.ts` — is
named and deliberately not chased: that directory holds pre-existing unowned work.

### What to check first when this breaks

- **Everything suddenly reads routine.** Check the wired canonicaliser first, before the
  paths. An identity or wrong canonicaliser degrades the digest quietly and in the
  unsafe direction; nothing else here fails that way.
- **A policy change that should have been reported as unmodelled, wasn't.** Check
  whether its path is marked lossless. A path excluded as "modelled" whose projection
  actually discards something is the one silent failure this design can still have, and
  the fidelity table is the list to audit.
- **Every grant change comes back unclassified.** A lossless path has stopped being
  excluded, so the digest moves on a dimension the classifier already reads and the
  routine branch is unreachable. That is the whole-policy-digest mistake returning.
- **A session control appears on every policy.** Microsoft sends unconfigured controls
  as keys with `null` values rather than omitting them; the null filter is what makes
  the presence set mean anything. Without it the set is identical for every policy and
  the comparison can never fire.

## The reflexive operator case, and the sweep that came with it

The second instance of one root, so the sweep mattered more than the patch.

**The defect.** `operatorChanged` compares the **mapped** operator, and two different
unreadable operators both map to `UNRECOGNISED` — so the "nothing changed" guard returned
before reaching the `grant_operator_unknown` branch written for exactly that input. **A
correct branch that nothing could reach.**

**The root, and it is the same as the state defect: a comparison in projection space.**
Wherever a mapping collapses distinct sources onto one member, a change predicate over that
mapping cannot see the collapse.

### The sweep, which found the rule rather than a third instance

Every distinguished-value check in the classifier:

| check | gated on a change predicate? |
|---|---|
| `state === 'UNAVAILABLE'` | no — unconditional |
| `state === 'UNRECOGNISED'` | no — unconditional |
| unreadable `ReadList` entries | no — unconditional |
| grant operator `UNRECOGNISED` | **yes** — behind the guard |

So the exclude lists were never exposed: the `unreadable > 0` check asks *"is anything
unreadable"* directly rather than *"did anything change"*, and that is the entire difference.
`sessionControls` compares a presence set in projection space, but it is LOSSY and stays in
the digest, so the fingerprint reports what the set cannot — which is why that path was made
lossy in the first place.

> **A distinguished-value check must not sit behind a change predicate.**

That is the rule to grep for. The honest question is not *"did anything change"* but *"did
anything change, or is anything unreadable"* — an unreadable value means the first cannot be
answered, rather than answered no.

### The fix was too coarse first, and my own test caught it

Letting *every* unreadable operator through reached the empty-set branch on a policy with no
grant controls, which says *"grant controls changed and one side has none"*. Both sides were
empty and nothing had changed, so **the sentence was false**. A fix for a comparison that hid
a change would have produced a verdict that misdescribed one.

Narrowed to where an unreadable value could actually hide something — unreadable **and**
controls present on either side. **`ABSENT` is deliberately excluded**: absent is absent,
there is no hidden variation behind it, so "nothing changed" is knowable and true. Treating
the two alike would report impact-unknown on every comparison of an unchanged operator-less
policy.

Written test-first, as required: it failed against the code as it stood, because 35 passing
tests over a behaviour nothing covered was the absence of a test rather than evidence. Three
mutations, and the one that survived — including `ABSENT` in the unreadable set — exposed
that nothing pinned the knowably-unchanged case either.
