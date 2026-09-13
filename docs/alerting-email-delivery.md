# Step 06 — email delivery

**What exists: a seam and a ledger, both pure, both under test. What does not exist: any code
that talks to Resend.** No HTTP call, no signature verification, no webhook route, no API key
read from anywhere. This document is careful about that line because the interesting failures
in this feature have all been things that read as done.

I did not read the pre-registration at `59cdc82`. The properties below are built from the
constraints PM relayed, so QA's check stays independent of what I read.

## The finding this is shaped by: ACCEPTED is not an outcome

The provider answers synchronously. **Whether the message arrived is a different fact, arriving
later, by webhook, about a send that has already returned.** One return value carries only the
first.

So `send(message): Promise<Outcome>` — the obvious signature, and the one I would have written
— cannot express most of what needs checking. **A seam that cannot express a property cannot
pin it, and an unaskable property reads exactly like a passing one.** That is QA's line and it
is the binding constraint on this shape.

The consequence is two phases with **two vocabularies that share no member**:

| | `Acceptance` | `Outcome` |
|---|---|---|
| answers | what the provider said when asked | what happened to the message |
| arrives | synchronously | later, by webhook |
| members | `ACCEPTED`, `REFUSED` | `DELIVERED`, `BOUNCED`, `COMPLAINED` |

Nothing converts one into the other. There is no `DELIVERED` arm on `Acceptance` and no
`ACCEPTED` arm on `Outcome`, so acceptance cannot be read as delivery by accident — not because
a reviewer would catch it, but because the union has nowhere to put it.

## ACCEPTED is not a resting state

An accepted job that is never mentioned again **sat in ACCEPTED forever** in QA's own first
draft, and ACCEPTED reads like success while every accounting identity passes.

The unresolved arm therefore carries `unresolvedSinceIso` — you cannot construct one without
saying when the waiting started — and `unconfirmed(ledger, now, afterMs)` is the report. It is
a function rather than a field somebody might render, because **a bounce nobody reads is the
same silence as a hold that expires**: fifth member of that family in this feature.

`afterMs` has **no default**. The honest value comes from observed provider latency, which no
worktree here has, and a default would be a guess every caller inherits without deciding.

## An event we cannot place is named, never dropped

An event for a provider id we hold no job for is **three different facts** — somebody else's
message, a job we lost, an id we never recorded — and discarding it makes all three look like
nothing happening. It lands in `unmatched` with a reason. So does a second outcome for a job
already resolved: Resend can redeliver a webhook, and overwriting would leave the first fact
gone with nothing recording that it was ever true.

`accounting(ledger, eventsReceived)` states the identity: every event either resolved a job or
is named in `unmatched`. A list, not a boolean, so a reader knows which figure to look at.

## Authenticity: pinned from the other side

QA flagged this as unpinnable — **they cannot tell a forged event from a real one.** It is a
security requirement regardless: an unauthenticated webhook endpoint that updates delivery
state is an endpoint anybody can use to mark our messages delivered.

So it is pinned structurally instead. `record` accepts only an `AuthenticEvent`, and the only
way to obtain one is `authenticate(raw, verdict)`. A missing or invalid signature produces an
`unmatched` entry and **has no path to becoming an outcome**. The verdict arrives as a
parameter, so this module never sees a secret and the verification can be tested where the real
signature is.

**The verification itself is not written.** `Authentication` is a type with three members and
nothing computes it yet. When it is written it goes in the route handler, against Resend's
signing scheme, and that is where a test with a real signed payload belongs.

## The body has no slot for a person or a tenant

M8 and M9 are **type-level with no runtime variant, on purpose**: *a leak searched for is a
leak you can spell wrong.* A content check has to enumerate what is forbidden, and the value
that gets through is the one nobody thought to forbid.

Every slot in `BodyLine` is a count, a catalogue id, an ISO timestamp or a closed enum. There
is no `string` free-text field, no name, no address, no tenant, and **no incident key** — the
key carries a tenant id inside it.

The deep link is an opaque `DigestId` resolved server-side behind auth, **not a path**. A URL
is the quiet way a customer name reaches an inbox; nobody thinks of it as message content. The
id is random and deliberately **not derived from the content** — a hash of the incident keys is
a tenant identifier with an extra step and a false sense of having handled it.

The recipient is an `OperatorAddress`, and **there is no constructor from a string**. The only
way to get one is `operatorAddressOf(recipient: VerifiedRecipient)`, and every arm of that union
is an MSP-side inbox somebody verified. "Never a customer end user as a recipient" is a value
this code cannot construct rather than a rule it follows.

**Twelve negatives are written as `@ts-expect-error` in the test file, so the file
type-checking is the evidence** — nine on the body and recipient, three on the authenticity brand
after it turned out not to be one. An unused `@ts-expect-error` is itself a compile error, which is what makes
them assertions rather than comments. Verified by mutation: giving `TYPE_COUNT` an optional
`tenantName` makes `tsc` fail with *Unused '@ts-expect-error' directive* at that line.

## What this module does not carry, and why that is the risk

> **The properties are homeless rather than lost, and the module does not pretend otherwise.
> The risk is not a false claim — it is that a seam this good makes a gap easy to miss, because
> homeless reads exactly like handled when everything visible is this careful.**

That is the inverse of every other finding in this feature. The usual danger is a claim stronger
than the code. Here it is code careful enough that nobody checks whether the thing they need is
actually in it.

**Idempotence and bounded retries live above a send, not inside one**, and always were going to:
idempotence needs the job store, bounded retries need the attempt history. Neither is a defect in
this file and neither is a note for later — **whatever owns retries must own the bound and the
idempotence, and must be checkable.** That is wiring scope.

**One property is partly askable.** Every attempt that reaches `accept` lands in exactly one
state, and that is pinned. An attempt that never reached `accept` leaves no trace at all, because
there is no attempt list to compare against. That closes when the job store exists, and not
before.

**Two are not askable here at all**, which is honest rather than wrong: nothing in a pure module
can establish that Resend honours an idempotency key or that its "accepted" means what we take it
to mean.

## The retry trap, and why `accept` absorbs rather than refuses

**Resend honouring an idempotency key returns the SAME provider id.** So a caller doing the
obvious thing — send, then accept — called `accept` twice with one provider id, and the ledger
held two `UNRESOLVED` jobs. The single `DELIVERED` event resolved the first. **The second stayed
`UNRESOLVED` forever and appeared in `unconfirmed` permanently: reporting that a message nobody
failed to deliver was never confirmed.**

Measured before it was fixed: two jobs, one event, `[RESOLVED, UNRESOLVED]`, still unconfirmed at
two hours. `accounting` did catch it — *"2 jobs share provider id p-1"* — but the seam gave the
caller no way to avoid it, because the provider id is not known until the send returns.

**`accept` now returns the existing job rather than refusing, because that is the truthful
answer.** If the provider returned the same id it *is* the same message. Refusing would be louder
and would push the work onto a caller who then has to write the right handler; absorbing makes
**the obvious code correct**, which is the shape that has worked everywhere else here. The retry
is recorded so it stays visible.

**And a retry is not a collision.** Same provider id with the same message is an honoured
idempotency key. Same provider id with a *different* message means two messages share an
identifier, so one message's outcome would resolve the other's job — `accounting` names that
separately, and `accept` still creates only one job, because a second would reintroduce the
permanent unconfirmed. **It is reported, not repaired:** repairing it would mean guessing which
message the provider actually took.

A consequence worth knowing: the older *"N jobs share provider id"* check is no longer reachable
through `accept`. It stays as a tripwire against a future writer that adds a job by another
route, and its test now builds that state by hand.

## What rests on Resend behaving as documented

**None of these is established by anything in this repository.** They need the provider.

- **That an idempotency key is honoured.** `SendAttempt.idempotencyKey` exists so a retry after
  a timeout does not send twice. Whether it works is Resend's behaviour, not ours.
- **That "accepted" means the provider has taken responsibility for the message.** The whole
  two-phase design assumes acceptance is a real commitment and not an acknowledgement of
  receipt. If it is the latter, `UNRESOLVED` is doing more work than it looks.
- **Any figure about real bounce rates.** There are none in this code, and there should not be
  until somebody measures them.
- **That the domain is verified on `hawkviewapp.com`.** PM's claim, not verified here.

## What to check first when this breaks

1. **Everything looks delivered and nothing is.** Check `unconfirmed` is being called on a
   clock. Nothing calls it yet — that is a wiring gap, not a logic one.
2. **`unmatched` is filling up with `NO_SUCH_JOB`.** Either the ledger is not durable across
   restarts, or webhooks are arriving for a different Resend project.
3. **`unmatched` is filling up with `SIGNATURE_INVALID`.** Check the signing secret before
   assuming an attack; a rotated secret and a forgery look identical from here, which is why
   both are named rather than counted.
4. **A message went out with a customer name in it.** It did not come through `BodyLine` —
   check whether something is rendering the subject line, which this module does not own.

## Not done

- The Resend HTTP call, and the mapping from its response to `Acceptance`.
- Signature verification, and the webhook route that would call `authenticate`.
- Durability: the ledger is a value, and nothing persists it.
- The subject line. It is not modelled here and it is the obvious next leak.
- Anything that decides when to send. That is step 05's `applyLimit` output, not this.
