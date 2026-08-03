ALTER TABLE "users"
  ADD COLUMN "time_zone" VARCHAR(100),
  ADD COLUMN "date_format" VARCHAR(20) NOT NULL DEFAULT 'MM/DD/YYYY',
  ADD COLUMN "time_format" VARCHAR(3) NOT NULL DEFAULT '12h';

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "category" VARCHAR(20) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "action_url" VARCHAR(500),
  "action_label" VARCHAR(100),
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notifications_user_id_created_at_idx"
  ON "notifications"("user_id", "created_at" DESC);

CREATE INDEX "notifications_user_id_read_at_idx"
  ON "notifications"("user_id", "read_at");
