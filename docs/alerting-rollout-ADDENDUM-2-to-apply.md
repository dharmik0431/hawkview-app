# Second addendum — to apply into `docs/alerting-rollout-readiness.md`

**Written, not landed.** The branch is Engineer's to write to; this goes in with the first
addendum and the other files, **into** the readiness document rather than beside it.

---

## A. REPLACE blocker 3 with this — `rawBody`, now measured

**3. The raw body does not reach the verifier, so a genuine webhook would fail — confirmed.**

`main.ts:8` is `NestFactory.create(AppModule)` with no options. The verifier computes its HMAC
over `id.timestamp.rawBody`; without the option, the raw bytes are discarded at parse time and
the only thing a handler can reach is a **re-serialisation** of the parsed object.

Measured through a real Nest pipeline bootstrapped with that exact call:

```
req.rawBody available to the controller : false

sent on the wire  : {"type":"email.delivered",  "data":{ ... }}
reconstructable   : {"type":"email.delivered","data":{ ... }}
byte-identical    : false          <- two spaces after a comma are enough

genuine signature : q3EgqaQcSTfWIPvu2ch+PqeblB/pZfcepKjHcIs6zc0=
over the rebuild  : aXZK46luUvwfzQ9JQ4TwvdrzN7IkgqihsxSDsWEb/hw=

a genuine Resend webhook would verify : FALSE
```

**Permanently, not intermittently.** Whitespace alone does it; key order and unicode escaping
would too.

**The remedy is one option**, run as a positive control:
`NestFactory.create(AppModule, { rawBody: true })` makes `req.rawBody` available. **It must be
made before the webhook route is written**, or the route will be built and tested against a
pipeline that cannot deliver its input — and those tests will pass.

**AND NO EXISTING TEST COULD HAVE FOUND THIS, INCLUDING QA'S OWN.** The verifier binding reported
elsewhere as "fully bound" was bound to the **function**, not to the **path**: every test in it —
QA's and Engineer's alike — hands the raw bytes straight to `verify()`. The verifier is correct
and discriminates correctly given the right bytes. **It says nothing about whether the right bytes
arrive, and it could not have.** Anybody reading "the verifier is fully bound" in the history
should read it as bound to the function only.

## B. REWORD blocker 4

**4. Delivery outcomes are not persisted.**

*(Previously "no persisted ledger", which reads as though nothing about sending is recorded. That
is false — and a blocker list with one dismissible item teaches a reader to skim the rest.)*

`alert_send_attempts` **is** persisted and holds `ACCEPTED`, `REFUSED_RETRYABLE`,
`REFUSED_PERMANENT` — **what the provider said when asked.** What has no table is the *outcome*:
`DELIVERED`, `BOUNCED`, `COMPLAINED`, plus `unmatched` and `retries`, which live only as
in-memory values. Searched for any outcome, delivery, webhook or unmatched table: none.

**What its absence costs:**

- **"Was it delivered?" is unanswerable across a restart.** Acceptance survives; the outcome does
  not.
- **`unmatched` events are lost** — events arriving for provider ids we hold no job for. **That is
  precisely the surface that would show somebody posting forged or replayed events at the
  endpoint**, which is what the verifier exists to protect.
- **Half of it already persists, which is the confusing part.** A hard bounce's *consequence* is
  durable in `alert_suppressed_addresses`. The bounce's *record against a message* is not.
  **After a restart you would know an address is dead and not know which message killed it.**

## C. ADD TO "THE SECOND GATE IS NOT A DATE"

| | harmless while nothing sends | consequential the moment email is on |
|---|---|---|
| **delivery outcomes not persisted** | no outcome exists to lose | "was it delivered" becomes a question people ask, and a restart erases the answer |

It is inert today for the same reason everything else on that table is inert: **nothing sends.**
It becomes load-bearing at the same instant the rest of them do.
