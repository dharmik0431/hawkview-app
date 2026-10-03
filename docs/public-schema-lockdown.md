# Public schema lockdown (PostgREST exposure)

## What was wrong

The Supabase `public` schema was readable and writable by anyone on the internet.

Three things combined:

1. `anon` and `authenticated` held `SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
   REFERENCES, TRIGGER` on all 42 tables — 588 grants in total.
2. Row level security was disabled on 38 of those 42 tables.
3. The console ships the Supabase publishable/anon key to the browser, so the
   key is public by design.

Anyone could pull the key out of the JS bundle and call `/rest/v1` directly.
Verified before the fix: `GET /rest/v1/users`, `/customer_tenants` and
`/encrypted_secrets` all returned `200` with real rows, unauthenticated, with
both the anon and the publishable key.

Eight tenant-isolation milestones had shipped before this was caught. All of
them enforce isolation in the API layer. Nothing tested the database directly,
so the canary stayed green while the database was wide open.

## The fix

`backend/prisma/migrations/20260909120000_lock_down_public_schema_grants_and_rls`

- Revokes all `anon` / `authenticated` privileges on tables, sequences and
  functions in `public`.
- Rewrites the default privileges so newly created tables do not silently
  re-grant them. This is the part that would otherwise quietly regress.
- Enables row level security, with **no policies**, on the 38 tables that were
  missing it. Deny-all is the target state.

`service_role` is deliberately left intact (294 grants).

## Why this does not affect the API

The backend connects with Prisma over `DATABASE_URL` as `postgres`. That role
owns all 42 tables and additionally holds `BYPASSRLS`. It never talks to
PostgREST. Table owners are exempt from RLS unless the table is switched to
`FORCE ROW LEVEL SECURITY`, which this migration never does.

The same deny-all shape was already running in production on the four
`identity_risk_*` cursor tables before this change, which is what made the
pattern safe to generalise.

Supabase Auth is untouched — it lives in the `auth` schema, which the migration
never references. Sign-in, sign-up and password recovery are unaffected.

## Rollback

Metadata only. No rows are read, written or moved, so this reverts cleanly.

```sql
BEGIN;

-- Restore the grants exactly as they were (relacl was uniformly
-- postgres/anon/authenticated/service_role = arwdDxtm on all 42 tables).
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;

-- Turn RLS back off on the 38 tables this migration enabled, leaving the four
-- identity_risk cursor tables enabled as they were before.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname NOT IN (
        'identity_risk_scheduler_cursors', 'identity_risk_attempt_heads',
        'identity_risk_history_cursors', 'identity_risk_history_tenant_cursors')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

COMMIT;
```

Then delete the migration row so Prisma does not consider it applied:

```sql
DELETE FROM _prisma_migrations
WHERE migration_name = '20260909120000_lock_down_public_schema_grants_and_rls';
```

Rolling back restores the exposure. It is a break-glass step, not a fix.

## Guardrail

`backend/src/prisma/public-schema-lockdown.database-integration.test.ts` asserts
the end state: every table in `public` has RLS on, none uses `FORCE`, there are
zero policies, `anon`/`authenticated` hold zero privileges, and default
privileges grant them nothing. The `FORCE` assertion is the important one — it
is the single change that would lock the API out of its own tables.

## Known residue

- ~~`PUBLIC` retains `EXECUTE` on the three `identity_risk_*` trigger
  functions.~~ Closed by `20260910040000_pin_function_search_path`, which
  revokes it alongside pinning `search_path`. `service_role` keeps `EXECUTE`.
- `anon` / `authenticated` keep `USAGE` on the `public` schema, which `PUBLIC`
  also holds via `pg_database_owner`. Worthless without object privileges.
- A second default-ACL entry for `public` is owned by `supabase_admin`. It only
  applies to objects that `supabase_admin` creates; Prisma creates as `postgres`.

## Function hardening (follow-up, landed separately)

`backend/prisma/migrations/20260910040000_pin_function_search_path`

The three `identity_risk_*` trigger guards ran with a role-mutable
`search_path`. For `identity_risk_wrapped_key_guard` that was not cosmetic: it
resolved `identity_risk_pseudonym_key_versions` unqualified three times, so a
caller could put their own schema earlier in `search_path` and point the scope
check at a table they control. Each function now sets `search_path = ''` and
qualifies every reference, and `EXECUTE` is revoked from `PUBLIC`.

`CREATE OR REPLACE` keeps the function OIDs, so the triggers stay bound and
none is recreated. Every guard branch was exercised against the live schema in a
rolled-back transaction first: identity-immutability, wrong-name rejection, a
valid insert still accepted, update rejection, the DELETE branch still running
its (now qualified) `UPDATE`, and reactivation rejection.

Rollback is the previous definitions from
`20260904090000_identity_risk_pseudonym_versions` and
`20260904100000_wrapped_identity_risk_pilot`, replayed with
`CREATE OR REPLACE` and no `SET search_path`, plus
`GRANT EXECUTE ON FUNCTION <name>() TO PUBLIC` if the grant is wanted back.

## Follow-ups

- Rotate the Supabase keys. They were public for the life of the project and the
  exposure window is unbounded, so rotation is the only way to invalidate
  anything already harvested. Couples to a frontend redeploy.
- Enable leaked-password protection (advisor WARN).
- Split dev from production. Every merge to `main` deploys straight to the only
  environment holding real customer data.
