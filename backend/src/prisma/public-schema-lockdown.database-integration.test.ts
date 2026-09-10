import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const databaseIntegrationEnabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

const migrationUrl = new URL(
  '../../prisma/migrations/20260909120000_lock_down_public_schema_grants_and_rls/migration.sql',
  import.meta.url,
)

// This one runs without a database so the intent is guarded on every push,
// not only in the job that provisions PostgreSQL.
test('the lockdown migration grants nothing back', async () => {
  const file = await readFile(migrationUrl, 'utf8')
  // Assert against executable SQL only. The header prose explains why FORCE and
  // policies are wrong, and would otherwise trip the very checks below.
  const sql = file.replaceAll(/--.*/g, '')

  assert.doesNotMatch(
    sql,
    /CREATE\s+POLICY/i,
    'deny-all is the target state; a policy here would reopen PostgREST access',
  )
  assert.doesNotMatch(
    sql,
    /FORCE\s+ROW\s+LEVEL\s+SECURITY/i,
    'FORCE would apply RLS to the table owner, which is the role the API connects as',
  )
  assert.doesNotMatch(sql, /\bGRANT\b/i, 'the migration only revokes')
  assert.doesNotMatch(
    sql,
    /\b(auth|storage|realtime)\.[a-z_]/i,
    'Supabase-managed schemas are out of bounds',
  )
})

test(
  'public schema stays denied to anon and authenticated',
  { skip: !databaseIntegrationEnabled },
  async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    try {
      const unprotected = await client.query(`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY c.relname
      `)
      assert.deepEqual(
        unprotected.rows.map((row) => row.relname),
        [],
        'every table in public must have row level security enabled',
      )

      // FORCE would lock out the owner, which is how the API connects. If this
      // ever trips, the backend loses access to its own tables.
      const forced = await client.query(`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
        ORDER BY c.relname
      `)
      assert.deepEqual(
        forced.rows.map((row) => row.relname),
        [],
        'no table may force row level security on its owner',
      )

      const policies = await client.query(`
        SELECT c.relname, p.polname
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
        ORDER BY c.relname, p.polname
      `)
      assert.deepEqual(
        policies.rows,
        [],
        'deny-all means zero policies; a permissive policy would reopen access',
      )

      // The Supabase roles are absent from a stock PostgreSQL image, so these
      // assert vacuously in CI and meaningfully against a real project.
      const grants = await client.query(`
        SELECT grantee, table_name, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
        ORDER BY grantee, table_name, privilege_type
      `)
      assert.deepEqual(
        grants.rows,
        [],
        'anon and authenticated must hold no privileges on public tables',
      )

      const routineGrants = await client.query(`
        SELECT grantee, routine_name
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public' AND grantee IN ('anon', 'authenticated')
        ORDER BY grantee, routine_name
      `)
      assert.deepEqual(
        routineGrants.rows,
        [],
        'anon and authenticated must hold no privileges on public routines',
      )

      // Default privileges are the quiet regression: without this, the next
      // CREATE TABLE re-grants everything to anon.
      const defaults = await client.query(`
        SELECT d.defaclobjtype, d.defaclacl::text AS acl
        FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public'
          AND pg_get_userbyid(d.defaclrole) = current_user
          AND (d.defaclacl::text LIKE '%anon=%' OR d.defaclacl::text LIKE '%authenticated=%')
      `)
      assert.deepEqual(
        defaults.rows,
        [],
        'new objects must not inherit anon or authenticated privileges',
      )
    } finally {
      await client.end()
    }
  },
)
