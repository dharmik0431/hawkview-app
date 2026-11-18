import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import { classifyInitialSyncTerminalEvidence as classify } from './initial-sync-terminal-evidence.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const stamp = (fraction: string) => `2026-11-17T15:00:00.${fraction}Z`
function operation(resource = 'SIGN_INS') {
  return { organizationId: id(1), customerTenantId: id(2), connectionId: id(3), epochId: id(4),
    attemptId: id(5), resourceType: resource, persistedKind: resource === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE' }
}
function evidence(resource = 'SIGN_INS'): Record<string, unknown> {
  const op = operation(resource)
  return { organizationId: op.organizationId, customerTenantId: op.customerTenantId,
    tenantStatus: 'ACTIVE', connectionId: op.connectionId, connectionOrganizationId: op.organizationId,
    connectionCustomerTenantId: op.customerTenantId, connectionStatus: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    initialSyncEpochId: op.epochId, epochStartedAtUtc: stamp('000100'), observedAtUtc: stamp('000900'),
    expectedResourceType: resource, stateId: id(6), stateOrganizationId: op.organizationId,
    stateCustomerTenantId: op.customerTenantId, stateResourceType: resource,
    initialSyncAttemptEpochId: op.epochId, initialSyncAttemptId: op.attemptId,
    initialSyncPersistedAttemptId: op.attemptId, initialSyncCompletedAttemptId: op.attemptId,
    initialSyncPersistedKind: op.persistedKind, status: 'SUCCEEDED', lastAttemptAtUtc: stamp('000200'),
    lastSuccessfulAtUtc: stamp('000800'), lastErrorCode: null, lastErrorMessage: null }
}
const inspect = (patch: Record<string, unknown> = {}) => classify(operation(), [{ ...evidence(), ...patch }])
const unproved = (result: ReturnType<typeof classify>) => assert.equal(result.kind, 'UNKNOWN')

for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
  test(`observes exact saved completion for ${resource} without granting action authority`, () => {
    const op = operation(resource)
    const row = evidence(resource)
    const before = structuredClone({ op, row })
    const result = classify(op, [row])
    assert.deepEqual(result, { kind: 'MATCHING_COMPLETION', operation: op, observed: {
      connectionId: id(3), epochId: id(4), attemptEpochId: id(4), attemptId: id(5), stateId: id(6), status: 'SUCCEEDED', atUtc: stamp('000900'),
    } })
    assert.deepEqual({ op, row }, before)
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'observed', 'operation'])
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.operation) && Object.isFrozen(result.observed))
    op.attemptId = id(900)
    row.status = 'FAILED'
    assert.equal(result.operation.attemptId, id(5))
    assert.equal(result.observed.status, 'SUCCEEDED')
  })
}

test('owner assertions neither grant authority nor erase an exact saved result', () => {
  for (const owner of [null, 'expired', 'replacement', true, false]) {
    const result = classify({ ...operation(), owner, canWrite: true }, [{ ...evidence(), owner, canResolve: true }])
    assert.equal(result.kind, 'MATCHING_COMPLETION')
    assert.ok(!JSON.stringify(result).includes('owner'))
    assert.ok(!JSON.stringify(result).includes('canWrite') && !JSON.stringify(result).includes('canResolve'))
  }
})

for (const status of ['RUNNING', 'FAILED', 'SUCCEEDED']) {
  test(`persisted-only preserves ${status} without interpreting absence as rollback`, () => {
    const result = inspect({ status, initialSyncCompletedAttemptId: null,
      lastErrorCode: status === 'FAILED' ? 'rejected' : null, lastSuccessfulAtUtc: stamp('000050') })
    assert.equal(result.kind, 'PERSISTED_ONLY')
    assert.equal(result.observed.status, status)
  })
}

test('early absence then delayed completion yields observations only, with no non-write classification', () => {
  const row = { ...evidence(), status: 'RUNNING', initialSyncCompletedAttemptId: null }
  assert.equal(classify(operation(), [row]).kind, 'PERSISTED_ONLY')
  assert.equal(classify(operation(), [evidence()]).kind, 'MATCHING_COMPLETION')
  unproved(inspect({ initialSyncPersistedAttemptId: null, initialSyncCompletedAttemptId: null,
    initialSyncPersistedKind: null, status: 'RUNNING' }))
  unproved(classify({ ...operation(), definiteNonWrite: true, settled: true }, []))
})

for (const [name, patch] of [
  ['connection', { connectionId: id(99) }],
  ['epoch', { initialSyncEpochId: id(99), initialSyncAttemptEpochId: id(99) }],
  ['attempt', { initialSyncAttemptId: id(99), initialSyncPersistedAttemptId: id(99), initialSyncCompletedAttemptId: id(99) }],
] as const) {
  test(`replacement ${name} with equal times is superseded, never historical completion`, () => {
    const result = inspect(patch)
    assert.equal(result.kind, 'SUPERSEDED')
    assert.equal(result.operation.attemptId, id(5))
    assert.equal(result.observed.atUtc, stamp('000900'))
  })
}

test('epoch rotation preserves old receipt identity and recognizes the new connection boundary', () => {
  const result = inspect({ initialSyncEpochId: id(99), epochStartedAtUtc: stamp('000850') })
  assert.equal(result.kind, 'SUPERSEDED')
  assert.equal(result.observed.epochId, id(99))
  assert.equal(result.observed.attemptEpochId, id(4))
  assert.equal(result.operation.epochId, id(4))
  // A caller already captured in E2 cannot reuse the retained E1 receipt.
  unproved(classify({ ...operation(), epochId: id(99) }, [{ ...evidence(),
    initialSyncEpochId: id(99), epochStartedAtUtc: stamp('000850') }]))
})

test('replacement does not override foreign, missing or malformed row evidence', () => {
  for (const patch of [{ stateOrganizationId: id(99) }, { stateCustomerTenantId: id(99) },
    { stateResourceType: 'USERS' }, { initialSyncAttemptId: null }, { stateId: null },
    { initialSyncPersistedAttemptId: id(88) }, { lastSuccessfulAtUtc: 'bad' }]) {
    unproved(inspect({ connectionId: id(99), ...patch }))
  }
})

test('same-millisecond violations fail exact microsecond ordering despite injected validity flags', () => {
  for (const patch of [{ epochStartedAtUtc: stamp('000901') }, { lastAttemptAtUtc: stamp('000099') },
    { lastAttemptAtUtc: stamp('000901') }, { lastSuccessfulAtUtc: stamp('000199') },
    { lastSuccessfulAtUtc: stamp('000901') }]) {
    const row: Record<string, unknown> = { ...evidence(), ...patch, contextTimeValid: true, proofTimeValid: true }
    assert.equal(new Set(['epochStartedAtUtc', 'lastAttemptAtUtc', 'lastSuccessfulAtUtc', 'observedAtUtc']
      .map(k => new Date(row[k] as string).getTime())).size, 1)
    unproved(classify(operation(), [row]))
  }
  assert.equal(inspect({ epochStartedAtUtc: stamp('000001'), lastAttemptAtUtc: stamp('000001'),
    lastSuccessfulAtUtc: stamp('000001'), observedAtUtc: stamp('000001') }).kind, 'MATCHING_COMPLETION')
})

test('invalid context, source, statuses, errors and broken receipt chains stay unknown', () => {
  for (const patch of [{ organizationId: id(99) }, { customerTenantId: id(99) },
    { connectionOrganizationId: id(99) }, { connectionCustomerTenantId: id(99) },
    { expectedResourceType: 'USERS' }, { connectionStatus: 'DISCONNECTED' }, { tenantStatus: 'SUSPENDED' },
    { connectionMode: 'UNKNOWN' }, { status: 'FAILED' }, { status: 'RUNNING' }, { status: 'invented' },
    { lastErrorCode: '' }, { lastErrorMessage: 'unknown' }, { initialSyncPersistedKind: 'AUDIT_FALLBACK' },
    { initialSyncPersistedKind: 'FULL_RESOURCE' }, { initialSyncPersistedAttemptId: id(99) },
    { initialSyncCompletedAttemptId: id(99) }, { initialSyncAttemptEpochId: id(99) },
    { initialSyncPersistedAttemptId: null }, { initialSyncPersistedKind: null },
    { initialSyncEpochId: null }, { initialSyncAttemptId: '00000000-0000-0000-0000-000000000000' }]) unproved(inspect(patch))
})

test('all omitted/invalid scalar fields and partial-null receipts reject completion', () => {
  for (const field of Object.keys(evidence())) {
    const row = evidence()
    delete row[field]
    unproved(classify(operation(), [row]))
    for (const value of [undefined, 1, true, {}, new Date()]) unproved(inspect({ [field]: value }))
  }
  const fields = ['initialSyncAttemptEpochId', 'initialSyncAttemptId', 'initialSyncPersistedAttemptId',
    'initialSyncCompletedAttemptId', 'initialSyncPersistedKind']
  for (let mask = 1; mask < 32; mask++) {
    const row = evidence()
    fields.forEach((field, i) => { if (mask & (1 << i)) row[field] = null })
    assert.notEqual(classify(operation(), [row]).kind, 'MATCHING_COMPLETION')
  }
})

test('missing, role-hidden, duplicate, sparse and non-row output cannot certify replacement or rollback', () => {
  for (const output of [null, undefined, {}, false, [], [null], [evidence(), evidence()], new Array(1)]) unproved(classify(operation(), output))
  const absent = Object.fromEntries(Object.keys(evidence()).map(k => [k, null]))
  unproved(classify(operation(), [absent]))
  unproved(classify(operation(), [Object.create(evidence())]))
})

test('invalid captured identity never falls back to row identity', () => {
  for (const value of [null, {}, [], true, Object.create(operation())]) unproved(classify(value, [evidence()]))
  for (const key of Object.keys(operation())) {
    for (const value of [null, undefined, '', true, '00000000-0000-0000-0000-000000000000']) {
      unproved(classify({ ...operation(), [key]: value }, [evidence()]))
    }
  }
  unproved(classify({ ...operation(), resourceType: 'DIRECTORY_ROLES' }, [evidence()]))
  unproved(classify({ ...operation(), persistedKind: 'FULL_RESOURCE' }, [evidence()]))
})

test('canonical UTC transport rejects invalid calendars, precision loss and nonfinite timestamps', () => {
  for (const value of [null, '', 'infinity', '-infinity', '2026-02-30T15:00:00.000200Z',
    '2026-11-17T24:00:00.000200Z', '0000-11-17T15:00:00.000200Z',
    '2026-11-17T15:00:60.000200Z', '2026-11-17T10:00:00.000200-05:00',
    '2026-11-17T15:00:00.000Z', '2026-11-17T15:00:00.0002000Z']) {
    for (const key of ['epochStartedAtUtc', 'lastAttemptAtUtc', 'lastSuccessfulAtUtc', 'observedAtUtc']) unproved(inspect({ [key]: value }))
  }
  for (const value of ['1969-12-31T23:59:59.999999Z', '2024-02-29T12:00:00.123456Z']) {
    assert.equal(inspect({ epochStartedAtUtc: value, lastAttemptAtUtc: value, lastSuccessfulAtUtc: value,
      observedAtUtc: value }).kind, 'MATCHING_COMPLETION')
  }
})
