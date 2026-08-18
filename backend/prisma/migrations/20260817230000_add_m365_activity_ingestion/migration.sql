ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'M365_AUDIT';

CREATE TABLE "m365_activity_subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "content_type" VARCHAR(80) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN',
    "last_start_requested_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "last_content_poll_at" TIMESTAMPTZ(6),
    "last_successful_poll_at" TIMESTAMPTZ(6),
    "discovery_window_start" TIMESTAMPTZ(6),
    "discovery_window_end" TIMESTAMPTZ(6),
    "discovery_next_page_uri" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "m365_activity_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "m365_activity_contents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "content_type" VARCHAR(80) NOT NULL,
    "microsoft_content_id" VARCHAR(500) NOT NULL,
    "content_uri" TEXT NOT NULL,
    "content_created_at" TIMESTAMPTZ(6),
    "content_expires_at" TIMESTAMPTZ(6),
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "ledger_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "m365_activity_contents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "m365_audit_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "content_type" VARCHAR(80) NOT NULL,
    "microsoft_record_id" VARCHAR(500) NOT NULL,
    "event_date_time" TIMESTAMPTZ(6) NOT NULL,
    "workload" VARCHAR(100),
    "operation" VARCHAR(500) NOT NULL,
    "actor_id" VARCHAR(320),
    "actor_type" VARCHAR(80),
    "object_id" TEXT,
    "result" VARCHAR(100),
    "client_ip" VARCHAR(128),
    "correlation_id" VARCHAR(200),
    "raw" JSONB NOT NULL,
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "m365_audit_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "m365_audit_daily_usage" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_tenant_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "downloaded_bytes" BIGINT NOT NULL DEFAULT 0,
    "records_stored" INTEGER NOT NULL DEFAULT 0,
    "blobs_processed" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "m365_audit_daily_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "m365_activity_subscriptions_customer_tenant_id_content_type_key" ON "m365_activity_subscriptions"("customer_tenant_id", "content_type");
CREATE INDEX "m365_activity_subscriptions_organization_id_customer_tenant_id_status_idx" ON "m365_activity_subscriptions"("organization_id", "customer_tenant_id", "status");
CREATE UNIQUE INDEX "m365_activity_contents_customer_tenant_id_microsoft_content_id_key" ON "m365_activity_contents"("customer_tenant_id", "microsoft_content_id");
CREATE INDEX "m365_activity_contents_organization_id_customer_tenant_id_status_next_retry_at_idx" ON "m365_activity_contents"("organization_id", "customer_tenant_id", "status", "next_retry_at");
CREATE INDEX "m365_activity_contents_ledger_expires_at_idx" ON "m365_activity_contents"("ledger_expires_at");
CREATE UNIQUE INDEX "m365_audit_records_customer_tenant_id_microsoft_record_id_key" ON "m365_audit_records"("customer_tenant_id", "microsoft_record_id");
CREATE INDEX "m365_audit_records_organization_id_customer_tenant_id_event_date_time_idx" ON "m365_audit_records"("organization_id", "customer_tenant_id", "event_date_time" DESC);
CREATE INDEX "m365_audit_records_customer_tenant_id_correlation_id_idx" ON "m365_audit_records"("customer_tenant_id", "correlation_id");
CREATE INDEX "m365_audit_records_expires_at_idx" ON "m365_audit_records"("expires_at");
CREATE UNIQUE INDEX "m365_audit_daily_usage_customer_tenant_id_usage_date_key" ON "m365_audit_daily_usage"("customer_tenant_id", "usage_date");
CREATE INDEX "m365_audit_daily_usage_usage_date_idx" ON "m365_audit_daily_usage"("usage_date");
CREATE INDEX "m365_audit_daily_usage_organization_id_customer_tenant_id_usage_date_idx" ON "m365_audit_daily_usage"("organization_id", "customer_tenant_id", "usage_date");

ALTER TABLE "m365_activity_subscriptions" ADD CONSTRAINT "m365_activity_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_activity_subscriptions" ADD CONSTRAINT "m365_activity_subscriptions_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_activity_contents" ADD CONSTRAINT "m365_activity_contents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_activity_contents" ADD CONSTRAINT "m365_activity_contents_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_audit_records" ADD CONSTRAINT "m365_audit_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_audit_records" ADD CONSTRAINT "m365_audit_records_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_audit_daily_usage" ADD CONSTRAINT "m365_audit_daily_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "m365_audit_daily_usage" ADD CONSTRAINT "m365_audit_daily_usage_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
