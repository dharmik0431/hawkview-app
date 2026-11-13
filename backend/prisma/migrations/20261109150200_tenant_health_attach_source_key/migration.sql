-- HAW-70 inactive foundation, phase 3/6. Metadata-only conversion of the
-- completed concurrent index into the exact key required by the pointer FK.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE "tenant_health_snapshots"
  ADD CONSTRAINT "tenant_health_snapshots_exact_source_key"
  UNIQUE USING INDEX "tenant_health_snapshots_exact_source_key";
COMMIT;
