CREATE TABLE "identity_risk_evaluation_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "run_key" VARCHAR(128) NOT NULL,
  "engine_version" VARCHAR(100) NOT NULL,
  "catalog_version" VARCHAR(100) NOT NULL,
  "status" VARCHAR(30) NOT NULL,
  "window_start" TIMESTAMPTZ NOT NULL,
  "window_end" TIMESTAMPTZ NOT NULL,
  "source_watermark_hash" VARCHAR(128) NOT NULL,
  "capability" VARCHAR(20) NOT NULL DEFAULT 'UNAVAILABLE',
  "aggregate" JSONB NOT NULL DEFAULT '{}',
  "alert_delivery_disabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "failure_code" VARCHAR(80),
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "identity_risk_runs_window_check" CHECK ("window_start" < "window_end"),
  CONSTRAINT "identity_risk_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT "identity_risk_runs_capability_check" CHECK ("capability" IN ('FULL', 'PARTIAL', 'UNAVAILABLE')),
  CONSTRAINT "identity_risk_runs_completion_check" CHECK (("status" = 'COMPLETED' AND "completed_at" IS NOT NULL) OR "status" <> 'COMPLETED'),
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "identity_risk_evaluation_runs_scope_key" ON "identity_risk_evaluation_runs"("organization_id", "customer_tenant_id", "run_key");
CREATE UNIQUE INDEX "identity_risk_evaluation_runs_scope_id" ON "identity_risk_evaluation_runs"("id", "organization_id", "customer_tenant_id");
CREATE INDEX "identity_risk_evaluation_runs_scope_completed" ON "identity_risk_evaluation_runs"("organization_id", "customer_tenant_id", "completed_at" DESC);
CREATE INDEX "identity_risk_evaluation_runs_scope_lease" ON "identity_risk_evaluation_runs"("organization_id", "customer_tenant_id", "status", "lease_expires_at");
CREATE INDEX "identity_risk_evaluation_runs_expiry" ON "identity_risk_evaluation_runs"("expires_at");

CREATE TABLE "identity_risk_rule_coverage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "customer_tenant_id" UUID NOT NULL,
  "evaluation_run_id" UUID NOT NULL, "rule_id" VARCHAR(150) NOT NULL,
  "eligible_count" INTEGER NOT NULL DEFAULT 0, "matched_count" INTEGER NOT NULL DEFAULT 0,
  "suppressed_count" INTEGER NOT NULL DEFAULT 0, "not_matched_count" INTEGER NOT NULL DEFAULT 0,
  "not_evaluated_count" INTEGER NOT NULL DEFAULT 0, "counts_capped" BOOLEAN NOT NULL DEFAULT FALSE,
  "reason_counts" JSONB NOT NULL DEFAULT '[]', "samples_truncated" BOOLEAN NOT NULL DEFAULT FALSE,
  "expires_at" TIMESTAMPTZ NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "identity_risk_coverage_counts_check" CHECK ("eligible_count" BETWEEN 0 AND 1000000 AND "matched_count" BETWEEN 0 AND 1000000 AND "suppressed_count" BETWEEN 0 AND 1000000 AND "not_matched_count" BETWEEN 0 AND 1000000 AND "not_evaluated_count" BETWEEN 0 AND 1000000),
  CONSTRAINT "identity_risk_coverage_rule_check" CHECK ("rule_id" ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$'),
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE,
  FOREIGN KEY ("evaluation_run_id", "organization_id", "customer_tenant_id") REFERENCES "identity_risk_evaluation_runs"("id", "organization_id", "customer_tenant_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "identity_risk_rule_coverage_scope_key" ON "identity_risk_rule_coverage"("organization_id", "customer_tenant_id", "evaluation_run_id", "rule_id");
CREATE INDEX "identity_risk_rule_coverage_scope_run" ON "identity_risk_rule_coverage"("organization_id", "customer_tenant_id", "evaluation_run_id");
CREATE INDEX "identity_risk_rule_coverage_expiry" ON "identity_risk_rule_coverage"("expires_at");

CREATE TABLE "identity_risk_matched_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "customer_tenant_id" UUID NOT NULL,
  "evaluation_run_id" UUID NOT NULL, "result_key" VARCHAR(128) NOT NULL, "rule_id" VARCHAR(150) NOT NULL,
  "subject_type" VARCHAR(50) NOT NULL, "subject_id" VARCHAR(128) NOT NULL, "severity" VARCHAR(20) NOT NULL,
  "confidence" VARCHAR(20) NOT NULL, "coverage" VARCHAR(20) NOT NULL, "observed_at" TIMESTAMPTZ NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]', "expires_at" TIMESTAMPTZ NOT NULL, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "identity_risk_matched_rule_check" CHECK ("rule_id" ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$'),
  CONSTRAINT "identity_risk_matched_subject_check" CHECK ("subject_type" IN ('USER', 'MAILBOX', 'APPLICATION', 'UNKNOWN')),
  CONSTRAINT "identity_risk_matched_severity_check" CHECK ("severity" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT "identity_risk_matched_confidence_check" CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT "identity_risk_matched_coverage_check" CHECK ("coverage" IN ('FULL', 'PARTIAL')),
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE,
  FOREIGN KEY ("evaluation_run_id", "organization_id", "customer_tenant_id") REFERENCES "identity_risk_evaluation_runs"("id", "organization_id", "customer_tenant_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "identity_risk_matched_results_scope_key" ON "identity_risk_matched_results"("organization_id", "customer_tenant_id", "result_key");
CREATE UNIQUE INDEX "identity_risk_matched_results_scope_id" ON "identity_risk_matched_results"("id", "organization_id", "customer_tenant_id");
CREATE INDEX "identity_risk_matched_results_scope_run" ON "identity_risk_matched_results"("organization_id", "customer_tenant_id", "evaluation_run_id");
CREATE INDEX "identity_risk_matched_results_expiry" ON "identity_risk_matched_results"("expires_at");

CREATE TABLE "identity_risk_findings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL, "customer_tenant_id" UUID NOT NULL,
  "matched_result_id" UUID NOT NULL, "dedupe_key" VARCHAR(128) NOT NULL, "rule_id" VARCHAR(150) NOT NULL,
  "rule_version" VARCHAR(100) NOT NULL, "subject_type" VARCHAR(50) NOT NULL, "subject_id" VARCHAR(128) NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'OPEN', "severity" VARCHAR(20) NOT NULL, "confidence" VARCHAR(20) NOT NULL,
  "coverage" VARCHAR(20) NOT NULL, "observed_at" TIMESTAMPTZ NOT NULL, "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "identity_risk_finding_rule_check" CHECK ("rule_id" ~ '^HV-ID-(EXP|CHG|APP|MBX|AUTH)-[0-9]{3}\.v1$' AND "rule_version" = 'v1'),
  CONSTRAINT "identity_risk_finding_subject_check" CHECK ("subject_type" IN ('USER', 'MAILBOX', 'APPLICATION', 'UNKNOWN')),
  CONSTRAINT "identity_risk_finding_state_check" CHECK ("state" IN ('OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED')),
  CONSTRAINT "identity_risk_finding_severity_check" CHECK ("severity" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT "identity_risk_finding_confidence_check" CHECK ("confidence" IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT "identity_risk_finding_coverage_check" CHECK ("coverage" IN ('FULL', 'PARTIAL')),
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE,
  FOREIGN KEY ("matched_result_id", "organization_id", "customer_tenant_id") REFERENCES "identity_risk_matched_results"("id", "organization_id", "customer_tenant_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "identity_risk_findings_scope_key" ON "identity_risk_findings"("organization_id", "customer_tenant_id", "dedupe_key");
CREATE INDEX "identity_risk_findings_scope_state" ON "identity_risk_findings"("organization_id", "customer_tenant_id", "state", "observed_at" DESC, "id" DESC);
CREATE INDEX "identity_risk_findings_expiry" ON "identity_risk_findings"("expires_at");

CREATE TABLE "identity_risk_operational_controls" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "control_type" VARCHAR(40) NOT NULL, "scope_type" VARCHAR(20) NOT NULL,
  "scope_key" VARCHAR(128) NOT NULL, "organization_id" UUID, "customer_tenant_id" UUID, "state" VARCHAR(20) NOT NULL,
  "episode_id" UUID NOT NULL, "reason_code" VARCHAR(80) NOT NULL, "actor_service_id" VARCHAR(128) NOT NULL,
  "activated_at" TIMESTAMPTZ NOT NULL, "resumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "identity_risk_control_type_check" CHECK ("control_type" IN ('ALERT_DELIVERY_DISABLED', 'EVALUATION_HARD_DISABLED')),
  CONSTRAINT "identity_risk_control_state_check" CHECK ("state" IN ('ACTIVE', 'RESUMED')),
  CONSTRAINT "identity_risk_control_scope_check" CHECK (("scope_type" = 'GLOBAL' AND "organization_id" IS NULL AND "customer_tenant_id" IS NULL) OR ("scope_type" = 'TENANT' AND "organization_id" IS NOT NULL AND "customer_tenant_id" IS NOT NULL)),
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "identity_risk_operational_controls_scope_key" ON "identity_risk_operational_controls"("control_type", "scope_key");
CREATE INDEX "identity_risk_operational_controls_scope_state" ON "identity_risk_operational_controls"("scope_type", "scope_key", "state");

CREATE TABLE "identity_risk_operational_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "control_id" UUID, "event_key" VARCHAR(128) NOT NULL,
  "event_type" VARCHAR(50) NOT NULL, "control_type" VARCHAR(40), "scope_type" VARCHAR(20) NOT NULL,
  "scope_opaque_id" VARCHAR(128) NOT NULL, "reason_code" VARCHAR(80) NOT NULL, "correlation_id" UUID NOT NULL,
  "actor_service_id" VARCHAR(128) NOT NULL, "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"), FOREIGN KEY ("control_id") REFERENCES "identity_risk_operational_controls"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "identity_risk_operational_events_event_key" ON "identity_risk_operational_events"("event_key");
CREATE INDEX "identity_risk_operational_events_created" ON "identity_risk_operational_events"("created_at" DESC);
CREATE INDEX "identity_risk_operational_events_control_created" ON "identity_risk_operational_events"("control_id", "created_at");
CREATE INDEX "identity_risk_operational_events_scope_expiry" ON "identity_risk_operational_events"("scope_type", "scope_opaque_id", "expires_at");
CREATE INDEX "identity_risk_operational_events_expiry" ON "identity_risk_operational_events"("expires_at");
