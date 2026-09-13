# Two blockers that existed as a mention — now measured

Both were named on the readiness blocker list and neither had been established. **One is
confirmed and worse than named. The other is real but ambiguously worded, and the wording is
doing harm.**

## 1. `rawBody` — CONFIRMED, and it invalidates nothing I reported but limits it

**The claim:** `main.ts` passes no `rawBody` option, so the bytes a signature is computed over
are not available.

**Measured through a real Nest pipeline**, bootstrapped with the same call `main.ts` makes —
`NestFactory.create(Module)`, no options — with a controller that tries to read the raw body:

```
rawBodyAvailableToTheController : false
sent on the wire   : {"type":"email.delivered",  "data":{...,"to":"søren@msp.example"}}
reconstructable    : {"type":"email.delivered","data":{...,"to":"søren@msp.example"}}
byte-identical     : false            <- the two spaces after the comma are gone
genuine signature  : q3EgqaQcSTfWIPvu2ch+PqeblB/pZfcepKjHcIs6zc0=
over the rebuild   : aXZK46luUvwfzQ9JQ4TwvdrzN7IkgqihsxSDsWEb/hw=
a genuine webhook would verify : FALSE
```

**A genuine Resend webhook would fail verification, permanently.** Not intermittently and not
under load — every time, because a re-serialised body is a different byte sequence with the same
meaning. Whitespace is enough; key order and unicode escaping would do it too.

**And no existing test can see it**, including mine. Every verifier test — theirs and the binding
I reported as clean — hands the raw bytes straight to `verify()`. **The verifier is correct; the
pipeline that feeds it is not, and the seam between them is where the property lives.** That is
the store-nobody-tested shape for the third time.

**My verifier binding is not invalidated but its scope is now stated:** it establishes that
`verify()` discriminates correctly given the right bytes. It says nothing about whether the right
bytes arrive.

**The remedy is one option, and I ran it as a positive control.**
`NestFactory.create(Module, { rawBody: true })` makes `req.rawBody` available. **Blocker, with a
one-line fix** — and the fix must be made before the webhook route is written, or the route will
be built and tested against a pipeline that cannot deliver its input.

## 2. "No persisted ledger" — REAL, but the wording should change

**It is not the send-attempt record**, and that was the thing worth checking, because
`alert_send_attempts` exists, is persisted, and looks like a ledger.

| | holds | persisted? |
|---|---|---|
| `alert_send_attempts.settled_kind` | `ACCEPTED`, `REFUSED_RETRYABLE`, `REFUSED_PERMANENT` — **what the provider said when asked** | **yes** |
| the in-memory `Ledger` | `DELIVERED`, `BOUNCED`, `COMPLAINED`, plus `unmatched` and `retries` — **what happened to the message afterwards** | **no table exists** |

Searched for any outcome, delivery, webhook or unmatched table: **none.**

**So the line is correct and should not be struck** — but "no persisted ledger" reads as though
nothing about sending is recorded, which is false and invites a reader to dismiss it on sight.
**Suggested wording: "delivery outcomes are not persisted."**

### What its absence actually costs

- **"Was it delivered?" is unanswerable across a restart.** Acceptance survives; the outcome does
  not.
- **`unmatched` events are lost** — events arriving for provider ids we hold no job for. That is
  the surface that would show somebody posting forged or replayed events at the endpoint, and it
  is the one the verifier work exists to protect.
- **Half of it already persists, which is the confusing part.** A hard bounce's *consequence* is
  durable — `alert_suppressed_addresses` survives a restart, verified in `c5339f5`. The bounce's
  *record against a message* is not. **After a restart you would know an address is dead and not
  know which message killed it.**

## Neither is left as "named"

One confirmed with a measured failure and a one-line remedy; one confirmed real, with a wording
change so a reader does not skim past it.
