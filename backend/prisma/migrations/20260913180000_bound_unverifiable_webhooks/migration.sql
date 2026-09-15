-- Bound the unauthenticated write path.
--
-- THE DEFECT: the webhook route returns 200 to a forged request and writes an UNMATCHED row,
-- so anyone who learns the URL can grow alert_delivery_outcomes without limit. The 200 is
-- correct — a 401 tells a forger their signature was checked and records nothing, and a non-2xx
-- makes Resend retry a body we will never accept — but the storage was not.
--
-- THE DISTINCTION THAT MAKES THIS TRACTABLE IS WHO CAN CAUSE THE ROW:
--
--   SIGNATURE_MISSING / SIGNATURE_INVALID  anyone, unbounded, content attacker-chosen
--   NO_SUCH_JOB / ALREADY_RESOLVED         only a holder of the signing secret, so bounded by
--                                          Resend's traffic, which is bounded by our own sending
--
-- Only the first pair needs a bound, and its per-row content is worthless: a forger picks any
-- provider id they like. What carries the signal is THAT it happened, HOW MANY, and WHEN — all
-- three of which an aggregate keeps, while bounding storage by TIME rather than by how hard
-- somebody pushes.
--
-- WHY NOT RETENTION ALONE: it bounds the long run and not the burst. An attacker can still
-- reach any size inside the retention window, which is the window that matters.
-- WHY NOT A RATE LIMIT: the dropped requests are exactly the evidence, so it protects the table
-- by destroying the signal — and it would drop genuine Resend bursts too.
--
-- FORWARD ONLY. 20260913160000 is not edited even though it is new and unapplied here, because
-- "unapplied" is not something this migration can verify and the rule earns its keep by being
-- absolute.

-- ---------------------------------------------------------------------------------------
-- 1. The aggregate. One row per verdict per hour, however many requests arrive.
-- ---------------------------------------------------------------------------------------

CREATE TABLE "alert_webhook_rejections" (
  "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
  -- The hour the requests arrived in, truncated. The bucket is what makes the row count a
  -- function of TIME rather than of traffic: 24 hours x 2 verdicts is the daily ceiling.
  "bucket_start" TIMESTAMPTZ(6) NOT NULL,
  "verdict"     VARCHAR(30)    NOT NULL,
  "attempts"    BIGINT         NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at"  TIMESTAMPTZ(6) NOT NULL,
  -- Following identity_risk_operational_events. The aggregate is already bounded, so this is
  -- hygiene rather than the safety property — the safety property is the bucket.
  "expires_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "alert_webhook_rejections_pkey" PRIMARY KEY ("id"),

  -- ONLY THE UNVERIFIABLE VERDICTS LAND HERE. NO_SUCH_JOB and ALREADY_RESOLVED are recorded in
  -- full in alert_delivery_outcomes, because those mean a job we lost or an id we never
  -- recorded — facts about this system that a count cannot answer.
  CONSTRAINT "alert_webhook_rejections_verdict_check"
    CHECK ("verdict" IN ('SIGNATURE_MISSING', 'SIGNATURE_INVALID')),

  CONSTRAINT "alert_webhook_rejections_attempts_check"
    CHECK ("attempts" > 0)
);

CREATE UNIQUE INDEX "alert_webhook_rejections_bucket_key"
  ON "alert_webhook_rejections" ("bucket_start", "verdict");

CREATE INDEX "alert_webhook_rejections_expiry"
  ON "alert_webhook_rejections" ("expires_at");

-- ---------------------------------------------------------------------------------------
-- 2. Make the unverifiable path UNWRITEABLE to the outcomes table.
-- ---------------------------------------------------------------------------------------
--
-- The bound above is a decision in a route; this is the same decision in the schema, and it is
-- the half that survives somebody rewriting the route. After this, an event whose signature did
-- not verify has no path into alert_delivery_outcomes at all — the same move as the four checks
-- already on that table, which make a wrong row unconstructible rather than reviewed for.

ALTER TABLE "alert_delivery_outcomes"
  DROP CONSTRAINT "alert_delivery_outcomes_because_check";

ALTER TABLE "alert_delivery_outcomes"
  ADD CONSTRAINT "alert_delivery_outcomes_because_check"
    CHECK (("kind" = 'UNMATCHED' AND "because" IN ('NO_SUCH_JOB', 'ALREADY_RESOLVED'))
        OR ("kind" <> 'UNMATCHED' AND "because" IS NULL));
