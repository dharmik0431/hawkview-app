-- HAW-70 inactive writer slice. A source writer must not silently retain a
-- current health pointer because RLS hides its authority row from an invoker
-- trigger. row_security=off rejects RLS-dependent access; it grants no bypass.
-- Existing owner/bypass writers keep their table privileges and ordinary
-- missing/dead-authority behavior. No grants, policies or function bodies change.
-- Do not deploy this partial protocol or activate its reader independently.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

ALTER FUNCTION public.tenant_health_invalidate_on_audit_change()
  SET row_security = off;
ALTER FUNCTION public.tenant_health_invalidate_on_sync_state_change()
  SET row_security = off;
ALTER FUNCTION public.tenant_health_authorize_on_tenant_insert()
  SET row_security = off;
ALTER FUNCTION public.tenant_health_tombstone_on_tenant_delete()
  SET row_security = off;

COMMIT;
