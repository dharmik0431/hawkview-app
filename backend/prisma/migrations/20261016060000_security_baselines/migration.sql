-- MSP-owned choices and one explicit assignment per tenant. Application API
-- enforces membership; these tables are not exposed to Supabase Data API.
CREATE TABLE "security_baselines" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "name" varchar(100) NOT NULL,
  "check_ids" text[] NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_baselines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "security_baselines_organization_id_name_key" UNIQUE ("organization_id", "name"),
  CONSTRAINT "security_baselines_id_organization_id_key" UNIQUE ("id", "organization_id"),
  CONSTRAINT "security_baselines_checks_nonempty" CHECK (cardinality("check_ids") BETWEEN 1 AND 20)
);

CREATE TABLE "tenant_security_baseline_assignments" (
  "customer_tenant_id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "baseline_id" uuid NOT NULL,
  "assigned_by_user_id" uuid NOT NULL,
  "assigned_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_baseline_assignment_scope_key" UNIQUE ("customer_tenant_id", "organization_id"),
  CONSTRAINT "tenant_security_baseline_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "tenant_baseline_assignment_tenant_scope_fkey" FOREIGN KEY ("customer_tenant_id", "organization_id") REFERENCES "customer_tenants"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "tenant_baseline_assignment_baseline_scope_fkey" FOREIGN KEY ("baseline_id", "organization_id") REFERENCES "security_baselines"("id", "organization_id") ON DELETE RESTRICT
);
CREATE INDEX "tenant_security_baseline_assignments_organization_id_baseline_id_idx" ON "tenant_security_baseline_assignments"("organization_id", "baseline_id");

ALTER TABLE "security_baselines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_security_baseline_assignments" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "security_baselines", "tenant_security_baseline_assignments" FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON security_baselines, tenant_security_baseline_assignments FROM %I', target_role);
    END IF;
  END LOOP;
END $$;
