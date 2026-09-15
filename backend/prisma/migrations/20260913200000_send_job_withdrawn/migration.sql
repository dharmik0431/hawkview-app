-- `WITHDRAWN` joins the send-job states, with the reason it stopped being appropriate.
--
-- THE SEND STOPPED BEING APPROPRIATE AND NO PERSON DECIDED THAT. The worker resolves the message
-- from CURRENT state after claiming it, which is the whole point of resolving late: an operator
-- who switches an alert type off between queueing and sending has changed their mind, and a queue
-- that delivers the old decision ignores them. When that resolve refuses, the job has to leave the
-- queue saying why — and until now there was no honest state to write.
--
-- WHY NOT REUSE AN EXISTING STATE. Both candidates are lies of a kind that a reader acts on:
--   CANCELLED is the operator's stop button, documented as "a person stopped it, and the remedy is
--   to decide whether they were right". Nobody pressed anything here. A reader who found CANCELLED
--   would go looking for who stopped it and find nobody.
--   GAVE_UP is the address refusing us — the same silence with the opposite meaning and a
--   different remedy (check the mailbox), which is the reuse 20260913020000 already argues against
--   for its own case.
--
-- **AND THE SHORTCUT WAS NOT AVAILABLE ANYWAY: `alert_send_jobs_cancellation_check` IS A
-- BICONDITIONAL.** state = 'CANCELLED' iff cancelled_at, cancelled_by AND cancelled_because are
-- all non-null — so writing a withdrawal as CANCELLED requires inventing a `cancelled_by`, which
-- is attributing a system decision to a person in the column somebody will later read as "who
-- stopped this". The constraint refused a lie. That is a database enforcing a product distinction
-- the application code was about to blur, and it is why this migration exists rather than a
-- comment apologising for a reused state.
--
-- **THERE IS DELIBERATELY NO `withdrawn_by`.** Not an oversight and not deferred: there is no
-- person to name, and a nullable column for one gets filled in eventually by somebody being
-- helpful — at which point a system decision has acquired an author and the distinction this
-- migration was written to protect is gone. The absence is the guarantee.
--
-- NOTHING HERE ALTERS A COLUMN THE PIPELINE WRITES ON INSERT. Two new nullable columns, and the
-- state CHECK widened. A widening cannot refuse a row any earlier version could write, so no
-- existing insert changes behaviour.
--
-- **THE COLUMNS MUST STAY NULLABLE AND UNDEFAULTED, AND THIS IS A CROSS-BRANCH CONSTRAINT RATHER
-- THAN A STYLE RULE.** `alert_send_jobs` is INSERTED BY THE PIPELINE (state='READY', neither of
-- these columns touched) and only TRANSITIONED here. A NOT NULL without a default would fail
-- every job insert the moment this lands — on the table that starts every send, so the failure is
-- "nothing is ever queued" rather than "withdrawals break". Found by the pipeline owner RUNNING
-- the merge rather than reading it. `send-queue.test.ts` asserts the columns are added without a
-- NOT NULL and that nothing later tightens them.
--
-- The biconditional is safe for that insert: ('READY' = 'WITHDRAWN') is false, (NULL IS NOT NULL
-- AND NULL IS NOT NULL) is false, and false = false is TRUE. The reason CHECK is `IS NULL OR
-- IN (...)`, which a NULL passes outright.
--
-- THE TIMESTAMP IS AFTER 180000 BECAUSE THE MERGE ORDER IS LEXICOGRAPHIC. The other branch holds
-- `20260913140000_alert_withheld_notices`, which this worktree cannot see; the fact that the two
-- sets interleave correctly is luck rather than coordination, since 160000 was chosen here
-- without sight of their 140000.
--
-- Forward-only and idempotent from any starting state, for the reason 20260912120000 learned.

-- A CHECK cannot be widened in place. Dropped first so re-running is safe from either state.
ALTER TABLE "public"."alert_send_jobs" DROP CONSTRAINT IF EXISTS "alert_send_jobs_state_check";

ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_state_check"
  CHECK ("state" IN ('READY', 'CLAIMED', 'SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED', 'WITHDRAWN'));

ALTER TABLE "public"."alert_send_jobs" ADD COLUMN IF NOT EXISTS "withdrawn_at" TIMESTAMPTZ(6);
ALTER TABLE "public"."alert_send_jobs" ADD COLUMN IF NOT EXISTS "withdrawn_because" VARCHAR(40);

DO $$
BEGIN
  -- A BICONDITIONAL, for the reason the cancellation one is. Withdrawn with no reason is
  -- unwriteable, and a reason on a job nobody withdrew is unwriteable too — the second half is how
  -- a half-finished UPDATE, one that set the columns and not the state, would otherwise survive as
  -- a row that reads as live and carries a withdrawal.
  --
  -- SAFE TO ADD AS A BICONDITIONAL ONLY BECAUSE NO WITHDRAWN ROW CAN EXIST: the state is
  -- introduced by this migration. The moment that stops being true this becomes a nullable column
  -- plus a backfill and is not addable in this form.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_withdrawal_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_withdrawal_check"
      CHECK (
        ("state" = 'WITHDRAWN')
        = ("withdrawn_at" IS NOT NULL AND "withdrawn_because" IS NOT NULL));
  END IF;

  -- A CLOSED VOCABULARY, AND THIS IS THE OPPOSITE CHOICE FROM `cancelled_because` ONE TABLE OVER.
  -- That one is free text on purpose: the reasons a PERSON stops a send are not enumerable in
  -- advance, and an OTHER bucket collecting every real answer is worse than a sentence. These
  -- reasons are not a person's — they are the four refusals the resolver can produce, each one a
  -- fact about configuration or about the incident, and every one of them is enumerable because
  -- the code that writes them is the code that decides them.
  --
  -- The four are `WithdrawnReason` in `send-worker.ts`, and `send-queue.test.ts` asserts this list
  -- and that type say the same thing — a vocabulary in two places is a vocabulary that drifts, and
  -- the drift shows up as an insert failing in production rather than as a test going red.
  --
  -- MESSAGE_CONTENT_UNAVAILABLE CARRIES TWO CAUSES DELIBERATELY: an unparseable message id, and an
  -- incident that is gone. The vocabulary is keyed on what an operator would DO, and today both
  -- send them to look at the job. **Split it the moment the remedies diverge** — the likely
  -- trigger being incidents acquiring a retention policy, at which point "the incident aged out"
  -- becomes expected while an unparseable id never does, and one reason would hide a real defect
  -- behind routine housekeeping.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_send_jobs_withdrawn_reason_check') THEN
    ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_withdrawn_reason_check"
      CHECK ("withdrawn_because" IS NULL OR "withdrawn_because" IN (
        'ALERT_TYPE_DISABLED',
        'NO_VERIFIED_RECIPIENT',
        'INCIDENT_NO_LONGER_ACTIONABLE',
        'MESSAGE_CONTENT_UNAVAILABLE'));
  END IF;
END $$;

-- "WHAT DID WE NOT SEND THIS WEEK, AND WHY" is the question these columns exist to answer, and it
-- is asked over a window. Not unique: one preference change withdrawing forty queued jobs is the
-- ordinary case, not a conflict. Mirrors `alert_send_jobs_cancelled_at_idx` for the same reason.
CREATE INDEX IF NOT EXISTS "alert_send_jobs_withdrawn_at_idx"
  ON "public"."alert_send_jobs" ("withdrawn_at");
