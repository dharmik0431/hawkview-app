CREATE TABLE "change_evidence_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "source" VARCHAR(40) NOT NULL,
  "source_event_id" VARCHAR(200) NOT NULL,
  "event_date_time" TIMESTAMPTZ(6) NOT NULL,
  "workload" VARCHAR(100),
  "category" VARCHAR(100) NOT NULL,
  "severity" VARCHAR(20) NOT NULL,
  "operation_name" VARCHAR(500) NOT NULL,
  "summary" TEXT NOT NULL,
  "actor_id" VARCHAR(128),
  "actor_display_name" VARCHAR(256),
  "actor_principal_name" VARCHAR(320),
  "target_id" VARCHAR(128),
  "target_display_name" VARCHAR(500),
  "target_type" VARCHAR(100),
  "correlation_id" VARCHAR(128),
  "result" VARCHAR(50),
  "ip_address" VARCHAR(64),
  "location" JSONB,
  "before_state" JSONB,
  "after_state" JSONB,
  "changed_fields" JSONB,
  "raw" JSONB NOT NULL,
  "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "change_evidence_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "change_evidence_events_customer_tenant_id_source_source_event_id_key" UNIQUE ("customer_tenant_id", "source", "source_event_id"),
  CONSTRAINT "change_evidence_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "change_evidence_events_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "change_evidence_events_organization_tenant_time_idx" ON "change_evidence_events"("organization_id", "customer_tenant_id", "event_date_time" DESC);
CREATE INDEX "change_evidence_events_tenant_category_time_idx" ON "change_evidence_events"("customer_tenant_id", "category", "event_date_time" DESC);
CREATE INDEX "change_evidence_events_tenant_correlation_idx" ON "change_evidence_events"("customer_tenant_id", "correlation_id");
CREATE INDEX "change_evidence_events_expires_at_idx" ON "change_evidence_events"("expires_at");
