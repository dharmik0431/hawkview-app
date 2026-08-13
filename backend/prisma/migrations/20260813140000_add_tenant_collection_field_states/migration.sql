CREATE TABLE "tenant_collection_field_states" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "field_key" VARCHAR(150) NOT NULL,
  "state" VARCHAR(40) NOT NULL,
  "reason_code" VARCHAR(100),
  "message" TEXT,
  "source" VARCHAR(100) NOT NULL DEFAULT 'Microsoft Graph',
  "endpoint" TEXT,
  "correlation_id" VARCHAR(200),
  "last_attempt_at" TIMESTAMPTZ(6),
  "last_successful_at" TIMESTAMPTZ(6),
  "is_stale" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tenant_collection_field_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_collection_field_states_customer_tenant_id_field_key_key" UNIQUE ("customer_tenant_id", "field_key"),
  CONSTRAINT "tenant_collection_field_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_collection_field_states_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tenant_collection_field_states_organization_id_customer_tenant_id_idx"
  ON "tenant_collection_field_states"("organization_id", "customer_tenant_id");
