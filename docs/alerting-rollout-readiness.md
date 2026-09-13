# Alerting — rollout readiness

Four artefacts, in the order they were asked for: the release commit, the end-to-end results, the
migration and rollback position, and the acceptance checklist's status. Everything here is
measured on this branch unless it says otherwise, and where something was not measured it says so
rather than reading as covered.

**Read the one-line version first: what this release ships is the RECORD, not the TELLING.**
Intake reads findings, writes incidents, and queues send jobs. Nothing drains the queue, no
provider client exists, and no email can leave. That is not a caveat on a sending feature — it is
what the release *is*, and the acceptance checklist below cannot be completed until it changes.

### The pipeline has nothing to carry yet

*Measured in production, read-only, by PM. I have no production access and did not confirm these.*

| table | rows |
|---|---|
| `identity_risk_evaluation_runs` | **7,365** |
| `identity_risk_matched_results` | **0** |
| `identity_risk_findings` | **0** |

**The risk engine has run 7,365 times and matched nothing, ever.** So switching alerting on — with
a perfect watermark, a working sender and every check signed — delivers **zero emails**. Not
because alerting is broken, but because there are no findings. **Do not read a correct alerting
chain as meaning MSPs will be notified.**

**And the zero is uncharacterised.** Whether it is a true zero — three narrow detectors across a
small fleet genuinely matching nothing — or an absence being read as evidence has not been
established. A source reports READY and CURRENT on the strength of a successful collection while
carrying no observed events. That is the difference between *nothing is happening* and *we cannot
see*, and it is outside alerting scope.

---

## 1. The release commit

**Branch `agent/alerts-step-01`.** The exact commit is the tip at the time of reading; the three
that carry this work are named in `alerting-HANDOFF.md`'s status section, which moves with every
commit that changes what is true about the product.

**Nothing is pushed, merged or deployed.** The release hold is active and this document does not
ask for it to be lifted. `git log origin/main..HEAD` is the honest description of what would
land.

⚠ **Do not treat a commit hash quoted anywhere else as current without checking it.** Two hashes
in this feature's history were reported and then orphaned by an amend, and a reviewer read a
stale tree three times. Verify the tip rather than the reference.

---

## 2. End-to-end test results

Run from `backend/`, the way CI does:

```bash
find src -type f -name '*.test.ts' | sort | xargs ./node_modules/.bin/tsx --test
```

| What | Result |
| --- | --- |
| Unit suite | **1826 tests, 1711 pass, 0 fail, 115 skipped** |
| `tsc --noEmit -p tsconfig.json` | clean |
| `tsc --noEmit -p tsconfig.scripts.json` | clean |
| Alerting integration, real PostgreSQL 15 | **19/19** — 12 pipeline, 4 in-app, 3 suppression |
| Schema drift vs `schema.prisma` | 254 lines, **none naming an `alert_` table** |

**The 113 skipped are the database-integration tests**, gated behind
`HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS=1`, which that command does not set. **The 1696 figure
does not cover them.** They were run separately, and the two results must not be added together
or quoted as one.

**The alerting integration files pass reliably; the identity-risk ones do not.** The alerting
files were run against clusters created, migrated and destroyed inside the session and have been
green on every run. The wider integration suite has no reproducible pass count — nine samples on
one commit ranged 11 to 45 — and the cause of the large majority of its failures is unidentified.
That suite is not on this release path. **Two suites, two states**; `alerting-HANDOFF.md` carries
the detail and the warning against reading one figure as the other.

**One intermittent unit failure, seen once, not reproduced.** `risk-owned Prisma transport drains
startup, BEGIN, query and rollback stalls` failed on one full run at 2149ms and has passed on
every run since — three isolated, three full. It asserts a two-second wall clock around a 650ms
deadline and imports only `node:net` and its own subject, so no import path reaches anything this
branch changed. **Recorded as a flake on that evidence, not asserted as one**; a fourth green run
does not make a timing assertion sound.

### One figure that will otherwise be over-read

`accountingProblems: []` means every finding appears exactly once across the jobs and the skips.
It is a **self-reconciliation over one pass**. It proves nothing vanished. **It cannot prove
anything was classified correctly** — a finding wrongly skipped as `RECORD_ONLY` counts exactly
once and the books still balance.

It is a tripwire against a future edit that adds a `continue` without a skip, which is worth
having. **It is not evidence that the delivery decisions are right**, and must not be cited as a
second line of proof that they are.

### What the tests do not establish

- **That anything sends.** There is no worker, no transport and no route. The end-to-end test
  ends at a row in `alert_send_jobs`, which is the deliverable, not a shortfall in the test.
- **That the provider honours the idempotency key.** Nothing in this repository can establish
  that; it is a line in the acceptance checklist for exactly that reason.
- **Lock ordering.** Classified as environment, unproven either way.

---

## 3. Migrations and rollback

Seven migrations carry this feature. **All seven are additive or widening — none drops a column,
narrows a type, or rewrites a row.**

| Migration | What it does |
| --- | --- |
| `20260912120000_notification_incident_key` | two **nullable** columns on `notifications`, one index |
| `20260912190000_alert_incidents_and_dispositions` | two new tables |
| `20260912223000_alert_send_jobs` | two new tables |
| `20260913000000_widen_incident_key` | `VARCHAR(300)` → `(400)` on two columns |
| `20260913020000_send_job_cancelled` | replaces one CHECK with a wider one |
| `20260913040000_alert_suppressed_addresses` | one new table |
| `20260913060000_send_job_cancellation_provenance` | three **nullable** columns on `alert_send_jobs`, two CHECKs, one index |

### Measured, not assumed

**Applying from empty works.** Three separate PostgreSQL 15 clusters were created with `initdb`,
migrated with `prisma migrate deploy`, used, and destroyed inside the session. 56 migrations
applied, no failures.

**Re-running every alerting migration by hand is safe, and this was measured three passes deep.**
All of them re-run clean against an already-migrated database, repeatedly, with existing rows intact.

**That measurement found a real defect, which is now fixed.**
`20260912120000`'s type guard asserted the column was `varchar(300)`. After `20260913000000`
widened it to 400, re-running the earlier migration on a current database raised — with a message
reading *"A column created by hand does not match the schema; drop it and re-run this
migration."* **A guard written before a later change had become an instruction to drop a column
holding real incident keys, on a database that was in the correct state.** It now accepts 300 or
400 and the message says explicitly not to drop the column. The guard still discriminates:
measured, `text` and `varchar(100)` are refused, `varchar(300)` and `varchar(400)` accepted.

### Rolling back

**Rollback is code-only. The schema stays, and that is safe.** Every added column on an existing
table is nullable, so code from before this work can insert into `notifications` without naming
them — measured directly, by writing a row naming only the pre-alerting columns against a fully
migrated database. The new tables are unreferenced by older code. The widened columns and the
widened CHECK accept everything the older code writes.

**There is no down migration and there should not be one.** Dropping `alert_incidents` would
destroy the record of what the product decided, which is the one thing worth keeping if the
sending half is withdrawn.

⚠ **`backend/Dockerfile` runs `db:migrate:deploy` on every container start.** So a redeploy of
older code against a migrated database does not roll the schema back and does not try to — but it
also means **the schema advances the moment any container starts with these migrations present.**
Deploying this branch is the schema change; there is no separate migration step to withhold.

⚠ **Editing an already-applied migration is SILENT.** Measured: after changing
`20260912120000` in place, `migrate deploy` reported *No pending migrations to apply* and
`migrate status` reported *Database schema is up to date* against a database holding the
pre-edit checksum. Neither noticed. **In-place edits are defensible only while these migrations
have reached nothing but throwaway clusters, which is the case today.** The moment one reaches a
database somebody keeps, they become immutable and every correction must be a forward migration.

---

## 4. The Green Technology acceptance checklist

**Status: cannot be completed, and the reason is structural rather than a matter of time.**
`green-technology-acceptance.md` walks an operator through turning email on, receiving an alert,
seeing one deliberately withheld, a hard bounce, a duplicate, and a person opening the inbox.
**Steps 2 onward all require a message to actually leave**, and nothing in this build can send
one.

What blocks it, in the order it must be cleared — this is the launch-blocker list:

1. **Nothing drains the queue.** No sender worker exists. `attemptSend` has no production caller,
   nothing calls `claimStatement`, and `SendPermit` is produced only inside tests. Intake writes
   jobs on every tick and no code path reads one. **A transport would change nothing on its own,
   because nothing would call it.**
2. **No transport.** Deliberately absent, so switching sending on requires somebody to *write*
   one rather than to set a variable.
3. **No route for the webhook verifier**, so no delivery outcome can be recorded. The raw bytes
   a signature is computed over ARE now available — this was a blocker in its own right and is
   closed. Measured through a real Nest pipeline bootstrapped the way `main.ts` bootstraps:

   | | |
   |---|---|
   | sent on the wire | `{"type":  "email.delivered", …}` |
   | re-serialised from the parsed body | `{"type":"email.delivered", …}` |
   | byte-identical | **false** — two spaces after a comma are enough |
   | genuine signature over the wire bytes | verifies |
   | the same signature over the rebuild | **refused** |

   **Permanently, not intermittently.** Whitespace alone does it; key order and unicode escaping
   would too. Fixed by `rawBody: true` in `HAWKVIEW_NEST_OPTIONS`, which `main.ts` and its test
   both read. What remains missing is the controller — and **its test must drive the real
   pipeline**, because every existing verifier test hands `verify()` the raw bytes and so tests
   the half that already worked.
4. **Delivery outcomes are not persisted.** *(Previously written here as "no persisted ledger",
   which reads as though nothing about sending is recorded. That is false, and a blocker list
   with one dismissible item teaches a reader to skim the rest.)*

   `alert_send_attempts` **is** persisted and holds `ACCEPTED`, `REFUSED_RETRYABLE` and
   `REFUSED_PERMANENT` — *what the provider said when asked*. What has no table is the **outcome**:
   `DELIVERED`, `BOUNCED`, `COMPLAINED`, plus unmatched events and retries, which exist only as
   in-memory values. What its absence costs:

   - **"Was it delivered?" is unanswerable across a restart.** Acceptance survives; the outcome
     does not.
   - **Unmatched events are lost** — events arriving for provider ids we hold no job for. That is
     precisely the surface that would show somebody posting forged or replayed events at the
     endpoint, which is what the verifier exists to protect.
   - ~~After a restart you would know an address is dead and not know which message killed it.~~
     **This one was reported and is not true.** `alert_suppressed_addresses` carries
     `message_id`, `because` and `first_suppressed_at`, with a CHECK refusing a machine-made
     suppression that names no message. It describes the state before migration
     `20260913040000`. Struck rather than deleted, because the same claim will be made again.

   *(The stop button is no longer on this list:  is its
   press, run end to end against a real cluster. So is the suppression store.)*
5. **The watermark is unchosen.** `HAWKVIEW_ALERT_WATERMARK_ISO` is unset, and intake refuses to
   run rather than defaulting — deliberately, because the default available is "now" and taking
   it silently decides for ever which history was never worth telling anybody about.

**What CAN be checked today, and is worth checking before any of the above:** that a real finding
produces an incident row and a queued job; that an organisation with no preference row produces
no job; that the stop button empties the queue; that a hard bounce recorded against an address
survives a restart. All four are covered by the integration tests and can be re-run by an
operator against a disposable database.

**Marking the checklist complete before a message has left would be the failure it exists to
prevent.** It stays INCOMPLETE.

---

### Forecast the first run before making it, then sign the four a person must do

**FIRST, THE FORECAST.** `backend/scripts/alerting-forecast.mts` reads and nothing else, refuses a
missing or unparseable watermark rather than falling back (both exit `2`), and prints the four
gates it is operating under so nobody has to remember they exist. Procedure in
`alerting-ACCEPTANCE-HOW.md`.

**If the forecast is more than a handful, the watermark is wrong** — a tuning question only until
it is sent. Afterwards it is a recall problem with no recall. The damage is bounded more tightly
than it looks: an ordinary tick reads at most 24 hours whatever the watermark says, so a watermark
set a month back does not send a month of email. **But a bound is not a number, and nobody has
counted what a day contains.**

> Forecast: ______ messages, across ______ organisations. Watermark: ____________
> Approved by ____________________ on ____________

**THEN THE FOUR NO TEST CAN CLOSE.** The blocker list says why the checklist cannot be completed;
these are what remains *after* it can be. **While these lines are blank, this feature is not
verified.**

**1. Send twice, one arrives.** Our side can only show two calls, one key, one provider id.
Whether that became one email is a fact about the provider and an inbox.

> Performed by ____________________ on ____________  Messages in the inbox: ______

**2. A human opens the inbox and writes down what arrived** — sender, subject, whether it
rendered, whether the deep link demands authentication, and **whether anything in the body names a
person or a tenant.** The closed vocabulary guarantees what the *code* can construct and says
nothing about what a template or a provider footer adds.

> Performed by ____________________ on ____________  Anything naming a person? ______

**3. A genuine signature still verifies**, against a real webhook with the real secret.
`() => 'invalid'` passes every forgery test ever written.

> Performed by ____________________ on ____________  Genuine verified: ____ Tampered rejected: ____

**4. A real hard bounce**: the next send to that address does not go, and a *different* message to
the same dead mailbox is not attempted either.

> Performed by ____________________ on ____________  Second message attempted? ______

## What is deliberately not in this release

- **SMS.** Deferred.
- **Six detectors that produce no email, by decision.** A risk rule becomes an alert type through
  the `investigationGuidanceCode` the catalogue declares, and two of the four codes map to no
  alert type — those findings produce no incident, no job and no email, and are reported as
  unmapped rather than defaulted. Verified by running the mapping, not by reading it:

  | rule | what it detects |
  |---|---|
  | `HV-ID-MBX-001.v1` | Mailbox forwarding outside verified domains requires review |
  | `HV-ID-MBX-002.v1` | **Mailbox concealment rule requires investigation** |
  | `HV-ID-MBX-003.v1` | Mailbox rule changed after suspicious authentication |
  | `HV-ID-CHG-005.v1` | **Identity protection configuration was weakened** |
  | `HV-ID-APP-001.v1` | New application declares high-impact permissions |
  | `HV-ID-APP-002.v1` | Application credential metadata changed |

  Eighteen rules do map. **Refusing to invent a type is correct engineering.** But *"we detect it
  and will not email you about it"* is a product decision, and the two in bold are why it needs
  deciding rather than inheriting: a concealment rule and a weakened identity-protection
  configuration are not routine findings to leave silent.
- **Backfilling historical findings.** Reading is bounded to 24 hours, so findings older than
  that never receive an incident from ordinary ticks. A one-off backfill command does not exist,
  and whether history should be recorded at all is an open question in the commit that added the
  bound.
- **An unsuppress path.** Removing a suppression requires SQL today.
- **Eleven further items**, each with its reason, in `alerting-post-launch-backlog.md`.

## The second gate is not a date

**A judgement, not a measurement.** Everything else in this document was run.

**The first real run is not the first tick after the switch. It is the first tick after findings
exist.** Today the source is empty, so switching on is uneventful — and the day the engine starts
matching, decisions made months earlier become load-bearing at once, with nobody watching
*because* switching on was uneventful.

| | harmless while the source is empty | load-bearing from the first finding |
|---|---|---|
| the watermark | nothing is older than it | decides which history is never mentioned |
| the 24-hour read window | nothing falls outside it | older findings never get an incident, and no backfill exists |
| the 5000-row read limit | unreachable | a burst above it is silently deferred |
| the six unmapped rules | they match nothing | six detectors fire and produce no email |
| the suppression list | empty | a hard bounce starts deciding who is never written to again |
| `maxAttempts` of 3 | no job spends it | decides when a message stops being retried |
| **delivery outcomes not persisted** | no outcome exists to lose | *was it delivered* becomes a question people ask, and a restart erases the answer |

**And several passing results in this document are passes over an empty input.**
`accountingProblems: []` balances zero findings; `neverSent()` enumerates jobs and there are none;
the unresolved-send report has never had a send to be unresolved about. They are true and they
have never had the chance to discriminate. **The reason to believe them is that they were
exercised against seeded fixtures and mutation-tested — not that production is quiet. A green
check on an empty input is not evidence about a full one.**

**One thing worth anticipating rather than discovering**, and it is speculation about a cause
nobody has established: the first findings may not arrive one at a time. If the emptiness is a
collection gap rather than a quiet fleet, fixing it produces findings for many tenants in one
tick — the single case where the watermark, the read window and the limit all bite together, on
the least likely day for anyone to be watching, because it will look like a collector fix.

**Somebody must be told what to re-check on the day the source stops being empty.** A checklist
organised solely around switching things on will pass every row in that table and still be wrong
later.
