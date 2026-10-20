ALTER TABLE "security_baselines"
  ADD COLUMN "check_settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "revision" integer NOT NULL DEFAULT 1;

ALTER TABLE "security_baselines"
  ADD CONSTRAINT "security_baselines_revision_positive" CHECK ("revision" > 0),
  ADD CONSTRAINT "security_baselines_check_settings_object" CHECK (jsonb_typeof("check_settings") = 'object');

CREATE TABLE "security_baseline_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "baseline_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "name" varchar(100) NOT NULL,
  "check_ids" text[] NOT NULL,
  "check_settings" jsonb NOT NULL,
  "changed_by_user_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_baseline_revisions_scope_fkey"
    FOREIGN KEY ("baseline_id", "organization_id")
    REFERENCES "security_baselines"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "security_baseline_revisions_baseline_id_revision_key" UNIQUE ("baseline_id", "revision"),
  CONSTRAINT "security_baseline_revisions_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "security_baseline_revisions_check_settings_object" CHECK (jsonb_typeof("check_settings") = 'object')
);
CREATE INDEX "security_baseline_revisions_organization_id_baseline_id_revision_idx"
  ON "security_baseline_revisions"("organization_id", "baseline_id", "revision");

INSERT INTO "security_baseline_revisions"
  ("id", "organization_id", "baseline_id", "revision", "name", "check_ids", "check_settings", "changed_by_user_id", "created_at")
SELECT gen_random_uuid(), "organization_id", "id", 1, "name", "check_ids", "check_settings", "created_by_user_id", "created_at"
FROM "security_baselines";

ALTER TABLE "security_baseline_revisions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "security_baseline_revisions" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "security_baseline_revisions" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "security_baseline_revisions" FROM authenticated;
  END IF;
END $$;
