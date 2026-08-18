-- Nullable preserves existing rows as "not yet authoritatively collected".
ALTER TABLE "tenant_licenses" ADD COLUMN "service_plans" JSONB;
