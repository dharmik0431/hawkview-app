-- HAW-70 inactive source-authority writer slice. Tombstone after the tenant's
-- row-level FK cascades so an audit UPDATE/DELETE cannot hold an audit row
-- while waiting for authority already locked by tenant deletion. The exact
-- pointer is cleared in the same tenant-delete statement and transaction.
-- Other health sources and the current reader remain unwired.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_health_tombstone_on_tenant_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.tenant_health_source_authorities AS authority
     SET source_revision = authority.source_revision + 1,
         live = false,
         current_snapshot_id = NULL,
         current_observation_sequence = 0
    FROM (SELECT DISTINCT organization_id, id FROM tenant_deleted_rows) AS deleted
   WHERE authority.organization_id = deleted.organization_id
     AND authority.customer_tenant_id = deleted.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER tenant_health_tombstone_on_tenant_delete
AFTER DELETE ON public.customer_tenants
REFERENCING OLD TABLE AS tenant_deleted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tenant_health_tombstone_on_tenant_delete();

REVOKE ALL ON FUNCTION public.tenant_health_tombstone_on_tenant_delete()
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_tombstone_on_tenant_delete()
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_tombstone_on_tenant_delete()
      FROM authenticated;
  END IF;
END $$;
COMMIT;
