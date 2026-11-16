import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'

// Storage contract only: no collector, provider, retention worker or outcome
// reader is exercised. These witnesses must never connect to local PostgreSQL.
const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
  && process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1'
const tables = ['m365_audit_coverage_gaps', 'm365_audit_coverage_states'] as const
const at = '2026-11-01T00:00:00.000Z'
const earlier = '2026-10-31T23:59:59.000Z'
type Scope = { organizationId: string; tenantId: string }
type PgError = { code?: string; constraint?: string; message?: string }

async function transaction(run: (client: pg.Client) => Promise<void>) {
  const url = assertDisposableTestDatabase()
  assert.equal(url.port, '5432', 'Only the registered hosted disposable PostgreSQL service is permitted')
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 })
  let began = false
  try {
    await client.connect()
    await client.query('BEGIN')
    began = true
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '2s'")
    await run(client)
  } finally {
    try { if (began) await client.query('ROLLBACK') } finally { await client.end() }
  }
}

async function scope(client: pg.Client, organizationId: string = randomUUID()): Promise<Scope> {
  const tenantId = randomUUID()
  await client.query(`INSERT INTO public.organizations (id, name, slug, updated_at)
    VALUES ($1, 'Synthetic coverage storage fixture', $2, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING`, [organizationId, organizationId])
  await client.query(`INSERT INTO public.customer_tenants
    (id, organization_id, microsoft_tenant_id, status, updated_at)
    VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP)`, [tenantId, organizationId, randomUUID()])
  return { organizationId, tenantId }
}

async function gap(client: pg.Client, owner: Scope, digest = 'a'.repeat(64)) {
  const id = randomUUID()
  await client.query(`INSERT INTO public.m365_audit_coverage_gaps
    (id, organization_id, customer_tenant_id, content_type, content_id_sha256,
     source_status, reason, source_expired_at, first_observed_at)
    VALUES ($1, $2, $3, 'Audit.General', $4, 'RETRY', 'LEDGER_EXPIRED', $5, $6)`,
  [id, owner.organizationId, owner.tenantId, digest, earlier, at])
  return id
}

async function state(client: pg.Client, owner: Scope) {
  await client.query(`INSERT INTO public.m365_audit_coverage_states
    (customer_tenant_id, organization_id, incomplete_since, last_gap_at)
    VALUES ($1, $2, $3, $3)`, [owner.tenantId, owner.organizationId, at])
}

async function rejectsStatement(client: pg.Client, operation: () => Promise<unknown>,
  code: string, constraint?: string, message?: RegExp) {
  await client.query('SAVEPOINT expected_rejection')
  try {
    await assert.rejects(operation, (error: unknown) => {
      const actual = error as PgError
      assert.equal(actual.code, code)
      if (constraint) assert.equal(actual.constraint, constraint)
      if (message) assert.match(actual.message ?? '', message)
      return true
    })
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection')
    await client.query('RELEASE SAVEPOINT expected_rejection')
  }
}

async function count(client: pg.Client, table: typeof tables[number], tenantId: string) {
  return (await client.query(`SELECT customer_tenant_id FROM public.${table}
    WHERE customer_tenant_id = $1`, [tenantId])).rowCount
}

test('HAW-75 additive storage preserves URL nullability and enforces compact-record constraints',
  { skip: !enabled, timeout: 30_000 }, async () => transaction(async client => {
    const columns = await client.query(`SELECT table_name, column_name, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'
      AND (table_name = ANY($1::text[]) OR (table_name = 'm365_activity_contents' AND column_name = 'content_uri'))
      ORDER BY table_name, ordinal_position`, [tables])
    assert.deepEqual(columns.rows.filter(row => row.table_name === 'm365_audit_coverage_gaps').map(row => row.column_name),
      ['id', 'organization_id', 'customer_tenant_id', 'content_type', 'content_id_sha256', 'source_status',
        'reason', 'source_expired_at', 'first_observed_at', 'resolved_at'])
    assert.deepEqual(columns.rows.filter(row => row.table_name === 'm365_audit_coverage_states').map(row => row.column_name),
      ['customer_tenant_id', 'organization_id', 'generation', 'incomplete_since', 'last_gap_at', 'has_purged_unrepaired_gap'])
    assert.equal(columns.rows.find(row => row.table_name === 'm365_activity_contents')?.is_nullable, 'NO')
    const indexes = await client.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY indexname`, [tables])
    assert.deepEqual(indexes.rows.map(row => row.indexname), [
      'm365_audit_coverage_gaps_observed_idx', 'm365_audit_coverage_gaps_pkey',
      'm365_audit_coverage_gaps_scope_observed_idx', 'm365_audit_coverage_gaps_tenant_digest_key',
      'm365_audit_coverage_states_pkey', 'm365_audit_coverage_states_scope_idx',
      'm365_audit_coverage_states_tenant_scope_key',
    ])
    const owner = await scope(client)
    const id = await gap(client, owner)
    await state(client, owner)
    for (const [column, value, suffix] of [
      ['content_id_sha256', 'A'.repeat(64), 'digest'],
      ['content_id_sha256', 'a'.repeat(63), 'digest'],
      ['source_status', 'COMPLETED', 'status'],
      ['reason', 'UNVERIFIED', 'reason'],
      ['resolved_at', earlier, 'resolution_time'],
    ]) {
      await rejectsStatement(client, () => client.query(
        `UPDATE public.m365_audit_coverage_gaps SET ${column} = $1 WHERE id = $2`, [value, id]),
      '23514', `m365_audit_coverage_gaps_${suffix}_check`)
    }
    await rejectsStatement(client, () => client.query(`UPDATE public.m365_audit_coverage_states
      SET generation = 0 WHERE customer_tenant_id = $1`, [owner.tenantId]),
    '23514', 'm365_audit_coverage_states_generation_check')
    await rejectsStatement(client, () => client.query(`UPDATE public.m365_audit_coverage_states
      SET last_gap_at = $1 WHERE customer_tenant_id = $2`, [earlier, owner.tenantId]),
    '23514', 'm365_audit_coverage_states_time_check')
    assert.deepEqual((await client.query(`SELECT generation::text, has_purged_unrepaired_gap
      FROM public.m365_audit_coverage_states WHERE customer_tenant_id = $1`, [owner.tenantId])).rows,
    [{ generation: '1', has_purged_unrepaired_gap: false }])
    await client.query('UPDATE public.m365_audit_coverage_gaps SET resolved_at = $1 WHERE id = $2', [at, id])
    // Compact-record deletion does not cascade to the independent state. This
    // does not prove the future writer sets the marker or the reader uses it.
    await client.query('DELETE FROM public.m365_audit_coverage_gaps WHERE id = $1', [id])
    assert.equal(await count(client, tables[1], owner.tenantId), 1)
  }))

test('HAW-75 storage enforces tenant scope, digest uniqueness and bounded cascades',
  { skip: !enabled, timeout: 30_000 }, async () => transaction(async client => {
    const a = await scope(client)
    const sibling = await scope(client, a.organizationId)
    const b = await scope(client)
    for (const owner of [a, sibling, b]) {
      await gap(client, owner)
      await state(client, owner)
    }
    await rejectsStatement(client, () => gap(client, a), '23505', 'm365_audit_coverage_gaps_tenant_digest_key')
    const unused = await scope(client, a.organizationId)
    const crossed = { ...unused, organizationId: b.organizationId }
    await rejectsStatement(client, () => gap(client, crossed), '23503', 'm365_audit_coverage_gaps_tenant_scope_fkey')
    await rejectsStatement(client, () => state(client, crossed), '23503', 'm365_audit_coverage_states_tenant_scope_fkey')
    await client.query('DELETE FROM public.customer_tenants WHERE id = $1', [a.tenantId])
    for (const table of tables) {
      assert.equal(await count(client, table, a.tenantId), 0)
      assert.equal(await count(client, table, sibling.tenantId), 1)
      assert.equal(await count(client, table, b.tenantId), 1)
    }
    await client.query('DELETE FROM public.organizations WHERE id = $1', [a.organizationId])
    for (const table of tables) {
      assert.equal(await count(client, table, sibling.tenantId), 0)
      assert.equal(await count(client, table, b.tenantId), 1)
    }
  }))

test('HAW-75 storage denies a non-owner both before and after synthetic table grants',
  { skip: !enabled, timeout: 30_000 }, async () => transaction(async client => {
    const owner = await scope(client)
    const insertionScope = await scope(client)
    await gap(client, owner)
    await state(client, owner)
    const role = `hv_coverage_${randomUUID().replaceAll('-', '')}`
    // Hosted administrator only. Role, grants and fixtures roll back together.
    await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`)
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    const metadata = await client.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      c.relowner <> r.oid AS not_owner, r.rolsuper, r.rolbypassrls, r.rolinherit,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_roles r WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      AND r.rolname = $2 ORDER BY c.relname`, [tables, role])
    assert.equal(metadata.rows.length, 2)
    for (const row of metadata.rows) {
      assert.equal(row.relrowsecurity, true)
      assert.equal(row.relforcerowsecurity, false)
      assert.equal(row.not_owner, true)
      assert.equal(row.rolsuper, false)
      assert.equal(row.rolbypassrls, false)
      assert.equal(row.rolinherit, false)
      assert.equal(row.policy_count, 0)
    }
    await client.query(`SET LOCAL ROLE "${role}"`)
    for (const table of tables) {
      assert.equal((await client.query('SELECT has_table_privilege(current_user, $1, $2) AS allowed',
        [`public.${table}`, 'SELECT'])).rows[0].allowed, false)
      await rejectsStatement(client, () => client.query(`SELECT * FROM public.${table}`), '42501', undefined, /permission denied for table/)
    }
    await client.query('RESET ROLE')
    for (const table of tables) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO "${role}"`)
    }
    await client.query(`SET LOCAL ROLE "${role}"`)
    for (const table of tables) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal((await client.query('SELECT has_table_privilege(current_user, $1, $2) AS allowed',
          [`public.${table}`, privilege])).rows[0].allowed, true)
      }
      assert.equal(await count(client, table, owner.tenantId), 0)
      assert.equal((await client.query(`UPDATE public.${table} SET organization_id = organization_id
        WHERE customer_tenant_id = $1`, [owner.tenantId])).rowCount, 0)
      assert.equal((await client.query(`DELETE FROM public.${table}
        WHERE customer_tenant_id = $1`, [owner.tenantId])).rowCount, 0)
    }
    await rejectsStatement(client, () => gap(client, insertionScope), '42501', undefined, /row-level security/)
    await rejectsStatement(client, () => state(client, insertionScope), '42501', undefined, /row-level security/)
    await client.query('RESET ROLE')
    // Positive control for exactly the same valid payloads under the CI role.
    // This role's success is not evidence about production application access.
    await gap(client, insertionScope)
    await state(client, insertionScope)
    for (const table of tables) {
      assert.equal(await count(client, table, owner.tenantId), 1)
      assert.equal((await client.query(`UPDATE public.${table} SET organization_id = organization_id
        WHERE customer_tenant_id = $1`, [insertionScope.tenantId])).rowCount, 1)
      assert.equal((await client.query(`DELETE FROM public.${table}
        WHERE customer_tenant_id = $1`, [insertionScope.tenantId])).rowCount, 1)
    }
  }))
