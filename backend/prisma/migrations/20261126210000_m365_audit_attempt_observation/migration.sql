-- HAW-75 bounded current-attempt budget-refusal observation.
--
-- Additive and nullable: every existing row stays valid and reads as UNKNOWN,
-- which is deliberately not a receipt that no budget block exists. The column
-- is read only for M365_AUDIT rows and holds a versioned envelope with a
-- durable attempt token, the attempt time, and at most one closed refusal
-- observation belonging to that same attempt. No index is added: the only
-- reader is the already-scoped sync-state load for one tenant, so no new
-- lookup path exists to support.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE "sync_states" ADD COLUMN "m365_audit_attempt" JSONB;

COMMIT;
