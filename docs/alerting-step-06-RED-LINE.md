# My nine step-06 properties, against the real seam — the red line assessment

**Owed since the pre-registration, and now run rather than read.** I pre-registered nine
properties before `email-delivery.ts` existed and said: if the implementer picks a different
shape, the properties stay and my checks get rewritten against theirs — but **I would not accept
a shape in which a property becomes UNASKABLE, because unaskable reads exactly like passing.**

The shape is different from the one I proposed. Checker: `qa-step-06-against-real.ts`, run at
`08133a2`.

## The verdict

| property | askable? | result |
|---|---|---|
| M4 accepted is not delivered | yes | **holds** — acceptance yields `UNRESOLVED`, and `Outcome` has no `ACCEPTED` arm to promote it |
| M5 a bounce lands on its job | yes | **holds** — resolved as `BOUNCED`, unclassified defaulting to `HARD` |
| M6 an unknown event is named | yes | **holds, stronger than I asked** — `NO_SUCH_JOB`, `ALREADY_RESOLVED` and `SIGNATURE_INVALID` are three separate reasons |
| M7 an unresolved job is reported | yes | **holds, and it discriminates** — quiet at one minute, reported at two hours |
| M8 the body cannot carry an identity | yes | **holds, stronger than my version** — `BodyLine` is a closed union of counts and catalogue ids with no `string` slot |
| M9 no tenant on the send path | yes | **holds** — `SendAttempt` is `messageId`, `to`, `body`, `idempotencyKey`, nothing else |
| M3 every attempt has a recorded outcome | **partly** | every attempt reaching `accept` lands in exactly one state; one that never reached it leaves no trace, and there is no attempt list to compare against |
| **M1 the same idempotency key sends once** | **NO** | no function takes an idempotency key; `accept` never reads `attempt.idempotencyKey` |
| **M2 retries bounded, exhaustion ABANDONED** | **NO** | `Job` has three states and none is `ABANDONED`; nothing counts attempts; no bound is a parameter |

**Six hold, three of those in a stronger form than I specified. One is partial. Two are
unaskable.** Seven seams out of seven where something turned out unpinnable.

## The qualification, and it is in the implementer's favour

**M1 and M2 were never askable of a send.** My own contract said so before this code existed:
*"idempotence needs the job store, not a function call"*, *"bounded retries need the attempts."*
My proposed seam carried `jobs`, `ticks` and `maxAttempts`; this one deliberately stops below
that layer.

**So the properties are not lost, they are homeless.** And nothing here pretends otherwise — the
`idempotencyKey` comment says plainly that it working *"is a claim about Resend, not about this
code."* That is the honest form and it belongs on the record.

**The risk is not a false claim. It is that a seam this good makes a gap easy to miss.** Nothing
currently owns retries, bounds or idempotence, and *homeless* reads exactly like *handled* when
everything visible is this careful.

## One concrete trap, measured rather than predicted

**A correctly idempotent retry, recorded the obvious way, produces a permanent false alarm.**

Resend honouring an idempotency key returns *the same* provider id for the retry. A caller doing
the natural thing — send, then `accept` — calls `accept` twice, and the ledger then holds **two
`UNRESOLVED` jobs sharing one provider id.** The single `DELIVERED` event that follows resolves
**only the first** (`record` takes `open[0]`). The second stays `UNRESOLVED` forever and appears
in `unconfirmed` **permanently** — reporting that a message nobody failed to deliver was never
confirmed.

Measured: `jobs: 2`; after one delivered event `["RESOLVED", "UNRESOLVED"]`;
`stillUnconfirmedAtTwoHours: 1`.

**`accounting` does catch it** — it returns `2 jobs share provider id p1`. That is a real
mitigation and it is why this is not a defect in the module.

**But the seam offers the caller no way to avoid it.** There is no `accept` that updates an
existing job and no lookup by idempotency key, and the provider id is unknown until the send
returns, so a caller cannot check first. **The trap is default-on for the obvious
implementation — which is the implementation about to be written.**

## What I recommend, as judgement rather than measurement

1. **Not a blocker on this module.** Nothing it claims is false, and M1/M2 were always going to
   live above it.
2. **A required item in the launch scope rather than a backlog entry:** whatever owns retries
   must own the bound and the idempotence, and must be checkable. I will pre-register against it
   before it is written — that is the only reason this assessment was possible today.
3. **Close the double-accept trap in the seam, not in a comment.** A comment is advice, and the
   next person is writing the caller. Either `accept` refuses a provider id the ledger already
   holds open, or it returns the existing job instead of appending a second.
