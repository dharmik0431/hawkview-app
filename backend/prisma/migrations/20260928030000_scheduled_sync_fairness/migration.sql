-- Admission bookkeeping only: never change collection/evidence timestamps.
-- Existing and newly onboarded tenants start ahead of previously considered
-- tenants. Finite opportunity assumes bounded arrivals, not an infinite influx.
CREATE SEQUENCE "scheduled_sync_position_seq" AS BIGINT NO CYCLE;
ALTER TABLE "customer_tenants"
  ADD COLUMN "scheduled_sync_position" BIGINT NOT NULL DEFAULT 0;
ALTER SEQUENCE "scheduled_sync_position_seq"
  OWNED BY "customer_tenants"."scheduled_sync_position";
CREATE INDEX "customer_tenants_scheduled_sync_position_id_idx"
  ON "customer_tenants" ("scheduled_sync_position", "id");
