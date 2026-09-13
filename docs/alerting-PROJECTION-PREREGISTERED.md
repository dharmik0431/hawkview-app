# The third stranding instance, registered before the fix — and failing against HEAD

**`qa-projection-check.ts` fails against `c5339f5`. That is the point.** A test for this fix that
passes today is not testing the fix, because **every incident is currently in exactly the state
P1 forbids.**

## What an incident is, from its own migration

> A PROJECTION OVER `notifications`, NOT A PARENT OF THEM. An incident is the set of rows sharing
> an `incident_key`; this holds the state of that set. There is deliberately NO foreign key to
> `notifications` — nothing cascades in either direction.

The pipeline writes an incident and a job and **no notification row**. So every incident is a
projection over the empty set.

## The three properties, measured against HEAD

| | against `c5339f5` |
|---|---|
| **P1** no incident projects over the empty set | **FAILS** — 1 of 1 |
| **P2** never silent in one channel and loud in the other | **FAILS** — 1 of 1 |
| **P3** no keyed notification without its incident | passes, **vacuously — see below** |

### P2 is the one that matters, and it is reachable today

A send job exists for an incident with no notification row. **If a sender existed, the MSP would
be emailed about something their alerts view says never happened.**

That is worse than either failure alone. An email that never arrives is a missed alert. An email
about an event absent from the record **teaches the MSP that the view is not a record** — and
once somebody stops trusting the list, every correct entry in it stops working too.

It is not hypothetical and not a race: it is the state of the only incident in the database, on
the ordinary path, with nothing going wrong.

### P3 passes vacuously, and I am saying so rather than counting it

There are **no keyed notifications at all**, so "no keyed notification without its incident" is
true over an empty set. **It is the same shape as `accountingProblems: []` over zero findings** —
a green check on an empty input, which is not evidence about a full one. P3 only starts
discriminating once the notification write exists.

## What must be re-established when the fix lands, not carried over

**The transaction will span three tables and my atomicity evidence covers two.** The same reason
I refused to carry the explicit-`BEGIN` result across to `prisma.$transaction`: a different
mechanism, or a different extent, is a different claim.

**The method that worked, applied to the third table:** a `CHECK` constraint that only the
**notification** insert can violate puts the failure precisely between the incident and the
notification. Then: **no incident, no job and no notification survives.** Anything less and the
stranding defect has simply moved one table along.

Three placements are needed, because they fail in different windows:

1. a failure on the **job** insert — already covered, re-run it
2. a failure on the **notification** insert — new
3. and the reverse order, if the implementation writes notifications first

## And the case that does not exist yet

**A notification written with no job, where email was expected.** Today it is unreachable — there
are no notifications. After the fix it becomes the mirror of P2: visible in the bell, and silent
by email, for an event where email was the point.

P3 covers the structural half. **The "email was expected" half is not checkable from the
database alone** — expected by whom is a routing decision — so it belongs with the disposition,
and I have not registered a check I cannot write.
