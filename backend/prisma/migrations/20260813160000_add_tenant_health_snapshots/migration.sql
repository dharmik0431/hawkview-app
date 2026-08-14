CREATE TABLE "tenant_health_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "health_model_version" INTEGER NOT NULL,
  "overall_status" VARCHAR(30) NOT NULL,
  "payload" JSONB NOT NULL,
  "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_health_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_health_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_health_snapshots_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tenant_health_snapshots_organization_tenant_evaluated_at_idx" ON "tenant_health_snapshots"("organization_id", "customer_tenant_id", "evaluated_at" DESC);
