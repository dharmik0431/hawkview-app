-- HAW-70 inactive protocol slice. TRUNCATE does not run the ordinary DELETE
-- invalidators and cannot establish per-tenant source versions or tombstones.
-- Refuse it even for an owner and in replica mode. Owners can still deliberately
-- disable/drop enforcement; trusted DDL and complete activation proof remain open.
-- This partial migration chain must not deploy or activate its reader alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

CREATE FUNCTION public.tenant_health_refuse_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'TENANT_HEALTH_TRUNCATE_REQUIRES_VERSIONED_DELETE'
    USING ERRCODE = '55000', SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME;
END;
$$;

-- These are the currently participating sources, parents and authority/history.
-- New health inputs need their own complete writer and truncation contract.
CREATE TRIGGER tenant_health_refuse_truncate BEFORE TRUNCATE ON public.directory_audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();
CREATE TRIGGER tenant_health_refuse_truncate BEFORE TRUNCATE ON public.sync_states
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();
CREATE TRIGGER tenant_health_refuse_truncate BEFORE TRUNCATE ON public.customer_tenants
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();
CREATE TRIGGER tenant_health_refuse_truncate BEFORE TRUNCATE ON public.organizations
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();
CREATE TRIGGER tenant_health_refuse_truncate BEFORE TRUNCATE ON public.tenant_health_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();
CREATE TRIGGER tenant_health_refuse_truncate BEFORE TRUNCATE ON public.tenant_health_source_authorities
FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_health_refuse_truncate();

ALTER TABLE public.directory_audit_logs ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;
ALTER TABLE public.sync_states ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;
ALTER TABLE public.customer_tenants ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;
ALTER TABLE public.organizations ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;
ALTER TABLE public.tenant_health_snapshots ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;
ALTER TABLE public.tenant_health_source_authorities ENABLE ALWAYS TRIGGER tenant_health_refuse_truncate;

REVOKE ALL ON FUNCTION public.tenant_health_refuse_truncate() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_refuse_truncate() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.tenant_health_refuse_truncate() FROM authenticated;
  END IF;
END $$;
COMMIT;
