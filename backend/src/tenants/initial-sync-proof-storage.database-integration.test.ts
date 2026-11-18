import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'

// Row-shape storage only. No producer, coherent projection, ownership or notice
// mutation is exercised. Never connect to a local or deployed PostgreSQL server.
const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
  && process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1'
const at = '2026-11-16T00:00:00.000002Z'
const before = '2026-11-16T00:00:00.000001Z'
const nil = '00000000-0000-0000-0000-000000000000'
const receiptColumns = [
  'initial_sync_attempt_epoch_id', 'initial_sync_attempt_id',
  'initial_sync_persisted_attempt_id', 'initial_sync_completed_attempt_id',
  'initial_sync_persisted_kind',
] as const
const connectionChecks = ['initial_sync_epoch_pair', 'initial_sync_epoch_non_nil', 'initial_sync_epoch_finite']
const stateChecks = [
  'initial_sync_attempt_pair', 'initial_sync_receipt_non_nil', 'initial_sync_persisted_attempt_match',
  'initial_sync_persisted_kind_pair', 'initial_sync_persisted_kind_resource', 'initial_sync_required_resource_only',
  'initial_sync_completed_attempt_match', 'initial_sync_attempt_time', 'initial_sync_completed_time',
]
type Scope = { organizationId: string; tenantId: string }
type Value = string | null
type StatePatch = Partial<Record<typeof receiptColumns[number] | 'resource_type' | 'status'
  | 'last_attempt_at' | 'last_successful_at' | 'last_error_code' | 'last_error_message', Value>>

async function transaction(run: (client: pg.Client) => Promise<void>) {
  const url = assertDisposableTestDatabase(process.env, { requireUtc: true })
  assert.equal(url.port, '5432', 'Only registered hosted disposable PostgreSQL is permitted')
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

async function scope(client: pg.Client): Promise<Scope> {
  const organizationId = randomUUID(), tenantId = randomUUID()
  await client.query(`INSERT INTO public.organizations (id, name, slug, updated_at)
    VALUES ($1, 'Synthetic initial proof storage fixture', $2, CURRENT_TIMESTAMP)`, [organizationId, organizationId])
  await client.query(`INSERT INTO public.customer_tenants
    (id, organization_id, microsoft_tenant_id, status, updated_at)
    VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP)`, [tenantId, organizationId, randomUUID()])
  return { organizationId, tenantId }
}

async function connection(client: pg.Client, owner: Scope) {
  const id = randomUUID()
  await client.query(`INSERT INTO public.tenant_connections
    (id, organization_id, customer_tenant_id, status, updated_at)
    VALUES ($1, $2, $3, 'CONNECTED', CURRENT_TIMESTAMP)`, [id, owner.organizationId, owner.tenantId])
  return id
}

async function state(client: pg.Client, owner: Scope, resource = 'USERS') {
  const id = randomUUID()
  await client.query(`INSERT INTO public.sync_states
    (id, organization_id, customer_tenant_id, resource_type, status, updated_at)
    VALUES ($1, $2, $3, $4::public."SyncResourceType", 'SUCCEEDED', CURRENT_TIMESTAMP)`,
  [id, owner.organizationId, owner.tenantId, resource])
  return id
}

async function update(client: pg.Client, id: string, patch: StatePatch) {
  const entries = Object.entries(patch)
  // Column names come exclusively from typed literal test vectors, never input.
  return client.query(`UPDATE public.sync_states SET ${entries.map(([column], index) =>
    `"${column}" = $${index + 1}`).join(', ')} WHERE id = $${entries.length + 1}`,
  [...entries.map(([, value]) => value), id])
}

async function readState(client: pg.Client, id: string) {
  return (await client.query('SELECT to_jsonb(s) AS row FROM public.sync_states s WHERE id = $1', [id])).rows[0]?.row
}

async function rejected(client: pg.Client, operation: () => Promise<unknown>, code: string,
  constraints?: readonly string[]) {
  await client.query('SAVEPOINT expected_rejection')
  try {
    await assert.rejects(operation, (error: unknown) => {
      const actual = error as { code?: string; constraint?: string }
      assert.equal(actual.code, code)
      if (constraints) assert.ok(constraints.includes(actual.constraint ?? ''), `Unexpected constraint: ${actual.constraint}`)
      return true
    })
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection')
    await client.query('RELEASE SAVEPOINT expected_rejection')
  }
}

function complete(resource = 'USERS'): StatePatch {
  const attempt = randomUUID()
  return {
    initial_sync_attempt_epoch_id: randomUUID(), initial_sync_attempt_id: attempt,
    initial_sync_persisted_attempt_id: attempt, initial_sync_completed_attempt_id: attempt,
    initial_sync_persisted_kind: resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE',
    status: 'SUCCEEDED', last_attempt_at: at, last_successful_at: at,
    last_error_code: null, last_error_message: null,
  }
}

const options = { skip: !enabled, timeout: 30_000 }

test('HAW-77 storage has seven nullable no-default fields and accepts every legacy resource', options,
  async () => transaction(async client => {
    const columns = (await client.query(`SELECT table_name, column_name, is_nullable, column_default,
      data_type, character_maximum_length, datetime_precision FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('sync_states', 'tenant_connections')
      AND column_name LIKE 'initial_sync_%' ORDER BY table_name, column_name`)).rows
    assert.deepEqual(columns.map(row => `${row.table_name}.${row.column_name}`), [
      ...receiptColumns.map(column => `sync_states.${column}`),
      'tenant_connections.initial_sync_epoch_id', 'tenant_connections.initial_sync_epoch_started_at',
    ].sort())
    for (const row of columns) {
      assert.equal(row.is_nullable, 'YES')
      assert.equal(row.column_default, null)
      assert.equal(row.data_type, row.column_name.endsWith('_started_at') ? 'timestamp with time zone'
        : row.column_name.endsWith('_kind') ? 'character varying' : 'uuid')
      if (row.column_name.endsWith('_kind')) assert.equal(row.character_maximum_length, 32)
      if (row.column_name.endsWith('_started_at')) assert.equal(row.datetime_precision, 6)
    }
    const checks = (await client.query(`SELECT c.conname, c.convalidated FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname IN ('sync_states', 'tenant_connections')
      AND c.conname LIKE 'initial_sync_%' ORDER BY c.conname`)).rows
    assert.deepEqual(checks.map(row => row.conname), [...connectionChecks, ...stateChecks].sort())
    assert.ok(checks.every(row => row.convalidated === true))
    const owner = await scope(client)
    const resources: string[] = (await client.query(`SELECT unnest(enum_range(NULL::public."SyncResourceType"))::text AS resource`)).rows.map(row => row.resource)
    assert.ok(resources.length > INITIAL_SYNC_RESOURCE_TYPES.length, 'include optional resource compatibility')
    for (const resource of resources) {
      const id = await state(client, owner, resource)
      // A newer ordinary attempt may keep historical success, including old errors.
      await update(client, id, { status: 'RUNNING', last_attempt_at: at, last_successful_at: before,
        last_error_code: 'legacy', last_error_message: 'retained legacy history' })
      const row = await readState(client, id)
      for (const column of receiptColumns) assert.equal(row[column], null)
      await update(client, id, { status: 'SUCCEEDED' })
      assert.equal((await readState(client, id)).initial_sync_completed_attempt_id, null,
        'legacy success must not mint a receipt')
    }
    const roleId = (await client.query(`SELECT id FROM public.sync_states
      WHERE customer_tenant_id = $1 AND resource_type = 'DIRECTORY_ROLES'`, [owner.tenantId])).rows[0].id
    await client.query(`UPDATE public.sync_states SET role_scope_version = 'storage-fixture',
      role_scope_incarnation = $1 WHERE id = $2`, [randomUUID(), roleId])
    const roleBefore = await readState(client, roleId)
    await update(client, roleId, { last_error_message: null })
    const roleAfter = await readState(client, roleId)
    for (const key of Object.keys(roleBefore).filter(key => key.startsWith('role_'))) {
      assert.deepEqual(roleAfter[key], roleBefore[key], key)
    }
  }))

test('HAW-77 connection epoch requires a non-nil identity paired with a finite start', options,
  async () => transaction(async client => {
    const id = await connection(client, await scope(client))
    const epoch = randomUUID()
    for (const [epochId, startedAt, constraint] of [
      [epoch, null, 'initial_sync_epoch_pair'], [null, at, 'initial_sync_epoch_pair'],
      [nil, at, 'initial_sync_epoch_non_nil'], [epoch, 'infinity', 'initial_sync_epoch_finite'],
      [epoch, '-infinity', 'initial_sync_epoch_finite'],
    ]) {
      await rejected(client, () => client.query(`UPDATE public.tenant_connections
        SET initial_sync_epoch_id = $1, initial_sync_epoch_started_at = $2 WHERE id = $3`,
      [epochId, startedAt, id]), '23514', [constraint!])
      assert.deepEqual((await client.query(`SELECT initial_sync_epoch_id, initial_sync_epoch_started_at
        FROM public.tenant_connections WHERE id = $1`, [id])).rows,
      [{ initial_sync_epoch_id: null, initial_sync_epoch_started_at: null }])
    }
    await client.query(`UPDATE public.tenant_connections SET initial_sync_epoch_id = $1,
      initial_sync_epoch_started_at = $2 WHERE id = $3`, [epoch, at, id])
    const row = (await client.query(`SELECT initial_sync_epoch_id,
      to_char(initial_sync_epoch_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started
      FROM public.tenant_connections WHERE id = $1`, [id])).rows[0]
    assert.deepEqual(row, { initial_sync_epoch_id: epoch, started: at })
  }))

test('HAW-77 receipt storage rejects every illegal partial-null vector atomically', options,
  async () => transaction(async client => {
    const owner = await scope(client)
    const id = await state(client, owner)
    const values = complete()
    const legal = new Set([0, 3, 23, 31]) // empty, attempt, persisted, completed
    for (let mask = 0; mask < 32; mask += 1) {
      const vector: StatePatch = { ...values }
      receiptColumns.forEach((column, bit) => { vector[column] = mask & (1 << bit) ? values[column]! : null })
      const beforeRow = await readState(client, id)
      if (legal.has(mask)) await update(client, id, vector)
      else {
        await rejected(client, () => update(client, id, vector), '23514', stateChecks)
        assert.deepEqual(await readState(client, id), beforeRow, `null mask ${mask}`)
      }
    }
  }))

test('HAW-77 full and Graph receipts enforce identity, source, terminal errors and precise times', options,
  async () => transaction(async client => {
    const owner = await scope(client)
    for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
      const id = await state(client, owner, resource)
      const valid = complete(resource)
      await update(client, id, valid)
      assert.equal((await readState(client, id)).initial_sync_completed_attempt_id, valid.initial_sync_attempt_id)
    }
    const id = (await client.query(`SELECT id FROM public.sync_states WHERE customer_tenant_id = $1
      AND resource_type = 'USERS'`, [owner.tenantId])).rows[0].id
    const valid = complete()
    await update(client, id, valid)
    const baseline = await readState(client, id)
    const vectors: StatePatch[] = [
      ...receiptColumns.slice(0, 4).map(column => ({ [column]: nil })),
      { initial_sync_attempt_id: randomUUID() }, { initial_sync_persisted_attempt_id: randomUUID() },
      { initial_sync_completed_attempt_id: randomUUID() },
      { initial_sync_persisted_kind: '' }, { initial_sync_persisted_kind: 'UNKNOWN' },
      { initial_sync_persisted_kind: 'GRAPH_SIGN_INS' },
      ...['IDLE', 'RUNNING', 'FAILED'].map(status => ({ status })),
      { last_error_code: 'collection-failed' }, { last_error_message: 'stale error' },
      ...[null, 'infinity', '-infinity'].map(last_attempt_at => ({ last_attempt_at })),
      ...[null, 'infinity', '-infinity', before].map(last_successful_at => ({ last_successful_at })),
    ]
    for (const patch of vectors) {
      await rejected(client, () => update(client, id, patch), '23514', stateChecks)
      assert.deepEqual(await readState(client, id), baseline)
    }
    const signId = (await client.query(`SELECT id FROM public.sync_states WHERE customer_tenant_id = $1
      AND resource_type = 'SIGN_INS'`, [owner.tenantId])).rows[0].id
    await rejected(client, () => update(client, signId, { initial_sync_persisted_kind: 'FULL_RESOURCE' }),
      '23514', ['initial_sync_persisted_kind_resource'])
    const optional: string[] = (await client.query(`SELECT unnest(enum_range(NULL::public."SyncResourceType"))::text AS resource`))
      .rows.map(row => row.resource).filter(resource => !INITIAL_SYNC_RESOURCE_TYPES.includes(resource as typeof INITIAL_SYNC_RESOURCE_TYPES[number]))
    for (const resource of optional) {
      const optionalId = await state(client, owner, resource)
      const attempt = { ...complete(), initial_sync_persisted_attempt_id: null,
        initial_sync_completed_attempt_id: null, initial_sync_persisted_kind: null }
      await rejected(client, () => update(client, optionalId, attempt), '23514', ['initial_sync_required_resource_only'])
    }
    // A failed persisted attempt and crash-before-finalize remain incomplete.
    await update(client, id, { initial_sync_completed_attempt_id: null, status: 'FAILED',
      last_error_code: 'failed', last_error_message: 'after persistence', last_successful_at: before })
    await rejected(client, () => update(client, id, { initial_sync_completed_attempt_id: valid.initial_sync_attempt_id }),
      '23514', ['initial_sync_completed_attempt_match'])
    await update(client, id, { initial_sync_completed_attempt_id: valid.initial_sync_attempt_id,
      status: 'SUCCEEDED', last_error_code: null, last_error_message: null, last_successful_at: at })
    const next = randomUUID()
    await update(client, id, { initial_sync_attempt_epoch_id: randomUUID(), initial_sync_attempt_id: next,
      initial_sync_persisted_attempt_id: null, initial_sync_completed_attempt_id: null, initial_sync_persisted_kind: null,
      status: 'RUNNING', last_attempt_at: '2026-11-16T00:01:00Z' })
    assert.equal((await readState(client, id)).initial_sync_completed_attempt_id, null)
    // SQL fixtures prove shape transitions only, not actual collector transactions.
  }))

test('HAW-77 storage keeps existing tenant scope and one-row-per-resource boundaries', options,
  async () => transaction(async client => {
    const a = await scope(client), b = await scope(client)
    const aState = await state(client, a), bState = await state(client, b)
    await connection(client, a)
    await connection(client, b)
    await update(client, aState, complete())
    const bBefore = await readState(client, bState)
    await rejected(client, () => state(client, a), '23505', ['sync_states_customer_tenant_id_resource_type_key'])
    const crossed = { ...a, organizationId: b.organizationId }
    await rejected(client, () => state(client, crossed, 'DOMAINS'), '23503', ['sync_states_customer_tenant_id_organization_id_fkey'])
    await rejected(client, () => connection(client, crossed), '23503', ['tenant_connections_customer_tenant_id_organization_id_fkey'])
    await client.query('DELETE FROM public.customer_tenants WHERE id = $1', [a.tenantId])
    assert.equal(await readState(client, aState), undefined)
    assert.deepEqual(await readState(client, bState), bBefore)
    assert.equal((await client.query('SELECT id FROM public.tenant_connections WHERE customer_tenant_id = $1', [a.tenantId])).rowCount, 0)
    assert.equal((await client.query('SELECT id FROM public.tenant_connections WHERE customer_tenant_id = $1', [b.tenantId])).rowCount, 1)
  }))
