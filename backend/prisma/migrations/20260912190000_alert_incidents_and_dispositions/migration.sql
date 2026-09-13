-- The two tables the launch wiring needs. Both are new; neither touches an existing row.
--
-- `alert_incidents` holds the lifecycle of an incident, once per incident.
-- `alert_rule_dispositions` holds what an MSP considers urgent, per rule.
--
-- TWO GRAINS, TWO QUESTIONS, AND THEY HOLD DIFFERENT FACTS. The organisation answers *what
-- counts as urgent here* -- a policy, because two people in one MSP must not disagree about
-- whether a privileged role grant is urgent. The user answers *how and when I hear about it*,
-- which is personal and already lives on `notification_preferences`. Two places holding the
-- SAME fact is a defect; two places holding DIFFERENT facts is a system.
--
-- IDEMPOTENT FROM ANY STARTING STATE, for the reason the previous migration learned: a
-- half-applied database must be able to converge rather than only fail, or `prisma migrate`
-- records a failed migration and every later one is blocked with P3009 until somebody runs
-- `migrate resolve` by hand.

-- ---------------------------------------------------------------------------------------
-- alert_incidents
-- ---------------------------------------------------------------------------------------
--
-- A PROJECTION OVER `notifications`, NOT A PARENT OF THEM. An incident is the set of rows
-- sharing an `incident_key`; this holds the state of that set. There is deliberately NO foreign
-- key to `notifications` -- nothing cascades in either direction, and an incident row missing
-- for a keyed notification is a reportable gap rather than a broken reference.
--
-- Not columns on `notifications`: an incident spans many rows, so the state would be stored
-- once per row with nothing making the copies agree. Acknowledging would be N writes and a
-- partial failure leaves an incident half-acknowledged with no way to tell.
--
-- Not on `identity_risk_findings`: half the incidents have no finding. Step 03 migrates rows
-- produced by tenant sync and directory audit, which never had one.
CREATE TABLE IF NOT EXISTS "public"."alert_incidents" (
  -- NO DATABASE DEFAULTS ON id OR updated_at, matching every other table here: Prisma generates
  -- the uuid client-side from @default(uuid()) and sets updated_at from @updatedAt. A database
  -- default would be a SECOND writer for the same field, and a raw INSERT would get a timestamp
  -- the application did not set. Caught by `prisma migrate diff`, which reported exactly these
  -- two columns as drift against the model.
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  -- Same width as `notifications.incident_key`, for the same reason: both are built by the
  -- length-prefixed encoder, so if one fits so does the other.
  "incident_key" VARCHAR(300) NOT NULL,
  "alert_type_id" VARCHAR(80) NOT NULL,
  "ownership" VARCHAR(20) NOT NULL,
  "condition" VARCHAR(20) NOT NULL,
  "investigation" VARCHAR(20) NOT NULL,
  -- THREE TIMESTAMPS, ONE PER AXIS, and that is the point of having three axes. A single
  -- `updated_at` collapses "when did the condition last change" and "when was this
  -- acknowledged" into one fact, and they move independently: a cleared condition on an
  -- unacknowledged incident is an ordinary state. Collapsing a pair like this is the failure
  -- this feature has now found in four other places.
  "ownership_at" TIMESTAMPTZ(6) NOT NULL,
  "condition_at" TIMESTAMPTZ(6) NOT NULL,
  "investigation_at" TIMESTAMPTZ(6) NOT NULL,
  "acknowledged_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "alert_incidents_pkey" PRIMARY KEY ("id")
);

-- THE VOCABULARIES ARE ENFORCED HERE RATHER THAN ONLY IN TYPESCRIPT.
--
-- A typo'd state written by a raw query would otherwise read back as a valid-looking string and
-- be routed as neither ACTIVE nor CLEARED -- silently, because nothing compares against a
-- closed set at read time. These are the exact unions from `alert-lifecycle.ts`; if that file
-- gains a state, this constraint must gain it in the same commit, and a migration that forgets
-- will fail loudly on the first write rather than quietly on the tenth read.
--
-- Added separately from CREATE TABLE so re-running is safe: `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`, so each is guarded by a catalogue check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_incidents_ownership_check') THEN
    ALTER TABLE "public"."alert_incidents" ADD CONSTRAINT "alert_incidents_ownership_check"
      CHECK ("ownership" IN ('UNACKNOWLEDGED', 'ACKNOWLEDGED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_incidents_condition_check') THEN
    ALTER TABLE "public"."alert_incidents" ADD CONSTRAINT "alert_incidents_condition_check"
      CHECK ("condition" IN ('ACTIVE', 'CLEARED', 'UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_incidents_investigation_check') THEN
    ALTER TABLE "public"."alert_incidents" ADD CONSTRAINT "alert_incidents_investigation_check"
      CHECK ("investigation" IN ('OPEN', 'RESOLVED', 'NONE'));
  END IF;
  -- TWO FIELDS THAT CAN DISAGREE, MADE UNWRITEABLE. `acknowledged_by` is meaningful exactly
  -- when ownership is ACKNOWLEDGED. Without this an incident can be ACKNOWLEDGED by nobody, or
  -- UNACKNOWLEDGED while naming who acknowledged it, and both read as ordinary rows.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_incidents_acknowledged_by_check') THEN
    ALTER TABLE "public"."alert_incidents" ADD CONSTRAINT "alert_incidents_acknowledged_by_check"
      CHECK (("ownership" = 'ACKNOWLEDGED') = ("acknowledged_by" IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "alert_incidents_organization_id_incident_key_key"
  ON "public"."alert_incidents" ("organization_id", "incident_key");

-- The queue read: this MSP's incidents that still need somebody, newest condition first.
CREATE INDEX IF NOT EXISTS "alert_incidents_organization_id_ownership_condition_at_idx"
  ON "public"."alert_incidents" ("organization_id", "ownership", "condition_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_incidents_organization_id_fkey') THEN
    ALTER TABLE "public"."alert_incidents" ADD CONSTRAINT "alert_incidents_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------
-- alert_rule_dispositions
-- ---------------------------------------------------------------------------------------
--
-- NOTHING IS SEEDED, AND THAT IS FORCED RATHER THAN LAZY. `defaultPreferenceFor` derives the
-- default FROM THE DECLARED SEVERITY, in its own words "so the default cannot drift from the
-- tiering the catalogue already states". Seeding twenty rows per organisation would copy a
-- derived value into storage, and the copies would disagree with the catalogue the first time a
-- severity changed -- which is the exact drift that comment exists to prevent.
--
-- So ABSENCE MEANS THE DERIVED DEFAULT, and a row exists only where an MSP has overridden it.
-- A consequence worth knowing: the table is empty on day one and that is correct, not a failed
-- seed.
CREATE TABLE IF NOT EXISTS "public"."alert_rule_dispositions" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  -- **`alert_type_id`, BECAUSE THAT IS WHAT THE PIPELINE LOOKS IT UP BY.** This column was called
  -- `rule_id` and the name lied: `finding-pipeline.ts` keys the lookup on the ALERT TYPE id, so a
  -- disposition stored as `HV-ID-AUTH-010.v1` — which is what any author reading the old name
  -- would store — was **silently ignored and the email went anyway**. The row existed, the write
  -- succeeded, the MSP saw their choice saved, and nothing changed. A correct writer and a
  -- correct reader disagreeing about the key, with no error anywhere.
  --
  -- Renamed while this table has never been deployed. One edit today against a production
  -- migration plus a live settings bug later — the same asymmetry as the incident_key widening,
  -- and the same answer.
  --
  -- ⚠ THE RENAME DOES NOT SOLVE THE THING THE VAGUE NAME WAS HIDING, and must not look as
  -- though it has. The reason the name was loose is a real future: a grain FINER than the alert
  -- type. Five of the seven types currently use the type as their own grain, and the routing
  -- document warns that the first finer rule added under one of them collapses invisibly. If
  -- that day comes it needs **its own column and a discriminator** — not this one overloaded
  -- with two kinds of id, which is the two-homes defect this feature has now fixed three times.
  --
  -- 120 rather than the catalogue's 80 is kept: it costs nothing and leaves room for the id
  -- namespace to grow without a second migration on a table an MSP's settings live in.
  "alert_type_id" VARCHAR(120) NOT NULL,
  "disposition" VARCHAR(20) NOT NULL,
  "set_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "alert_rule_dispositions_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  -- **THE DISPOSITION IS THE TIER, NOT THE CHANNEL.** It held
  -- `RING | EMAIL | DIGEST | RECORD_ONLY` — a `DeliveryPreference`, which is HOW somebody is
  -- reached. It now holds `ACT_NOW | ACT_TODAY | RECORD_ONLY`, the catalogue's `Severity`, which
  -- is HOW URGENT this is here.
  --
  -- The reasoning: the organisation answers *what counts as urgent for us*, and the product
  -- answers *how we reach you about something that urgent* — `defaultPreference` already maps
  -- tier to channel, so storing the channel put the second answer in the MSP's hands and left
  -- the first unsayable. It also meant the catalogue's declared severity and the stored
  -- disposition were two vocabularies for one judgement, with a mapping between them.
  --
  -- ⚠ `RECORD_ONLY` IS IN BOTH VOCABULARIES, WHICH IS WHY THIS CHANGE IS DANGEROUS TO DO HALF.
  -- Every test that exercises "off" passes under either spelling, so a half-migrated system looks
  -- healthy on exactly the case everybody checks and is wrong on RING, EMAIL and DIGEST. Changed
  -- in one place, in this migration, while the table has never been deployed anywhere.
  --
  -- DIGEST HAS NO TIER, AND THAT IS A LOSS. An MSP can no longer say "batch these for me"; it
  -- can say how urgent they are and the product decides the channel. Recorded rather than
  -- discovered: if digesting returns it is a delivery preference belonging beside quiet hours,
  -- not a fourth urgency.
  --
  -- THERE IS STILL NO 'OFF'. An MSP may choose not to be DELIVERED to; it may not choose for the
  -- thing not to be recorded. RECORD_ONLY remains the quietest value that exists.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rule_dispositions_disposition_check') THEN
    ALTER TABLE "public"."alert_rule_dispositions" ADD CONSTRAINT "alert_rule_dispositions_disposition_check"
      CHECK ("disposition" IN ('ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rule_dispositions_organization_id_fkey') THEN
    ALTER TABLE "public"."alert_rule_dispositions" ADD CONSTRAINT "alert_rule_dispositions_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "alert_rule_dispositions_organization_id_alert_type_id_key"
  ON "public"."alert_rule_dispositions" ("organization_id", "alert_type_id");

-- ---------------------------------------------------------------------------------------
-- Row-level security, matching what every other table in this schema has.
-- ---------------------------------------------------------------------------------------
--
-- 20260909120000 enabled RLS on every table then present. A new table without it is a hole in
-- that lockdown, and the hole is invisible: nothing fails, the table is simply readable by a
-- role the others are closed to.
ALTER TABLE "public"."alert_incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."alert_rule_dispositions" ENABLE ROW LEVEL SECURITY;

-- RUNNING THIS TWICE IS SAFE FROM ANY STARTING STATE: clean, fully applied, or half-applied by
-- hand. Every object is created with IF NOT EXISTS or guarded by a catalogue check, and
-- ENABLE ROW LEVEL SECURITY is idempotent by definition.
