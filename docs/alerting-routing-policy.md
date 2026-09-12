# Step 05: routing, recipients and policy

MSPs choose what they are alerted on. **Our tiering is the default, not the law** — a
privileged role grant can ring a phone at 2am or sit in a digest, and that is the MSP's call.
The twenty rule identifiers made a wire contract in step 01 are the grain that makes it
sayable: *"role grants ring me, application permissions go to the digest"* needs those to be
separate names rather than one category.

**Types only so far, deliberately** — the same order as step 04, where writing the seam before
the wiring found two things that would have been expensive later. QA is pre-registering step 05
now, and their reference has not been read.

## Two guardrails built as types, not as rules

A rule is something a later code path routes around. These two are not rules.

### Silencing a notification never silences the record

`DeliveryPreference` is `RING | EMAIL | DIGEST | RECORD_ONLY`. **There is no `OFF`.** Any rule
can be turned down to the floor; no rule can be made not-recorded, and that is expressed as a
missing enum member rather than as a validation — a validation is a thing a later code path can
skip, and an absent value is not a thing anyone can select.

The stronger half is that **the record is not an output a preference can address.**
`Routing.record` is a required field, so there is no branch in which a quiet preference
produced nothing at all, and the preference is not an input to building it. A `Routing` without
a record does not compile.

An MSP that wants to hear nothing about a rule gets exactly that, and HawkView still knows — so
*"why was I not told"* has an answer six months later.

### One cause is one message per MSP

A `Delivery` names an **organisation** and carries `affectedTenants` as a list. **There is no
tenant field to vary**, so a per-tenant fan-out is not something you can write.

At 100 MSPs × 15 tenants, one message per tenant is **1,500 messages from a single incident** —
the failure that would destroy the channel on its first bad day. Coalescing cannot be
*forgotten*, because un-coalesced is not expressible. That is the difference between this and a
rate limit applied afterwards, which is a thing a caller who does not know it exists can bypass.

## Quiet hours defer, and the deferral is visible at once

`DeliveryTiming` is `IMMEDIATE | HELD`, and `HELD` carries the time it will go. **There is no
variant meaning discarded.** The record shows the hold from the moment it is decided, so an
in-app view says *"held until 07:00 — quiet hours"* rather than going silent until 07:00, which
is indistinguishable from having been forgotten.

An MSP can name types that always ring; that list **defaults to empty**, so the choice is made
rather than inherited.

## The rest, as built

- **The default is derived from the declared severity**, not listed again per rule, so it
  cannot drift from the catalogue. An MSP overriding it is expressing a preference; HawkView
  disagreeing with itself would be a bug.
- **A recipient is verified or named as absent.** Never a customer end user — they have no
  relationship with HawkView and did not ask to hear from it, and a type accepting a bare
  string invites one to be typed in. "Nobody is listening" is a variant, not an empty list, so
  the settings screen can say *which* tenants have no recipient.
- **Coverage gaps are sentences, not a count.** "8 rules are set to record-only" tells a reader
  nothing they can act on; *"you will not be contacted about privileged role grants — they are
  still recorded"* tells them one thing they might want to change, and says the record survives
  in the same breath, because a gap statement that only names the loss reads as *HawkView
  stopped watching*.
- **A preference change carries who, when, and what it was before.** The previous value is what
  explains a gap: *who set this* and *what did they change it from* are different questions, and
  only the second says why the period before the change looked different.

## The gate, and how it differs from step 04's

Two kinds of test, labelled, because they prove different things:

| kind | how | what it proves |
|---|---|---|
| **unexpressible** | `@ts-expect-error` | the wrong state does not compile — if it ever does, the directive itself fails |
| **expressible** | two states shown distinguishable | the seam can hold the difference a property needs |

**The unexpressible half was checked against itself**: adding `'OFF'` back to
`DeliveryPreference` makes the expectation unused and the build fails. A gate of this kind that
was never shown to fail is a gate that passes.

## Open decisions — yours, not mine to fill in

**1. What counts as "one cause".** `Delivery.causeKey` exists and its composition does not. A
fleet-wide collector failure is clearly one cause, but is the key `ruleId`, or
`ruleId + resourceType`? Two *different* rules failing for one underlying reason — a tenant
disconnected, so every collector for it fails — is arguably one cause too, and keying on the
rule would send several messages for it. **This is the decision that determines whether the
rate limit actually holds on the day it matters**, and it is a product judgement about what an
MSP would consider one event.

**2. `OPERATIONAL` is the code's word for what the plan calls the monitoring channel.** They are
the same category and I have used the existing vocabulary rather than adding a synonym — a
second name for one thing is how two of them end up meaning slightly different things. Say if
you want it renamed rather than aliased.

**3. Quiet hours: per MSP, or per recipient?** An MSP with a follow-the-sun rota and one with a
single inbox want different answers, and the type currently supports either.

**4. What routing does when the recipient is `NONE_VERIFIED`.** The variant exists so the gap
is nameable; whether an unroutable alert holds, escalates to a designated owner, or records
only, is not decided. My inclination is record-only plus a coverage statement, but it is
exactly the kind of default that quietly becomes policy.

**5. Digest cadence** is unspecified, and it interacts with quiet hours — a digest that fires
inside quiet hours is either held or is the exception that makes holding pointless.

## Still open from step 03, and it travels

The `windowReadableThroughout` producer obligation: derived from sync state with gaps included,
and its producer tested **above** the level that picks it. Step 05 does not touch it yet. If
routing ever reads coverage to decide whether to alert, that constraint comes with it.

## QA's seam attack: two properties the first shape could not express

Four of their six were already covered by the shape above. Two were not, and both are real.

### Quiet hours need more than one moment

`route(incidents, preferences, now) -> Delivery[]` carries **one `now` and has no later**, so
**held-and-delivered and held-and-lost are the same output.** A hold that matures and goes out
and one that is quietly forgotten look identical at the only moment the function can see.

**This is step 04's flat list, one feature over.** There, "emitted then stopped" and "never
emitted" were the same *input*; here, "held then sent" and "held then lost" are the same
*output*. Same repair: carry the sequence, not the snapshot. Routing takes `RoutingTick[]`, and
**a tick with no incidents is not a wasted entry** — it is the thing that lets a hold come due.
Without it the passage of time is not expressible at all.

### A property about a configuration cannot be carried by a list of events

Their sixth, found by attacking their own repaired seam, and **the one I would have missed.**
`suppressed` is event-driven: an entry exists only when an incident arrives on a silenced rule.
So an MSP who silences a rule that then **never fires** produces output byte-identical to an
MSP who silenced nothing and had a quiet week — and *silenced-and-therefore-silent* is exactly
the state the property exists to make visible.

`silencedRules` is derived from the **preference set**, not from what happened. The control
matters as much as the field: an MSP who silenced nothing lists nothing, or the section passes
by listing everything always.

The generalisation is worth more than the instance: **if the answer changes when nothing
happens, it is not derivable from what happened.**

## Two rulings, made structural

**A delivery limit may aggregate or defer. It may never drop.** There is no `dropped` bucket in
`RoutingOutcome`, so a dropped message cannot be written and then explained. A limit that drops
is silence produced by a feature whose purpose is volume, exactly as a hold that expires is
silence produced by a feature whose purpose is timing — the same failure, and **the limit is
the more tempting one, because dropping is the simplest implementation and looks like working
as designed.**

**Escalation builds on the ownership axis that already exists.** A ladder needs acknowledgement,
which is a person's act — that is `acknowledge` from step 01, touching ownership only. No second
notion of "somebody has this". The ladder is a function of time-since-notified and ownership
state, not a new axis. Not built yet, and the shape comes to PM before it is.

## The accounting identity, arriving here

Every incident appears exactly once in `records`, and lands in **exactly one** of `delivered`,
`stillHeld`, `suppressed`. An incident in **none** is silence nobody can find — this step's
whole failure mode. An incident in **two** is a message somebody receives twice while the record
says once. `accountingProblems` reports violations by name rather than as a boolean, for the
reason step 03 settled: a reader needs to know which figure to go and look at.

**The gate discriminates**: collapsing the tick sequence to a single moment, removing
`stillHeld`, removing `silencedRules`, or adding a `dropped` bucket are each caught at compile
time — four collapses, four caught.

## `causeKeyOf` did not exist, and the seam could not say what one cause is

`Delivery.causeKey` said *"see `causeKeyOf`"* and **there was no such function anywhere** — a
dangling reference I wrote. `RoutableIncident` carried no fleet-wide cause either, so what
makes two incidents one cause was not in the seam at all, and any grouping written against it
would have measured a guess rather than the product's rule. Step 04's P7 shape again.

### The ruling: only monitoring coalesces

**Security findings never coalesce across tenants.**

A collector failing across fifteen tenants is **one reason** — our collection broke, or
Microsoft's API did — and fifteen messages about it is the failure the plan names. Two
privileged role grants in two tenants are **two reasons that happen to share a rule**, and
coalescing them **hides one behind the other**: the 301 defect wearing a rate-limit costume.

| category | cause key |
|---|---|
| `OPERATIONAL` | organisation + rule + subject. **No tenant** — that is the whole point. |
| `SECURITY` | organisation + rule + **tenant** + subject. Nothing coalesces. |

**The direction of error is chosen**: over-send security, under-send monitoring noise. Wrong
about a fleet-wide security cause and an MSP gets duplicates; wrong the other way and an attack
in one tenant is hidden inside a message about another.

Built on step 01's `joinUnambiguously`, so a subject id containing a separator cannot collide
two causes into one. `RoutableIncident` gained the `subjectId` the key reads — the field whose
absence was the actual problem.

### The missing field stops the address, not the fan-out

A `Delivery` genuinely cannot be *addressed* to a tenant — no `customerTenantId` to vary, and
that is a compile error. But **fifteen Deliveries each naming one tenant in `affectedTenants`
compile fine and share a cause key.** The absent field stops the address; it does not stop the
fan-out, and the fan-out is the 1,500 messages.

So the guarantee needs an accounting rule as well: **one delivery per cause key per MSP per
tick**, in `fanOutProblems`. The two negative controls matter as much as the positive one — it
must not fire across ticks (recurrence is a new message, not a duplicate) and must not fire
across MSPs (two organisations with one cause are two messages by definition).

## Held then silenced is suppressed

An alert held under EMAIL, silenced to RECORD_ONLY while the hold is pending, then maturing,
would come out **delivered** while `silencedRules` simultaneously says the MSP will not hear
about that rule. **The outcome asserts both at once.**

**The preference at delivery time wins.** The MSP's most recent expressed intent is the one to
honour; delivering something they have just silenced is exactly what makes people stop trusting
a settings screen; and **a held alert is by definition not the always-ring kind**, since
anything that bypasses quiet hours was never held. The record survives regardless.

The reverse stays as it was: silenced on arrival then un-silenced leaves a suppression in
**history** and nothing in the **standing statement**. One is what happened, the other is what
is configured — the same distinction as coverage not being derivable from events.

## A delivery to nobody was sitting in `delivered`

`Recipient` has a third member, `NONE_VERIFIED`, and every `Delivery` carried a full
`Recipient`. So an organisation with **no verified inbox** produced an entry in `delivered`,
satisfied the accounting identity, and **read as served** — indistinguishable in the outcome
from one that was fully reached. The bucket was honest and silence got in through a field
inside it, which is this feature's recurring shape one layer down each time.

`Delivery.recipient` is now `VerifiedRecipient`; a delivery to nobody does not compile.

**I read "it is not a fourth bucket" as *do not leave it hidden in delivered* and gave it its
own place in the identity — say if that is the wrong call.** Folding it into `suppressed` was
the alternative and I think it would be wrong: **suppressed means the MSP chose this;
unroutable means we have nobody to tell.** Conflating a choice with a gap is the error this
feature keeps finding.

## Casts, checked on my own files

QA's fixtures carried two invented enum values masked by `as` casts added to make the file
compile — six checks reporting READY over a vocabulary that is not the product's. Their naming
is the useful part: **a cast written to fix one complaint is a blanket over all of them.**

Grepped mine. No casts in `routing-policy.test.ts` or `finding-intake.test.ts`. The handful
elsewhere are unknown-object traversal (`as Record<string, unknown>` while walking a value of
unknown shape) and one deliberate `as never` to pass an undeclared id to a function that must
reject it. None masking an invented value — but the check was worth running rather than
assuming, and it is cheap enough to repeat.

Six collapses, six caught: the tenant put back into a monitoring cause, the tenant dropped from
a security one, the subject dropped entirely, `fanOutProblems` ignoring the tick, keyed per
tenant, and `contradictions` always reporting none.

## Both directions of `causeKeyOf`, and the sweep that found more than the fix

### Direction 2: the category came from the caller

`causeKeyOf` read `incident.category` and **never consulted `ALERT_CATALOG`**, which is the
authoritative owner of every rule's category and declares it right beside the subject. So the
tenant was in a security cause key only because a caller-supplied field said `SECURITY`.

That is exactly the rule step 02 settled for the subject — **it comes from the declaration, not
from the caller** — because a second place for one fact is free to drift. Same shape, one step
later. `RoutableIncident` now carries `alertTypeId` (typed, so an undeclared id does not
compile) and no `category` at all; the declaration supplies it.

**The case that bites:** one subject present in several tenants — an MSP's own admin account,
or a vendor service principal, which is precisely the identity a fleet-wide privileged change
involves. Same subject across two tenants, mislabelled `OPERATIONAL`, merges into one cause:
**one message covering a privileged change in two customers, naming one of them.**

### Direction 1: the tenant re-entered through the subject

`monitoring.tenant_disconnected` declares `subject: 'TENANT'`, so its subject id **is** the
tenant id. The operational branch dropped `customerTenantId` and **kept** `subjectId` — so
fifteen disconnected tenants produced fifteen causes. One Microsoft outage, fifteen messages
per MSP: the 1,500-message case arriving through the very rule the branch exists to coalesce.

**Dropping one copy of the tenant while keeping the other is incoherent.** If the subject is
the tenant, the branch removes it in both places or in neither.

Safe because coalescing is **per tick** — `fanOutProblems` allows the same fifteen across
different ticks, so two outages a week apart stay two causes. Without that control this ruling
would forbid legitimate recurrence. And `affectedTenants` names the tenants the one message
covers; this is the case it exists for.

### The sweep, and it found a second instance

Driven off `ALERT_CATALOG` rather than written as a list of cases, so a rule added later is
covered without anybody remembering to come back.

| pair | rules | operational branch removes the tenant? |
|---|---|---|
| `OPERATIONAL / COLLECTOR` | `collector_failing`, `recovered` | yes — subject is a resource type, tenant-independent |
| `OPERATIONAL / TENANT` | `tenant_disconnected`, **`consent_expiring`** | yes, and the subject too — both were affected |
| `SECURITY / ACTOR` | `privileged_directory_change`, `routine_directory_change` | n/a — security never coalesces |
| `SECURITY / TARGET` | `suspected_credential_attack` | n/a |

**`monitoring.consent_expiring` has the identical shape and was not among the rules checked.**
One instance found by looking at the obvious candidate is not evidence there is only one — the
sweep asserts the count, so adding a third rule with a tenant subject fails here rather than
shipping.

### And a namespace confusion the sweep surfaced

The instruction described *twenty rules with subject/category pairs*. There are **two separate
namespaces**, and my own step-01 comment states it: *"the configurable grain is this list, not
the seven catalogue ids."*

| list | count | carries |
|---|---|---|
| `ALERT_CATALOG` | 7 | category, subject, severity — the authority for routing |
| `CHANGE_RULES` | 28 | nothing but the identifier — the configurable grain for preferences |

Only the seven have categories and subjects at all, so only the seven can be swept for this
defect. The twenty-eight are what an MSP sets preferences on.

**And there is a third.** Step 04's `intake` puts `IdentityRiskFinding.ruleId` — the Risky
Users engine's own rule — into `QueuedIncident.ruleId`, and that id is in neither list. So a
`RoutableIncident` built from step 04's queue has no declared alert type, and **routing cannot
derive its category at all.**

**That is a gap, not a bug I should fill in.** The Risky Users rules need declared alert types
before their findings can be routed — category, subject and severity, from the catalogue like
everything else. Inventing a mapping here is exactly the shortcut that put a caller-supplied
category in the cause key in the first place. `RoutableIncident.ruleId` is kept alongside
`alertTypeId` for the preference grain, but the type for those findings has to be declared.

### One follow-on, flagged rather than decided

The cause key now uses `alertTypeId`, the coarse declared type. Preferences are per **fine**
rule. If two fine rules under one type carry different preferences — one silenced, one not —
coalescing them into a single cause makes one message span both, and `contradictions` would be
right to complain. Whether the cause key should therefore use the fine rule, or whether
preferences should be constrained not to differ within a type, is a product decision.

## The standing rule, because it is the third time

> **When two fields on one object can disagree about the same fact, one is derived from the
> other or both from a shared owner — never both supplied.**

| step | the fact | who was supplying it wrongly |
|---|---|---|
| 02 | the incident subject | the caller, instead of the declaration |
| 05 | the alert category | the caller, instead of the catalogue |
| 05 | the alert type | the caller, alongside an unrelated rule id |

Same sentence three times. **Anything a caller can get wrong in two places will eventually be
wrong in one of them, and the failure is always silent, because each field is individually
plausible.** Nothing about `category: 'OPERATIONAL'` looks wrong next to a security rule id —
it is a valid value of a real type, and only the pair is nonsense.

This applies to the remaining steps as a design rule, not as a thing to check afterwards. A
review can catch a wrong value; only the shape can stop the pair existing.

### The residual, closed by derivation

`alertTypeId` and `ruleId` were independent fields with nothing tying them, so a
security-natured rule paired with an operational type merged two tenants again. Not live —
no mapping existed — but the shape was there waiting for one.

**The mapping had an owner already**, which is why this creates no second place for the fact.
`ChangeClassification` (`URGENT | ROUTINE | UNCLASSIFIED`) is exactly the distinction the
catalogue's two directory types draw, and `ClassifiedChange.severity` is *already* derived from
it rather than chosen beside it. `alertTypeForChange` is the same derivation, one field over.

A table from twenty-eight rule ids to seven type ids would have **been** that second place:
twenty-eight rows somebody maintains, each able to disagree with the verdict the classifier
already reached.

**`UNCLASSIFIED` refuses rather than defaulting**, and the refusal names no type — checked
against every catalogue id, so a caller reading the sentence cannot extract the default the
function declined to give.

### And the qualification on the sweep, which is the load-bearing part

The sweep holds because **no operational rule has an ACCOUNT-shaped subject** — a fact about
today's catalogue, not about the key. An `OPERATIONAL` rule with an `ACTOR`, `TARGET` or
`ACCOUNT` subject would drop the tenant and put it straight back through the subject id. The
pairs assertion is what stands between us and that, and it discriminates: mutating
`collector_failing` to `ACTOR` fails three tests by name.

## Two shapes, for approval before any code

### Escalation

No new axis. The ladder is a function of **time since notified** and the **ownership state**
that already exists — step 01's `acknowledge` — so "somebody has this" is asked in exactly one
place.

```
EscalationState =
  | { kind: 'WAITING'; notifiedAt; nextRungAt }     // nobody has acknowledged yet
  | { kind: 'ACKNOWLEDGED'; by; at }                // the ladder stops, permanently
  | { kind: 'EXHAUSTED'; lastRungAt; because }      // every rung climbed, still nobody
```

Three things I would want ruled on:

**A rung is a delivery, so it obeys everything above it.** Quiet hours hold it, the cause key
coalesces it, `RECORD_ONLY` means no rung ever fires. That last one is the interesting case: an
MSP who silenced a rule has, by the same act, silenced its escalation — which I think is right
and is worth being deliberate about rather than discovering.

**`EXHAUSTED` is not a failure state and must not read as one.** It means we told everybody we
were told to tell. Whether it also raises something to HawkView's own operators is a product
question I have not answered.

**Acknowledgement is per incident, not per delivery.** Acknowledging a coalesced message about
fifteen tenants acknowledges the cause. If that is wrong — if an MSP must acknowledge each
tenant — then coalescing and escalation are in tension and I would rather know now.

### Delivery limits

Two mechanisms, because a fleet-wide cause and a per-tenant burst want different answers, and
one mechanism doing both would do one of them badly.

| when | mechanism | why |
|---|---|---|
| many tenants, one cause | **aggregate** | already how the cause key works; the limit is the same idea counted rather than keyed |
| many causes, one MSP, short window | **defer** | each cause is a real separate thing; folding them loses the distinction, so they queue |

**Counted over the MSP and the tick**, matching `fanOutProblems`, so the limit and the
invariant measure the same window rather than two windows that nearly agree.

**Never drop** — there is no bucket for it, so the shape cannot express the outcome.

The open question is the number, and I would rather measure it than pick it: the honest input
is the observed distribution of causes per MSP per tick on production data, and I do not have
production access. Until then the limit is a constant with its provenance recorded as *not yet
measured*, which is the same discipline the staleness threshold got — and unlike that one, it
does not yet have its 5,166 runs behind it.

## Correction: the previous commit claimed a closure that was open

`8ef3e1a` said *"the residual, closed by derivation"*. It was not closed. `RoutableIncident`
still accepted `alertTypeId` and `ruleId` independently, and `alertTypeForChange` was **a
function a caller may use, not a constraint on the pair.** Two incidents with a security rule
id and an operational type still produced one cause where correct pairing gives two.

**A field a caller can still set is not derived. It is derivable — a different property, and
not the one the standing rule asks for.** I wrote that rule into the doc in the same commit
where the object it was written for still supplied both fields, which is the difference
between a rule being written down and being applied.

### Closed properly: the pair cannot come into existence

`RoutableIncident` is branded with a phantom field, so an object literal is not assignable and
`routableIncident` is the only way one exists. It takes an **origin**, not a pair:

| origin | where the type comes from |
|---|---|
| `CLASSIFIED_CHANGE` | `alertTypeForChange(classification)` — the verdict the classifier already reached |
| `DECLARED_TYPE` | the type **is** the grain (`monitoring.collector_failing` is both type and rule), so this supplies one fact, not two |

An `UNCLASSIFIED` change produces **no incident at all**, so there is nothing to route under
either directory type.

Every fixture in the test file had to change, and that is the evidence the old shape was
reachable everywhere rather than only in theory.

### And the limit of the brand, measured rather than assumed

A spread **copies** the brand, so patching a derived incident compiles. I wrote a
`@ts-expect-error` claiming otherwise and the compiler reported it **unused** — the compiler
catching the same overclaim twice in a row, in the commit fixing the first one.

- **What the brand gives:** an incident cannot be *fabricated*. No code path invents an
  inconsistent pair from nothing.
- **What it does not give:** immunity from someone holding a real incident and overriding a
  field.

That surface is smaller — it needs a valid incident in hand — and it is not zero, so it is
written down and demonstrated by a test rather than implied away.

### One more self-inflicted: the phantom was not phantom

`declare const` gives a compile-time symbol with no runtime value, and I used it as a computed
key. Every construction threw `ROUTABLE_INCIDENT is not defined` on the first call. Caught by
the tests, not by review — a brand must be declared in the type and never emitted, with the
constructor casting, so the one unchecked step lives in the one place allowed to make these.

## Design constraints for 05b, recorded before the code

**A limit-induced hold has no `until`, and that changes the shape.** A quiet-hours hold has a
natural release: the hour they end, a `Date`, checkable. **A limit releases when volume falls,
which is not a time.** Invent an `until` and the hold sits forever while every accounting
identity still passes — silence that satisfies the books. So a limited delivery carries a
release **condition**, not a timestamp, and `DeliveryTiming` needs a third variant rather than
reusing `HELD`.

**Folding must flatten, not nest.** `Delivery.incidentKeys` resists nesting only one level
deep, so an aggregate of aggregates loses what is inside it — silence produced by a feature
whose purpose is clarity.

**`rungFor(incident, now)` measures the wrong interval.** Time since the *incident* is not time
since the *notification*, and the natural-looking shape cannot express the difference. The
ladder input is the notification, not the incident.

**An acknowledgement carries who and when, and an assumed one has no constructor.** Same shape
as the recipient union: the honest refusal is a variant, and the thing that must not exist is
given no way to be written.

**A ladder advances over time, so one `now` cannot express two advances** — the same
sequence-not-snapshot repair as quiet hours, arriving a third time.

**And the escalation input cannot be derived from what was sent.** QA's own seam derived the
incident set from the deliveries, so an incident nobody had been told about did not exist to
have a ladder — and the property passed vacuously against both the reference and the defect.
Incidents are an input of their own. **Fourth instance of the same rule: a property about
something that did not happen cannot be carried by a list of things that did.**
