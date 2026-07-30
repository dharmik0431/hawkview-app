ALTER TABLE "directory_users"
ADD COLUMN "assigned_license_sku_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The users delta checkpoint was created before assignedLicenses was selected.
-- Reset it once so the next sync performs a complete, correctly shaped read.
UPDATE "sync_states"
SET "delta_link" = NULL
WHERE "resource_type" = 'USERS';
