-- HAW-70 inactive foundation, phase 6/6. PostgreSQL validates existing rows
-- with SHARE UPDATE EXCLUSIVE on snapshots, allowing ordinary reads/writes.
-- The phase-1 NOT VALID constraints already protect subsequent writes/moves.
ALTER TABLE "tenant_health_snapshots"
  VALIDATE CONSTRAINT "tenant_health_snapshots_source_tag_complete";
ALTER TABLE "tenant_health_snapshots"
  VALIDATE CONSTRAINT "tenant_health_snapshots_source_revision_positive";
ALTER TABLE "tenant_health_snapshots"
  VALIDATE CONSTRAINT "tenant_health_snapshots_observation_sequence_positive";
ALTER TABLE "tenant_health_snapshots"
  VALIDATE CONSTRAINT "tenant_health_snapshots_organization_id_fkey";
ALTER TABLE "tenant_health_snapshots"
  VALIDATE CONSTRAINT "tenant_health_snapshots_customer_tenant_id_organization_id_fkey";
