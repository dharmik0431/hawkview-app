-- HAW-70 inactive source-authority writer slice. Tenant deletion must
-- invalidate the exact current pointer before dependent history cascades.
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
  UPDATE public.tenant_health_source_authorities
     SET source_revision = source_revision + 1,
         live = false,
         current_snapshot_id = NULL,
         current_observation_sequence = 0
   WHERE organization_id = OLD.organization_id
     AND customer_tenant_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER tenant_health_tombstone_on_tenant_delete
BEFORE DELETE ON public.customer_tenants
FOR EACH ROW
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
