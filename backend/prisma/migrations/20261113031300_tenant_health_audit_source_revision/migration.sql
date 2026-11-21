-- HAW-70 pre-activation writer slice. A changed audit row invalidates a
-- current health pointer in the same transaction as the source write. This
-- migration changes the audit write path and must not deploy alone; the
-- current reader remains inactive until every source and lifecycle is fenced.
-- Transition tables coalesce a bulk statement to one revision per tenant;
-- duplicate rows skipped by ON CONFLICT are absent from the transition table.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_health_invalidate_on_audit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.tenant_health_source_authorities AS authority
       SET source_revision = authority.source_revision + 1,
           current_snapshot_id = NULL,
           current_observation_sequence = 0
      FROM (SELECT DISTINCT organization_id, customer_tenant_id
              FROM audit_new_rows) AS changed
     WHERE authority.organization_id = changed.organization_id
       AND authority.customer_tenant_id = changed.customer_tenant_id
       AND authority.live;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.tenant_health_source_authorities AS authority
       SET source_revision = authority.source_revision + 1,
           current_snapshot_id = NULL,
           current_observation_sequence = 0
      FROM (SELECT DISTINCT organization_id, customer_tenant_id
              FROM audit_old_rows) AS changed
     WHERE authority.organization_id = changed.organization_id
       AND authority.customer_tenant_id = changed.customer_tenant_id
       AND authority.live;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A scope-changing correction must invalidate both source and destination.
    -- No-op updates conservatively invalidate; they cannot retain stale health.
    UPDATE public.tenant_health_source_authorities AS authority
       SET source_revision = authority.source_revision + 1,
           current_snapshot_id = NULL,
           current_observation_sequence = 0
      FROM (SELECT organization_id, customer_tenant_id FROM audit_old_rows
            UNION
            SELECT organization_id, customer_tenant_id FROM audit_new_rows) AS changed
     WHERE authority.organization_id = changed.organization_id
       AND authority.customer_tenant_id = changed.customer_tenant_id
       AND authority.live;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER tenant_health_audit_insert_invalidate
AFTER INSERT ON public.directory_audit_logs
REFERENCING NEW TABLE AS audit_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_audit_change();

CREATE TRIGGER tenant_health_audit_delete_invalidate
AFTER DELETE ON public.directory_audit_logs
REFERENCING OLD TABLE AS audit_old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_audit_change();

CREATE TRIGGER tenant_health_audit_update_invalidate
AFTER UPDATE ON public.directory_audit_logs
REFERENCING OLD TABLE AS audit_old_rows NEW TABLE AS audit_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_audit_change();

REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_audit_change()
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_audit_change()
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_audit_change()
      FROM authenticated;
  END IF;
END $$;
COMMIT;
