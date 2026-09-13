# Alerting rollout — the four artefacts, in one place

**For Dharmik, written for somebody who was not here.** Everything in this document was run on
disposable PostgreSQL against real commits. **Nothing has been run against production, and
nothing has been sent to anybody.**

---

## READ THIS PAGE FIRST

**What is true right now:**

- A real Risky Users finding reaches a queued send job, through real foreign keys, on a real
  database — **and the product does this itself now**, not only in a test. Intake is called from
  the sync cascade.
- **Nothing sends.** The only send transport in the repository refuses every message, and
  `resend` is not a dependency at all. Turning sending on requires somebody to *write* a module,
  not to set a variable.
- The migration applies itself on deploy, and a rollback of the deploy is a rollback of **code
  only**. This has been rehearsed.

**What is NOT done, and none of it is optional:**

| | |
|---|---|
| the webhook signature verifier | **not written** |
| the `emailEnabled` switch as an operator-facing step | **not written** |
| **cancelling unsent jobs — the stop button** | **not written** |
| the watermark instant | **nobody has chosen it** |
| a backfill for findings older than the read window | **does not exist** |

**No commit is nominated for release yet**, because none of them contains a stop button. See
artefact 1.

**Three checks in this document can only be closed by a person.** They are named, with a
signature line each, in artefact 4. **Nothing here should be read as verified while those lines
are blank.**

---

## Artefact 1 — the exact release commit

**`<RELEASE_COMMIT — NOT YET NOMINATED>`**

Deliberately unfilled. A commit is nominatable when it contains the verifier, the `emailEnabled`
switch and **cancel-unsent-jobs**. The last of those is the operator's stop button, and D9 makes
it near-certain somebody will want it within a minute of switching the feature on.

**Do not nominate a commit that cannot be stopped.**

Current head of the work at the time of writing: `c3953b2` — the sender, with no transport.

## Artefact 2 — tests actually executed, by name and result

**No suite totals.** A total is the figure that hid the gap this feature spent a night
correcting.

### The alerting integration tests — ten runs of five

| test | result |
|---|---|
| `A PERSISTED FINDING REACHES A SEND JOB` | pass |
| `NO HISTORICAL SENDS, against the real table` | pass |
| `INTAKE YIELDS RATHER THAN BORROWING FROM THE COLLECTORS` | pass |
| `A BUDGET YIELD LEAVES NO HALF-DONE WORK, and the next run completes it` | pass |
| `AN UNMAPPED RULE PRODUCES NOTHING AND IS STILL ACCOUNTED FOR` | pass |

**Ten consecutive runs on one cluster, one commit, one database: five of five every time.**

**And the reason, which is worth more than ten samples.** These tests' budgets are thirty seconds
against work that finishes in under a second, and the one deadline-sensitive assertion drives an
**injected** clock rather than racing a real one. They are reproducible **by construction, not by
luck.** That distinction is why the figure above can be relied on.

### The identity-risk database-integration suite

**This suite has no reproducible number, and none is quoted here — not even in passing.** Repeated
runs on one machine, one cluster and one commit produce materially different results. A figure
from it describes the run it came from and nothing else.

**The cause of most of its failures has not been identified.** A timeout accounts for some of
them; it does not account for most. *"One speed-sensitive suite"* describes the **variance**; it
is not an account of the **failures**, and it must not be written as one.

**It is not on the release path**, and nothing in this rollout depends on it. The separately
useful fact is that **the 1588-passing unit figure does not cover it**, and never did.

### Other checks run, by name

- The apply runbook, all five commands end to end, both preflight outcomes, on a disposable
  database — plus a concurrent writer proving the in-transaction re-check rolls the run back
  rather than writing 46 of 47.
- One claim wins, against Postgres: 25 rounds, exactly one winner each time.
- Cancellation C1/C2, against Postgres, **before the code exists**: one statement produced one
  winner 25/25; the read-then-write shape cancelled a job a worker had already claimed 25/25.

## Artefact 3 — migration and rollback readiness

### Deploy is migrate

`backend/Dockerfile` runs `npm run db:migrate:deploy` before `npm start`, on every container
start. **Three consequences:**

1. **There is no migration gate.** Merging and deploying applies all four alerting migrations,
   with no operator step in between. **The release hold is the only thing standing between them
   and your production database.**
2. **`prisma migrate deploy` is forward only.** Rolling back to the previous image does not undo
   a migration.
3. **The runbook's step 0 therefore describes a gate that does not exist.** Running the command
   by hand is a confirmation, not a decision. Corrected text has been supplied for that step.

### The rollback rehearsal — run, not reasoned

A disposable database migrated to the branch head, then the **previous commit's** backend started
against it. Dependencies identical between the commits, verified by blob sha.

| | result |
|---|---|
| the old image's boot step against a database four migrations ahead | `No pending migrations to apply`, exit 0 |
| the old application starting | started, **zero errors** after start |
| `GET /health` | 200 |
| `GET /health/database` — a real query | 200, **`{"database":"connected","schema":"current"}`** |
| `/api/notifications`, `/api/tenants`, `/api/changes` | 401 — the guard runs; the stack serves |
| the old client against a row the apply had already **keyed** | serves, **and the key survives untouched** |

**The strongest line is `"schema":"current"`** — that is not somebody's judgement that the schema
looks compatible, it is **the old code's own schema check passing against the new schema.**

**The first row is the one that could have gone the other way.** Had `migrate deploy` refused a
database ahead of it, the old container would not merely have failed to undo the schema — **it
would have failed to boot**, and "rollback is code-only" would have been "there is no rollback".
Nothing in reading the migrations distinguishes those two outcomes.

### Two limits on that result, which must not be rounded up

- **What was established: three public and three guarded routes answered.** `/health`,
  `/health/database` and the application starting; `/api/notifications`, `/api/tenants` and
  `/api/changes` returning 401 rather than 500. On a synthetic database, with synthetic
  configuration, under no load.

  **"The old application serves" is a stronger claim than that, and it should not be written.**
  The gap between six routes answering and an application serving is exactly where a rollback
  goes wrong — and it goes wrong at the worst possible moment, because a rollback is something
  you do when something is already broken and you are already out of time.
- **A rollback does not undo the apply.** Keys written by the apply survive a code rollback,
  untouched and unread by the old code. Undoing the apply is the revert subcommand's job, and it
  needs its receipt file — without `receipt.json` there is no revert.

## Artefact 4 — the Green Technology acceptance checklist

**Step one, before anything else: `emailEnabled` is off until somebody turns it on.** The switch
defaults false and an absent preference row means off. Checked by *absence producing no send*,
never by reading a default.

### The four a person must do

**No test can close these. While these lines are blank, this feature is not verified.**

**1. Send twice, one arrives.** Two sends carrying one idempotency key. Our side can only show
what we did — two calls, one key, one provider id. **Whether that became one email or two is a
fact about the provider and an inbox.** A test asserting "one arrived" by counting our own calls
asserts what it assumed.

> Performed by ____________________ on ____________  Messages in the inbox: ______

**2. A human opens the inbox and writes down what arrived.** Sender address, subject, whether it
rendered, whether the deep link resolves **and demands authentication**, and **whether anything
in the body names a person or a tenant.** The body is built from a closed vocabulary with no slot
for an identity — a guarantee about what the *code* can construct, and not about what a template,
a subject line or a provider footer adds on the way out.

> Performed by ____________________ on ____________  Anything naming a person? ______

**3. A genuine signature still verifies.** Against a real webhook, with the real secret.
**`() => 'invalid'` passes every forgery test ever written** — a verifier that rejects everything
is indistinguishable from a correct one until something genuine arrives, and the first genuine
thing in production would be a delivery receipt that silently never lands.

> Performed by ____________________ on ____________  Genuine signature verified: ______

**4. A real hard bounce**, handled as a fact about an address rather than an error in a log: the
next send to that address does not go, and a *different* message to the same dead mailbox is not
attempted either.

> Performed by ____________________ on ____________  Address suppressed afterwards: ______

### Forecast the first real run before it runs

**How many messages, to which organisations, computed from the chosen watermark, nothing sent.**
If that number is more than a handful the watermark is wrong — **and that is a tuning question
only until it is sent. Afterwards it is a recall problem, and there is no recall.**

The damage is bounded more tightly than it first appears: an ordinary tick reads **at most the
last 24 hours** (168 if raised), whatever the watermark says, so a watermark set a month back does
not send a month of email. **But a bound is not a number, and nobody has counted what a day
contains.**

> Forecast: ______ messages, across ______ organisations. Watermark: ____________
> Approved by ____________________ on ____________

### One figure that will otherwise be over-read

`accountingProblems: []` means every finding appears exactly once across the jobs and the skips.
It is a self-reconciliation over one pass. **It proves nothing vanished. It cannot prove anything
was classified correctly** — a finding wrongly skipped as `RECORD_ONLY` counts exactly once and
the books still balance. A tripwire against a future edit, **not evidence that the delivery
decisions are right.**

### Three decisions that are yours, not ours

**1. The watermark instant.** Nobody has chosen it. The service refuses to run without one and
treats an unparseable value as a refusal rather than a fallback, which is correct — but it means
the feature cannot start until you pick the instant before which nothing is sent.

**2. Whether findings older than the read window should exist in the system at all.** Ordinary
ticks read a bounded window, so older findings **never receive an incident row**, and no backfill
job exists. That is the difference between *"we will not email you about last month"* and *"last
month is not in the system"*. Both are defensible; they are different products, and the choice is
yours.

**3. Mailbox forwarding at launch — FLAGGED, AND I COULD NOT FRAME IT.** This was raised as a
launch decision and I have not been able to establish what it refers to. Searching the alerting
code, the alerting documents, the handoff and the acceptance notes returns nothing: every match
for *forward* is unrelated — a watermark's forward edge, carrying an acknowledgement forward. The
only mailbox-forwarding material in the repository is frontend mock data about Exchange
auto-forwarding **rules**, which is a control HawkView reports on rather than anything about how
HawkView's own mail is delivered.

**It is listed here unframed on purpose.** It is a real decision somebody is holding, and writing
a plausible-sounding version of it would be worse than leaving the gap visible — a decision put
to you in words nobody checked is how a caller-supplied category ends up in a key. **Whoever
raised it should supply the sentence.**

If it means what I would guess — that the MSP security inbox may be a distribution list or a
forwarding address, so HawkView's alerts reach people nobody enumerated — then that is worth
deciding, and it interacts with the body carrying no identity: **a closed vocabulary limits what
we say, and says nothing about who ends up reading it.** But that is my guess and it is labelled
as one.
