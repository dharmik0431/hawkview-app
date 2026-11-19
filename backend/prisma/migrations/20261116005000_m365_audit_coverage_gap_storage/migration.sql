-- Local reconstruction of additive HAW-75 storage only. Installing this DDL
-- creates real database objects; it is not a feature flag. No runtime caller
-- currently reads or writes these tables. Existing content_uri stays required.
-- A later atomic writer must preserve both a gap and sticky state before URL
-- deletion. No gap-to-state FK or automatic retention/clearance is provided.
SET lock_timeout = '5s';

CREATE TABLE "public"."m365_audit_coverage_gaps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "content_type" VARCHAR(80) NOT NULL,
    "content_id_sha256" CHAR(64) NOT NULL,
    "source_status" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "source_expired_at" TIMESTAMPTZ(6) NOT NULL,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "m365_audit_coverage_gaps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "m365_audit_coverage_gaps_digest_check"
      CHECK ("content_id_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "m365_audit_coverage_gaps_status_check"
      CHECK ("source_status" IN ('PENDING', 'PROCESSING', 'RETRY', 'FAILED', 'INSUFFICIENT_CAPACITY')),
    CONSTRAINT "m365_audit_coverage_gaps_reason_check"
      CHECK ("reason" IN ('LEDGER_EXPIRED', 'PROVIDER_URL_EXPIRED', 'URL_AGE_EXPIRED', 'CONTENT_UNAVAILABLE')),
    CONSTRAINT "m365_audit_coverage_gaps_resolution_time_check"
      CHECK ("resolved_at" IS NULL OR "resolved_at" >= "first_observed_at")
);

CREATE TABLE "public"."m365_audit_coverage_states" (
    "customer_tenant_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "incomplete_since" TIMESTAMPTZ(6) NOT NULL,
    "last_gap_at" TIMESTAMPTZ(6) NOT NULL,
    "has_purged_unrepaired_gap" BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT "m365_audit_coverage_states_pkey" PRIMARY KEY ("customer_tenant_id"),
    CONSTRAINT "m365_audit_coverage_states_generation_check" CHECK ("generation" > 0),
    CONSTRAINT "m365_audit_coverage_states_time_check" CHECK ("last_gap_at" >= "incomplete_since")
);

-- Match m365_activity_contents(customer_tenant_id, microsoft_content_id).
-- Future writers hash the stored ID after its existing 500-character limit.
CREATE UNIQUE INDEX "m365_audit_coverage_gaps_tenant_digest_key"
  ON "public"."m365_audit_coverage_gaps"("customer_tenant_id", "content_id_sha256");
CREATE INDEX "m365_audit_coverage_gaps_scope_observed_idx"
  ON "public"."m365_audit_coverage_gaps"("organization_id", "customer_tenant_id", "first_observed_at");
CREATE INDEX "m365_audit_coverage_gaps_observed_idx"
  ON "public"."m365_audit_coverage_gaps"("first_observed_at");
CREATE INDEX "m365_audit_coverage_states_scope_idx"
  ON "public"."m365_audit_coverage_states"("organization_id", "customer_tenant_id");
CREATE UNIQUE INDEX "m365_audit_coverage_states_tenant_scope_key"
  ON "public"."m365_audit_coverage_states"("customer_tenant_id", "organization_id");

ALTER TABLE "public"."m365_audit_coverage_gaps" ADD CONSTRAINT "m365_audit_coverage_gaps_org_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."m365_audit_coverage_gaps" ADD CONSTRAINT "m365_audit_coverage_gaps_tenant_scope_fkey"
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "public"."customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."m365_audit_coverage_states" ADD CONSTRAINT "m365_audit_coverage_states_org_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."m365_audit_coverage_states" ADD CONSTRAINT "m365_audit_coverage_states_tenant_scope_fkey"
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "public"."customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Default-deny boundary for non-owner roles; no browser/PostgREST policy.
-- Deployment must separately prove the application role has the intended access.
-- Success under the CI administrator does not establish production role identity.
ALTER TABLE "public"."m365_audit_coverage_gaps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."m365_audit_coverage_states" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."m365_audit_coverage_gaps", "public"."m365_audit_coverage_states" FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.m365_audit_coverage_gaps, public.m365_audit_coverage_states FROM %I', target_role);
    END IF;
  END LOOP;
END
$$;

COMMENT ON TABLE "public"."m365_audit_coverage_gaps" IS
  'URL-free audit coverage records; a future owner-fenced repair must set resolved_at with full-blob proof, and cleanup purges records 720 hours after first_observed_at while retaining incomplete state for unresolved loss.';
COMMENT ON TABLE "public"."m365_audit_coverage_states" IS
  'Sticky tenant audit incomplete marker; purging an unresolved compact gap must set has_purged_unrepaired_gap and must never delete or clear this row.';
