# Alerting — rollout readiness

Four artefacts, in the order they were asked for: the release commit, the end-to-end results, the
migration and rollback position, and the acceptance checklist's status. Everything here is
measured on this branch unless it says otherwise, and where something was not measured it says so
rather than reading as covered.

**Read the one-line version first: what this release ships is the RECORD, not the TELLING.**
Intake reads findings, writes incidents, and queues send jobs. Nothing drains the queue, no
provider client exists, and no email can leave. That is not a caveat on a sending feature — it is
what the release *is*, and the acceptance checklist below cannot be completed until it changes.

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
| Unit suite | **1820 tests, 1706 pass, 0 fail, 114 skipped** |
| `tsc --noEmit -p tsconfig.json` | clean |
| `tsc --noEmit -p tsconfig.scripts.json` | clean |
| Alerting integration, real PostgreSQL 15 | **18/18** — 12 pipeline, 3 in-app, 3 suppression |
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
   a signature is computed over ARE now available (`rawBody: true`, measured against a real Nest
   pipeline); what is missing is the controller.
4. **Delivery outcomes are not persisted.** `alert_send_attempts` does persist what reached a
   provider; what has no table is the provider's later verdict — delivered, bounced,
   complained — so a route would authenticate an event and discard it.

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

## What is deliberately not in this release

- **SMS.** Deferred.
- **Backfilling historical findings.** Reading is bounded to 24 hours, so findings older than
  that never receive an incident from ordinary ticks. A one-off backfill command does not exist,
  and whether history should be recorded at all is an open question in the commit that added the
  bound.
- **An unsuppress path.** Removing a suppression requires SQL today.
- **Eleven further items**, each with its reason, in `alerting-post-launch-backlog.md`.
