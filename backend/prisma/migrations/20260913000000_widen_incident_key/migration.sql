-- Widen both `incident_key` columns from 300 to 400. They hold the same derived key.
--
-- THE BOUND HAD ELEVEN CHARACTERS OF HEADROOM AND NOTHING ENFORCED IT. The worst case the widths
-- allow is 289 of 300, and it overflows at a 48-character alert type id. The longest today is 36
-- — `security.suspected_credential_attack` — so the slack is guarded by nothing but whoever names
-- the next type. The failure would be an INSERT that fails in production on a real finding, which
-- in this pipeline kills the run rather than degrading the alert.
--
-- A FORWARD MIGRATION RATHER THAN AN IN-PLACE EDIT, AND THE REASON IS THE OPPOSITE OF THE ONE I
-- EXPECTED. I assumed editing an applied migration would fail loudly on a checksum. It does not:
-- measured against a throwaway cluster, `prisma migrate deploy` after a one-character edit to an
-- already-applied migration reported "No pending migrations to apply" and changed nothing.
--
-- So an in-place edit is not loud — it is SILENT. Any database that already ran the original
-- keeps a 300-wide column while the migration file claims 400, and nothing anywhere says so. A
-- forward migration is correct on both: a fresh database gets 300 then 400, an applied one gets
-- widened.
--
-- THAT ALSO MEANS THE QUESTION "IS IT LIVE?" DID NOT HAVE TO BE ANSWERED. Everything available
-- here says no — the runbook records the step-03 migration as applied only to a throwaway
-- PostgreSQL 15, no connection to production has ever been made from an engineering worktree, and
-- the release hold stands. But none of that is verification, and this shape is safe either way,
-- which is a better place to be than a correct guess.

-- Widening a varchar does not rewrite the table and takes no meaningful lock; re-running is a
-- no-op, so this is idempotent without needing a guard.
ALTER TABLE "public"."notifications" ALTER COLUMN "incident_key" TYPE VARCHAR(400);
ALTER TABLE "public"."alert_incidents" ALTER COLUMN "incident_key" TYPE VARCHAR(400);

-- THE COLUMN IS THE CEILING, NOT THE GUARD. A wider column raises the limit; it does not stop
-- anybody walking into it. The alert type id is chosen by a person editing `ALERT_CATALOG`, so
-- the bound belongs there — see `alert-catalog.ts`, where an over-long id now fails to COMPILE.
-- This migration buys the headroom; the type system is what keeps it.
