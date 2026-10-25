-- Inactive, backfill-free receipt store for a future bounded alert-intake path.
-- The finding UUID is provenance, not a foreign key. Retaining or deleting a
-- finding through the existing bounded history worker neither blocks on nor
-- silently removes its intake receipt. No existing finding rows are scanned.
SET lock_timeout = '5s';

CREATE TABLE "public"."alert_finding_intake_status" (
  "finding_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "dedupe_key" VARCHAR(128) NOT NULL,
  "source_matched_result_id" UUID NOT NULL,
  "source_rule_id" VARCHAR(150) NOT NULL,
  "source_rule_version" VARCHAR(100) NOT NULL,
  "source_subject_type" VARCHAR(50) NOT NULL,
  "source_subject_id" VARCHAR(128) NOT NULL,
  "source_state" VARCHAR(30) NOT NULL,
  "source_severity" VARCHAR(20) NOT NULL,
  "source_confidence" VARCHAR(20) NOT NULL,
  "source_coverage" VARCHAR(20) NOT NULL,
  "source_observed_at" TIMESTAMPTZ(6) NOT NULL,
  "source_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "source_updated_at" TIMESTAMPTZ(6) NOT NULL,
  "outcome" VARCHAR(30) NOT NULL,
  "mapping_revision" VARCHAR(64) NOT NULL,
  "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_finding_intake_status_pkey" PRIMARY KEY ("finding_id"),
  CONSTRAINT "alert_finding_intake_status_outcome_check" CHECK ("outcome" IN
    ('COMPLETED', 'BLOCKED_UNMAPPED', 'AGED_OUT_RECORDED', 'EXPIRED_BEFORE_INTAKE')),
  CONSTRAINT "alert_finding_intake_status_tenant_scope_fkey"
    FOREIGN KEY ("customer_tenant_id", "organization_id")
    REFERENCES "public"."customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "alert_finding_intake_status_scope_outcome"
  ON "public"."alert_finding_intake_status"
  ("organization_id", "customer_tenant_id", "outcome", "decided_at" DESC);

-- Match the public-schema deny-all boundary: only the backend table owner
-- accesses this receipt store. CI stock PostgreSQL may lack browser roles.
ALTER TABLE "public"."alert_finding_intake_status" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "public"."alert_finding_intake_status" FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.alert_finding_intake_status FROM %I', target_role);
    END IF;
  END LOOP;
END $$;
