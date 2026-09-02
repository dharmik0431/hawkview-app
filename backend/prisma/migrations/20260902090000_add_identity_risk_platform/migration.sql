CREATE TABLE "identity_risk_evaluation_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "customer_tenant_id" UUID NOT NULL, "run_key" VARCHAR(128) NOT NULL,
  "engine_version" VARCHAR(100) NOT NULL, "catalog_version" VARCHAR(100) NOT NULL, "status" VARCHAR(30) NOT NULL,
  "window_start" TIMESTAMPTZ NOT NULL, "window_end" TIMESTAMPTZ NOT NULL, "source_watermark_hash" VARCHAR(128) NOT NULL,
  "aggregate" JSONB NOT NULL DEFAULT '{}', "expires_at" TIMESTAMPTZ NOT NULL, "completed_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"), FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE);
CREATE UNIQUE INDEX "identity_risk_evaluation_runs_scope_key" ON "identity_risk_evaluation_runs"("organization_id", "customer_tenant_id", "run_key");
CREATE INDEX "identity_risk_evaluation_runs_scope_completed" ON "identity_risk_evaluation_runs"("organization_id", "customer_tenant_id", "completed_at" DESC);
CREATE TABLE "identity_risk_findings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "customer_tenant_id" UUID NOT NULL, "evaluation_run_id" UUID NOT NULL,
  "dedupe_key" VARCHAR(128) NOT NULL, "rule_id" VARCHAR(150) NOT NULL, "rule_version" VARCHAR(100) NOT NULL, "subject_type" VARCHAR(50) NOT NULL, "subject_id" VARCHAR(128) NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'OPEN', "severity" VARCHAR(20) NOT NULL, "confidence" VARCHAR(20) NOT NULL, "coverage" VARCHAR(20) NOT NULL,
  "explanation" JSONB NOT NULL DEFAULT '{}', "evidence" JSONB NOT NULL DEFAULT '[]', "observed_at" TIMESTAMPTZ NOT NULL, "expires_at" TIMESTAMPTZ NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"), FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE,
  FOREIGN KEY ("evaluation_run_id") REFERENCES "identity_risk_evaluation_runs"("id") ON DELETE CASCADE);
CREATE UNIQUE INDEX "identity_risk_findings_scope_key" ON "identity_risk_findings"("organization_id", "customer_tenant_id", "dedupe_key");
CREATE INDEX "identity_risk_findings_scope_state" ON "identity_risk_findings"("organization_id", "customer_tenant_id", "state", "observed_at" DESC);
