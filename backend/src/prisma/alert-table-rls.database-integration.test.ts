import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from './prisma.service.js'
import { assertDisposableNativeAlertDatabase } from './native-alert-test-database.js'

const migrationUrl = new URL(
  '../../prisma/migrations/20260915140000_security_alert_support_rls/migration.sql',
  import.meta.url,
)
const tables = ['alert_delivery_outcomes', 'alert_webhook_rejections', 'alert_withheld_notices'] as const
const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

test('forward alert-table migration restores exactly three deny-all RLS boundaries', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replaceAll(/--.*/g, '')
  const enabledTables = [...sql.matchAll(/ALTER TABLE "public"\."([^"]+)" ENABLE ROW LEVEL SECURITY;/g)]
    .map((match) => match[1]).sort()
  assert.deepEqual(enabledTables, [...tables].sort())
  assert.doesNotMatch(sql, /CREATE\s+POLICY|FORCE\s+ROW\s+LEVEL\s+SECURITY|DISABLE\s+ROW\s+LEVEL\s+SECURITY|\bGRANT\b/i)
  assert.match(sql, /FROM PUBLIC;/)
  assert.match(sql, /ARRAY\['anon', 'authenticated'\]/)
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = target_role\)/)
})

test('alert-table owner CRUD remains available while a non-bypass role is denied by RLS',
  { skip: !enabled }, async () => {
    const url = assertDisposableNativeAlertDatabase()
    const client = new pg.Client({ connectionString: url.toString() })
    const prisma = new PrismaService()
    const organizationId = randomUUID()
    const role = `hv_rls_probe_${randomUUID().replaceAll('-', '')}`
    const rows = Object.fromEntries(tables.map((table) => [table, randomUUID()])) as Record<typeof tables[number], string>
    const at = new Date()
    let organizationCreated = false
    let connected = false
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Synthetic RLS fixture', slug: organizationId } })
      organizationCreated = true
      await client.connect()
      connected = true
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '5s'")
      await client.query("SET LOCAL lock_timeout = '2s'")
      const metadata = await client.query(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
          (pg_has_role(current_user, c.relowner, 'USAGE') OR r.rolsuper OR r.rolbypassrls) AS backend_access
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.rolname = current_user
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname
      `, [tables])
      assert.equal(metadata.rows.length, 3)
      for (const row of metadata.rows) {
        assert.equal(row.relrowsecurity, true)
        assert.equal(row.relforcerowsecurity, false)
        assert.equal(row.backend_access, true, 'API connection retains its existing owner/bypass access model')
      }

      await client.query(`
        INSERT INTO public.alert_delivery_outcomes (id, provider_id, kind, because, occurred_at)
        VALUES ($1, $2, 'UNMATCHED', 'NO_SUCH_JOB', $3)
      `, [rows.alert_delivery_outcomes, randomUUID(), at])
      await client.query(`
        INSERT INTO public.alert_webhook_rejections
          (id, bucket_start, verdict, attempts, first_seen_at, last_seen_at, expires_at)
        VALUES ($1, $2, 'SIGNATURE_INVALID', 1, $2, $2, $2::timestamptz + interval '1 hour')
      `, [rows.alert_webhook_rejections, at])
      await client.query(`
        INSERT INTO public.alert_withheld_notices
          (id, organization_id, dedupe_key, alert_type_id, finding_id, because)
        VALUES ($1, $2, $3, 'security.suspected_credential_attack', $4, 'RECORD_ONLY')
      `, [rows.alert_withheld_notices, organizationId, randomUUID(), randomUUID()])

      for (const table of tables) {
        assert.equal((await client.query(`SELECT id FROM public.${table} WHERE id = $1`, [rows[table]])).rowCount, 1)
        assert.equal((await client.query(`UPDATE public.${table} SET id = id WHERE id = $1`, [rows[table]])).rowCount, 1)
      }

      // Disposable CI/QA administrator only. All grants, role creation and rows
      // roll back together; no production roles or policies are changed.
      await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`)
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      for (const table of tables) {
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO "${role}"`)
      }
      await client.query(`SET LOCAL ROLE "${role}"`)
      for (const table of tables) {
        assert.equal((await client.query(`SELECT id FROM public.${table} WHERE id = $1`, [rows[table]])).rowCount, 0)
        assert.equal((await client.query(`UPDATE public.${table} SET id = id WHERE id = $1`, [rows[table]])).rowCount, 0)
        assert.equal((await client.query(`DELETE FROM public.${table} WHERE id = $1`, [rows[table]])).rowCount, 0)
        await client.query('SAVEPOINT denied_insert')
        await assert.rejects(
          client.query(`INSERT INTO public.${table} DEFAULT VALUES`),
          (error: unknown) => (error as { code?: string }).code === '42501',
          'RLS must reject INSERT even when the synthetic role has table privileges',
        )
        await client.query('ROLLBACK TO SAVEPOINT denied_insert')
      }
      await client.query('RESET ROLE')
      for (const table of tables) {
        assert.equal((await client.query(`DELETE FROM public.${table} WHERE id = $1`, [rows[table]])).rowCount, 1)
      }
    } finally {
      if (connected) {
        try { await client.query('ROLLBACK') } finally { await client.end() }
      }
      try {
        if (organizationCreated) await prisma.organization.delete({ where: { id: organizationId } })
      } finally { await prisma.$disconnect() }
    }
  })
