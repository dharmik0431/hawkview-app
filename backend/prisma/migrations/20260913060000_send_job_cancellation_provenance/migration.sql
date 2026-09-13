-- Who stopped it, when, and why.
--
-- SIX MONTHS FROM NOW, "WHY WAS THIS MSP NEVER TOLD" HAS TO BE ANSWERABLE FROM THE RECORD. Before
-- these columns the answer was "the job says CANCELLED" and stopped there — the state records that
-- somebody stopped it and nothing records who or on what grounds. An unexplained stop is precisely
-- the thing that turns into an argument with a customer, and the argument happens long after every
-- log that might have settled it has rotated away.
--
-- THE REASON IS REQUIRED, NOT DEFAULTED. A default would be written by the code rather than by the
-- person, and a field that always says the same thing answers nothing. Requiring it costs the
-- operator one sentence at the moment they have the context, which is the only moment the sentence
-- is cheap.
--
-- FREE TEXT RATHER THAN A CLOSED VOCABULARY, and that is the exception in this feature rather than
-- a lapse. Everything else here is an enum because the possibilities were enumerable in advance;
-- the reasons a person stops a send are not, and an `OTHER` bucket collecting every real answer is
-- worse than a sentence.
--
-- Idempotent from any starting state, for the reason 20260912120000 learned.

ALTER TABLE "public"."alert_send_jobs" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ(6);
ALTER TABLE "public"."alert_send_jobs" ADD COLUMN IF NOT EXISTS "cancelled_by" VARCHAR(200);
ALTER TABLE "public"."alert_send_jobs" ADD COLUMN IF NOT EXISTS "cancelled_because" VARCHAR(500);

DO $$
BEGIN
  -- A BICONDITIONAL, NOT THREE NULLABLE COLUMNS AND A CONVENTION. Cancelled with no provenance is
  -- unwriteable, and provenance on a job nobody cancelled is unwriteable too — the second half
  -- matters because it is how a half-finished UPDATE, one that set the columns and not the state,
  -- would otherwise survive as a row that reads as live and carries a cancellation.
  --
  -- SAFE TO ADD AS A BICONDITIONAL ONLY BECAUSE NO CANCELLED ROW EXISTS ANYWHERE. `CANCELLED` was
  -- introduced by 20260913020000, which has reached nothing but throwaway clusters, and nothing
  -- has ever called `cancelStatement` in production. The moment either stops being true this has
  -- to become a nullable column plus a backfill, and it will not be addable in this form.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_cancellation_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_cancellation_check"
      CHECK (
        ("state" = 'CANCELLED')
        = ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL AND "cancelled_because" IS NOT NULL));
  END IF;
  -- An empty reason satisfies NOT NULL and answers nothing. The type refuses it on our side; this
  -- refuses it to anything that bypasses the type, which is the whole point of saying it twice.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_cancel_reason_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_cancel_reason_check"
      CHECK ("cancelled_because" IS NULL OR length(btrim("cancelled_because")) > 0);
  END IF;
END $$;

-- For "what was stopped, and by whom" over a window. Not a unique index: one operator stopping a
-- hundred jobs in one press is the ordinary case, not a conflict.
CREATE INDEX IF NOT EXISTS "alert_send_jobs_cancelled_at_idx"
  ON "public"."alert_send_jobs" ("cancelled_at");
