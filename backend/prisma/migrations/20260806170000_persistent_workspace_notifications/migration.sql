ALTER TABLE "notifications"
  ADD COLUMN "organization_id" UUID,
  ADD COLUMN "customer_tenant_id" UUID,
  ADD COLUMN "recipient_user_id" UUID,
  ADD COLUMN "event_type" VARCHAR(80) NOT NULL DEFAULT 'legacy.user_notification',
  ADD COLUMN "severity" VARCHAR(20) NOT NULL DEFAULT 'info',
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "source" VARCHAR(80) NOT NULL DEFAULT 'system',
  ADD COLUMN "dedupe_key" VARCHAR(300),
  ADD COLUMN "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "first_occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "last_occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "notifications" n
SET "recipient_user_id" = n."user_id",
    "organization_id" = (
      SELECT m."organization_id"
      FROM "memberships" m
      WHERE m."user_id" = n."user_id"
      ORDER BY CASE WHEN m."status" = 'ACTIVE' THEN 0 ELSE 1 END, m."created_at"
      LIMIT 1
    ),
    "dedupe_key" = 'legacy:' || n."id"::text,
    "first_occurred_at" = n."created_at",
    "last_occurred_at" = n."created_at";

DELETE FROM "notifications" WHERE "organization_id" IS NULL;

CREATE TABLE "notification_user_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "notification_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "read_at" TIMESTAMPTZ(6),
  "dismissed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_user_states_pkey" PRIMARY KEY ("id")
);

INSERT INTO "notification_user_states" ("notification_id", "user_id", "read_at")
SELECT "id", "user_id", "read_at" FROM "notifications";

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_user_id_fkey",
  DROP COLUMN "user_id",
  DROP COLUMN "read_at",
  ALTER COLUMN "organization_id" SET NOT NULL,
  ALTER COLUMN "dedupe_key" SET NOT NULL;

DROP INDEX IF EXISTS "notifications_user_id_created_at_idx";
DROP INDEX IF EXISTS "notifications_user_id_read_at_idx";

CREATE UNIQUE INDEX "notifications_organization_id_dedupe_key_key" ON "notifications"("organization_id", "dedupe_key");
CREATE INDEX "notifications_organization_id_last_occurred_at_idx" ON "notifications"("organization_id", "last_occurred_at" DESC);
CREATE INDEX "notifications_customer_tenant_id_resolved_at_idx" ON "notifications"("customer_tenant_id", "resolved_at");
CREATE UNIQUE INDEX "notification_user_states_notification_id_user_id_key" ON "notification_user_states"("notification_id", "user_id");
CREATE INDEX "notification_user_states_user_id_read_at_dismissed_at_idx" ON "notification_user_states"("user_id", "read_at", "dismissed_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_tenant_id_organization_id_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_user_states" ADD CONSTRAINT "notification_user_states_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_user_states" ADD CONSTRAINT "notification_user_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "security_enabled" BOOLEAN NOT NULL DEFAULT true,
  "connection_enabled" BOOLEAN NOT NULL DEFAULT true,
  "synchronization_enabled" BOOLEAN NOT NULL DEFAULT true,
  "account_enabled" BOOLEAN NOT NULL DEFAULT true,
  "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
  "minimum_severity" VARCHAR(20) NOT NULL DEFAULT 'info',
  "email_enabled" BOOLEAN NOT NULL DEFAULT false,
  "digest_mode" VARCHAR(20) NOT NULL DEFAULT 'off',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_preferences_user_id_organization_id_key" ON "notification_preferences"("user_id", "organization_id");
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
