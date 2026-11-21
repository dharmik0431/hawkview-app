-- Inactive foundation for owner-checked audit-triggered inventory replay.
-- No current application path enqueues, reads or completes these rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE "tenant_audit_reconciliation_work" (
  "organization_id" UUID NOT NULL,
  "customer_tenant_id" UUID NOT NULL,
  "resource_type" "SyncResourceType" NOT NULL,
  "requested_revision" BIGINT NOT NULL DEFAULT 1,
  "completed_revision" BIGINT NOT NULL DEFAULT 0,
  "last_completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_audit_reconciliation_work_pkey"
    PRIMARY KEY ("organization_id", "customer_tenant_id", "resource_type"),
  CONSTRAINT "tenant_audit_reconciliation_work_revision_check"
    CHECK ("requested_revision" >= 1 AND "completed_revision" >= 0
       AND "completed_revision" <= "requested_revision"),
  CONSTRAINT "tenant_audit_reconciliation_work_resource_check"
    CHECK ("resource_type" IN (
      'ORGANIZATION_CONFIGURATION', 'GROUPS', 'LICENSES', 'DOMAINS',
      'DOMAIN_DNS_HEALTH', 'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES',
      'CONDITIONAL_ACCESS', 'NAMED_LOCATIONS', 'DEVICES', 'DIRECTORY_ROLES',
      'SERVICE_PRINCIPALS', 'APPLICATIONS', 'SECURITY_DEFAULTS',
      'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE',
      'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES', 'SHAREPOINT_SITES',
      'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE'
    )),
  CONSTRAINT "tenant_audit_reconciliation_work_tenant_scope_fkey"
    FOREIGN KEY ("customer_tenant_id", "organization_id")
    REFERENCES "customer_tenants"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "tenant_audit_reconciliation_work" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "tenant_audit_reconciliation_work" FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.tenant_audit_reconciliation_work FROM %I',
        target_role);
    END IF;
  END LOOP;
END
$$;
COMMIT;
