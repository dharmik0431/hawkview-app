-- HAW-70 unpublished snapshot writer slice. Installing this migration changes
-- AUTH_REGISTRATIONS and RISKY_USERS writes, including old processes. Do not deploy
-- this partial package. This resource set matches the current saved-health inputs.
-- It does not activate the health reader or extend any reconciliation receipt.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_health_invalidate_on_input_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
SET row_security = off
AS $$
DECLARE
  changed record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- One lock at a time in the same scope order, including both ends of moves.
    FOR changed IN
      SELECT DISTINCT organization_id, customer_tenant_id FROM health_input_snapshot_new_rows
      WHERE resource_type IN ('AUTH_REGISTRATIONS', 'RISKY_USERS')
      ORDER BY organization_id, customer_tenant_id
    LOOP
      UPDATE public.tenant_health_source_authorities AS authority
         SET source_revision = authority.source_revision + 1,
             current_snapshot_id = NULL,
             current_observation_sequence = 0
       WHERE authority.organization_id = changed.organization_id
         AND authority.customer_tenant_id = changed.customer_tenant_id
         AND authority.live;
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    -- One lock at a time in the same scope order, including both ends of moves.
    FOR changed IN
      SELECT DISTINCT organization_id, customer_tenant_id FROM health_input_snapshot_old_rows
      WHERE resource_type IN ('AUTH_REGISTRATIONS', 'RISKY_USERS')
      ORDER BY organization_id, customer_tenant_id
    LOOP
      UPDATE public.tenant_health_source_authorities AS authority
         SET source_revision = authority.source_revision + 1,
             current_snapshot_id = NULL,
             current_observation_sequence = 0
       WHERE authority.organization_id = changed.organization_id
         AND authority.customer_tenant_id = changed.customer_tenant_id
         AND authority.live;
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    -- One lock at a time in the same scope order, including both ends of moves.
    FOR changed IN
      SELECT organization_id, customer_tenant_id FROM health_input_snapshot_old_rows
      WHERE resource_type IN ('AUTH_REGISTRATIONS', 'RISKY_USERS')
      UNION SELECT organization_id, customer_tenant_id FROM health_input_snapshot_new_rows
      WHERE resource_type IN ('AUTH_REGISTRATIONS', 'RISKY_USERS')
      ORDER BY organization_id, customer_tenant_id
    LOOP
      UPDATE public.tenant_health_source_authorities AS authority
         SET source_revision = authority.source_revision + 1,
             current_snapshot_id = NULL,
             current_observation_sequence = 0
       WHERE authority.organization_id = changed.organization_id
         AND authority.customer_tenant_id = changed.customer_tenant_id
         AND authority.live;
    END LOOP;
  END IF;
  -- Missing/dead authority stays untrusted. Overflow fails the source transaction.
  RETURN NULL;
END;
$$;

CREATE TRIGGER tenant_health_input_snapshot_insert_invalidate
AFTER INSERT ON public.tenant_entra_snapshots
REFERENCING NEW TABLE AS health_input_snapshot_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_input_snapshot_change();

CREATE TRIGGER tenant_health_input_snapshot_delete_invalidate
AFTER DELETE ON public.tenant_entra_snapshots
REFERENCING OLD TABLE AS health_input_snapshot_old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_input_snapshot_change();

CREATE TRIGGER tenant_health_input_snapshot_update_invalidate
AFTER UPDATE ON public.tenant_entra_snapshots
REFERENCING OLD TABLE AS health_input_snapshot_old_rows NEW TABLE AS health_input_snapshot_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_input_snapshot_change();

REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_input_snapshot_change() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_input_snapshot_change() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_input_snapshot_change() FROM authenticated;
  END IF;
END $$;
-- TRUNCATE has no row transition set: refuse the entire mixed-resource table.
-- Reuse the existing invoker guard and preserve refusal in replica mode.
CREATE TRIGGER tenant_health_refuse_truncate
BEFORE TRUNCATE ON public.tenant_entra_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();
ALTER TABLE public.tenant_entra_snapshots
  ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;
COMMIT;
