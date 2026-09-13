# The three checks no test can close, and who has to do them

**For the acceptance checklist.** These are registered so that nobody can report this feature
verified without saying **which of them a person actually performed**. Each has a name, a reason
it cannot be automated, and a line for the person who did it.

They are not a formality. Each one covers a failure that every automated check in the repository
would report as passing.

---

## D2 — Send twice, one arrives

**Who: a person with access to the receiving inbox.**

Two sends carrying one idempotency key. **Our side can only ever show what we did** — two calls,
one key, one provider id back. Whether that became one email or two is a fact about Resend and
an inbox, and no assertion in this codebase can reach it.

**A test that asserts "one email arrived" by counting our own calls is asserting the thing it
assumed.** This is the same defect as searching a serialisation for the one rendering of a secret
we happened to think of.

**Write down:** how many messages were in the inbox. Not "idempotency verified".

> Performed by ____________________ on ____________  Messages in the inbox: ______

---

## D5 — A human opens the inbox and writes down what arrived

**Who: a person, ideally one who is not on this project.**

Not "the email sent successfully". What arrived, as read by somebody:

- the sender address it came from
- the subject line
- whether it rendered, in whatever client they actually use
- whether the deep link resolves **and demands authentication**
- **whether anything in the body names a person or a tenant**

The last one is the one to slow down on. The body is built from a closed vocabulary with no slot
for an identity, which is a strong guarantee about what the code can construct — and it is not a
guarantee about what a template, a subject line, or a provider's own footer adds on the way out.

> Performed by ____________________ on ____________  Anything naming a person? ______

---

## D7 — A genuine Resend signature still verifies

**Who: whoever holds the webhook signing secret.**

My reference implementation proves the *check discriminates*. **It does not prove Resend signs
that way.** The positive control has to run against a real signature from a real Resend webhook,
with the real secret, in the place that has it.

**Why this one is not optional:** `() => 'SIGNATURE_INVALID'` passes every forgery test ever
written. A verifier that rejects everything is indistinguishable from a correct one until
something genuine arrives — and the first genuine thing to arrive in production would be a
delivery receipt that silently never lands, leaving every message permanently unconfirmed.

> Performed by ____________________ on ____________  Genuine signature verified: ______

---

## And one that is a decision rather than a check

**D9 — the first real run must be forecast before it runs.** How many messages, to which
organisations, computed from the chosen watermark, **with nothing sent.**

**Nobody has chosen the watermark instant, and it is not QA's to choose.** If the forecast is
more than a handful, the watermark is wrong — and that is a tuning question only until it is
sent. Afterwards it is a recall problem, and there is no recall.

> Forecast: ______ messages, across ______ organisations. Watermark: ____________
> Approved by ____________________ on ____________
