ALTER TABLE "customer_tenants"
ALTER COLUMN "display_name" DROP NOT NULL,
ADD COLUMN "primary_domain" VARCHAR(253);

ALTER TABLE "tenant_connections"
ADD COLUMN "consent_state_hash" VARCHAR(64),
ADD COLUMN "consent_state_expires_at" TIMESTAMPTZ(6);
