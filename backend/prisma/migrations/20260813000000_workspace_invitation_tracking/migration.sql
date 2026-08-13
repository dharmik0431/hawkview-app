ALTER TABLE "users"
ADD COLUMN "invite_sent_at" TIMESTAMPTZ(6),
ADD COLUMN "invite_accepted_at" TIMESTAMPTZ(6);

-- Existing Supabase-linked accounts predate invitation tracking and should
-- remain active rather than appearing as newly invited pending users.
UPDATE "users"
SET "invite_accepted_at" = COALESCE("updated_at", "created_at")
WHERE "auth_provider_user_id" IS NOT NULL
  AND "invite_accepted_at" IS NULL;

CREATE INDEX "users_invite_accepted_at_idx" ON "users"("invite_accepted_at");
