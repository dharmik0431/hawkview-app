-- Inactive persistence contract for a future tenant-wide SYNC visit fence.
-- No application path acquires or publishes a visit lease in this candidate.
CREATE TABLE "tenant_sync_visit_leases" (
  "customer_tenant_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "owner_token" UUID,
  "generation" BIGINT NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_sync_visit_leases_pkey" PRIMARY KEY ("customer_tenant_id", "organization_id"),
  CONSTRAINT "tenant_sync_visit_leases_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "tenant_sync_visit_leases_owner_expiry_check"
    CHECK (("owner_token" IS NULL) = ("expires_at" IS NULL)),
  CONSTRAINT "tenant_sync_visit_leases_customer_tenant_id_organization_id_fkey"
    FOREIGN KEY ("customer_tenant_id", "organization_id")
    REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The backend table owner retains access; public-schema readers receive none.
ALTER TABLE "tenant_sync_visit_leases" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "tenant_sync_visit_leases" FROM PUBLIC;
DO $$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.tenant_sync_visit_leases FROM %I', target_role);
    END IF;
  END LOOP;
END
$$;
