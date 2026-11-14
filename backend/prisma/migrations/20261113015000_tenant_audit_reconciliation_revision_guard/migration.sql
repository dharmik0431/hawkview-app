-- Inactive audit-reentry ledger invariant. No application path uses this
-- table yet; a future owner-checked writer must not erase unfinished work.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_audit_reconciliation_revision_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.requested_revision < OLD.requested_revision
     OR NEW.completed_revision < OLD.completed_revision THEN
    RAISE EXCEPTION 'audit reconciliation revisions cannot decrease'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tenant_audit_reconciliation_revision_monotonic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_audit_reconciliation_revision_monotonic
BEFORE UPDATE ON public.tenant_audit_reconciliation_work
FOR EACH ROW
EXECUTE FUNCTION public.tenant_audit_reconciliation_revision_monotonic();

REVOKE ALL ON FUNCTION public.tenant_audit_reconciliation_revision_monotonic()
  FROM PUBLIC;
DO $$
DECLARE target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.tenant_audit_reconciliation_revision_monotonic() FROM %I',
        target_role);
    END IF;
  END LOOP;
END
$$;
COMMIT;
