ALTER TYPE "SyncResourceType" ADD VALUE 'LICENSES';
ALTER TYPE "SyncResourceType" ADD VALUE 'DOMAINS';

CREATE TABLE "tenant_licenses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "microsoft_sku_id" UUID NOT NULL,
    "sku_part_number" VARCHAR(200) NOT NULL,
    "consumed_units" INTEGER NOT NULL DEFAULT 0,
    "enabled_units" INTEGER NOT NULL DEFAULT 0,
    "warning_units" INTEGER NOT NULL DEFAULT 0,
    "suspended_units" INTEGER NOT NULL DEFAULT 0,
    "locked_out_units" INTEGER NOT NULL DEFAULT 0,
    "capability_status" VARCHAR(50),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "tenant_licenses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenant_domains" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "name" VARCHAR(253) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_initial" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_licenses_customer_tenant_id_microsoft_sku_id_key"
ON "tenant_licenses"("customer_tenant_id", "microsoft_sku_id");
CREATE INDEX "tenant_licenses_organization_id_customer_tenant_id_idx"
ON "tenant_licenses"("organization_id", "customer_tenant_id");
CREATE UNIQUE INDEX "tenant_domains_customer_tenant_id_name_key"
ON "tenant_domains"("customer_tenant_id", "name");
CREATE INDEX "tenant_domains_organization_id_customer_tenant_id_idx"
ON "tenant_domains"("organization_id", "customer_tenant_id");

ALTER TABLE "tenant_licenses"
ADD CONSTRAINT "tenant_licenses_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_licenses"
ADD CONSTRAINT "tenant_licenses_customer_tenant_id_organization_id_fkey"
FOREIGN KEY ("customer_tenant_id", "organization_id")
REFERENCES "customer_tenants"("id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_domains"
ADD CONSTRAINT "tenant_domains_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_domains"
ADD CONSTRAINT "tenant_domains_customer_tenant_id_organization_id_fkey"
FOREIGN KEY ("customer_tenant_id", "organization_id")
REFERENCES "customer_tenants"("id", "organization_id")
ON DELETE CASCADE ON UPDATE CASCADE;
