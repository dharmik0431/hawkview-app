-- The table `send-queue.ts` already writes SQL against, and which did not exist.
--
-- FOUND BY WRITING THE REMAINING-WORK LIST RATHER THAN BY AN OPERATOR HITTING IT. `claimStatement`
-- names `alert_send_jobs`, its columns and its states, and no migration created it — exactly the
-- shape of the step-03 failure, where code referred to columns nothing had made and the first
-- symptom was a schema error two steps into a runbook. Caught earlier this time, which is the only
-- difference worth noting.
--
-- Idempotent from any starting state, for the reason 20260912120000 learned.

-- WIDTHS: 400, NOT 200. A message id derives from the incident it speaks for, and an incident
-- key is up to 300 characters of length-prefixed encoding — so 200 truncated exactly the long
-- subjects that are hardest to notice. Found by the end-to-end test, which built a real key
-- rather than a short fixture; a hand-written 'm-1' would have fitted and passed.
--
-- EDITED IN PLACE RATHER THAN FOLLOWED BY AN ALTER, and that is only defensible because this
-- migration has never been applied anywhere but throwaway clusters created and deleted inside
-- this session. The moment it reaches a database somebody keeps, it becomes immutable.
-- ---------------------------------------------------------------------------------------
-- alert_send_jobs
-- ---------------------------------------------------------------------------------------
--
-- THE BUDGET LIVES HERE, NOT IN THE WORKER. `attempts_made` and `max_attempts` are columns
-- because a `maxAttempts` argument to a runner lives in the PROCESS: a redeploy restarts the
-- count from zero, and so does a second worker picking the job up. The job then retries forever
-- while every test of the runner shows it stopping at three — because the runner really does stop
-- at three, it is just not the only runner there has ever been.
--
-- `not_before_at` IS THE BACKOFF, for the same reason. A worker that sleeps in memory is a worker
-- whose wait a redeploy discards, and a wait nobody can query is a wait nobody can test.
--
-- NO TENANT COLUMN, AND NO ORGANISATION COLUMN. Nothing about a send job is scoped, so a
-- per-tenant queue is not discouraged but UNWRITEABLE — there is no field to partition on. That
-- is the one-message-per-cause rule enforced by the schema. The message id is the only link to
-- whatever knows who it is for, and `send-queue.ts` pins this shape in a test that asserts the
-- whole key set rather than a list of forbidden names.
CREATE TABLE IF NOT EXISTS "public"."alert_send_jobs" (
  -- No database defaults on id or updated_at: Prisma generates both client-side, and a database
  -- default would be a second writer for the same field. Learned from the drift check on
  -- 20260912190000, which reported exactly those two columns.
  "id" UUID NOT NULL,
  "message_id" VARCHAR(400) NOT NULL,
  "idempotency_key" VARCHAR(400) NOT NULL,
  "state" VARCHAR(20) NOT NULL,
  "attempts_made" INTEGER NOT NULL,
  "max_attempts" INTEGER NOT NULL,
  "not_before_at" TIMESTAMPTZ(6) NOT NULL,
  "claimed_by" VARCHAR(100),
  "claimed_at" TIMESTAMPTZ(6),
  "claim_expires_at" TIMESTAMPTZ(6),
  -- Set when the provider accepted it, so SENT is a state with its evidence attached rather than
  -- a state somebody has to trust.
  "provider_id" VARCHAR(200),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "alert_send_jobs_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  -- The five states, exactly as `SendState` declares them. A typo'd state written by a raw query
  -- would otherwise read back as a valid-looking string that is neither claimable nor terminal.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_state_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_state_check"
      CHECK ("state" IN ('READY', 'CLAIMED', 'SENT', 'EXHAUSTED', 'GAVE_UP'));
  END IF;

  -- THE BUDGET CANNOT BE EXCEEDED, AND IT CANNOT BE ZERO. A job created with max_attempts 0 is a
  -- job that will never be attempted and never be reported as stopped, because it is neither
  -- terminal nor eligible — the silent state this whole layer exists to prevent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_budget_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_budget_check"
      CHECK ("max_attempts" >= 1 AND "attempts_made" >= 0 AND "attempts_made" <= "max_attempts");
  END IF;

  -- A CLAIM IS ALL THREE FIELDS OR NONE. A row naming a holder with no expiry is a job nobody can
  -- ever reclaim; an expiry with no holder is a lock with no owner. Two fields that can disagree,
  -- made unwriteable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_claim_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_claim_check"
      CHECK (num_nonnulls("claimed_by", "claimed_at", "claim_expires_at") IN (0, 3));
  END IF;

  -- SENT MEANS THERE IS EVIDENCE. A job in SENT with no provider id is a claim that something was
  -- delivered with nothing to look it up by, which is indistinguishable from a guess.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_sent_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_sent_check"
      CHECK (("state" = 'SENT') = ("provider_id" IS NOT NULL));
  END IF;
END $$;

-- One job per message. The claim statement addresses a job by message id, so two rows for one
-- message would make `WHERE message_id = $1` update both — two workers, one message, two sends.
CREATE UNIQUE INDEX IF NOT EXISTS "alert_send_jobs_message_id_key"
  ON "public"."alert_send_jobs" ("message_id");

-- The drain read: what is claimable now, oldest first.
CREATE INDEX IF NOT EXISTS "alert_send_jobs_state_not_before_at_idx"
  ON "public"."alert_send_jobs" ("state", "not_before_at");

-- ---------------------------------------------------------------------------------------
-- alert_send_attempts
-- ---------------------------------------------------------------------------------------
--
-- WRITTEN BEFORE THE SIDE EFFECT, WHICH IS WHY `settled_kind` IS NULLABLE. If the row were
-- written when the send RETURNS, a crash mid-send would leave no trace that anything was sent —
-- and the retry would send a second email believing it was the first. An attempt with a null
-- settlement past its deadline is exactly the evidence that a process died holding a send.
--
-- So the nullability here is not laxity. It is the only shape in which "we do not know what
-- happened to that send" is expressible at all.
CREATE TABLE IF NOT EXISTS "public"."alert_send_attempts" (
  "id" UUID NOT NULL,
  "message_id" VARCHAR(400) NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "settled_kind" VARCHAR(30),
  "settled_at" TIMESTAMPTZ(6),
  "provider_id" VARCHAR(200),
  "because" VARCHAR(500),
  CONSTRAINT "alert_send_attempts_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_attempts_settled_check') THEN
    ALTER TABLE "public"."alert_send_attempts" ADD CONSTRAINT "alert_send_attempts_settled_check"
      CHECK (
        ("settled_kind" IS NULL AND "settled_at" IS NULL)
        OR ("settled_kind" IN ('ACCEPTED', 'REFUSED_RETRYABLE', 'REFUSED_PERMANENT')
            AND "settled_at" IS NOT NULL));
  END IF;
  -- An ACCEPTED attempt names the message the provider took. Without it, "one send per message"
  -- cannot be checked over the history, because there is nothing to count.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_attempts_accepted_check') THEN
    ALTER TABLE "public"."alert_send_attempts" ADD CONSTRAINT "alert_send_attempts_accepted_check"
      CHECK (("settled_kind" = 'ACCEPTED') = ("provider_id" IS NOT NULL));
  END IF;
END $$;

-- One row per attempt per message, so a double-write of the same attempt number is refused rather
-- than inflating the history the budget is reconciled against.
CREATE UNIQUE INDEX IF NOT EXISTS "alert_send_attempts_message_id_attempt_no_key"
  ON "public"."alert_send_attempts" ("message_id", "attempt_no");

-- Unsettled attempts, which is the in-flight query.
CREATE INDEX IF NOT EXISTS "alert_send_attempts_settled_kind_started_at_idx"
  ON "public"."alert_send_attempts" ("settled_kind", "started_at");

-- NO FOREIGN KEY FROM ATTEMPTS TO JOBS, deliberately. An attempt is a record of something that
-- happened; a job is current state. If a job is ever removed, the attempts must survive it —
-- otherwise deleting a job destroys the evidence of what it sent, which is the one thing that
-- cannot be reconstructed. `accounting()` reports an attempt with no job rather than the database
-- forbidding it.

ALTER TABLE "public"."alert_send_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."alert_send_attempts" ENABLE ROW LEVEL SECURITY;
