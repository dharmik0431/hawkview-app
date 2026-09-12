-- The two columns step 03 writes. THEY DID NOT EXIST, and everything referred to them.
--
-- `incident_key` and `episode` appeared in `apply-mapping.ts`, in `alerting-apply.mts` and
-- throughout the runbook, in no migration and not in `schema.prisma`. The failure was
-- delayed and looked like something else: `save-mapping` reads through Prisma and never
-- selects either column, so step 1 SUCCEEDS and writes a mapping file, and step 2 dies with
-- `column "incident_key" does not exist`. An operator following the runbook would get a
-- clean-looking artefact and then a schema error, in that order, and would reasonably
-- suspect the runner rather than the schema.
--
-- THIS MIGRATION IS AN ANNOTATION AND NOTHING ELSE. It adds two nullable columns and one
-- index. It reads no row, writes no row, and deletes nothing. Running it changes no
-- behaviour anywhere: every existing row gets NULL in both columns, which is exactly the
-- state the apply expects to find and exactly the state a revert returns them to.
--
-- WHY CONSOLIDATION IS A COLUMN RATHER THAN FEWER ROWS. `notifications` carries
-- `@@unique([organization_id, dedupe_key])`. Rows sharing an incident would need to share a
-- dedupe key, which that constraint forbids, and merging them would mean deleting rows --
-- which cascades to `notification_user_states` and would silently discard read state. So
-- many rows carry one `incident_key`, and no row is removed.

-- NULLABLE, WITH NO DEFAULT, AND BOTH FACTS ARE LOAD-BEARING.
--
-- Nullable because NULL is the pre-migration state and the post-revert state, and because
-- most rows will hold NULL for a long time: the first apply keys the rows whose key shape
-- determines an alert type -- 44 of 366 today -- and the rest wait on the classifier.
--
-- No default, so a writer that forgets to set the key violates nothing and simply leaves it
-- NULL, which reads as "not keyed" and is true. A default would manufacture membership of
-- an incident nobody assigned.
--
-- Adding a nullable column with no default does not rewrite the table in PostgreSQL 11+, so
-- this is a catalogue change and takes no meaningful lock time. At 366 rows that would not
-- matter either way; it is stated because it stops being true if somebody adds a default in
-- a later edit to this file.
ALTER TABLE "public"."notifications" ADD COLUMN "incident_key" VARCHAR(300);

-- MATCHES `dedupe_key`'s width on purpose. An incident key is built from the same parts as
-- a dedupe key -- organisation, tenant, type, subject -- through `alert-incident-key.ts`'s
-- length-prefixed encoding, so if one fits, so does the other. A narrower column would
-- truncate exactly the long-subject rows that are hardest to notice.

-- The episode ordinal within its incident. NULL where the count could not be recovered --
-- 47 incidents today -- and NULL IS A VALUE HERE, not an absence: it means "this incident
-- holds a row whose event time is gone, so the number of separate bursts is unknowable".
-- It is distinguishable from episode 1, and that distinction is the point. `integer`
-- matches the `::int` cast the apply statement already emits.
ALTER TABLE "public"."notifications" ADD COLUMN "episode" INTEGER;

-- ORGANISATION FIRST, DELIBERATELY.
--
-- The column exists to be grouped by, and every read in this product is scoped to one
-- organisation -- an incident key never spans two, which the verify step asserts. So the
-- composite serves both "the rows of this incident" and "the incidents of this MSP", while
-- an index on `incident_key` alone would serve the first and be useless for the second.
--
-- CONSIDERED AND NOT DONE: a partial index `WHERE incident_key IS NOT NULL`. It would be
-- much smaller -- 44 rows of 366 are keyed today and the ratio stays lopsided until the
-- classifier lands -- and every grouping query filters on non-null, so it would serve all
-- of them. It is not here because Prisma's schema cannot express a partial index, so it
-- would exist only in this file and show up as drift on the next `migrate dev`. A silent
-- schema disagreement is worse than a slightly larger index on a small table. Revisit if
-- this table grows and the ratio stays low.
--
-- Not CONCURRENTLY: Prisma runs a migration inside a transaction and `CREATE INDEX
-- CONCURRENTLY` cannot run in one. At this size the plain form is immediate. If this is
-- ever applied to a table where that is untrue, take the index out of this migration rather
-- than making the whole migration non-transactional.
CREATE INDEX "notifications_organization_id_incident_key_idx"
  ON "public"."notifications" ("organization_id", "incident_key");

-- No GRANT or RLS statement is needed. Privileges and row-level security are table-level
-- here (see 20260909120000_lock_down_public_schema_grants_and_rls), so new columns inherit
-- both, and adding one grants nobody anything they did not already have on this table.
