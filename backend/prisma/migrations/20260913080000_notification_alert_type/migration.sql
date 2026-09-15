-- Which alert type a notification is, so the inbox can say an alert is urgent.
--
-- THE PROBLEM IT SOLVES: an ACT_NOW incident and a routine informational message render
-- identically in the panel today, so the tier the whole alerting design turns on is unsayable in
-- the one place alerts actually land. A design whose central distinction disappears at the point
-- of delivery has not been delivered.
--
-- **THIS COLUMN IS THE FACT. THE TIER IS DERIVED FROM IT.** `ALERT_CATALOG` already owns which
-- types are ACT_NOW, ACT_TODAY and RECORD_ONLY, and it is the third time in this feature that the
-- right answer has been *derive it from the catalogue rather than store it again*. A second
-- severity column beside the existing one would be two columns describing how urgent something
-- is, and they would disagree the first time anybody edited one.
--
-- NOTHING IS WRITTEN TO `severity` AS A SECOND SOURCE OF TRUTH. That column predates this work,
-- holds the old info/low/medium/high/critical vocabulary, and is what the reader's visibility
-- filter matches on — so it is still SET, derived from the alert type at write time. It is a
-- RENDERING, not the fact, and `alert_type_id` wins if they ever disagree. Said here because a
-- reader who finds two urgency-shaped columns deserves to be told which one to believe.
--
-- NULLABLE, AND ABSENCE IS NOT A TIER. Most notifications are not alerts — a sync failure, a
-- connection problem — and they have no alert type. **A row that does not state a tier is a row
-- that did not say, which is not the same as RECORD_ONLY.** RECORD_ONLY is a decision somebody
-- made to stop being told; NULL is the absence of any such decision. Collapsing them would make a
-- silenced alert type and an unconfigured one render identically.
--
-- Idempotent from any starting state, for the reason 20260912120000 learned.

-- 64 MATCHES THE TYPE-LEVEL BOUND. `alert-catalog.ts` proves at compile time that every declared
-- id fits the incident-key budget, and that budget is 64 characters. A wider column would let the
-- database hold an id the product cannot key on; a narrower one would truncate, and a truncated
-- alert type id is a DIFFERENT alert type id that silently resolves to nothing.
ALTER TABLE "public"."notifications"
  ADD COLUMN IF NOT EXISTS "alert_type_id" VARCHAR(64);

-- For "show me the urgent ones", which is the query the panel exists to answer. Organisation
-- first for the same reason the incident_key index is: every read here is org-scoped.
CREATE INDEX IF NOT EXISTS "notifications_organization_id_alert_type_id_idx"
  ON "public"."notifications" ("organization_id", "alert_type_id");
