-- Delivery outcomes: what happened to a message, as against what the provider said when asked.
--
-- FORWARD ONLY. Editing an applied migration in place is reported as healthy by both
-- `prisma migrate status` and `prisma migrate deploy` (measured at 7.9.1), so nothing catches it.

CREATE TABLE "alert_delivery_outcomes" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "provider_id" VARCHAR(200) NOT NULL,
  -- NULLABLE ON PURPOSE. A verified event carrying a provider id we hold no job for is a fact
  -- about this system, not a non-event: a job we lost, an id never recorded, or somebody posting
  -- forged or replayed events at the endpoint. All three look like nothing happening if the row
  -- is dropped for want of something to attach it to.
  "message_id"  VARCHAR(400),
  "kind"        VARCHAR(20)  NOT NULL,
  "bounce"      VARCHAR(10),
  "because"     VARCHAR(30),
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "alert_delivery_outcomes_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "alert_delivery_outcomes_kind_check"
    CHECK ("kind" IN ('DELIVERED', 'BOUNCED', 'COMPLAINED', 'UNMATCHED')),

  -- A bounce class belongs to a bounce and to nothing else. Without this a DELIVERED row could
  -- carry 'HARD', and any query grouping by bounce class would answer a question about a set
  -- that should be empty.
  CONSTRAINT "alert_delivery_outcomes_bounce_check"
    CHECK (("kind" = 'BOUNCED' AND "bounce" IN ('HARD', 'SOFT'))
        OR ("kind" <> 'BOUNCED' AND "bounce" IS NULL)),

  -- A reason belongs to an unmatched event and to nothing else, in both directions. An UNMATCHED
  -- row with no reason is the silent drop this table exists to prevent, wearing a row.
  CONSTRAINT "alert_delivery_outcomes_because_check"
    CHECK (("kind" = 'UNMATCHED' AND "because" IN
             ('SIGNATURE_MISSING', 'SIGNATURE_INVALID', 'NO_SUCH_JOB', 'ALREADY_RESOLVED'))
        OR ("kind" <> 'UNMATCHED' AND "because" IS NULL)),

  -- An outcome that matched nothing has no message; one that matched has one. Enforced rather
  -- than trusted, because "which send killed this address" is answered from this column.
  CONSTRAINT "alert_delivery_outcomes_message_check"
    CHECK (("kind" = 'UNMATCHED' AND "message_id" IS NULL)
        OR ("kind" <> 'UNMATCHED' AND "message_id" IS NOT NULL))
);

-- ONE ROW PER PROVIDER EVENT. Resend retries a webhook it believes failed, so the same event
-- arrives more than once; a second DELIVERED row for one send would make any count of delivered
-- messages depend on how often the provider retried us.
--
-- NOT A UNIQUE ON provider_id ALONE: one message legitimately produces DELIVERED and later
-- COMPLAINED, and a key that collapsed those would discard the complaint — which is the event
-- that changes behaviour.
CREATE UNIQUE INDEX "alert_delivery_outcomes_event_key"
  ON "alert_delivery_outcomes" ("provider_id", "kind", "occurred_at");

CREATE INDEX "alert_delivery_outcomes_message_id_idx"
  ON "alert_delivery_outcomes" ("message_id");

CREATE INDEX "alert_delivery_outcomes_kind_occurred_at_idx"
  ON "alert_delivery_outcomes" ("kind", "occurred_at");
