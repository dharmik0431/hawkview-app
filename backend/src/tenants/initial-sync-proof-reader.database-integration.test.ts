import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import type { Prisma } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import { readInitialSyncProof, type InitialSyncProofScope } from './initial-sync-proof-reader.js'
import { validateInitialSyncCompletionProjection } from './initial-sync-proof-projection.js'
import { readInitialSyncTerminalEvidence } from './initial-sync-terminal-readback.js'
import type { InitialSyncTerminalOperation } from './initial-sync-terminal-evidence.js'

// Registered hosted PostgreSQL only. Fixtures assert stored facts, not producer
// completeness, deployed-role access or notice ownership. The aggregate and
// terminal Prisma cases use the real adapter; other cases use pg.
const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
  && process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1'
const options = { skip: !enabled, timeout: 45_000 }
const stamp = (fraction: string) => `2020-01-01T12:00:00.${fraction}Z`
const start = stamp('000100'), attempted = stamp('000200'), succeeded = stamp('000800')
type Fixture = {
  scope: InitialSyncProofScope
  connectionId: string
  epoch: string
  states: Map<string, { id: string; attempt: string }>
}
type Row = Record<string, unknown>

function client() {
  const url = assertDisposableTestDatabase(process.env, { requireUtc: true })
  assert.equal(url.port, '5432', 'Only registered hosted disposable PostgreSQL is permitted')
  return new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 })
}

async function settings(db: pg.Client) {
  await db.query("SET LOCAL statement_timeout = '5s'")
  await db.query("SET LOCAL lock_timeout = '2s'")
}

async function transaction(run: (db: pg.Client) => Promise<void>) {
  const db = client()
  let began = false
  try {
    await db.connect()
    await db.query('BEGIN')
    began = true
    await settings(db)
    await run(db)
  } finally {
    try { if (began) await db.query('ROLLBACK') } finally { await db.end() }
  }
}

async function fixture(db: pg.Client, organizationId: string = randomUUID()): Promise<Fixture> {
  const scope = { organizationId, customerTenantId: randomUUID() }
  const connectionId = randomUUID(), epoch = randomUUID()
  await db.query(`INSERT INTO public.organizations (id, name, slug, updated_at)
    VALUES ($1, 'Synthetic proof projection fixture', $2, CURRENT_TIMESTAMP)`, [scope.organizationId, scope.organizationId])
  await db.query(`INSERT INTO public.customer_tenants
    (id, organization_id, microsoft_tenant_id, status, updated_at)
    VALUES ($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP)`,
  [scope.customerTenantId, scope.organizationId, randomUUID()])
  await db.query(`INSERT INTO public.tenant_connections
    (id, organization_id, customer_tenant_id, status, initial_sync_epoch_id, initial_sync_epoch_started_at, updated_at)
    VALUES ($1, $2, $3, 'CONNECTED', $4, $5, CURRENT_TIMESTAMP)`,
  [connectionId, scope.organizationId, scope.customerTenantId, epoch, start])
  const states = new Map<string, { id: string; attempt: string }>()
  for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
    const id = randomUUID(), attempt = randomUUID()
    states.set(resource, { id, attempt })
    await db.query(`INSERT INTO public.sync_states
      (id, organization_id, customer_tenant_id, resource_type, status, last_attempt_at, last_successful_at,
       initial_sync_attempt_epoch_id, initial_sync_attempt_id, initial_sync_persisted_attempt_id,
       initial_sync_completed_attempt_id, initial_sync_persisted_kind, updated_at)
      VALUES ($1, $2, $3, $4::public."SyncResourceType", 'SUCCEEDED', $5, $6, $7, $8, $8, $8, $9, CURRENT_TIMESTAMP)`,
    [id, scope.organizationId, scope.customerTenantId, resource, attempted, succeeded, epoch, attempt,
      resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE'])
  }
  return { scope, connectionId, epoch, states }
}

async function read(db: pg.Client, scope: InitialSyncProofScope) {
  let calls = 0
  let rows: Row[] = []
  const result = await readInitialSyncProof(scope, async (sql, values) => {
    calls++
    rows = (await db.query(sql, [...values])).rows
    return rows
  })

  assert.equal(calls, 1)
  return { rows, result }
}

async function savepoint(db: pg.Client, run: () => Promise<void>) {
  await db.query('SAVEPOINT witness')
  try { await run() } finally {
    await db.query('ROLLBACK TO SAVEPOINT witness')
    await db.query('RELEASE SAVEPOINT witness')
  }
}

function terminalOperation(owner: Fixture, resource = 'SIGN_INS'): InitialSyncTerminalOperation {
  return { ...owner.scope, connectionId: owner.connectionId, epochId: owner.epoch,
    attemptId: owner.states.get(resource)!.attempt, resourceType: resource,
    persistedKind: resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE' }
}

async function readTerminal(db: pg.Client, operation: InitialSyncTerminalOperation) {
  let calls = 0
  let rows: Row[] = []
  const result = await readInitialSyncTerminalEvidence(operation, async (sql, values) => {
    calls++
    rows = (await db.query(sql, [...values])).rows
    return rows
  })
  assert.equal(calls, 1)
  return { rows, result }
}

// These three terminal cases exercise exact SQL/pg transport in rollback-only
// fixture transactions. They do not exercise committed-result loss, a separate
// read-only executor, Prisma transport, role visibility or ownership settlement.
test('HAW-77 terminal readback selects exact scoped resources and preserves absent or foreign evidence', options,
  async () => transaction(async db => {
    const owner = await fixture(db), sibling = await fixture(db)
    await db.query("SET LOCAL TIME ZONE 'Asia/Kathmandu'")
    await db.query("SET LOCAL DateStyle = 'SQL, DMY'")
    await db.query('SET LOCAL search_path TO pg_catalog')
    const snapshot = async () => (await db.query(`SELECT to_jsonb(s) AS row FROM public.sync_states s
      WHERE organization_id = $1 ORDER BY id`, [owner.scope.organizationId])).rows
    const before = await snapshot()
    for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
      const operation = terminalOperation(owner, resource)
      const actual = await readTerminal(db, operation)
      assert.equal(actual.rows.length, 1)
      const row = actual.rows[0]!
      assert.equal(row.stateId, owner.states.get(resource)!.id)
      assert.equal(row.expectedResourceType, resource)
      assert.equal(row.stateResourceType, resource)
      assert.equal(row.organizationId, owner.scope.organizationId)
      assert.equal(row.customerTenantId, owner.scope.customerTenantId)
      assert.equal(row.connectionId, owner.connectionId)
      assert.equal(row.initialSyncEpochId, owner.epoch)
      assert.equal(row.initialSyncAttemptId, operation.attemptId)
      assert.equal(row.epochStartedAtUtc, start)
      assert.equal(row.lastAttemptAtUtc, attempted)
      assert.equal(row.lastSuccessfulAtUtc, succeeded)
      assert.match(String(row.observedAtUtc), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      assert.equal(actual.result.kind, 'MATCHING_COMPLETION')
      assert.deepEqual(actual.result.operation, operation)
      assert.equal(actual.result.observed.atUtc, row.observedAtUtc)
    }
    assert.deepEqual(await snapshot(), before, 'Terminal readbacks must not mutate stored resource evidence')
    for (const operation of [{ ...terminalOperation(owner), organizationId: sibling.scope.organizationId },
      { ...terminalOperation(owner), customerTenantId: randomUUID() }]) {
      const actual = await readTerminal(db, operation)
      assert.deepEqual(actual.rows, [])
      assert.equal(actual.result.kind, 'UNKNOWN')
    }
    await savepoint(db, async () => {
      await db.query('DELETE FROM public.sync_states WHERE id = $1', [owner.states.get('SIGN_INS')!.id])
      const actual = await readTerminal(db, terminalOperation(owner))
      assert.equal(actual.rows.length, 1, 'Absent state remains an explicit left-joined row')
      assert.equal(actual.rows[0]!.stateId, null)
      assert.equal(actual.rows[0]!.initialSyncCompletedAttemptId, null)
      assert.equal(actual.result.kind, 'UNKNOWN')
      assert.equal((await readTerminal(db, terminalOperation(sibling))).result.kind, 'MATCHING_COMPLETION')
    })
    await savepoint(db, async () => {
      await db.query('DELETE FROM public.tenant_connections WHERE id = $1', [owner.connectionId])
      const actual = await readTerminal(db, terminalOperation(owner))
      assert.equal(actual.rows.length, 1)
      assert.equal(actual.rows[0]!.connectionId, null)
      assert.equal(actual.result.kind, 'UNKNOWN')
    })
  }))

test('HAW-77 terminal readback retains old epoch receipts and distinguishes replacement from current completion', options,
  async () => transaction(async db => {
    const owner = await fixture(db), operation = terminalOperation(owner), stateId = owner.states.get('SIGN_INS')!.id
    const before = (await db.query('SELECT to_jsonb(s) AS row FROM public.sync_states s WHERE id = $1', [stateId])).rows
    await savepoint(db, async () => {
      const nextEpoch = randomUUID()
      await db.query(`UPDATE public.tenant_connections SET initial_sync_epoch_id = $1,
        initial_sync_epoch_started_at = $2 WHERE id = $3`, [nextEpoch, stamp('000850'), owner.connectionId])
      const actual = await readTerminal(db, operation)
      assert.equal(actual.rows[0]!.initialSyncEpochId, nextEpoch)
      assert.equal(actual.rows[0]!.initialSyncAttemptEpochId, owner.epoch)
      assert.equal(actual.rows[0]!.lastAttemptAtUtc, attempted)
      assert.equal(actual.result.kind, 'SUPERSEDED')
      assert.equal(actual.result.observed.epochId, nextEpoch)
      assert.equal(actual.result.observed.attemptEpochId, owner.epoch)
      assert.equal(actual.result.operation.epochId, owner.epoch)
      assert.equal((await readTerminal(db, { ...operation, epochId: nextEpoch })).result.kind, 'UNKNOWN',
        'Current-epoch callers cannot reuse retained old-epoch proof')
      assert.deepEqual((await db.query('SELECT to_jsonb(s) AS row FROM public.sync_states s WHERE id = $1', [stateId])).rows, before)
    })
    await savepoint(db, async () => {
      const nextAttempt = randomUUID()
      await db.query(`UPDATE public.sync_states SET initial_sync_attempt_id = $1,
        initial_sync_persisted_attempt_id = $1, initial_sync_completed_attempt_id = $1 WHERE id = $2`, [nextAttempt, stateId])
      const actual = await readTerminal(db, operation)
      assert.equal(actual.result.kind, 'SUPERSEDED')
      assert.equal(actual.result.observed.attemptId, nextAttempt)
      assert.equal(actual.result.operation.attemptId, operation.attemptId)
      assert.equal((await readTerminal(db, { ...operation, attemptId: nextAttempt })).result.kind, 'MATCHING_COMPLETION')
    })
    for (const status of ['RUNNING', 'FAILED']) await savepoint(db, async () => {
      await db.query(`UPDATE public.sync_states SET initial_sync_completed_attempt_id = NULL,
        status = $1::public."SyncStateStatus", last_error_message = $2 WHERE id = $3`,
      [status, status === 'FAILED' ? 'Synthetic persisted-only failure' : null, stateId])
      const actual = await readTerminal(db, operation)
      assert.equal(actual.rows[0]!.initialSyncPersistedAttemptId, operation.attemptId)
      assert.equal(actual.rows[0]!.initialSyncCompletedAttemptId, null)
      assert.equal(actual.result.kind, 'PERSISTED_ONLY')
      assert.equal(actual.result.observed.status, status)
    })
    assert.equal((await readTerminal(db, operation)).result.kind, 'MATCHING_COMPLETION', 'Savepoint cleanup restores original evidence')
  }))

test('HAW-77 terminal readback transports invalid timestamps distinctly from null and rejects microsecond violations', options,
  async () => transaction(async db => {
    const owner = await fixture(db), operation = terminalOperation(owner), stateId = owner.states.get('SIGN_INS')!.id
    await savepoint(db, async () => {
      await db.query(`UPDATE public.sync_states SET initial_sync_completed_attempt_id = NULL,
        status = 'FAILED', last_error_message = 'Synthetic retained persistence', last_successful_at = NULL WHERE id = $1`, [stateId])
      const absent = await readTerminal(db, operation)
      assert.equal(absent.rows[0]!.lastSuccessfulAtUtc, null)
      assert.equal(absent.result.kind, 'PERSISTED_ONLY')
      for (const invalid of ['infinity', '-infinity', '0001-01-01 00:00:00+00 BC', '10000-01-01 00:00:00+00']) {
        await db.query('UPDATE public.sync_states SET last_successful_at = $1 WHERE id = $2', [invalid, stateId])
        const actual = await readTerminal(db, operation)
        assert.equal(actual.rows[0]!.lastSuccessfulAtUtc, 'INVALID_TIMESTAMP', invalid)
        assert.equal(actual.result.kind, 'UNKNOWN', invalid)
      }
    })
    await savepoint(db, async () => {
      await db.query('UPDATE public.sync_states SET last_attempt_at = $1 WHERE id = $2', [stamp('000099'), stateId])
      const actual = await readTerminal(db, operation), row = actual.rows[0]!
      assert.equal(row.lastAttemptAtUtc, stamp('000099'))
      assert.equal(new Date(row.lastAttemptAtUtc as string).getTime(), new Date(row.epochStartedAtUtc as string).getTime())
      assert.equal(actual.result.kind, 'UNKNOWN', 'Rounded milliseconds must not certify a pre-epoch attempt')
    })
    await savepoint(db, async () => {
      await db.query('UPDATE public.sync_states SET last_successful_at = $1 WHERE id = $2', ['9999-12-31T23:59:59.999999Z', stateId])
      const actual = await readTerminal(db, operation)
      assert.equal(actual.rows[0]!.lastSuccessfulAtUtc, '9999-12-31T23:59:59.999999Z')
      assert.equal(actual.result.kind, 'UNKNOWN', 'Representable future success is not current completion')
    })
    for (const invalid of ['0001-01-01 00:00:00+00 BC', '10000-01-01 00:00:00+00']) await savepoint(db, async () => {
      await db.query('UPDATE public.tenant_connections SET initial_sync_epoch_started_at = $1 WHERE id = $2', [invalid, owner.connectionId])
      const actual = await readTerminal(db, operation)
      assert.equal(actual.rows[0]!.epochStartedAtUtc, 'INVALID_TIMESTAMP')
      assert.equal(actual.result.kind, 'UNKNOWN')
    })
    assert.equal((await readTerminal(db, operation)).result.kind, 'MATCHING_COMPLETION')
  }))

test('HAW-77 terminal readback distinguishes pending rollback and committed completion without reserving attempt authority', options,
  async () => {
    const reader = client(), writer = client()
    const organizationIds = [randomUUID(), randomUUID()]
    let readerConnected = false, writerConnected = false, readerBegan = false, writerBegan = false
    const beginWriter = async () => {
      await writer.query('BEGIN'); writerBegan = true
      await settings(writer)
    }
    try {
      await reader.connect(); readerConnected = true
      await writer.connect(); writerConnected = true
      for (const db of [reader, writer]) {
        await db.query("SET statement_timeout = '5s'")
        await db.query("SET lock_timeout = '2s'")
      }
      assert.notEqual((await reader.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
        (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      await beginWriter()
      const owner = await fixture(writer, organizationIds[0]!)
      const sibling = await fixture(writer, organizationIds[1]!)
      const operation = terminalOperation(owner), stateId = owner.states.get('SIGN_INS')!.id
      assert.equal((await writer.query(`UPDATE public.sync_states SET status = 'RUNNING',
        initial_sync_completed_attempt_id = NULL, last_successful_at = NULL WHERE id = $1`, [stateId])).rowCount, 1)
      await writer.query('COMMIT'); writerBegan = false
      const snapshot = async (organizationId: string) => (await writer.query(`SELECT to_jsonb(s)::text AS row
        FROM public.sync_states s WHERE organization_id = $1 ORDER BY id`, [organizationId])).rows
      const baseline = await snapshot(owner.scope.organizationId), siblingBefore = await snapshot(sibling.scope.organizationId)
      await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'); readerBegan = true
      await settings(reader)
      assert.deepEqual((await reader.query('SHOW transaction_read_only')).rows, [{ transaction_read_only: 'on' }])
      assert.deepEqual((await reader.query('SHOW transaction_isolation')).rows, [{ transaction_isolation: 'read committed' }])
      const persistedOnly = async () => {
        const actual = await readTerminal(reader, operation)
        assert.equal(actual.rows.length, 1)
        assert.equal(actual.rows[0]!.initialSyncAttemptId, operation.attemptId)
        assert.equal(actual.rows[0]!.initialSyncPersistedAttemptId, operation.attemptId)
        assert.equal(actual.rows[0]!.initialSyncCompletedAttemptId, null)
        assert.equal(actual.rows[0]!.lastSuccessfulAtUtc, null)
        assert.equal(actual.result.kind, 'PERSISTED_ONLY')
        assert.equal(actual.result.observed.status, 'RUNNING')
        return actual
      }
      const early = await persistedOnly()
      // Fixture-only terminal update: no owner claim or production writer is
      // exercised. Await RETURNING to prove it ran before the external read.
      const completeFixture = async () => {
        const pending = await writer.query(`UPDATE public.sync_states
          SET initial_sync_completed_attempt_id = initial_sync_attempt_id,
            status = 'SUCCEEDED', last_successful_at = $1,
            last_error_code = NULL, last_error_message = NULL
          WHERE id = $2 AND organization_id = $3 AND customer_tenant_id = $4
            AND initial_sync_attempt_epoch_id = $5 AND initial_sync_attempt_id = $6
            AND status = 'RUNNING' AND initial_sync_completed_attempt_id IS NULL
          RETURNING initial_sync_completed_attempt_id::text AS completed, status::text AS status`,
        [succeeded, stateId, owner.scope.organizationId, owner.scope.customerTenantId, owner.epoch, operation.attemptId])
        assert.equal(pending.rowCount, 1)
        assert.deepEqual(pending.rows, [{ completed: operation.attemptId, status: 'SUCCEEDED' }])
      }
      await beginWriter()
      await completeFixture()
      await persistedOnly() // Uncommitted completion is invisible on this other connection.
      await writer.query('ROLLBACK'); writerBegan = false
      await persistedOnly()
      assert.deepEqual(await snapshot(owner.scope.organizationId), baseline, 'Acknowledged rollback restores the fixture')

      await beginWriter()
      await completeFixture()
      await persistedOnly()
      await writer.query('COMMIT'); writerBegan = false
      const committed = await readTerminal(reader, operation)
      assert.equal(committed.rows.length, 1)
      assert.equal(committed.rows[0]!.initialSyncCompletedAttemptId, operation.attemptId)
      assert.equal(committed.rows[0]!.lastSuccessfulAtUtc, succeeded)
      assert.equal(committed.result.kind, 'MATCHING_COMPLETION')
      assert.deepEqual(committed.result.operation, operation)
      assert.equal(early.result.kind, 'PERSISTED_ONLY', 'The earlier observation did not predict rollback or stop the later commit')

      const nextAttempt = randomUUID()
      await beginWriter()
      assert.equal((await writer.query(`UPDATE public.sync_states SET initial_sync_attempt_id = $1,
        initial_sync_persisted_attempt_id = $1, initial_sync_completed_attempt_id = NULL,
        status = 'RUNNING', last_attempt_at = $2 WHERE id = $3`, [nextAttempt, stamp('000900'), stateId])).rowCount, 1)
      assert.equal((await readTerminal(reader, operation)).result.kind, 'MATCHING_COMPLETION',
        'An uncommitted replacement cannot yet invalidate the reader snapshot')
      await writer.query('COMMIT'); writerBegan = false
      const afterReplacement = await snapshot(owner.scope.organizationId)
      const superseded = await readTerminal(reader, operation)
      assert.equal(superseded.rows[0]!.initialSyncAttemptId, nextAttempt)
      assert.equal(superseded.rows[0]!.initialSyncCompletedAttemptId, null)
      assert.equal(superseded.rows[0]!.lastSuccessfulAtUtc, succeeded, 'Retained old success cannot certify the new attempt')
      assert.equal(superseded.result.kind, 'SUPERSEDED')
      assert.equal(superseded.result.observed.attemptId, nextAttempt)
      assert.equal((await readTerminal(reader, { ...operation, attemptId: nextAttempt })).result.kind, 'PERSISTED_ONLY')
      assert.equal(committed.result.kind, 'MATCHING_COMPLETION', 'Saved observation is historical, not reserved authority')
      assert.equal((await readTerminal(reader, terminalOperation(sibling))).result.kind, 'MATCHING_COMPLETION')
      await reader.query('ROLLBACK'); readerBegan = false
      assert.deepEqual(await snapshot(owner.scope.organizationId), afterReplacement,
        'Read-only observation and rollback must not alter the independently committed attempt')
      assert.deepEqual(await snapshot(sibling.scope.organizationId), siblingBefore)
    } finally {
      const failures: unknown[] = []
      const clean = async (run: () => Promise<unknown>) => {
        try { await run() } catch (error) { failures.push(error) }
      }
      if (readerConnected && readerBegan) await clean(() => reader.query('ROLLBACK'))
      if (writerConnected && writerBegan) await clean(() => writer.query('ROLLBACK'))
      if (writerConnected) for (const organizationId of organizationIds) await clean(async () => {
        await writer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
        for (const table of ['customer_tenants', 'tenant_connections', 'sync_states']) {
          assert.equal((await writer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
        }
      })
      await clean(() => reader.end())
      await clean(() => writer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic terminal-order fixture cleanup failed')
    }
  })

test('HAW-77 coherent reader returns thirteen scoped precise receipts under non-default session settings', options,
  async () => transaction(async db => {
    const owner = await fixture(db)
    await db.query("SET LOCAL TIME ZONE 'America/Los_Angeles'")
    await db.query("SET LOCAL DateStyle = 'SQL, DMY'")
    await db.query('SET LOCAL search_path TO pg_catalog')
    // Optional role receipts are unrelated and must not multiply the projection.
    const roleId = randomUUID()
    await db.query(`INSERT INTO public.sync_states
      (id, organization_id, customer_tenant_id, resource_type, status, role_scope_version, role_scope_incarnation, updated_at)
      VALUES ($1, $2, $3, 'DIRECTORY_ROLES', 'FAILED', 'projection-fixture', $4, CURRENT_TIMESTAMP)`,
    [roleId, owner.scope.organizationId, owner.scope.customerTenantId, randomUUID()])
    const before = (await db.query('SELECT to_jsonb(s) AS row FROM public.sync_states s WHERE customer_tenant_id = $1 ORDER BY id', [owner.scope.customerTenantId])).rows
    const { rows, result } = await read(db, owner.scope)
    assert.equal(result.complete, true)
    assert.deepEqual(rows.map(row => row.expectedResourceType), [...INITIAL_SYNC_RESOURCE_TYPES])
    assert.equal(new Set(rows.map(row => row.observedAtUtc)).size, 1)
    for (const row of rows) {
      assert.equal(row.contextTimeValid, true)
      assert.equal(row.proofTimeValid, true)
      assert.equal(row.epochStartedAtUtc, start)
      assert.equal(row.lastAttemptAtUtc, attempted)
      assert.equal(row.lastSuccessfulAtUtc, succeeded)
      assert.match(String(row.observedAtUtc), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      assert.equal(row.organizationId, owner.scope.organizationId)
      assert.equal(row.customerTenantId, owner.scope.customerTenantId)
      assert.equal(row.initialSyncEpochId, owner.epoch)
      assert.equal(typeof row.lastAttemptAtUtc, 'string')
    }
    assert.deepEqual((await db.query('SELECT to_jsonb(s) AS row FROM public.sync_states s WHERE customer_tenant_id = $1 ORDER BY id', [owner.scope.customerTenantId])).rows, before)
  }))

test('HAW-77 reader preserves every missing slot and refuses foreign or absent tenant and connection context', options,
  async () => transaction(async db => {
    const owner = await fixture(db), sibling = await fixture(db)
    for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
      await savepoint(db, async () => {
        await db.query('DELETE FROM public.sync_states WHERE id = $1', [owner.states.get(resource)!.id])
        const { rows, result } = await read(db, owner.scope)
        assert.equal(rows.length, 13)
        const missing = rows.find(row => row.expectedResourceType === resource)!
        assert.equal(missing.stateId, null)
        assert.equal(missing.stateResourceType, null)
        assert.equal(missing.proofTimeValid, false)
        assert.deepEqual(result.incompleteResources, [resource])
        assert.equal((await read(db, sibling.scope)).result.complete, true)
      })
    }
    for (const scope of [{ ...owner.scope, organizationId: sibling.scope.organizationId },
      { ...owner.scope, customerTenantId: randomUUID() }]) {
      const actual = await read(db, scope)
      assert.deepEqual(actual.rows, [])
      assert.equal(actual.result.complete, false)
    }
    await savepoint(db, async () => {
      await db.query('DELETE FROM public.tenant_connections WHERE id = $1', [owner.connectionId])
      const actual = await read(db, owner.scope)
      assert.equal(actual.rows.length, 13)
      assert.ok(actual.rows.every(row => row.connectionId === null && row.contextTimeValid === false))
      assert.equal(actual.result.reason, 'INVALID_CONTEXT')
    })
    for (const status of ['PENDING_CONSENT', 'ERROR']) await savepoint(db, async () => {
      await db.query('UPDATE public.tenant_connections SET status = $1::public."TenantConnectionStatus" WHERE id = $2', [status, owner.connectionId])
      const actual = await read(db, owner.scope)
      assert.equal(actual.rows.length, 13, 'ineligible context is not prefiltered')
      assert.equal(actual.result.reason, 'INVALID_CONTEXT')
    })
    await db.query("UPDATE public.customer_tenants SET status = 'SUSPENDED' WHERE id = $1", [owner.scope.customerTenantId])
    assert.equal((await read(db, owner.scope)).result.reason, 'INVALID_CONTEXT')
  }))

test('HAW-77 SQL precision rejects microsecond epoch and order violations plus unsupported and future times', options,
  async () => transaction(async db => {
    const owner = await fixture(db), stateId = owner.states.get('SIGN_INS')!.id
    await savepoint(db, async () => {
      await db.query('UPDATE public.sync_states SET last_attempt_at = $1 WHERE id = $2', [stamp('000099'), stateId])
      const actual = await read(db, owner.scope), row = actual.rows.find(row => row.stateId === stateId)!
      assert.equal(new Date(row.lastAttemptAtUtc as string).getTime(), new Date(row.epochStartedAtUtc as string).getTime())
      assert.equal(row.proofTimeValid, false)
      assert.deepEqual(actual.result.incompleteResources, ['SIGN_INS'])
    })
    // Completed-time storage rejects this inversion; a persisted-only row may
    // retain an older success. Test the SQL predicate itself, not only mapping.
    await savepoint(db, async () => {
      await db.query(`UPDATE public.sync_states SET initial_sync_completed_attempt_id = NULL,
        last_successful_at = $1 WHERE id = $2`, [stamp('000199'), stateId])
      const actual = await read(db, owner.scope), row = actual.rows.find(row => row.stateId === stateId)!
      assert.equal(new Date(row.lastAttemptAtUtc as string).getTime(), new Date(row.lastSuccessfulAtUtc as string).getTime())
      assert.equal(row.proofTimeValid, false)
      assert.deepEqual(actual.result.incompleteResources, ['SIGN_INS'])
    })
    await savepoint(db, async () => {
      await db.query('UPDATE public.sync_states SET last_successful_at = $1 WHERE id = $2', ['9999-12-31T23:59:59.999999Z', stateId])
      const actual = await read(db, owner.scope)
      assert.equal(actual.rows.find(row => row.stateId === stateId)!.proofTimeValid, false)
      assert.equal(actual.result.complete, false)
    })
    for (const invalid of ['infinity', '-infinity', '0001-01-01 00:00:00+00 BC', '10000-01-01 00:00:00+00']) {
      await savepoint(db, async () => {
        await db.query(`UPDATE public.sync_states SET initial_sync_completed_attempt_id = NULL,
          last_successful_at = $1 WHERE id = $2`, [invalid, stateId])
        const actual = await read(db, owner.scope), row = actual.rows.find(row => row.stateId === stateId)!
        assert.equal(row.lastSuccessfulAtUtc, null, invalid)
        assert.equal(row.proofTimeValid, false, invalid)
        assert.equal(actual.result.complete, false)
      })
    }
    for (const invalid of ['0001-01-01 00:00:00+00 BC', '10000-01-01 00:00:00+00', '9999-12-31T23:59:59.999999Z']) {
      await savepoint(db, async () => {
        await db.query('UPDATE public.tenant_connections SET initial_sync_epoch_started_at = $1 WHERE id = $2', [invalid, owner.connectionId])
        const actual = await read(db, owner.scope)
        assert.ok(actual.rows.every(row => row.contextTimeValid === false))
        assert.equal(actual.result.reason, 'INVALID_CONTEXT')
      })
    }
  }))

test('HAW-77 reader retains current legacy failed and replaced-attempt rows without fallback to old success', options,
  async () => transaction(async db => {
    const owner = await fixture(db), stateId = owner.states.get('SIGN_INS')!.id
    await savepoint(db, async () => {
      await db.query('UPDATE public.tenant_connections SET initial_sync_epoch_id = $1 WHERE id = $2', [randomUUID(), owner.connectionId])
      const actual = await read(db, owner.scope)
      assert.equal(actual.rows.length, 13)
      assert.deepEqual(actual.result.incompleteResources, [...INITIAL_SYNC_RESOURCE_TYPES])
    })
    await savepoint(db, async () => {
      await db.query(`UPDATE public.sync_states SET initial_sync_attempt_epoch_id = NULL, initial_sync_attempt_id = NULL,
        initial_sync_persisted_attempt_id = NULL, initial_sync_completed_attempt_id = NULL,
        initial_sync_persisted_kind = NULL WHERE id = $1`, [stateId])
      const actual = await read(db, owner.scope)
      assert.equal(actual.rows.find(row => row.stateId === stateId)!.status, 'SUCCEEDED')
      assert.deepEqual(actual.result.incompleteResources, ['SIGN_INS'])
    })
    await db.query(`UPDATE public.sync_states SET initial_sync_attempt_id = $1, initial_sync_persisted_attempt_id = NULL,
      initial_sync_completed_attempt_id = NULL, initial_sync_persisted_kind = NULL,
      status = 'RUNNING', last_attempt_at = $2 WHERE id = $3`, [randomUUID(), stamp('000801'), stateId])
    let actual = await read(db, owner.scope)
    assert.equal(actual.rows.find(row => row.stateId === stateId)!.lastSuccessfulAtUtc, succeeded)
    assert.deepEqual(actual.result.incompleteResources, ['SIGN_INS'])
    await db.query(`UPDATE public.sync_states SET initial_sync_persisted_attempt_id = initial_sync_attempt_id,
      initial_sync_persisted_kind = 'GRAPH_SIGN_INS', status = 'FAILED',
      last_error_message = 'Synthetic failure after persistence' WHERE id = $1`, [stateId])
    actual = await read(db, owner.scope)
    assert.equal(actual.rows.find(row => row.stateId === stateId)!.status, 'FAILED')
    assert.deepEqual(actual.result.incompleteResources, ['SIGN_INS'])
  }))

test('HAW-77 two-client reader sees committed snapshots and an old result never reserves current epoch authority', options,
  async () => {
    const reader = client(), writer = client()
    let owner: Fixture | undefined, writerBegan = false, readerBegan = false
    try {
      await reader.connect()
      await writer.connect()
      await writer.query('BEGIN'); writerBegan = true
      await settings(writer)
      owner = await fixture(writer)
      await writer.query('COMMIT'); writerBegan = false
      await reader.query('BEGIN READ ONLY'); readerBegan = true
      await settings(reader)
      const first = await read(reader, owner.scope)
      assert.equal(first.result.complete, true)
      const nextEpoch = randomUUID()
      await writer.query('BEGIN'); writerBegan = true
      await settings(writer)
      await writer.query('UPDATE public.tenant_connections SET initial_sync_epoch_id = $1 WHERE id = $2', [nextEpoch, owner.connectionId])
      for (const state of owner.states.values()) {
        const nextAttempt = randomUUID()
        await writer.query(`UPDATE public.sync_states SET initial_sync_attempt_epoch_id = $1, initial_sync_attempt_id = $2,
          initial_sync_persisted_attempt_id = $2, initial_sync_completed_attempt_id = $2 WHERE id = $3`,
        [nextEpoch, nextAttempt, state.id])
      }
      const uncommitted = await read(reader, owner.scope)
      assert.equal(uncommitted.result.complete, true)
      assert.ok(uncommitted.rows.every(row => row.initialSyncEpochId === owner!.epoch && row.initialSyncAttemptEpochId === owner!.epoch))
      await writer.query('ROLLBACK'); writerBegan = false
      assert.ok((await read(reader, owner.scope)).rows.every(row => row.initialSyncEpochId === owner!.epoch))
      // Commit only an epoch replacement: all old resource facts must be stale.
      await writer.query('BEGIN'); writerBegan = true
      await settings(writer)
      await writer.query('UPDATE public.tenant_connections SET initial_sync_epoch_id = $1 WHERE id = $2', [nextEpoch, owner.connectionId])
      await writer.query('COMMIT'); writerBegan = false
      const current = await read(reader, owner.scope)
      assert.ok(current.rows.every(row => row.initialSyncEpochId === nextEpoch && row.initialSyncAttemptEpochId === owner!.epoch))
      assert.equal(current.result.complete, false)
      assert.equal(validateInitialSyncCompletionProjection(owner.scope, first.rows).complete, true,
        'saved rows still describe the earlier snapshot; notice mutation must recheck locked authority')
    } finally {
      try {
        if (readerBegan) await reader.query('ROLLBACK')
        if (writerBegan) await writer.query('ROLLBACK')
        if (owner) await writer.query('DELETE FROM public.organizations WHERE id = $1', [owner.scope.organizationId])
      } finally { await Promise.all([reader.end(), writer.end()]) }
    }
  })

test('HAW-77 actual Prisma read-only transactions preserve scoped microsecond evidence and committed invalidation',
  { ...options, timeout: 60_000 }, async () => {
    // Refuse every nonregistered target before loading or constructing Prisma.
    const url = assertDisposableTestDatabase(process.env, { requireUtc: true })
    assert.equal(url.port, '5432', 'Only registered hosted disposable PostgreSQL is permitted')
    const [{ PrismaClient }, { createAdapter }] = await Promise.all([
      import('../generated/prisma/client.js'), import('../prisma/prisma.service.js'),
    ])
    const observer = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 })
    const prisma = new PrismaClient({ adapter: createAdapter(url.toString()) })
    // Keep cleanup identities even if fixture creation fails before returning.
    const organizationIds = [randomUUID(), randomUUID()]
    let connected = false, began = false
    const snapshot = async (organizationId: string) => {
      const output: Record<string, string[]> = {}
      for (const table of ['customer_tenants', 'tenant_connections', 'sync_states']) {
        output[table] = (await observer.query(`SELECT to_jsonb(t)::text AS data
          FROM public.${table} t WHERE organization_id = $1 ORDER BY id`, [organizationId])).rows.map(row => row.data)
      }
      return output
    }
    const readPrisma = async (tx: Prisma.TransactionClient, scope: InitialSyncProofScope) => {
      let calls = 0
      let rows: Row[] = []
      const result = await readInitialSyncProof(scope, async (sql, values) => {
        calls++
        // Execute the real query and return the real decoded array unchanged.
        rows = await tx.$queryRawUnsafe<Row[]>(sql, ...values)
        return rows
      })
      assert.equal(calls, 1)
      return { rows, result }
    }
    const readOnly = (run: (tx: Prisma.TransactionClient) => Promise<void>) => prisma.$transaction(async tx => {
      // Must precede the first query: a wrapper alone does not enforce read-only.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_read_only'), [{ transaction_read_only: 'on' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_isolation'), [{ transaction_isolation: 'read committed' }])
      // This observes UTC; it does not independently prove the onConnect hook
      // caused it, since the hosted database can also default to UTC.
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW TimeZone'), [{ TimeZone: 'UTC' }])
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kathmandu'")
      await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'SQL, DMY'")
      await tx.$executeRawUnsafe('SET LOCAL search_path TO pg_catalog')
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW TimeZone'), [{ TimeZone: 'Asia/Kathmandu' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW DateStyle'), [{ DateStyle: 'SQL, DMY' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW search_path'), [{ search_path: 'pg_catalog' }])
      await run(tx)
    }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 20_000 })
    try {
      await observer.connect(); connected = true
      await observer.query("SET statement_timeout = '5s'")
      await observer.query("SET lock_timeout = '2s'")
      await observer.query('BEGIN'); began = true
      const owner = await fixture(observer, organizationIds[0]!)
      const sibling = await fixture(observer, organizationIds[1]!)
      await observer.query('COMMIT'); began = false
      const before = await snapshot(owner.scope.organizationId)
      const siblingBefore = await snapshot(sibling.scope.organizationId)
      let afterObserverChanges: Record<string, string[]> | undefined
      const rollback = new Error('EXPECTED_PRISMA_PROOF_READ_ROLLBACK')
      await assert.rejects(readOnly(async tx => {
        const first = await readPrisma(tx, owner.scope)
        assert.equal(first.result.complete, true)
        assert.deepEqual(first.rows.map(row => row.expectedResourceType), [...INITIAL_SYNC_RESOURCE_TYPES])
        assert.equal(new Set(first.rows.map(row => row.observedAtUtc)).size, 1)
        for (const row of first.rows) {
          assert.equal(row.organizationId, owner.scope.organizationId)
          assert.equal(row.customerTenantId, owner.scope.customerTenantId)
          assert.equal(row.connectionId, owner.connectionId)
          assert.equal(row.initialSyncEpochId, owner.epoch)
          assert.equal(typeof row.stateId, 'string')
          assert.equal(row.epochStartedAtUtc, start)
          assert.equal(row.lastAttemptAtUtc, attempted)
          assert.equal(row.lastSuccessfulAtUtc, succeeded)
          assert.equal(typeof row.observedAtUtc, 'string')
          assert.match(row.observedAtUtc as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
          assert.equal(row.contextTimeValid, true)
          assert.equal(row.proofTimeValid, true)
        }
        assert.deepEqual(await snapshot(owner.scope.organizationId), before)
        const foreign = await readPrisma(tx, { ...owner.scope, organizationId: sibling.scope.organizationId })
        assert.deepEqual(foreign.rows, [])
        assert.equal(foreign.result.complete, false)
        const stateId = owner.states.get('SIGN_INS')!.id
        // Autocommit through the separate observer. Each subsequent SELECT in
        // this same ReadCommitted transaction must see the committed change.
        assert.equal((await observer.query('UPDATE public.sync_states SET last_attempt_at = $1 WHERE id = $2',
          [stamp('000099'), stateId])).rowCount, 1)
        const inverted = await readPrisma(tx, owner.scope)
        const invertedRow = inverted.rows.find(row => row.stateId === stateId)!
        assert.equal(invertedRow.lastAttemptAtUtc, stamp('000099'))
        assert.equal(new Date(invertedRow.lastAttemptAtUtc as string).getTime(), new Date(invertedRow.epochStartedAtUtc as string).getTime())
        assert.equal(invertedRow.proofTimeValid, false)
        assert.deepEqual(inverted.result.incompleteResources, ['SIGN_INS'])

        assert.equal((await observer.query(`UPDATE public.sync_states SET last_attempt_at = $1,
          initial_sync_completed_attempt_id = NULL, status = 'FAILED', last_error_message = 'Synthetic persisted-only failure'
          WHERE id = $2`, [attempted, stateId])).rowCount, 1)
        const failed = await readPrisma(tx, owner.scope)
        const failedRow = failed.rows.find(row => row.stateId === stateId)!
        assert.equal(failedRow.proofTimeValid, true, 'Valid times alone cannot certify a failed attempt')
        assert.equal(failedRow.initialSyncCompletedAttemptId, null)
        assert.equal(failedRow.status, 'FAILED')
        assert.equal(failedRow.lastErrorMessage, 'Synthetic persisted-only failure')
        assert.deepEqual(failed.result.incompleteResources, ['SIGN_INS'])

        assert.equal((await observer.query('DELETE FROM public.sync_states WHERE id = $1', [stateId])).rowCount, 1)
        const missing = await readPrisma(tx, owner.scope)
        assert.equal(missing.rows.length, 13)
        const missingRow = missing.rows.find(row => row.expectedResourceType === 'SIGN_INS')!
        for (const field of ['stateId', 'stateOrganizationId', 'stateCustomerTenantId', 'stateResourceType',
          'initialSyncAttemptEpochId', 'initialSyncAttemptId', 'initialSyncPersistedAttemptId',
          'initialSyncCompletedAttemptId', 'initialSyncPersistedKind', 'status', 'lastAttemptAtUtc',
          'lastSuccessfulAtUtc', 'lastErrorCode', 'lastErrorMessage']) assert.equal(missingRow[field], null, field)
        assert.equal(missingRow.proofTimeValid, false)
        assert.deepEqual(missing.result.incompleteResources, ['SIGN_INS'])
        assert.equal((await readPrisma(tx, sibling.scope)).result.complete, true)
        afterObserverChanges = await snapshot(owner.scope.organizationId)
        throw rollback
      }), error => error === rollback)
      assert.ok(afterObserverChanges)
      assert.deepEqual(await snapshot(owner.scope.organizationId), afterObserverChanges,
        'Rolling back the read-only transaction cannot undo separately committed fixture changes')
      await readOnly(async tx => {
        assert.deepEqual((await readPrisma(tx, owner.scope)).result.incompleteResources, ['SIGN_INS'])
        assert.equal((await readPrisma(tx, sibling.scope)).result.complete, true)
      })
      assert.deepEqual(await snapshot(owner.scope.organizationId), afterObserverChanges)
      assert.deepEqual(await snapshot(sibling.scope.organizationId), siblingBefore)
    } finally {
      const failures: unknown[] = []
      const clean = async (operation: () => Promise<unknown>) => {
        try { await operation() } catch (error) { failures.push(error) }
      }
      // Prisma callbacks are awaited above before scoped cleanup. If setup
      // failed, roll back any incomplete fixture transaction first.
      if (connected) {
        if (began) await clean(() => observer.query('ROLLBACK'))
        for (const organizationId of organizationIds) await clean(async () => {
          await observer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
          for (const table of ['customer_tenants', 'tenant_connections', 'sync_states']) {
            assert.equal((await observer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
          }
        })
      }
      await clean(() => prisma.$disconnect())
      await clean(() => observer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic Prisma proof-reader cleanup failed')
    }
  })

test('HAW-77 terminal readback through actual Prisma preserves precise null invalid and replaced evidence',
  { ...options, timeout: 60_000 }, async () => {
    // Refuse nonregistered targets before Prisma import or client construction.
    const url = assertDisposableTestDatabase(process.env, { requireUtc: true })
    assert.equal(url.port, '5432', 'Only registered hosted disposable PostgreSQL is permitted')
    const [{ PrismaClient }, { createAdapter }] = await Promise.all([
      import('../generated/prisma/client.js'), import('../prisma/prisma.service.js'),
    ])
    const observer = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 25_000 })
    const prisma = new PrismaClient({ adapter: createAdapter(url.toString()) })
    const organizationIds = [randomUUID(), randomUUID()]
    let connected = false, began = false
    const snapshot = async (organizationId: string) => {
      const output: Record<string, string[]> = {}
      for (const table of ['customer_tenants', 'tenant_connections', 'sync_states']) {
        output[table] = (await observer.query(`SELECT to_jsonb(t)::text AS data
          FROM public.${table} t WHERE organization_id = $1 ORDER BY id`, [organizationId])).rows.map(row => row.data)
      }
      return output
    }
    const readPrisma = async (tx: Prisma.TransactionClient, operation: InitialSyncTerminalOperation) => {
      let calls = 0
      let rows: Row[] = []
      const result = await readInitialSyncTerminalEvidence(operation, async (sql, values) => {
        calls++
        // Return the actual Prisma-decoded array without a synthetic projection.
        rows = await tx.$queryRawUnsafe<Row[]>(sql, ...values)
        return rows
      })
      assert.equal(calls, 1)
      return { rows, result }
    }
    const readOnly = (run: (tx: Prisma.TransactionClient) => Promise<void>) => prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_read_only'), [{ transaction_read_only: 'on' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_isolation'), [{ transaction_isolation: 'read committed' }])
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kathmandu'")
      await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'SQL, DMY'")
      await tx.$executeRawUnsafe('SET LOCAL search_path TO pg_catalog')
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW TimeZone'), [{ TimeZone: 'Asia/Kathmandu' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW DateStyle'), [{ DateStyle: 'SQL, DMY' }])
      assert.deepEqual(await tx.$queryRawUnsafe('SHOW search_path'), [{ search_path: 'pg_catalog' }])
      await run(tx)
    }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 20_000 })
    try {
      await observer.connect(); connected = true
      await observer.query("SET statement_timeout = '5s'")
      await observer.query("SET lock_timeout = '2s'")
      await observer.query('BEGIN'); began = true
      const owner = await fixture(observer, organizationIds[0]!)
      const sibling = await fixture(observer, organizationIds[1]!)
      await observer.query('COMMIT'); began = false
      const before = await snapshot(owner.scope.organizationId), siblingBefore = await snapshot(sibling.scope.organizationId)
      const operation = terminalOperation(owner), stateId = owner.states.get('SIGN_INS')!.id
      const nextAttempt = randomUUID()
      let afterObserverChanges: Record<string, string[]> | undefined
      const rollback = new Error('EXPECTED_PRISMA_TERMINAL_READ_ROLLBACK')
      await assert.rejects(readOnly(async tx => {
        for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
          const expected = terminalOperation(owner, resource), actual = await readPrisma(tx, expected)
          assert.equal(actual.rows.length, 1)
          const row = actual.rows[0]!
          assert.equal(row.organizationId, owner.scope.organizationId)
          assert.equal(row.customerTenantId, owner.scope.customerTenantId)
          assert.equal(row.connectionId, owner.connectionId)
          assert.equal(row.stateId, owner.states.get(resource)!.id)
          assert.equal(row.expectedResourceType, resource)
          assert.equal(row.stateResourceType, resource)
          assert.equal(row.initialSyncEpochId, owner.epoch)
          assert.equal(row.initialSyncAttemptId, expected.attemptId)
          assert.equal(row.epochStartedAtUtc, start)
          assert.equal(row.lastAttemptAtUtc, attempted)
          assert.equal(row.lastSuccessfulAtUtc, succeeded)
          assert.equal(typeof row.observedAtUtc, 'string')
          assert.match(row.observedAtUtc as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
          assert.equal(actual.result.kind, 'MATCHING_COMPLETION')
          assert.deepEqual(actual.result.operation, expected)
          assert.equal(actual.result.observed.atUtc, row.observedAtUtc)
        }
        assert.deepEqual(await snapshot(owner.scope.organizationId), before)
        const foreign = await readPrisma(tx, { ...operation, organizationId: sibling.scope.organizationId })
        assert.deepEqual(foreign.rows, [])
        assert.equal(foreign.result.kind, 'UNKNOWN')
        // Each change is acknowledged and autocommitted on another connection.
        // This tests ReadCommitted visibility, not a lost result or late arrival.
        assert.equal((await observer.query(`UPDATE public.sync_states SET initial_sync_completed_attempt_id = NULL,
          status = 'FAILED', last_error_message = 'Synthetic terminal transport fixture',
          last_successful_at = NULL WHERE id = $1`, [stateId])).rowCount, 1)
        const missingSuccess = await readPrisma(tx, operation)
        assert.equal(missingSuccess.rows[0]!.lastSuccessfulAtUtc, null)
        assert.equal(missingSuccess.rows[0]!.initialSyncCompletedAttemptId, null)
        assert.equal(missingSuccess.result.kind, 'PERSISTED_ONLY')
        assert.equal(missingSuccess.result.observed.status, 'FAILED')
        for (const invalid of ['infinity', '-infinity', '0001-01-01 00:00:00+00 BC', '10000-01-01 00:00:00+00']) {
          assert.equal((await observer.query('UPDATE public.sync_states SET last_successful_at = $1 WHERE id = $2',
            [invalid, stateId])).rowCount, 1)
          const actual = await readPrisma(tx, operation)
          assert.equal(actual.rows[0]!.lastSuccessfulAtUtc, 'INVALID_TIMESTAMP', invalid)
          assert.equal(actual.result.kind, 'UNKNOWN', invalid)
        }
        assert.equal((await observer.query(`UPDATE public.sync_states SET last_successful_at = $1,
          initial_sync_completed_attempt_id = initial_sync_attempt_id, status = 'SUCCEEDED',
          last_error_message = NULL, last_attempt_at = $2 WHERE id = $3`, [succeeded, stamp('000099'), stateId])).rowCount, 1)
        const inverted = await readPrisma(tx, operation), invertedRow = inverted.rows[0]!
        assert.equal(invertedRow.lastAttemptAtUtc, stamp('000099'))
        assert.equal(new Date(invertedRow.lastAttemptAtUtc as string).getTime(), new Date(invertedRow.epochStartedAtUtc as string).getTime())
        assert.equal(inverted.result.kind, 'UNKNOWN', 'Prisma must not round a pre-epoch attempt into valid evidence')
        assert.equal((await observer.query('UPDATE public.sync_states SET last_attempt_at = $1 WHERE id = $2',
          [attempted, stateId])).rowCount, 1)
        assert.equal((await readPrisma(tx, operation)).result.kind, 'MATCHING_COMPLETION')
        const nextEpoch = randomUUID()
        assert.equal((await observer.query('UPDATE public.tenant_connections SET initial_sync_epoch_id = $1 WHERE id = $2',
          [nextEpoch, owner.connectionId])).rowCount, 1)
        const replacedEpoch = await readPrisma(tx, operation)
        assert.equal(replacedEpoch.rows[0]!.initialSyncEpochId, nextEpoch)
        assert.equal(replacedEpoch.rows[0]!.initialSyncAttemptEpochId, owner.epoch)
        assert.equal(replacedEpoch.result.kind, 'SUPERSEDED')
        assert.equal((await readPrisma(tx, { ...operation, epochId: nextEpoch })).result.kind, 'UNKNOWN')
        assert.equal((await observer.query('UPDATE public.tenant_connections SET initial_sync_epoch_id = $1 WHERE id = $2',
          [owner.epoch, owner.connectionId])).rowCount, 1)
        assert.equal((await observer.query(`UPDATE public.sync_states SET initial_sync_attempt_id = $1,
          initial_sync_persisted_attempt_id = $1, initial_sync_completed_attempt_id = $1 WHERE id = $2`,
        [nextAttempt, stateId])).rowCount, 1)
        const replacedAttempt = await readPrisma(tx, operation)
        assert.equal(replacedAttempt.rows[0]!.initialSyncAttemptId, nextAttempt)
        assert.equal(replacedAttempt.result.kind, 'SUPERSEDED')
        assert.equal((await readPrisma(tx, { ...operation, attemptId: nextAttempt })).result.kind, 'MATCHING_COMPLETION')
        assert.equal((await readPrisma(tx, terminalOperation(sibling))).result.kind, 'MATCHING_COMPLETION')
        afterObserverChanges = await snapshot(owner.scope.organizationId)
        throw rollback
      }), error => error === rollback)
      assert.ok(afterObserverChanges)
      assert.deepEqual(await snapshot(owner.scope.organizationId), afterObserverChanges,
        'Read-only rollback must not undo acknowledged changes from the other connection')
      await readOnly(async tx => {
        assert.equal((await readPrisma(tx, operation)).result.kind, 'SUPERSEDED')
        assert.equal((await readPrisma(tx, { ...operation, attemptId: nextAttempt })).result.kind, 'MATCHING_COMPLETION')
      })
      assert.deepEqual(await snapshot(owner.scope.organizationId), afterObserverChanges)
      assert.deepEqual(await snapshot(sibling.scope.organizationId), siblingBefore)
    } finally {
      const failures: unknown[] = []
      const clean = async (operation: () => Promise<unknown>) => {
        try { await operation() } catch (error) { failures.push(error) }
      }
      // Await both Prisma transactions before scoped fixture cleanup.
      if (connected) {
        if (began) await clean(() => observer.query('ROLLBACK'))
        for (const organizationId of organizationIds) await clean(async () => {
          await observer.query('DELETE FROM public.organizations WHERE id = $1', [organizationId])
          for (const table of ['customer_tenants', 'tenant_connections', 'sync_states']) {
            assert.equal((await observer.query(`SELECT 1 FROM public.${table} WHERE organization_id = $1`, [organizationId])).rowCount, 0)
          }
        })
      }
      await clean(() => prisma.$disconnect())
      await clean(() => observer.end())
      if (failures.length) throw new AggregateError(failures, 'Synthetic Prisma terminal-reader cleanup failed')
    }
  })
