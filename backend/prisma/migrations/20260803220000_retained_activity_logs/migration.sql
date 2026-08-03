ALTER TYPE "SyncResourceType" ADD VALUE IF NOT EXISTS 'AUDIT_LOGS';

CREATE TABLE "sign_in_logs" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "microsoft_sign_in_id" VARCHAR(200) NOT NULL,
  "event_date_time" TIMESTAMPTZ(6) NOT NULL,
  "user_id" VARCHAR(128),
  "user_display_name" VARCHAR(256),
  "user_principal_name" VARCHAR(320),
  "app_id" VARCHAR(128),
  "app_display_name" VARCHAR(256),
  "resource_display_name" VARCHAR(256),
  "ip_address" VARCHAR(64),
  "client_app_used" VARCHAR(100),
  "conditional_access_status" VARCHAR(50),
  "is_interactive" BOOLEAN,
  "risk_level" VARCHAR(50),
  "status_error_code" VARCHAR(32),
  "failure_reason" TEXT,
  "location" JSONB,
  "device_detail" JSONB,
  "raw" JSONB NOT NULL,
  "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "sign_in_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "directory_audit_logs" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "microsoft_audit_id" VARCHAR(200) NOT NULL,
  "event_date_time" TIMESTAMPTZ(6) NOT NULL,
  "activity_display_name" VARCHAR(500) NOT NULL,
  "category" VARCHAR(100),
  "operation_type" VARCHAR(100),
  "result" VARCHAR(50),
  "result_reason" TEXT,
  "correlation_id" VARCHAR(128),
  "logged_by_service" VARCHAR(100),
  "initiated_by" JSONB,
  "target_resources" JSONB,
  "additional_details" JSONB,
  "raw" JSONB NOT NULL,
  "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "directory_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sign_in_logs_customer_tenant_id_microsoft_sign_in_id_key"
  ON "sign_in_logs"("customer_tenant_id", "microsoft_sign_in_id");
CREATE INDEX "sign_in_logs_organization_id_customer_tenant_id_event_date_idx"
  ON "sign_in_logs"("organization_id", "customer_tenant_id", "event_date_time" DESC);
CREATE INDEX "sign_in_logs_customer_tenant_id_user_principal_name_event_d_idx"
  ON "sign_in_logs"("customer_tenant_id", "user_principal_name", "event_date_time" DESC);
CREATE INDEX "sign_in_logs_expires_at_idx" ON "sign_in_logs"("expires_at");

CREATE UNIQUE INDEX "directory_audit_logs_customer_tenant_id_microsoft_audit_id_key"
  ON "directory_audit_logs"("customer_tenant_id", "microsoft_audit_id");
CREATE INDEX "directory_audit_logs_organization_id_customer_tenant_id_even_idx"
  ON "directory_audit_logs"("organization_id", "customer_tenant_id", "event_date_time" DESC);
CREATE INDEX "directory_audit_logs_customer_tenant_id_category_event_date_t_idx"
  ON "directory_audit_logs"("customer_tenant_id", "category", "event_date_time" DESC);
CREATE INDEX "directory_audit_logs_expires_at_idx" ON "directory_audit_logs"("expires_at");

ALTER TABLE "sign_in_logs"
  ADD CONSTRAINT "sign_in_logs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sign_in_logs"
  ADD CONSTRAINT "sign_in_logs_customer_tenant_id_organization_id_fkey"
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "directory_audit_logs"
  ADD CONSTRAINT "directory_audit_logs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "directory_audit_logs"
  ADD CONSTRAINT "directory_audit_logs_customer_tenant_id_organization_id_fkey"
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
