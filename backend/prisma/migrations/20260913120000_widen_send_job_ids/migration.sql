-- `message_id` and `idempotency_key` at 400, forward.
--
-- **THE THIRD IN-PLACE EDIT, AND THE WORST OF THEM: it fails on the first real alert rather than
-- on a settings write.** `0a62f8d` widened these three columns from VARCHAR(200) to VARCHAR(400)
-- by editing `20260912223000` after it had been applied. On a database built from the pre-edit
-- file:
--
--   widths before          200, 200, 200
--   prisma migrate deploy  "All migrations have been successfully applied", exit 0
--   widths after           STILL 200
--   a fresh database       400
--
-- A real message id does not fit. `incident/${organizationId}|${incidentKey}` for one ordinary
-- finding measures 209 characters — and that is a FLOOR, taken from a run with synthetic short
-- subjects. A real subject is a UUID or a UPN, and an alert type id may be 64 characters.
--
-- So on such a database the first tick that decides to send anything fails on the write with
-- 22001. The commit is all three tables or none, so there is no incident, no notification and no
-- job — the alert simply does not happen — while Prisma reports a healthy, fully-migrated
-- database. The tick reports FAILED/WRITING, which is legible only because the phase split
-- landed first.
--
-- ⚠ **AND THERE IS NO CHECKSUM GUARD BEHIND ANY OF THIS.** Measured at Prisma 7.9.1: with an
-- applied migration's file modified so its recorded checksum no longer matches, `migrate status`
-- says *Database schema is up to date!* and `migrate deploy` says *No pending migrations to
-- apply*, both exit 0. Neither validates it, and `deploy` is what the Dockerfile runs on every
-- container start. **Forward-migrations-only is not a tidiness rule; it is the only thing
-- standing there.**
--
-- A NO-OP WHERE THE COLUMNS ARE ALREADY 400, which is every fresh database — but a migration that
-- is correct only on the machine somebody happened to test is not correct. `ALTER COLUMN TYPE` to
-- a WIDER varchar does not rewrite the table and takes no long lock.

ALTER TABLE "public"."alert_send_jobs"
  ALTER COLUMN "message_id" TYPE VARCHAR(400);

ALTER TABLE "public"."alert_send_jobs"
  ALTER COLUMN "idempotency_key" TYPE VARCHAR(400);

-- The attempts table carries the same id and was widened in the same edit. Missing it would move
-- the failure one table over rather than removing it: the job would insert and the attempt — the
-- row written BEFORE the send, so that a crash leaves evidence — would be the thing that failed.
ALTER TABLE "public"."alert_send_attempts"
  ALTER COLUMN "message_id" TYPE VARCHAR(400);
