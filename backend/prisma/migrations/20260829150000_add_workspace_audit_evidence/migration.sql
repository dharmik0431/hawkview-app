ALTER TABLE "workspace_admin_audit_logs"
  ADD COLUMN "target_type" VARCHAR(50),
  ADD COLUMN "target_opaque_id" VARCHAR(128),
  ADD COLUMN "stage" VARCHAR(50),
  ADD COLUMN "error_code" VARCHAR(100),
  ADD COLUMN "request_id" VARCHAR(100),
  ADD COLUMN "operation_id" UUID,
  ADD COLUMN "event_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "expires_at" TIMESTAMPTZ(6);

CREATE INDEX "workspace_admin_audit_logs_organization_id_operation_id_created_at_idx"
  ON "workspace_admin_audit_logs"("organization_id", "operation_id", "created_at");

CREATE INDEX "workspace_admin_audit_logs_organization_id_request_id_created_at_idx"
  ON "workspace_admin_audit_logs"("organization_id", "request_id", "created_at");

CREATE INDEX "workspace_admin_audit_logs_expires_at_idx"
  ON "workspace_admin_audit_logs"("expires_at");
