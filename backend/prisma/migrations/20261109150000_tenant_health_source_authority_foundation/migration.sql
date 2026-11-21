-- HAW-70 inactive foundation, phase 1/6: metadata-only history scope fence.
-- The old composite FK can CASCADE a tenant move into historical scope. Swap
-- to enforced-but-NOT-VALID RESTRICT FKs before creating any current pointer.
-- Defer full-table validation and index building to later, lower-lock phases.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE "tenant_health_snapshots"
  DROP CONSTRAINT "tenant_health_snapshots_organization_id_fkey",
  DROP CONSTRAINT "tenant_health_snapshots_customer_tenant_id_organization_id_fkey",
  ADD COLUMN "source_incarnation" uuid,
  ADD COLUMN "source_revision" bigint,
  ADD COLUMN "observation_sequence" bigint,
  ADD CONSTRAINT "tenant_health_snapshots_source_tag_complete"
    CHECK (num_nonnulls("source_incarnation", "source_revision", "observation_sequence") IN (0, 3)) NOT VALID,
  ADD CONSTRAINT "tenant_health_snapshots_source_revision_positive"
    CHECK ("source_revision" IS NULL OR "source_revision" > 0) NOT VALID,
  ADD CONSTRAINT "tenant_health_snapshots_observation_sequence_positive"
    CHECK ("observation_sequence" IS NULL OR "observation_sequence" > 0) NOT VALID,
  ADD CONSTRAINT "tenant_health_snapshots_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "tenant_health_snapshots_customer_tenant_id_organization_id_fkey"
    FOREIGN KEY ("customer_tenant_id", "organization_id")
    REFERENCES "customer_tenants"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;

COMMIT;
