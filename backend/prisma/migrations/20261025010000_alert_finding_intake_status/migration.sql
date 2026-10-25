-- Inactive, backfill-free receipt store for a future bounded alert-intake path.
-- The finding UUID is provenance, not a foreign key. Retaining or deleting a
-- finding through the existing bounded history worker neither blocks on nor
-- silently removes its intake receipt. No existing finding rows are scanned.
SET lock_timeout = '5s';

CREATE TABLE "public"."alert_finding_intake_status" (
  "finding_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "source_rule_id" VARCHAR(150) NOT NULL,
  "source_rule_version" VARCHAR(100) NOT NULL,
  "outcome" VARCHAR(30) NOT NULL,
  "mapping_revision" VARCHAR(64) NOT NULL,
  "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_cleanup_check_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_finding_intake_status_pkey" PRIMARY KEY ("finding_id"),
  CONSTRAINT "alert_finding_intake_status_outcome_check" CHECK ("outcome" IN
    ('COMPLETED', 'BLOCKED_UNMAPPED', 'AGED_OUT_RECORDED', 'EXPIRED_BEFORE_INTAKE')),
  CONSTRAINT "alert_finding_intake_status_cleanup_window_check" CHECK (
    isfinite("decided_at") AND isfinite("next_cleanup_check_at")
    AND "next_cleanup_check_at" >= "decided_at" + INTERVAL '2160 hours'),
  CONSTRAINT "alert_finding_intake_status_tenant_scope_fkey"
    FOREIGN KEY ("customer_tenant_id", "organization_id")
    REFERENCES "public"."customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "alert_finding_intake_status_scope_outcome"
  ON "public"."alert_finding_intake_status"
  ("organization_id", "customer_tenant_id", "outcome", "decided_at" DESC);

CREATE INDEX "alert_finding_intake_status_cleanup_due"
  ON "public"."alert_finding_intake_status"
  ("next_cleanup_check_at", "finding_id");

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
