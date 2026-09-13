# The verifier and the cancel, bound against the registers

Both registers were published before the code existed — delivery at `08522b9`, cancel at
`c370af8` — and Engineer has not read either.

## The verifier: bound, including the property that must not hold only on the happy path

`87036ad`. Tested against a signature computed the way the product computes it, so the
unconfigured case is asked about something that **would** authenticate.

| | result |
|---|---|
| **D7 positive control** — a genuine signature verifies | **AUTHENTIC** |
| **D6** — a wrong secret, and a tampered body | `SIGNATURE_INVALID` both, **no exception** |
| **D6b** — missing is not invalid | missing gives `SIGNATURE_MISSING`, forged gives `SIGNATURE_INVALID` |
| **unconfigured fails closed** | refuses **the very signature a configured verifier accepts** |
| replay window | a correctly-signed event a day old gives `SIGNATURE_INVALID` |

**The positive control is listed first on purpose.** Without it, the other four rows are satisfied
by a verifier that returns `SIGNATURE_INVALID` for everything.

**Unconfigured was the row worth attacking**, because "fails closed" is easy to hold on malformed
input and easy to lose on well-formed input. Tested with a valid signature, correct timestamp and
correct body: with the secret set it returns `AUTHENTIC`; with the secret removed and **nothing
else changed**, `SIGNATURE_INVALID`. Never `AUTHENTIC` on any input tried.

Two things not in my register and better than what I asked for: the signature header is treated as
a **space-separated list**, so a secret rotation does not reject genuine traffic for its duration;
and a malformed secret yields `null` rather than throwing, so a bad webhook secret cannot stop
HawkView collecting.

## The cancel: five bound, one overruled with a reason I accept, two not met

| property | result |
|---|---|
| C2 one statement, no read-then-write | **bound** — a single `UPDATE`, no `SELECT` |
| C3/C4 bulk and scoped | **bound** — the organisation separator guard works |
| C5 terminal states are not relabelled | **bound** — `SENT` and `EXHAUSTED` untouched |
| C6 the row survives | **bound** — six rows before, six after |
| C8 the incident is untouched | **bound** — the statement names only `alert_send_jobs` |
| **C1 a claimed job is never cancelled** | **overruled, with a reason — I accept it** |
| **C7 who, when and why on the job** | **NOT MET** |
| **a per-job result, not a row count** | **NOT MET** |

### C1 was mine, and Engineer is right

I registered that a `CLAIMED` job must never be cancelled, because it may already be at the
provider. **What landed cancels it deliberately, and the argument is better than mine:** a job
attempted once and refused retryably is still `READY` with its budget unspent, so leaving it alone
means the operator presses stop and an email goes out afterwards anyway — **a decorative stop
button, which is R2 wearing a different hat.**

And `CANCELLED` is a statement about the *job* — we stopped pursuing this — never a claim that
nothing reached a provider. What reached one lives in `alert_send_attempts`, which the cancel does
not touch. **My register protected the record and would have broken the button.** Verified: a
claimed job is cancelled and its claim released.

### C7 is not met

Only `updated_at` moves. **There is no `cancelled_by`, no `cancelled_at`, no
`cancelled_because`** — the migration adds `CANCELLED` to the state constraint and nothing else.

Six months from now, *"why was this MSP never told about that incident"* answers *"the job says
CANCELLED"* and stops there. **That is the silence this feature exists to remove, arriving in the
audit trail instead of the inbox.**

### The per-job distinction is not met, and it was an explicit requirement

The statement has **no `RETURNING`**, so the caller gets a row count.

Measured on a seeded queue: the cancel reported **3**. Of those three, **two had attempts already
made** and **one had none**. **An operator cannot tell which from the result.** The two kinds are
separable only by a second query the caller must know to write.

The operator who most needs that distinction is the one who has just pressed stop on a bad run and
is deciding whether to tell a customer the message was caught. **Told "3 cancelled", they will say
it was caught. Two of those three may already be at the provider.**

**A per-job preview does exist before the press** — `wouldCancel(job, scope)` — which is good, and
is a different question. Before: which jobs *would* stop. After: which of them *might already have
gone*.

## Nothing drains the queue — verified independently, and one wider than named

Engineer named this themselves in `c5339f5`. Verified rather than relayed. **Production callers,
excluding tests and QA probes:**

```
claimStatement    0        attemptSend      0        beginAttempt   0
afterAttempt      0        cancelStatement  0
```

Only two files touch `alert_send_jobs` at all: the intake service, which **writes**, and
`send-queue.ts`, which is the library. **Nothing reads.** So a job existing is not a message being
sent, and every statement about the queue is a statement about an intent nobody executes.

**And `cancelStatement` is in that list, which Engineer did not name.** The stop button exists as
a function and not as a button — no endpoint, no CLI, no script. **A release precondition that
cannot be pressed is not met by the function existing**, and "cancel-unsent-jobs" is one of the
three preconditions on the unnominated release commit.

The new suppression store is in the same position: correct, table-backed, tested — and with no
production caller.

**None of this is wrong.** There is no sender to consume with yet, and building the queue before
the worker is a reasonable order. It needs to be a **stated fact** rather than something
discovered later by somebody wondering why the queue only grows.
