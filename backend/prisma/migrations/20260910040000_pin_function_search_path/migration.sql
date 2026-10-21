-- Pin search_path on the identity-risk trigger guards, and drop the PUBLIC
-- EXECUTE left over from the public schema lockdown.
--
-- These three functions had a role-mutable search_path (Supabase advisor WARN).
-- For `identity_risk_wrapped_key_guard` that is not cosmetic: it resolves
-- `identity_risk_pseudonym_key_versions` unqualified three times, so a caller
-- who put their own schema earlier in search_path could point the scope check
-- at a table they control and satisfy the guard with forged rows. The other two
-- only compare OLD/NEW fields, but are pinned for the same reason.
--
-- `SET search_path = ''` is the strong form: nothing is resolved implicitly, so
-- every reference is qualified below. pg_catalog is still searched implicitly,
-- which is what keeps COALESCE, CURRENT_TIMESTAMP and `||` working. Dropping
-- pg_temp from the path is a bonus -- it removes temp-table shadowing.
--
-- Bodies are otherwise byte-for-byte what they were. The only edits are the
-- `public.` qualifications in the wrapped-key guard. `status` and `provider`
-- are VARCHAR with CHECK constraints rather than enums, so the string literal
-- comparisons need no type resolution and are unaffected.
--
-- CREATE OR REPLACE keeps each function's OID, so the existing triggers stay
-- bound to it and no trigger is recreated.

CREATE OR REPLACE FUNCTION public.identity_risk_key_identity_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF ROW(OLD.id, OLD.organization_id, OLD.customer_tenant_id, OLD.environment, OLD.provider, OLD.immutable_key_id)
     IS DISTINCT FROM ROW(NEW.id, NEW.organization_id, NEW.customer_tenant_id, NEW.environment, NEW.provider, NEW.immutable_key_id) THEN
    RAISE EXCEPTION 'Identity risk key identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_risk_key_no_reactivation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (OLD.status <> 'ACTIVE' AND NEW.status='ACTIVE') OR (OLD.destroyed_at IS NOT NULL AND NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at) THEN
    RAISE EXCEPTION 'Retired or destroyed key cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_risk_wrapped_key_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE k public.identity_risk_pseudonym_key_versions;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Wrapped key is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    UPDATE public.identity_risk_pseudonym_key_versions SET status='DISABLED', retired_at=COALESCE(retired_at,CURRENT_TIMESTAMP), destroyed_at=CURRENT_TIMESTAMP WHERE id=OLD.key_version_id;
    RETURN OLD;
  END IF;
  SELECT * INTO k FROM public.identity_risk_pseudonym_key_versions WHERE id=NEW.key_version_id FOR UPDATE;
  IF k.id IS NULL OR k.provider <> 'WRAPPED_AES_GCM_V1' OR k.status <> 'ACTIVE' OR k.destroyed_at IS NOT NULL OR
     NEW.name <> ('risk-wrapped:v1:' || k.environment || ':' || k.organization_id || ':' || k.customer_tenant_id || ':' || k.id) OR NEW.name <> k.immutable_key_id THEN
    RAISE EXCEPTION 'Wrapped key scope unavailable';
  END IF;
  RETURN NEW;
END;
$$;

-- The lockdown migration revoked anon/authenticated, but PUBLIC kept EXECUTE,
-- and PUBLIC covers those roles anyway -- so the earlier revoke only really
-- bites once this lands. Trigger execution does not re-check EXECUTE at fire
-- time (it is checked when the trigger is created), and the API connects as the
-- owner, which holds EXECUTE implicitly. Safe to remove.
--
-- CREATE OR REPLACE above preserves each function's ACL, so this has to run
-- after it, not before.
REVOKE ALL PRIVILEGES ON FUNCTION public.identity_risk_key_identity_immutable() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.identity_risk_key_no_reactivation() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.identity_risk_wrapped_key_guard() FROM PUBLIC;
