import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import { INITIAL_SYNC_TERMINAL_READBACK_QUERY as SQL, readInitialSyncTerminalEvidence as read } from './initial-sync-terminal-readback.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const stamp = (part: string) => `2026-11-17T17:00:00.${part}Z`
function operation(resourceType = 'SIGN_INS') {
  return { organizationId: id(1), customerTenantId: id(2), connectionId: id(3), epochId: id(4),
    attemptId: id(5), resourceType, persistedKind: resourceType === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE' }
}
function row(resource = 'SIGN_INS'): Record<string, unknown> {
  const op = operation(resource)
  return { organizationId: op.organizationId, customerTenantId: op.customerTenantId, tenantStatus: 'ACTIVE',
    connectionId: op.connectionId, connectionOrganizationId: op.organizationId, connectionCustomerTenantId: op.customerTenantId,
    connectionStatus: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED', initialSyncEpochId: op.epochId,
    epochStartedAtUtc: stamp('000100'), observedAtUtc: stamp('000900'), expectedResourceType: resource,
    stateId: id(6), stateOrganizationId: op.organizationId, stateCustomerTenantId: op.customerTenantId, stateResourceType: resource,
    initialSyncAttemptEpochId: op.epochId, initialSyncAttemptId: op.attemptId, initialSyncPersistedAttemptId: op.attemptId,
    initialSyncCompletedAttemptId: op.attemptId, initialSyncPersistedKind: op.persistedKind, status: 'SUCCEEDED',
    lastAttemptAtUtc: stamp('000200'), lastSuccessfulAtUtc: stamp('000800'), lastErrorCode: null, lastErrorMessage: null }
}

test('one read binds only captured scope/resource; exact completion remains an observation', async () => {
  for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
    let calls = 0
    const op = operation(resource)
    const result = await read(op, async (sql, values) => {
      calls++
      assert.equal(sql, SQL)
      assert.deepEqual(values, [op.organizationId, op.customerTenantId, resource])
      assert.ok(Object.isFrozen(values))
      for (const value of [op.organizationId, op.customerTenantId, op.connectionId, op.epochId, op.attemptId]) assert.ok(!sql.includes(value))
      return [row(resource)]
    })
    assert.equal(calls, 1)
    assert.equal(result.kind, 'MATCHING_COMPLETION')
    assert.deepEqual(result.operation, op)
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'observed', 'operation'])
  }
})

test('invalid scope, epoch, attempt, source or resource is rejected before query', async () => {
  const invalid = [null, {}, [], true, Object.create(operation())]
  for (const key of Object.keys(operation())) {
    for (const value of [null, '', undefined, true, '00000000-0000-0000-0000-000000000000', "bad'; SELECT 1 --"]) {
      invalid.push({ ...operation(), [key]: value })
    }
  }
  invalid.push({ ...operation(), resourceType: 'DIRECTORY_ROLES' }, { ...operation(), persistedKind: 'FULL_RESOURCE' })
  for (const op of invalid) {
    let calls = 0
    assert.deepEqual(await read(op, async () => { calls++; throw new Error('must not execute') }),
      { kind: 'UNKNOWN', reason: 'INVALID_OPERATION' })
    assert.equal(calls, 0)
  }
})

test('operation mutation while read is pending cannot relabel its result or query values', async () => {
  const op = operation()
  let resolve!: (value: unknown) => void
  const pending = read(op, async (_sql, values) => {
    assert.deepEqual(values, [id(1), id(2), 'SIGN_INS'])
    return new Promise(r => { resolve = r })
  })
  Object.assign(op, { organizationId: id(91), customerTenantId: id(92), connectionId: id(93), epochId: id(94),
    attemptId: id(95), resourceType: 'USERS', persistedKind: 'FULL_RESOURCE' })
  resolve([row()])
  const result = await pending
  assert.equal(result.kind, 'MATCHING_COMPLETION')
  assert.deepEqual(result.operation, operation())
  assert.ok(Object.isFrozen(result.operation))

  const changed = operation()
  const rejected = await read(changed, async () => {
    changed.organizationId = id(91)
    return [{ ...row(), organizationId: changed.organizationId, connectionOrganizationId: changed.organizationId,
      stateOrganizationId: changed.organizationId }]
  })
  assert.equal(rejected.kind, 'UNKNOWN')
})

test('rejection or synchronous executor failure stays unavailable with no retry or error reflection', async () => {
  for (const failure of [new Error('private transport detail'), null, 'private transport detail']) {
    let calls = 0
    const result = await read(operation(), async () => { calls++; throw failure })
    assert.deepEqual(result, { kind: 'UNKNOWN', reason: 'READ_UNAVAILABLE' })
    assert.equal(calls, 1)
    assert.ok(Object.isFrozen(result))
  }
  assert.deepEqual(await read(operation(), () => { throw new Error('synchronous failure') }),
    { kind: 'UNKNOWN', reason: 'READ_UNAVAILABLE' })
})

test('raw results are not unwrapped, truncated, coerced or substituted on missing evidence', async () => {
  for (const output of [[], [null], [row(), row()], { rows: [row()] }, JSON.stringify([row()]), null, new Array(1)]) {
    assert.equal((await read(operation(), async () => output)).kind, 'UNKNOWN')
  }
  for (const patch of [{ stateOrganizationId: id(99) }, { stateCustomerTenantId: id(99) }, { stateId: null },
    { status: 'FAILED' }, { initialSyncAttemptId: null }, { lastSuccessfulAtUtc: new Date() }]) {
    assert.equal((await read(operation(), async () => [{ ...row(), ...patch }])).kind, 'UNKNOWN')
  }
})

test('new epoch retains historical row identity; newer attempt is not filtered into absence', async () => {
  const result = await read(operation(), async () => [{ ...row(), initialSyncEpochId: id(99), epochStartedAtUtc: stamp('000850') }])
  assert.equal(result.kind, 'SUPERSEDED')
  assert.equal(result.observed.epochId, id(99))
  assert.equal(result.observed.attemptEpochId, id(4))
  const next = await read(operation(), async () => [{ ...row(), initialSyncAttemptId: id(99),
    initialSyncPersistedAttemptId: id(99), initialSyncCompletedAttemptId: id(99) }])
  assert.equal(next.kind, 'SUPERSEDED')
  assert.equal(next.operation.attemptId, id(5))
  assert.equal(next.observed.attemptId, id(99))
})

test('retained persistence with genuine null success differs from invalid SQL timestamp sentinel', async () => {
  const partial = { ...row(), status: 'FAILED', initialSyncCompletedAttemptId: null,
    lastSuccessfulAtUtc: null, lastErrorCode: 'original-error' }
  const result = await read(operation(), async () => [partial])
  assert.equal(result.kind, 'PERSISTED_ONLY')
  assert.equal(result.observed.status, 'FAILED')
  for (const value of ['INVALID_TIMESTAMP', 'infinity', '-infinity', '0000-01-01T00:00:00.000000Z']) {
    assert.equal((await read(operation(), async () => [{ ...partial, lastSuccessfulAtUtc: value }])).kind, 'UNKNOWN')
  }
})

test('same-millisecond invalid time stays unproved and cannot be overridden by extra validity flags', async () => {
  assert.equal((await read(operation(), async () => [{ ...row(), lastSuccessfulAtUtc: stamp('000199'), proofTimeValid: true }])).kind, 'UNKNOWN')
})

test('decoding defects remain visible outside the executor rejection catch', async () => {
  const corrupt = row()
  const defect = new Error('synthetic decoder access failure')
  Object.defineProperty(corrupt, 'status', { get() { throw defect } })
  await assert.rejects(read(operation(), async () => [corrupt]), error => error === defect)
})

test('static query preserves scopes, missing rows and timestamp invalidity without action statements', () => {
  assert.deepEqual([...new Set(SQL.match(/\$\d+/g))].sort(), ['$1', '$2', '$3'])
  const where = SQL.slice(SQL.indexOf('WHERE ')).trim()
  assert.equal(where, 'WHERE tenant.organization_id = $1::uuid AND tenant.id = $2::uuid')
  assert.match(SQL, /LEFT JOIN public\.tenant_connections AS connection/)
  assert.match(SQL, /LEFT JOIN public\.sync_states AS state/)
  assert.match(SQL, /state\.organization_id = tenant\.organization_id/)
  assert.match(SQL, /state\.customer_tenant_id = tenant\.id/)
  assert.match(SQL, /state\.resource_type = \$3::public\."SyncResourceType"/)
  assert.equal((SQL.match(/statement_timestamp\(\)/g) ?? []).length, 1)
  assert.doesNotMatch(SQL, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR UPDATE|SKIP LOCKED|LIMIT|DISTINCT|COALESCE)\b/i)
  for (const column of ['connection.initial_sync_epoch_started_at', 'observation.observed_at', 'state.last_attempt_at', 'state.last_successful_at']) {
    assert.ok(SQL.includes(`CASE WHEN ${column} IS NULL THEN NULL`))
    assert.ok(SQL.includes(`WHEN isfinite(${column})`))
    assert.ok(SQL.includes(`${column} >= TIMESTAMPTZ '0001-01-01 00:00:00+00'`))
    assert.ok(SQL.includes(`${column} < TIMESTAMPTZ '10000-01-01 00:00:00+00'`))
    assert.ok(SQL.includes(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`))
  }
  assert.equal((SQL.match(/ELSE 'INVALID_TIMESTAMP' END/g) ?? []).length, 4)
  assert.deepEqual([...SQL.matchAll(/AS "([^"]+)"/g)].map(x => x[1]).sort(), Object.keys(row()).sort())
})
