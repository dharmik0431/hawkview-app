-- HAW-70 inactive foundation, phase 5/6. One INSERT statement, after every
-- large-table DDL lock has committed. Backfill only null pointers; this is
-- NOT authoritative because source writers do not yet bump revisions and
-- tenants created during/after the scan may be absent. A later activation
-- must reconcile live rows before reading this table.
INSERT INTO "tenant_health_source_authorities"
  ("organization_id", "customer_tenant_id", "incarnation", "source_revision",
   "live", "current_snapshot_id", "current_observation_sequence")
SELECT "organization_id", "id", gen_random_uuid(), 1, true, NULL, 0
FROM "customer_tenants";
