ALTER TABLE "organizations"
  ADD COLUMN "business_domain" VARCHAR(253),
  ADD COLUMN "time_zone" VARCHAR(100),
  ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "created_by_user_id" UUID;

-- Existing workspaces predate the onboarding state machine. Treat them as
-- complete so this deployment never interrupts an established MSP. The
-- earliest owner membership is a deterministic founder/backfill authority.
UPDATE "organizations" AS organization
SET
  "onboarding_completed_at" = COALESCE(organization."updated_at", organization."created_at"),
  "created_by_user_id" = (
    SELECT membership."user_id"
    FROM "memberships" AS membership
    WHERE
      membership."organization_id" = organization."id"
      AND membership."role" = 'MSP_OWNER'
      AND membership."status" = 'ACTIVE'
    ORDER BY membership."created_at" ASC, membership."id" ASC
    LIMIT 1
  );

-- Organizations without an owner are still historic and must not be forced
-- through setup. They intentionally have no founder-edit authority until a
-- future audited platform recovery flow assigns one.
UPDATE "organizations"
SET "onboarding_completed_at" = COALESCE("updated_at", "created_at")
WHERE "onboarding_completed_at" IS NULL;

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "organizations_created_by_user_id_idx"
  ON "organizations"("created_by_user_id");

CREATE INDEX "organizations_onboarding_completed_at_idx"
  ON "organizations"("onboarding_completed_at");
