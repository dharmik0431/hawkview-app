# Migration and rollback readiness

**One of Dharmik's four rollout artefacts.** Everything below was run, on disposable databases,
against real commits. Nothing ran against production.

## The fact that determines the shape of this document

`backend/Dockerfile` line 44:

```
CMD ["sh", "-c", "node scripts/prepare-geolite.mjs && npm run db:migrate:deploy && npm start"]
```

**Deploy is migrate.** Three consequences, and they are not footnotes:

1. **There is no separate migration gate.** Merging and deploying applies all four alerting
   migrations, with no operator step and no decision point in between. **The release hold is the
   only thing standing between them and production.**
2. **`prisma migrate deploy` is forward only.** Rolling a deploy back to the previous image does
   not undo a migration. The old container starts against the new schema.
3. **So the runbook's step 0 does not describe a no-op — it describes a gate that does not
   exist.** An operator reading it would believe they choose when the schema changes. They do
   not.

## THE ROLLBACK IS A ROLLBACK OF CODE ONLY

Stated plainly because the opposite is what everyone assumes — including me, until I read the
Dockerfile. Reverting the deploy reverts the application. **The schema stays forward.**

## The rehearsal, which nobody had run

A disposable database migrated to the branch head — 54 migrations, all four alerting tables
present — and then the **previous commit's** backend (`origin/main`, `5488ad6`, 50 migrations)
pointed at it. Dependencies are identical between the two commits, verified by blob sha, so the
only difference is the code under test.

| what was run | result |
|---|---|
| the old image's boot step, `prisma migrate deploy`, against a database carrying four migrations it has never heard of | **`No pending migrations to apply.` exit 0** — Prisma does not object to applied migrations missing locally, so the container reaches `npm start` |
| the old Prisma client reading and writing `notifications`, the table that gained two columns | **serves** — read, create and read-back all succeeded |
| the old client against a row the apply had already **keyed** | **serves, and the key survives** — the old client cannot see `incident_key` or `episode` at all, and updating the row through it leaves both intact |

**So a code-only rollback works.** The additive reading was right — but it is measured now rather
than read, and the first row is the one that could have gone the other way: had `migrate deploy`
refused a database ahead of it, the old container would not merely have failed to undo the
schema, **it would have failed to boot.**

**What this does not establish:** that the old application *as a whole* serves every route. I
exercised the Prisma client against the changed table, not a booted HTTP surface. A full boot
needs production-shaped configuration this worktree does not have.

## What the revert path actually is

Because it is not a deploy rollback:

**For step 03's apply** — the prepared `revert` subcommand and its run receipt. It reads the
receipt, touches only the rows that run changed, and only where they still hold exactly what it
wrote.

- **Covers:** undoing the incident keys that run wrote. Verified: 43 of 44 put back, 1 refused
  because somebody else had re-keyed it, 44 of 44 accounted for, and 15 occurrences arriving in
  between caused no refusal.
- **Does not cover, and must not be expected to:** the migration itself — the columns stay, which
  is correct, since a column holding NULL is the pre-apply state. Rows the apply never wrote.
  Rows somebody changed after the apply: **refused on purpose**, because they are no longer that
  run's to undo.
- **Requires the receipt file.** Without `receipt.json` there is no revert. It is the only thing
  that makes the revert safe, and it is sufficient on its own — verified by running the revert
  with the mapping file moved away.

**For the flow's own writes — `alert_incidents`, `alert_send_jobs`, `alert_send_attempts` — there
is no revert at all.** I checked rather than assumed: nothing in `src/alerts/` deletes or undoes
those rows. That is defensible while nothing sends, because an unsent job is inert. **It stops
being defensible the moment the sender exists**, and it should be decided before then rather
than after.

## The correction the runbook needs, at step 0

Replaced, not deleted:

> ## ~~Step 0 — apply the migration that creates the columns~~ — THE DEPLOY ALREADY DID THIS
>
> **`backend/Dockerfile` runs `npm run db:migrate:deploy` on every container start, so the
> migration applies when the code deploys.** Running `npx prisma migrate deploy` by hand is
> idempotent and safe — it reports `No pending migrations to apply` — but it is a confirmation,
> **not a gate**. There is no point at which an operator chooses whether the schema changes:
> deploying the code is that decision, and it has already been made by the time anyone reads
> this step.
>
> **Confirm it landed** with the query below, and understand that rolling the deploy back will
> not remove these columns. `prisma migrate deploy` is forward only, and reverting to the
> previous image leaves the schema where it is. That is safe — the previous image has been
> rehearsed against this schema and serves — but it is not an undo.
