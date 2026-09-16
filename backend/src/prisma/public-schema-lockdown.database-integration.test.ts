import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from './native-alert-test-database.js'
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
    const client = new pg.Client({ connectionString: assertDisposableTestDatabase().toString() })
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

const searchPathMigrationUrl = new URL(
  '../../prisma/migrations/20260910040000_pin_function_search_path/migration.sql',
  import.meta.url,
)

test('the search_path migration pins every function it defines', async () => {
  const file = await readFile(searchPathMigrationUrl, 'utf8')
  const sql = file.replaceAll(/--.*/g, '')

  const defined = [...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_.]+)\(/gi)]
  assert.equal(defined.length, 3, 'expected exactly the three guard functions')

  const pinned = [...sql.matchAll(/SET\s+search_path\s*=\s*''/gi)]
  assert.equal(
    pinned.length,
    defined.length,
    'every redefined function must pin search_path',
  )

  // With search_path = '' nothing resolves implicitly, so any table the bodies
  // touch has to be schema-qualified or the guard breaks at runtime.
  assert.doesNotMatch(
    sql,
    /(FROM|UPDATE|INTO|DECLARE\s+\w+)\s+identity_risk_pseudonym_key_versions\b/i,
    'unqualified table reference under an empty search_path',
  )
  assert.doesNotMatch(sql, /\bGRANT\b/i, 'the migration only revokes')
})

test(
  'public functions pin search_path and are closed to PUBLIC',
  { skip: !databaseIntegrationEnabled },
  async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    try {
      const unpinned = await client.query(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND COALESCE(array_to_string(p.proconfig, ','), '') NOT LIKE '%search_path=%'
        ORDER BY p.proname
      `)
      assert.deepEqual(
        unpinned.rows.map((row) => row.proname),
        [],
        'a function with a role-mutable search_path can be redirected by its caller',
      )

      // A PUBLIC grant covers anon and authenticated no matter what was revoked
      // from them by name, so this is what actually closes the function surface.
      const publicExecute = await client.query(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::text LIKE '=%')
        ORDER BY p.proname
      `)
      assert.deepEqual(
        publicExecute.rows.map((row) => row.proname),
        [],
        'no function in public may grant EXECUTE to PUBLIC',
      )
    } finally {
      await client.end()
    }
  },
)
