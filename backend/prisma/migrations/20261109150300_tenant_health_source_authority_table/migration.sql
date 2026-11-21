-- HAW-70 inactive foundation, phase 4/6. No runtime reads/writes this table
-- yet. The tenant pair intentionally has no tenant FK: deletion must retain
-- the incarnation tombstone. Organization deletion removes the private scope.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE "tenant_health_source_authorities" (
  "organization_id" uuid NOT NULL,
  "customer_tenant_id" uuid NOT NULL,
  "incarnation" uuid NOT NULL DEFAULT gen_random_uuid(),
  "source_revision" bigint NOT NULL DEFAULT 1,
  "live" boolean NOT NULL DEFAULT true,
  "current_snapshot_id" uuid,
  "current_observation_sequence" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "tenant_health_source_authorities_pkey"
    PRIMARY KEY ("organization_id", "customer_tenant_id"),
  CONSTRAINT "tenant_health_source_authorities_source_revision_positive"
    CHECK ("source_revision" > 0),
  CONSTRAINT "tenant_health_source_authorities_observation_sequence_nonnegative"
    CHECK ("current_observation_sequence" >= 0),
  CONSTRAINT "tenant_health_source_authorities_pointer_sequence_positive"
    CHECK ("current_snapshot_id" IS NULL OR "current_observation_sequence" > 0),
  CONSTRAINT "tenant_health_source_authorities_dead_pointer_null"
    CHECK ("live" OR "current_snapshot_id" IS NULL),
  CONSTRAINT "tenant_health_source_authorities_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "tenant_health_source_authorities_exact_pointer_key"
    UNIQUE ("current_snapshot_id", "organization_id", "customer_tenant_id",
            "incarnation", "source_revision", "current_observation_sequence"),
  CONSTRAINT "tenant_health_source_authorities_exact_pointer_fkey"
    FOREIGN KEY ("current_snapshot_id", "organization_id", "customer_tenant_id",
                 "incarnation", "source_revision", "current_observation_sequence")
    REFERENCES "tenant_health_snapshots"
      ("id", "organization_id", "customer_tenant_id",
       "source_incarnation", "source_revision", "observation_sequence")
    ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

-- A future reader will allocate this before its source reads. Creation alone
-- does not turn any legacy snapshot into a current health observation.
CREATE SEQUENCE "tenant_health_observation_sequence" AS bigint START WITH 1 NO CYCLE;

ALTER TABLE "tenant_health_source_authorities" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "tenant_health_source_authorities" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "tenant_health_observation_sequence" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "tenant_health_source_authorities" FROM anon;
    REVOKE ALL ON SEQUENCE "tenant_health_observation_sequence" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "tenant_health_source_authorities" FROM authenticated;
    REVOKE ALL ON SEQUENCE "tenant_health_observation_sequence" FROM authenticated;
  END IF;
END $$;
COMMIT;
