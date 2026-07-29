-- CreateEnum
CREATE TYPE "CustomerTenantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "TenantConnectionStatus" AS ENUM ('PENDING_CONSENT', 'CONNECTED', 'ERROR', 'REVOKED');

-- CreateTable
CREATE TABLE "customer_tenants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "microsoft_tenant_id" UUID NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "status" "CustomerTenantStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "status" "TenantConnectionStatus" NOT NULL DEFAULT 'PENDING_CONSENT',
    "consented_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consented_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(100),
    "last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenants_microsoft_tenant_id_key" ON "customer_tenants"("microsoft_tenant_id");

-- CreateIndex
CREATE INDEX "customer_tenants_organization_id_status_idx" ON "customer_tenants"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenants_id_organization_id_key" ON "customer_tenants"("id", "organization_id");

-- CreateIndex
CREATE INDEX "tenant_connections_organization_id_status_idx" ON "tenant_connections"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_connections_customer_tenant_id_organization_id_key" ON "tenant_connections"("customer_tenant_id", "organization_id");

-- AddForeignKey
ALTER TABLE "customer_tenants" ADD CONSTRAINT "customer_tenants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_connections" ADD CONSTRAINT "tenant_connections_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
