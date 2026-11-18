import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import { INITIAL_SYNC_PROOF_QUERY, readInitialSyncProof } from './initial-sync-proof-reader.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const scope = { organizationId: id(1), customerTenantId: id(2) }
function rowsFor(requestedScope = scope) {
  return INITIAL_SYNC_RESOURCE_TYPES.map((resourceType, index) => ({
    ...requestedScope, tenantStatus: 'ACTIVE', connectionId: id(3),
    connectionOrganizationId: requestedScope.organizationId,
    connectionCustomerTenantId: requestedScope.customerTenantId,
    connectionStatus: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    initialSyncEpochId: id(4), epochStartedAtUtc: '2026-11-16T20:00:00.000100Z',
    observedAtUtc: '2026-11-16T20:00:00.000900Z', contextTimeValid: true,
    expectedResourceType: resourceType, stateId: id(100 + index),
    stateOrganizationId: requestedScope.organizationId,
    stateCustomerTenantId: requestedScope.customerTenantId, stateResourceType: resourceType,
    initialSyncAttemptEpochId: id(4), initialSyncAttemptId: id(200 + index),
    initialSyncPersistedAttemptId: id(200 + index), initialSyncCompletedAttemptId: id(200 + index),
    initialSyncPersistedKind: resourceType === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE',
    status: 'SUCCEEDED', lastAttemptAtUtc: '2026-11-16T20:00:00.000200Z',
    lastSuccessfulAtUtc: '2026-11-16T20:00:00.000800Z',
    lastErrorCode: null, lastErrorMessage: null, proofTimeValid: true,
  }))
}

test('one read supplies frozen scoped values and all thirteen enum values to the static query', async () => {
  let calls = 0
  const result = await readInitialSyncProof(scope, async (sql, values) => {
    calls++
    assert.equal(sql, INITIAL_SYNC_PROOF_QUERY)
    assert.deepEqual(values, [scope.organizationId, scope.customerTenantId, ...INITIAL_SYNC_RESOURCE_TYPES])
    assert.equal(Object.isFrozen(values), true)
    assert.equal(sql.includes(scope.organizationId), false)
    return rowsFor()
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { complete: true, reason: 'COMPLETE', incompleteResources: [] })
})

test('invalid canonical or nil scope is rejected before any query', async () => {
  for (const invalid of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000',
    'aaaaaaaa-AAAA-4000-8000-000000000001', `${id(1)} `, `${id(1)}'; SELECT 1 --`]) {
    for (const field of ['organizationId', 'customerTenantId']) {
      let calls = 0
      const result = await readInitialSyncProof({ ...scope, [field]: invalid }, async () => { calls++; return rowsFor() })
      assert.equal(calls, 0)
      assert.equal(result.reason, 'INVALID_CONTEXT')
    }
  }
})

test('the reader forwards raw output into strict validation without shape coercion', async () => {
  for (const output of [null, { rows: rowsFor() }, '[]', [], [rowsFor()[0]]]) {
    assert.equal((await readInitialSyncProof(scope, async () => output)).complete, false)
  }
  const badTime = rowsFor()
  badTime[0]!.lastSuccessfulAtUtc = '2026-11-16T20:00:00.000901Z'
  assert.deepEqual((await readInitialSyncProof(scope, async () => badTime)).incompleteResources, ['USERS'])
})

test('read errors propagate unchanged with no retry or fabricated empty result', async () => {
  const failure = new Error('read failed')
  let calls = 0
  await assert.rejects(readInitialSyncProof(scope, async () => { calls++; throw failure }), error => error === failure)
  assert.equal(calls, 1)
})

test('caller mutation during the await cannot relabel scope or captured parameters', async () => {
  const mutableScope = { ...scope }
  let resolveRead!: (rows: unknown) => void
  const result = readInitialSyncProof(mutableScope, async (_sql, values) => {
    assert.deepEqual(values.slice(0, 2), [scope.organizationId, scope.customerTenantId])
    return new Promise(resolve => { resolveRead = resolve })
  })
  mutableScope.organizationId = id(91)
  mutableScope.customerTenantId = id(92)
  resolveRead(rowsFor())
  assert.equal((await result).complete, true)

  const relabeledScope = { ...scope }
  const rejected = readInitialSyncProof(relabeledScope, async () => {
    relabeledScope.organizationId = id(91)
    relabeledScope.customerTenantId = id(92)
    return rowsFor(relabeledScope)
  })
  assert.equal((await rejected).reason, 'INVALID_CONTEXT')
})
