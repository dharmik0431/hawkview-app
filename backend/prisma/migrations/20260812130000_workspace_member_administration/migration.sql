CREATE TABLE "workspace_admin_audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_email" VARCHAR(320),
    "target_user_id" UUID,
    "target_email" VARCHAR(320),
    "action" VARCHAR(100) NOT NULL,
    "outcome" VARCHAR(30) NOT NULL DEFAULT 'SUCCEEDED',
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_admin_audit_logs_organization_id_created_at_idx"
ON "workspace_admin_audit_logs"("organization_id", "created_at" DESC);

CREATE INDEX "workspace_admin_audit_logs_target_user_id_created_at_idx"
ON "workspace_admin_audit_logs"("target_user_id", "created_at" DESC);
