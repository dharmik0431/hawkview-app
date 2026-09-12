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

**Nine negatives are written as `@ts-expect-error` in the test file, so the file type-checking
is the evidence.** An unused `@ts-expect-error` is itself a compile error, which is what makes
them assertions rather than comments. Verified by mutation: giving `TYPE_COUNT` an optional
`tenantName` makes `tsc` fail with *Unused '@ts-expect-error' directive* at that line.

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
