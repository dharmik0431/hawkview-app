-- HAW-70 inactive writer slice. Every newly inserted tenant receives a private
-- source authority in the same transaction. Reusing a deleted tenant ID starts
-- a fresh incarnation and cannot revive an old current-health pointer.
-- Historical tenants missed between the one-time backfill and this trigger
-- still need a separate locked reconciliation before reader activation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_health_authorize_on_tenant_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.tenant_health_source_authorities
    (organization_id, customer_tenant_id, incarnation, source_revision,
     live, current_snapshot_id, current_observation_sequence)
  VALUES
    (NEW.organization_id, NEW.id, gen_random_uuid(), 1, true, NULL, 0)
  ON CONFLICT (organization_id, customer_tenant_id) DO UPDATE
    SET incarnation = gen_random_uuid(),
        source_revision = public.tenant_health_source_authorities.source_revision + 1,
        live = true,
        current_snapshot_id = NULL,
        current_observation_sequence = 0;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_health_authorize_on_tenant_insert
AFTER INSERT ON public.customer_tenants
FOR EACH ROW
EXECUTE FUNCTION public.tenant_health_authorize_on_tenant_insert();

REVOKE ALL ON FUNCTION public.tenant_health_authorize_on_tenant_insert()
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_authorize_on_tenant_insert()
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_authorize_on_tenant_insert()
      FROM authenticated;
  END IF;
END $$;
COMMIT;
