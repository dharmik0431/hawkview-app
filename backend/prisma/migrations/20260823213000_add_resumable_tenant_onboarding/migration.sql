CREATE TYPE "MicrosoftConsentFlow" AS ENUM (
  'DISCOVER_TENANT',
  'EXISTING_TENANT',
  'EXCHANGE_READ_ONLY'
);

ALTER TABLE "tenant_connections"
  ADD COLUMN "exchange_read_only_skipped_at" TIMESTAMPTZ(6),
  ADD COLUMN "report_settings_last_checked_at" TIMESTAMPTZ(6),
  ADD COLUMN "report_identifiers_visible" BOOLEAN,
  ADD COLUMN "report_visibility_deferred_at" TIMESTAMPTZ(6),
  ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ(6);

-- Existing tenants have already passed the legacy onboarding experience.
-- New tenant connections intentionally remain incomplete until each optional
-- setup choice is either verified or explicitly deferred.
UPDATE "tenant_connections"
SET "onboarding_completed_at" = COALESCE("consented_at", "created_at");

CREATE TABLE "microsoft_consent_attempts" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID,
  "initiated_by_user_id" UUID,
  "flow" "MicrosoftConsentFlow" NOT NULL,
  "state_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "result_code" VARCHAR(100),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "microsoft_consent_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "microsoft_consent_attempts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "microsoft_consent_attempts_customer_tenant_id_organization_id_fkey"
    FOREIGN KEY ("customer_tenant_id", "organization_id")
    REFERENCES "customer_tenants"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "microsoft_consent_attempts_initiated_by_user_id_fkey"
    FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "microsoft_consent_attempts_state_hash_key"
  ON "microsoft_consent_attempts"("state_hash");
CREATE INDEX "microsoft_consent_attempts_organization_id_created_at_idx"
  ON "microsoft_consent_attempts"("organization_id", "created_at" DESC);
CREATE INDEX "microsoft_consent_attempts_customer_tenant_id_flow_created_at_idx"
  ON "microsoft_consent_attempts"("customer_tenant_id", "flow", "created_at" DESC);
CREATE INDEX "microsoft_consent_attempts_expires_at_idx"
  ON "microsoft_consent_attempts"("expires_at");
