# The acceptance checks, as things to do at nine in the morning

**The checklist says what must be established. This says how.** For each: what to run, what to
look at, what counts as a pass, and what to write on the line.

**Nothing here is signed by running a command.** Four of these need a person to look at something
a machine cannot look at, which is why they have signature lines at all.

---

## FIRST — forecast the run before you make it

**Run:**

```bash
cd backend
export DATABASE_URL='…'                              # read-only credentials are enough
export HAWKVIEW_ALERT_WATERMARK_ISO='2026-09-13T00:00:00.000Z'   # the instant YOU chose
npx tsx scripts/alerting-forecast.mts
```

**It reads and nothing else.** Only `SELECT` statements; verified by row count before and after.
**It refuses to run without a watermark, and an unparseable one is also a refusal** — both exit
`2`, so it is safe to put in a script.

**Look at:** the first block. It prints the four gates it is operating under — watermark, read
window, read limit, and how many unmapped rules appear in this window — **so you are not relying
on remembering that they exist.**

**A pass is:** a number of messages you are willing to send, to a set of organisations you
recognise. **There is no correct value.** If it is more than a handful on the first run, the
watermark is wrong, and that is a tuning question **only until it is sent.**

**Two things that mean stop:**

- `*** N ARE BEYOND THE 5000-ROW LIMIT` — a burst is being deferred, and the forecast describes
  one tick rather than the backlog.
- `*** THEY DISAGREE` — the same figure counted two ways does not match. Do not act on the
  forecast; something has drifted between the catalogue and the decision.

> Forecast: ______ messages, across ______ organisations. Watermark: ____________
> Approved by ____________________ on ____________

---

## 1 — Send twice, one arrives

**Run:** trigger the same message twice — the same job retried, not two different alerts. On a
disposable setup, the simplest form is to let a send time out and be retried; on a real one, ask
the operator of the queue to replay one job.

**Look at:** the receiving inbox. **Count the messages in it.** Not the logs, not the job state,
not the provider dashboard — **the inbox.**

**A pass is:** exactly one message, for two sends carrying one idempotency key.

**Why a machine cannot do this:** our side can only show what we did — two calls, one key, one
provider id back. **Whether that became one email or two is a fact about the provider and a
mailbox.** A test that counts our own calls is asserting the thing it assumed.

> Performed by ____________________ on ____________  Messages in the inbox: ______

---

## 2 — A human opens the inbox and writes down what arrived

**Run:** nothing. Open the message that arrived in check 1.

**Look at, and write down:**

- the **sender address** it came from
- the **subject line**
- whether it **rendered** — in the client the recipient actually uses, not a preview
- whether the **deep link resolves and demands authentication** when opened in a private window
- **whether anything in the body names a person or a tenant**

**A pass is:** nothing in the body names a person or a tenant, and the link demands
authentication.

**Why a machine cannot do this:** the body is built from a closed vocabulary with no slot for an
identity. That is a strong guarantee **about what the code can construct** — and it says nothing
about what a template, a subject line, or a provider's own footer adds on the way out. **The only
place to see what was actually sent is the thing that received it.**

> Performed by ____________________ on ____________  Anything naming a person? ______

---

## 3 — A genuine signature still verifies

**Run:** send a real webhook from the provider — a test event from their dashboard is enough —
at the configured endpoint, with the real signing secret in place.

**Look at:** whether the event was accepted and matched to its job, **and** whether a deliberately
corrupted copy of the same event is rejected.

**A pass is both halves.** A genuine event verifies **and** a tampered one does not.

**Why the positive half is not optional:** `() => 'invalid'` passes every forgery test ever
written. **A verifier that rejects everything is indistinguishable from a correct one until
something genuine arrives** — and the first genuine thing in production would be a delivery
receipt that silently never lands, leaving every message permanently unconfirmed.

> Performed by ____________________ on ____________  Genuine verified: ____  Tampered rejected: ____

---

## 4 — A real hard bounce

**Run:** send one message to an address that will hard-bounce — an invalid mailbox at a domain
you control is cleanest.

**Look at:** the suppression state for that address after the bounce arrives, then attempt a
**different** message to the same address.

**A pass is:** the second message is **not attempted**, and the refusal names the suppression
rather than looking like an error.

**Why it matters that it is per address:** a bounce recorded against the job would let every new
incident retry the same dead mailbox, and **continuing to write to dead addresses is what earns a
sending domain a reputation problem** — damage that lands on every other message rather than on
the one that bounced.

> Performed by ____________________ on ____________  Second message attempted? ______
