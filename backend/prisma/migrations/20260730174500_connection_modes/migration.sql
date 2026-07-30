CREATE TYPE "MicrosoftConnectionMode" AS ENUM ('HAWKVIEW_MANAGED', 'CUSTOMER_MANAGED');

ALTER TABLE "tenant_connections"
ADD COLUMN "connection_mode" "MicrosoftConnectionMode" NOT NULL DEFAULT 'HAWKVIEW_MANAGED',
ADD COLUMN "client_id" UUID,
ADD COLUMN "credential_reference" VARCHAR(500),
ADD COLUMN "credential_expires_at" TIMESTAMPTZ(6);

ALTER TABLE "tenant_connections"
ADD CONSTRAINT "tenant_connections_customer_credential_check"
CHECK (
  "connection_mode" <> 'CUSTOMER_MANAGED'
  OR ("client_id" IS NOT NULL AND "credential_reference" IS NOT NULL)
);

CREATE TABLE "platform_microsoft_connectors" (
    "id" VARCHAR(32) NOT NULL DEFAULT 'default',
    "client_id" UUID NOT NULL,
    "home_tenant_id" UUID NOT NULL,
    "credential_reference" VARCHAR(500) NOT NULL,
    "credential_expires_at" TIMESTAMPTZ(6),
    "configured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "platform_microsoft_connectors_pkey" PRIMARY KEY ("id")
);
