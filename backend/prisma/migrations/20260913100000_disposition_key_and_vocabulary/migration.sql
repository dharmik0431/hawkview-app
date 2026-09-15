-- The disposition column's NAME and its VOCABULARY, both corrected forward.
--
-- **THESE TWO CHANGES WERE MADE BY EDITING 20260912190000 IN PLACE, AND THAT WAS WRONG.** Measured
-- rather than argued: against a database migrated before the edit, `prisma migrate deploy` reports
-- *No pending migrations to apply* and `prisma migrate status` reports *Database schema is up to
-- date!*, while the column is still `rule_id` and the CHECK still holds
-- `RING | EMAIL | DIGEST | RECORD_ONLY`. The settings endpoint's every write then fails with
-- 23514, and **both Prisma commands report health the whole time.**
--
-- Deploying IS migrating here — `backend/Dockerfile` runs `db:migrate:deploy` on every container
-- start — so that state reaches production with nothing raising a hand. 20260912190000 has been
-- restored to what it actually applied, and the corrections live here where a database can
-- converge on them from either side.
--
-- THE RULE THIS ESTABLISHES: **forward migrations only.** An in-place edit is safe only under a
-- premise nobody can verify from here — that no database anywhere has applied the old file — and
-- being right about that once does not make it a method. A forward migration is correct whether or
-- not the premise holds, which is the property that matters.
--
-- Idempotent from any starting state, and safe to run against a database that already has the
-- corrections: every step checks first.

-- ---------------------------------------------------------------------------------------
-- 1. `rule_id` becomes `alert_type_id`
-- ---------------------------------------------------------------------------------------
--
-- THE NAME LIED, AND THE LIE WAS EXPENSIVE. `finding-pipeline.ts` keys the lookup on the ALERT
-- TYPE id, so a disposition stored as `HV-ID-AUTH-010.v1` — which is what any author reading
-- `rule_id` would store — was silently ignored and the email went anyway: the row existed, the
-- write succeeded, the MSP saw their choice saved, and nothing changed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'alert_rule_dispositions'
       AND column_name = 'rule_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'alert_rule_dispositions'
       AND column_name = 'alert_type_id'
  ) THEN
    ALTER TABLE "public"."alert_rule_dispositions" RENAME COLUMN "rule_id" TO "alert_type_id";
  END IF;
END $$;

-- The index name follows the column, or the next person greps for one and finds the other.
ALTER INDEX IF EXISTS "alert_rule_dispositions_organization_id_rule_id_key"
  RENAME TO "alert_rule_dispositions_organization_id_alert_type_id_key";

-- Belt and braces for a database that never had the old index under either name.
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rule_dispositions_organization_id_alert_type_id_key"
  ON "public"."alert_rule_dispositions" ("organization_id", "alert_type_id");

-- ---------------------------------------------------------------------------------------
-- 2. The vocabulary becomes the TIER rather than the CHANNEL
-- ---------------------------------------------------------------------------------------
--
-- `RING | EMAIL | DIGEST | RECORD_ONLY` is a `DeliveryPreference` — HOW somebody is reached.
-- `ACT_NOW | ACT_TODAY | RECORD_ONLY` is the catalogue's `Severity` — HOW URGENT this is here.
-- The organisation answers the second; the product answers the first from it.
--
-- ⚠ `RECORD_ONLY` IS IN BOTH VOCABULARIES, which is why a half-done change looks healthy: every
-- test that exercises *off* passes under either spelling, and only RING, EMAIL and DIGEST are
-- wrong. That is also why any stored row must be translated rather than left — see below.
--
-- ANY EXISTING ROW IS TRANSLATED THROUGH `defaultPreference` RUN BACKWARDS, which is the only
-- mapping that ever related the two: RING came from ACT_NOW, EMAIL from ACT_TODAY, RECORD_ONLY
-- from itself. DIGEST had no tier and never could be produced by the default, so a stored DIGEST
-- was a deliberate MSP choice to be batched — there is no tier for it, and it becomes ACT_TODAY
-- rather than being dropped, because the alternative is silently discarding a setting somebody
-- made. That loss is recorded in the handoff rather than hidden here.
-- **THE CONSTRAINT COMES OFF BEFORE THE ROWS MOVE, and the order is not cosmetic.** Written the
-- other way round first, this migration failed on a real database with real rows: writing
-- `ACT_NOW` while the old CHECK still stood raised 23514 and rolled the whole migration back,
-- leaving it recorded as failed and every later deploy blocked with P3009.
--
-- A FRESH DATABASE WOULD NOT HAVE CAUGHT IT — there are no rows to translate, so both orderings
-- pass. It took a database seeded in the old vocabulary, which is the only kind this migration
-- exists for.
ALTER TABLE "public"."alert_rule_dispositions"
  DROP CONSTRAINT IF EXISTS "alert_rule_dispositions_disposition_check";

UPDATE "public"."alert_rule_dispositions" SET "disposition" = 'ACT_NOW'   WHERE "disposition" = 'RING';
UPDATE "public"."alert_rule_dispositions" SET "disposition" = 'ACT_TODAY' WHERE "disposition" IN ('EMAIL', 'DIGEST');

-- Added last, so it validates rows that have already been translated.
ALTER TABLE "public"."alert_rule_dispositions"
  ADD CONSTRAINT "alert_rule_dispositions_disposition_check"
  CHECK ("disposition" IN ('ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'));
