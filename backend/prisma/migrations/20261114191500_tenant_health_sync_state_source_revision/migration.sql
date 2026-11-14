-- HAW-70 unpublished writer slice. Installing this migration changes every
-- sync-state writer, including old processes; do not deploy the partial package.
-- It does not activate the health reader or extend any reconciliation receipt.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_health_invalidate_on_sync_state_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  changed record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- One lock at a time in the same scope order, including both ends of moves.
    FOR changed IN
      SELECT DISTINCT organization_id, customer_tenant_id FROM sync_state_new_rows
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
      SELECT DISTINCT organization_id, customer_tenant_id FROM sync_state_old_rows
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
      SELECT organization_id, customer_tenant_id FROM sync_state_old_rows
      UNION SELECT organization_id, customer_tenant_id FROM sync_state_new_rows
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

CREATE TRIGGER tenant_health_sync_state_insert_invalidate
AFTER INSERT ON public.sync_states
REFERENCING NEW TABLE AS sync_state_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_sync_state_change();

CREATE TRIGGER tenant_health_sync_state_delete_invalidate
AFTER DELETE ON public.sync_states
REFERENCING OLD TABLE AS sync_state_old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_sync_state_change();

CREATE TRIGGER tenant_health_sync_state_update_invalidate
AFTER UPDATE ON public.sync_states
REFERENCING OLD TABLE AS sync_state_old_rows NEW TABLE AS sync_state_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_invalidate_on_sync_state_change();

REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_sync_state_change() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_sync_state_change() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_invalidate_on_sync_state_change() FROM authenticated;
  END IF;
END $$;
COMMIT;
