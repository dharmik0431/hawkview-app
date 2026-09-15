-- `CANCELLED` joins the send-job states.
--
-- THE OPERATOR'S STOP BUTTON. A job is an intent to send; an incident is a fact. Cancelling
-- intent that has not yet settled is the only undo that matters, and somebody will want it
-- within a minute of switching sending on. Today they would have nothing to press.
--
-- ITS OWN STATE, NOT A DELETION AND NOT A REUSE OF `GAVE_UP`. Deleting the row loses the ability
-- to explain what the product did — the same reason the step 03 apply annotates rather than
-- re-keys. And gave-up against cancelled is the same silence with opposite meanings and different
-- remedies: one means the address refused us and somebody should check the mailbox, the other
-- means a person stopped it and somebody should decide whether they were right.
--
-- NOTHING HERE TOUCHES `alert_incidents`. The incident stays.

-- The CHECK is replaced rather than added to, because a CHECK cannot be widened in place. Dropped
-- first so re-running is safe from either state.
ALTER TABLE "public"."alert_send_jobs" DROP CONSTRAINT IF EXISTS "alert_send_jobs_state_check";

ALTER TABLE "public"."alert_send_jobs" ADD CONSTRAINT "alert_send_jobs_state_check"
  CHECK ("state" IN ('READY', 'CLAIMED', 'SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED'));

-- A NOTE ON THE ONE THAT IS NOT ENFORCED HERE. "A finished job is never relabelled" lives in
-- `cancelStatement`'s WHERE clause rather than in a constraint, because it is a rule about a
-- TRANSITION and a CHECK sees only the row it is given — it cannot tell CANCELLED-from-READY
-- from CANCELLED-from-SENT. A trigger could; a trigger is a second place that decides who may
-- send, which is the thing this feature has spent its length refusing.
--
-- THE BOUND WAS `attempts_made = 0` WHEN THIS MIGRATION WAS FIRST WRITTEN, on the reasoning that
-- an attempted job had already reached a provider and calling it cancelled would be a lie. That
-- protected the record and broke the button: a job attempted once and refused RETRYABLY is still
-- READY with budget left, so the operator pressed stop and an email went afterwards. Cancel now
-- covers every non-terminal job. Nothing in this file changes with it — the state list was
-- always the whole schema contribution — but the note would otherwise describe a rule that is
-- no longer there.