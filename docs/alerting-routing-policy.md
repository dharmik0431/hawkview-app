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
