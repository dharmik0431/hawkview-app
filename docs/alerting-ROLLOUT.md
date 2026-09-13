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

**AND THE THING THAT MATTERS MOST ON THIS PAGE: the pipeline works and there is nothing for it to
carry.** Measured in production, read-only, by PM — **I have no production access and have not
confirmed these myself:**

| table | rows |
|---|---|
| `identity_risk_evaluation_runs` | **7,365** |
| `identity_risk_matched_results` | **0** |
| `identity_risk_findings` | **0** |
| `notifications` | 366, across 7 tenants and 4 organisations |

**The risk engine has run 7,365 times and matched nothing, ever.** So switching alerting on today
— with a perfect watermark, a working sender and every check on this page signed — delivers
**zero emails to Green Technology.** Not because alerting is broken, but because there are no
findings for it to act on.

**Do not read a correct alerting chain as meaning MSPs will be notified.** Everything this
document establishes is about a pipeline that currently has an empty source.

**And the zero is uncharacterised.** It has not been established whether it is a true zero —
three narrow detectors across a small fleet genuinely matching nothing, which is a legitimate
outcome — or an absence being read as evidence. PM's narrower observation, which I am relaying
rather than confirming: a source reports READY and CURRENT on the strength of a successful
collection while carrying no observed events, and the rules built on it assess zero identities
and also report READY. **That is the difference between "nothing is happening" and "we cannot
see", and nobody has resolved which.** It is outside the alerting scope and is being handled
separately.

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

**Each of these is written out as a procedure in `alerting-ACCEPTANCE-HOW.md`** — what to run,
what to look at, what counts as a pass, and what to write on the line.

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

**There is now a command for this — see `alerting-ACCEPTANCE-HOW.md`.**
`npx tsx scripts/alerting-forecast.mts` reads and nothing else, refuses to run without a chosen
watermark (and refuses an unparseable one rather than falling back), and prints the four gates it
is operating under so nobody has to remember they exist.

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

**3. Six detectors produce no email, and two of the six are not minor.** This was put to me as
"mailbox forwarding at launch". I could not frame it from the alerting code, because it is not
there — and having now been shown where it lives, **the decision is wider than the phrase.**

A risk rule becomes an alert type through the `investigationGuidanceCode` the catalogue declares.
Two of the four codes map to no alert type, **deliberately** — so a finding under them produces
no incident, no job and no email, and is reported as unmapped rather than defaulted. Verified by
running the mapping rather than reading it:

| rule | what it detects | why no email |
|---|---|---|
| `HV-ID-MBX-001.v1` | Mailbox forwarding outside verified domains requires review | `REVIEW_MAILBOX_RULE` |
| `HV-ID-MBX-002.v1` | **Mailbox concealment rule requires investigation** | `REVIEW_MAILBOX_RULE` |
| `HV-ID-MBX-003.v1` | Mailbox rule changed after suspicious authentication | `REVIEW_MAILBOX_RULE` |
| `HV-ID-CHG-005.v1` | **Identity protection configuration was weakened** | `REVIEW_CONFIGURATION` |
| `HV-ID-APP-001.v1` | New application declares high-impact permissions | `REVIEW_CONFIGURATION` |
| `HV-ID-APP-002.v1` | Application credential metadata changed | `REVIEW_CONFIGURATION` |

Eighteen rules do map. **The refusal is the correct engineering** — inventing a type for these is
the shortcut that put a caller-supplied category into a key once already. **But "we detect it and
we will not email you about it" is a product decision, not an engineering one**, and the two rows
in bold are the reason it is yours: a concealment rule and a weakened identity-protection
configuration are not routine findings to leave silent.

The options are to add catalogue types for these codes, to ship deliberately silent and say so, or
to ship with them surfaced somewhere other than email. **All three are defensible; only you can
pick.**

*(Separately, and not what was being asked: an MSP security inbox that is a distribution list or a
forwarding address would send alerts to people nobody enumerated. That is a different concern from
the one above, it is unexamined, and I raise it only so it is not lost.)*

---

# The second gate, and it is not a date

**A judgement, not a measurement.** Everything above is something that was run. This section is
an argument about what happens later, and it is labelled that way because it should be argued
with rather than trusted.

**The first real run is not the first tick after the switch. It is the first tick after findings
exist.**

Today the source is empty, so switching alerting on is uneventful: the forecast is trivially
safe, nothing sends, and every check passes. **The day the risk engine starts matching, a set of
decisions made months earlier all become load-bearing at the same instant — and nobody will be
watching, precisely because switching it on was uneventful.**

These are not gated by a date, a deploy or a release. **They are gated by the first finding.**

## What changes meaning on that day

| | harmless while the source is empty | load-bearing from the first finding |
|---|---|---|
| **the watermark instant** | nothing is older than it, because nothing exists | decides which history is silently never mentioned |
| **the 24-hour read window** | no findings fall outside it | findings older than a day never receive an incident at all, and no backfill job exists |
| **the `LIMIT 5000`** | unreachable | a burst above it is silently deferred, and no test can reach the boundary |
| **the six unmapped rules** | they match nothing | six detectors fire and produce no email, two of them for concealment and weakened identity protection |
| **the suppression list** | empty | a hard bounce starts deciding who is never written to again |
| **`maxAttempts` of 3** | no job spends it | decides when a message stops being retried and becomes `EXHAUSTED` |

## And the part that is mine to say

**Several of the passing results in this document are passes over an empty input.** They are true
and they are worth having, but they have never had the chance to discriminate:

- `accountingProblems: []` balances a set of zero findings. **An invariant that has never seen a
  non-trivial input has never had the opportunity to fail.** It was mutation-tested on fixtures,
  which is why I trust it — but the trust comes from the mutation, not from the production zero.
- `neverSent()` enumerates jobs, and there are none.
- The unresolved-send report has never had a send to be unresolved about.

**A green check on an empty input is not evidence about a full one.** Every one of these was
exercised against seeded fixtures, and that is the reason to believe them — **not** the fact that
production is quiet.

## One thing worth anticipating rather than discovering

The first findings may not arrive one at a time. The engine has run **7,365 times without
matching**; if what is currently empty is a collection gap rather than a genuinely quiet fleet,
then fixing it produces findings for **many tenants at once**. That is the case in which the
watermark, the read window and the `LIMIT` all bite in the same tick — and it is the least likely
day for anyone to be watching, because it will look like a routine collector fix rather than an
alerting change.

**This is speculation about a cause nobody has established**, and it is stated as such. It is
here because the cost of anticipating it is a paragraph, and the cost of discovering it is an
MSP's first impression of the feature.

## So the ask

**Somebody must be told what to re-check on the day the source stops being empty.** If alerting
ships while there is nothing to carry, that is defensible — but the knowledge of what becomes
load-bearing that day currently exists only in one night's working notes.

**A checklist organised solely around switching things on will pass every item in the table above
and still be wrong later.**
