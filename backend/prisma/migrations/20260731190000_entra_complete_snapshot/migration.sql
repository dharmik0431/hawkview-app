ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'AUTH_REGISTRATIONS';
ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'AUTH_METHOD_POLICIES';
ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'CONDITIONAL_ACCESS';
ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'NAMED_LOCATIONS';
ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'SIGN_INS';
ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'DEVICES';
ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'DIRECTORY_ROLES';

CREATE TABLE "tenant_entra_snapshots" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "resource_type" "SyncResourceType" NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '[]',
  "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tenant_entra_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_entra_snapshots_customer_tenant_id_resource_type_key"
  ON "tenant_entra_snapshots"("customer_tenant_id", "resource_type");
CREATE INDEX "tenant_entra_snapshots_organization_id_customer_tenant_id_idx"
  ON "tenant_entra_snapshots"("organization_id", "customer_tenant_id");
ALTER TABLE "tenant_entra_snapshots"
  ADD CONSTRAINT "tenant_entra_snapshots_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_entra_snapshots"
  ADD CONSTRAINT "tenant_entra_snapshots_customer_tenant_id_organization_id_fkey"
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
