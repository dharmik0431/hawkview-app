-- Addresses that must not be written to again, and that survive a restart.
--
-- WHY THIS IS A TABLE AND NOT A SET. `Suppressions` has been an interface with one in-memory
-- implementation since the sender was written. That means a hard bounce is forgotten on the next
-- deploy, and the address is attempted again — so the suppression was never a suppression, it was
-- a cache with a very short life. A dead mailbox retried after every release is exactly the
-- pattern that costs a sending domain its reputation, and the damage lands on every other message
-- HawkView sends rather than on the one that bounced.
--
-- THE ADDRESS IS THE PRIMARY KEY. Not a uuid with a unique index on the address — those are the
-- same thing until somebody writes the second row, and a surrogate key makes two disagreeing rows
-- about one address WRITEABLE. Then "is this suppressed" has two answers and no owner.
--
-- NO ORGANISATION COLUMN, and this is the uncomfortable direction rather than the convenient one.
-- A mailbox proven dead by one MSP's send is dead for all of them, because the fact is about the
-- mailbox, not about who was writing to it. Scoping per organisation would let a second
-- organisation re-prove the same dead address and take the same reputation hit to learn what was
-- already known. The cost is real and is stated rather than hidden: two MSPs who genuinely share
-- an address string cannot disagree about it.
--
-- NO EXPIRY AND NO TTL. A hard bounce does not heal on a timer. An expiry would resume sending to
-- a dead mailbox on a schedule, which is the failure this table exists to stop, arriving later
-- and looking like a new problem.
--
-- Idempotent from any starting state, for the reason 20260912120000 learned.

CREATE TABLE IF NOT EXISTS "public"."alert_suppressed_addresses" (
  -- 320 = 64 local + @ + 255 domain, the RFC maximum. Not 400: a longer string is not an address,
  -- and truncating one here would suppress a DIFFERENT address than the one that bounced.
  "address" VARCHAR(320) NOT NULL,
  "reason" VARCHAR(30) NOT NULL,
  -- What the provider said, verbatim. A suppression somebody disagrees with is unarguable without
  -- it, and the person who has to argue is usually the one whose mail stopped.
  "because" VARCHAR(500),
  -- The message that proved it. Null only for MANUAL, which has no send behind it.
  "message_id" VARCHAR(400),
  -- TWO TIMESTAMPS, NOT ONE, and they answer different questions. `first_suppressed_at` is when
  -- we stopped writing to it and must never move, or the age of a suppression is unknowable.
  -- `last_seen_at` moves on every repeat, which is how a still-bouncing address is told from one
  -- that bounced once a year ago and might be worth revisiting.
  "first_suppressed_at" TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "alert_suppressed_addresses_pkey" PRIMARY KEY ("address")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_suppressed_addresses_reason_check') THEN
    ALTER TABLE "public"."alert_suppressed_addresses"
      ADD CONSTRAINT "alert_suppressed_addresses_reason_check"
      CHECK ("reason" IN ('HARD_BOUNCE', 'COMPLAINT', 'MANUAL'));
  END IF;
  -- A machine-made suppression names the send that proved it; a MANUAL one cannot. Without this
  -- an automated write with a null message_id is indistinguishable from a human's, and the first
  -- question asked of any suppression is "what made this happen".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_suppressed_addresses_provenance_check') THEN
    ALTER TABLE "public"."alert_suppressed_addresses"
      ADD CONSTRAINT "alert_suppressed_addresses_provenance_check"
      CHECK (("reason" = 'MANUAL') OR ("message_id" IS NOT NULL));
  END IF;
  -- Ordering, not just presence. A first_suppressed_at after last_seen_at is a clock or a code
  -- defect, and it silently makes every "how long has this been dead" answer negative.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_suppressed_addresses_time_check') THEN
    ALTER TABLE "public"."alert_suppressed_addresses"
      ADD CONSTRAINT "alert_suppressed_addresses_time_check"
      CHECK ("first_suppressed_at" <= "last_seen_at");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "alert_suppressed_addresses_reason_first_suppressed_at_idx"
  ON "public"."alert_suppressed_addresses" ("reason", "first_suppressed_at");

ALTER TABLE "public"."alert_suppressed_addresses" ENABLE ROW LEVEL SECURITY;
