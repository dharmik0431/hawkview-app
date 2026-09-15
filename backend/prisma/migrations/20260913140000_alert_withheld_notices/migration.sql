-- PER-FINDING SUPPRESSION HISTORY, because nothing else could carry it.
--
-- THE RULING: retain evidence and inspectable history, but suppress active notifications, unread
-- bell counts, and email; RE-ENABLING MUST NOT REPLAY SUPPRESSED HISTORY. The second half needs a
-- fact that no existing row holds: was THIS finding withheld because its type was record-only at
-- the time it was handled.
--
-- TWO ATTEMPTS INFERRED IT FROM A ROW THAT IS NOT ABOUT THE FINDING, and both were wrong the same
-- way.
--   1. Incident state. Once an incident is open, that is true forever, so genuinely new evidence
--      on an incident somebody is working was silenced with the backlog. Confirmed by a failing
--      test at c4bae87.
--   2. A timestamp comparison -- disposition.updated_at against finding.observed_at. `updated_at`
--      moves on ANY edit to that row, so ACT_NOW -> ACT_TODAY looks like a record-only transition;
--      and `observed_at` is when the event happened, not when it was ingested, so delayed
--      ingestion and retries cross the boundary in the wrong direction.
-- The fact is per finding, so it is recorded per finding, WHEN THE DECISION IS MADE rather than
-- reconstructed afterwards from something adjacent.
--
-- KEYED LIKE `notifications` ON PURPOSE: (organization_id, dedupe_key), the same grain, because a
-- finding's notification dedupe key is the identity being decided about. The gate then reads both
-- tables at one key -- notified, withheld, or neither, and "neither" is exactly what "new, tell
-- somebody" means -- with no arithmetic on time anywhere in it.
--
-- THE UNIQUE INDEX BELOW DOES NOT MAKE THE TWO OUTCOMES MUTUALLY EXCLUSIVE, and an earlier draft
-- of this header claimed it did. It prevents duplicates WITHIN this table and says nothing about
-- the pair; a constraint spanning two tables is not expressible here. Two overlapping ticks whose
-- dispositions differ between their reads can write one of each -- measured, not supposed. The
-- gate survives it by UNIONing the two tables rather than consulting them in an order, so a
-- finding in either is decided and the answer cannot depend on which landed first.
--
-- A REASON, NOT A BOOLEAN. `withheld because something went wrong` and `withheld because the MSP
-- silenced this type` must not be the same row. The CHECK admits only reasons that are a
-- deliberate product decision; a future reason is a migration, which is the point.
CREATE TABLE "alert_withheld_notices" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID         NOT NULL,
  -- Matches notifications.dedupe_key exactly, including its 300 characters, so the two can be
  -- compared without truncating one side into the other.
  "dedupe_key"      VARCHAR(300) NOT NULL,
  "alert_type_id"   VARCHAR(80)  NOT NULL,
  -- Provenance. The dedupe key identifies the decision; this says which row produced it, so an
  -- operator asking "why is this silent" can reach the evidence rather than infer it.
  "finding_id"      UUID         NOT NULL,
  "because"         VARCHAR(40)  NOT NULL,
  "withheld_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "alert_withheld_notices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alert_withheld_notices_because_check" CHECK ("because" IN ('RECORD_ONLY')),
  CONSTRAINT "alert_withheld_notices_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ONE DECISION PER FINDING PER ORGANISATION. A second tick reaching the same finding must find
-- the existing row rather than write another, and the scope makes case 6 -- another organisation
-- cannot suppress or expose this evidence -- true by the key rather than by a WHERE clause
-- somebody has to remember.
CREATE UNIQUE INDEX "alert_withheld_notices_scope_key"
  ON "alert_withheld_notices" ("organization_id", "dedupe_key");
