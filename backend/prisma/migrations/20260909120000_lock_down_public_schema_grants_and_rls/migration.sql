-- P0 security lockdown for the `public` schema.
--
-- Background: every table in `public` carried full DML privileges for the
-- Supabase `anon` and `authenticated` roles, and 38 of 42 tables had row level
-- security disabled. Because the browser bundle ships the publishable/anon key,
-- anyone could read and write every row in every table through PostgREST
-- (`/rest/v1`) without authenticating. This migration closes that by hand at
-- both layers: it removes the grants, and it turns RLS on with no policies.
--
-- Why this is safe for the API: the NestJS backend connects with Prisma over
-- `DATABASE_URL` as `postgres`, which owns all 42 tables and additionally holds
-- BYPASSRLS. It never uses PostgREST. Table owners are exempt from RLS unless
-- the table is switched to FORCE ROW LEVEL SECURITY, so these statements
-- deliberately use ENABLE and never FORCE. The same deny-all shape is already
-- running in production on the four identity_risk cursor tables.
--
-- Supabase Auth is untouched: it lives in the `auth` schema, which this
-- migration never references.
--
-- Deliberately NOT done here: no policies are created. The backend does not
-- need them and each one would be new attack surface. Deny-all is the target.

-- Each ALTER TABLE below needs a brief ACCESS EXCLUSIVE lock. The changes
-- themselves are catalog-only and effectively instant, but the *wait* for a
-- lock is not bounded by default, and a migration that queues behind a slow
-- query would stall every later query on that table. Fail fast instead: Render
-- restarts the container and reruns the migration, so a timeout is self-healing
-- while a lock pile-up on a live database is not.
SET lock_timeout = '5s';

-- 1. Remove the anon/authenticated privileges, and stop future objects from
--    silently re-granting them.
--
--    The role guard matters: CI applies these migrations to a stock
--    `postgres:16-alpine` service where `anon` and `authenticated` do not
--    exist, and a bare REVOKE would abort the run. ALTER DEFAULT PRIVILEGES is
--    issued without FOR ROLE so it rewrites the default ACL of the role running
--    the migration -- `postgres` in this project, which is the role Prisma
--    creates new tables as.
DO $$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', target_role);
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', target_role);

      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I', target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I', target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I', target_role);
    END IF;
  END LOOP;
END
$$;

-- 2. Deny-all RLS on every table that was missing it. ENABLE on an
--    already-enabled table is a no-op, so this stays re-runnable.
ALTER TABLE "public"."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."change_evidence_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customer_tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."directory_audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."directory_group_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."directory_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."directory_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."encrypted_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_evaluation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_findings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_key_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_matched_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_operational_controls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_operational_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_pseudonym_key_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_rule_coverage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."identity_risk_wrapped_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."m365_activity_contents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."m365_activity_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."m365_audit_daily_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."m365_audit_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."microsoft_consent_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notification_user_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."platform_microsoft_connectors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sign_in_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sync_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_collection_field_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_entra_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_health_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_licenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workspace_admin_audit_logs" ENABLE ROW LEVEL SECURITY;
