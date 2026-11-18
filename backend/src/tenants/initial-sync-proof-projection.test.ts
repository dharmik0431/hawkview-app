import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import { validateInitialSyncCompletionProjection as validate } from './initial-sync-proof-projection.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const scope = { organizationId: id(1), customerTenantId: id(2) }
const epoch = id(3)
const stamp = (fraction: string) => `2026-11-16T20:00:00.${fraction}Z`
type Row = Record<string, unknown>
function baseline(): Row[] {
  return INITIAL_SYNC_RESOURCE_TYPES.map((resourceType, i) => ({
    ...scope, tenantStatus: 'ACTIVE', connectionId: id(4),
    connectionOrganizationId: scope.organizationId, connectionCustomerTenantId: scope.customerTenantId,
    connectionStatus: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    initialSyncEpochId: epoch, epochStartedAtUtc: stamp('000100'), observedAtUtc: stamp('000900'),
    contextTimeValid: true, expectedResourceType: resourceType,
    stateId: id(100 + i), stateOrganizationId: scope.organizationId, stateCustomerTenantId: scope.customerTenantId,
    stateResourceType: resourceType, initialSyncAttemptEpochId: epoch, initialSyncAttemptId: id(200 + i),
    initialSyncPersistedAttemptId: id(200 + i), initialSyncCompletedAttemptId: id(200 + i),
    initialSyncPersistedKind: resourceType === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : 'FULL_RESOURCE',
    status: 'SUCCEEDED', lastAttemptAtUtc: stamp('000200'), lastSuccessfulAtUtc: stamp('000800'),
    lastErrorCode: null, lastErrorMessage: null, proofTimeValid: true,
  }))
}
function patchResource(patch: Row, resource = 'SIGN_INS') {
  return baseline().map(row => row.expectedResourceType === resource ? { ...row, ...patch } : row)
}
function patchContext(patch: Row) { return baseline().map(row => ({ ...row, ...patch })) }

test('strict mapper accepts all thirteen current receipts with distinct attempts without mutating input', () => {
  const rows = baseline().reverse()
  const before = structuredClone(rows)
  assert.deepEqual(validate(scope, rows), { complete: true, reason: 'COMPLETE', incompleteResources: [] })
  assert.deepEqual(rows, before)
  assert.equal(validate(scope, patchContext({ connectionMode: 'HAWKVIEW_MANAGED' })).complete, true)
})

test('equal microsecond boundaries are valid and no rounded snapshot escapes', () => {
  const rows = patchContext({ epochStartedAtUtc: stamp('000001'), observedAtUtc: stamp('000001'),
    lastAttemptAtUtc: stamp('000001'), lastSuccessfulAtUtc: stamp('000001') })
  assert.deepEqual(Object.keys(validate(scope, rows)).sort(), ['complete', 'incompleteResources', 'reason'])
  assert.equal(validate(scope, rows).complete, true)
})

for (const [name, patch] of [
  ['attempt one microsecond before epoch', { lastAttemptAtUtc: stamp('000099') }],
  ['success one microsecond before attempt', { lastSuccessfulAtUtc: stamp('000199') }],
  ['success one microsecond after observation', { lastSuccessfulAtUtc: stamp('000901') }],
] as const) {
  test(`rejects ${name} even with a true database predicate and identical Date milliseconds`, () => {
    const rows = patchResource(patch)
    const row = rows.find(row => row.expectedResourceType === 'SIGN_INS')!
    const rounded = ['epochStartedAtUtc', 'observedAtUtc', 'lastAttemptAtUtc', 'lastSuccessfulAtUtc'].map(k => new Date(row[k] as string).getTime())
    assert.equal(new Set(rounded).size, 1)
    assert.deepEqual(validate(scope, rows).incompleteResources, ['SIGN_INS'])
  })
}

test('future epoch within the same millisecond is rejected despite a true database context predicate', () => {
  assert.equal(validate(scope, patchContext({ epochStartedAtUtc: stamp('000901') })).reason, 'INVALID_CONTEXT')
})

test('canonical UTC parsing checks the calendar, range and exact six-decimal format', () => {
  for (const value of [null, '', 'infinity', '-infinity', '2026-02-30T20:00:00.000200Z',
    '2026-11-16T24:00:00.000200Z', '0000-11-16T20:00:00.000200Z',
    '2026-11-16T20:00:60.000200Z', '2026-11-16T15:00:00.000200-05:00',
    '2026-11-16T20:00:00.000Z', '2026-11-16 20:00:00.000200+00',
    '+010000-11-16T20:00:00.000200Z', '2026-11-16T20:00:00.0002000Z']) {
    assert.equal(validate(scope, patchResource({ lastAttemptAtUtc: value })).complete, false, String(value))
    assert.equal(validate(scope, patchContext({ observedAtUtc: value })).reason, 'INVALID_CONTEXT', String(value))
  }
  for (const value of ['2024-02-29T12:00:00.123456Z', '1969-12-31T23:59:59.999999Z']) {
    assert.equal(validate(scope, patchContext({ epochStartedAtUtc: value, observedAtUtc: value,
      lastAttemptAtUtc: value, lastSuccessfulAtUtc: value })).complete, true)
  }
})

test('Date objects, numeric timestamps, omitted fields and string booleans are never coerced', () => {
  for (const patch of [{ lastAttemptAtUtc: new Date(stamp('000200')) }, { lastAttemptAtUtc: 1794859200000 },
    { proofTimeValid: 'true' }, { proofTimeValid: 1 }, { proofTimeValid: undefined },
    { initialSyncAttemptId: {} }, { lastErrorMessage: undefined }]) {
    assert.equal(validate(scope, patchResource(patch)).reason, 'INVALID_PROJECTION')
  }
  const rows = baseline()
  delete rows[0]!.stateId
  assert.equal(validate(scope, rows).reason, 'INVALID_PROJECTION')
  for (const value of [null, {}, 'rows', [null], [baseline()[0]], [], new Array(13)]) assert.equal(validate(scope, value).complete, false)
  const sparse = baseline()
  delete sparse[7]
  assert.equal(validate(scope, sparse).reason, 'INVALID_PROJECTION')
})

test('false or null full-precision database predicates cannot be overridden by good timestamps', () => {
  for (const value of [false, null]) {
    assert.deepEqual(validate(scope, patchResource({ proofTimeValid: value })).incompleteResources, ['SIGN_INS'])
    assert.equal(validate(scope, patchContext({ contextTimeValid: value })).reason, 'INVALID_CONTEXT')
  }
})

test('every repeated context field must agree, including observation microseconds', () => {
  for (const field of ['organizationId', 'customerTenantId', 'tenantStatus', 'connectionId',
    'connectionOrganizationId', 'connectionCustomerTenantId', 'connectionStatus', 'connectionMode',
    'initialSyncEpochId', 'epochStartedAtUtc', 'observedAtUtc', 'contextTimeValid']) {
    const rows = baseline()
    rows[7]![field] = field === 'contextTimeValid' ? false : null
    assert.equal(validate(scope, rows).reason, 'INVALID_PROJECTION', field)
  }
  const rows = baseline()
  rows[7]!.observedAtUtc = stamp('000901')
  assert.equal(validate(scope, rows).reason, 'INVALID_PROJECTION')
})

test('absent, foreign and ineligible tenant or connection context cannot certify readiness', () => {
  for (const patch of [{ organizationId: id(900) }, { customerTenantId: id(900) },
    { connectionOrganizationId: id(900) }, { connectionCustomerTenantId: id(900) },
    { connectionId: null }, { connectionId: 'invalid' }, { connectionId: '00000000-0000-0000-0000-000000000000' },
    { tenantStatus: 'SUSPENDED' }, { connectionStatus: 'PENDING_CONSENT' }, { connectionStatus: 'ERROR' },
    { connectionStatus: 'DISCONNECTED' }, { connectionMode: 'UNKNOWN' },
    { initialSyncEpochId: null }, { initialSyncEpochId: '00000000-0000-0000-0000-000000000000' },
    { epochStartedAtUtc: null }]) assert.equal(validate(scope, patchContext(patch)).reason, 'INVALID_CONTEXT')
  assert.equal(validate({ ...scope, organizationId: '' }, baseline()).reason, 'INVALID_CONTEXT')
})

for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
  test(`missing joined ${resource} stays incomplete and cannot be replaced by another slot`, () => {
    const rows = baseline()
    const missing = rows.find(row => row.expectedResourceType === resource)!
    for (const key of ['stateId', 'stateOrganizationId', 'stateCustomerTenantId', 'stateResourceType',
      'initialSyncAttemptEpochId', 'initialSyncAttemptId', 'initialSyncPersistedAttemptId',
      'initialSyncCompletedAttemptId', 'initialSyncPersistedKind', 'status', 'lastAttemptAtUtc',
      'lastSuccessfulAtUtc', 'lastErrorCode', 'lastErrorMessage']) missing[key] = null
    missing.proofTimeValid = false
    assert.deepEqual(validate(scope, rows).incompleteResources, [resource])
    missing.stateResourceType = resource
    assert.equal(validate(scope, rows).reason, 'INVALID_PROJECTION')
    assert.equal(validate(scope, baseline().filter(row => row.expectedResourceType !== resource)).reason, 'INVALID_RESOURCE_SET')
    const another = rows.find(row => row.expectedResourceType !== resource)!
    assert.equal(validate(scope, baseline().map(row => row.expectedResourceType === resource ? another : row)).reason, 'INVALID_RESOURCE_SET')
  })
}

test('optional, foreign, relabeled and multiplied joined rows cannot fill the required set', () => {
  for (const patch of [{ expectedResourceType: 'DIRECTORY_ROLES' }, { stateResourceType: 'USERS' },
    { stateResourceType: null }, { stateOrganizationId: id(900) }, { stateCustomerTenantId: id(900) },
    { stateId: 'bad-id' }]) assert.equal(validate(scope, patchResource(patch)).reason, 'INVALID_RESOURCE_SET')
  const rows = baseline()
  assert.equal(validate(scope, [...rows, rows[0]]).reason, 'INVALID_RESOURCE_SET')
  rows[1]!.stateId = rows[0]!.stateId
  assert.equal(validate(scope, rows).reason, 'INVALID_RESOURCE_SET')
})

test('old epoch, replacement attempt, persisted-only and legacy success remain unproved', () => {
  for (const patch of [{ initialSyncAttemptEpochId: id(900) }, { initialSyncAttemptId: id(900) },
    { initialSyncPersistedAttemptId: null }, { initialSyncCompletedAttemptId: null },
    { initialSyncAttemptEpochId: null, initialSyncAttemptId: null, initialSyncPersistedAttemptId: null,
      initialSyncCompletedAttemptId: null, initialSyncPersistedKind: null },
    { initialSyncAttemptId: '00000000-0000-0000-0000-000000000000',
      initialSyncPersistedAttemptId: '00000000-0000-0000-0000-000000000000',
      initialSyncCompletedAttemptId: '00000000-0000-0000-0000-000000000000' }]) {
    assert.deepEqual(validate(scope, patchResource(patch)).incompleteResources, ['SIGN_INS'])
  }
})

test('none of the 31 partial-null receipt combinations can certify completion', () => {
  const keys = ['initialSyncAttemptEpochId', 'initialSyncAttemptId', 'initialSyncPersistedAttemptId',
    'initialSyncCompletedAttemptId', 'initialSyncPersistedKind']
  for (let mask = 0; mask < 32; mask++) {
    const rows = baseline()
    const row = rows.find(row => row.expectedResourceType === 'SIGN_INS')!
    keys.forEach((key, bit) => { if ((mask & (1 << bit)) === 0) row[key] = null })
    assert.equal(validate(scope, rows).complete, mask === 31, `receipt mask ${mask}`)
  }
})

test('source classification is read from stored facts and cannot be supplied by derived coverage flags', () => {
  for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
    for (const kind of [null, 'UNKNOWN', resource === 'SIGN_INS' ? 'FULL_RESOURCE' : 'GRAPH_SIGN_INS']) {
      assert.deepEqual(validate(scope, patchResource({ initialSyncPersistedKind: kind,
        coverage: 'FULL', authenticationSource: 'GRAPH_SIGN_INS' }, resource)).incompleteResources, [resource])
    }
  }
})

test('both error fields and the current outcome are required; retained success cannot clear failures', () => {
  for (const patch of [{ lastErrorMessage: '' }, { lastErrorMessage: 'partial collection' }, { lastErrorCode: '' },
    { lastErrorCode: 'limited' }, { status: 'FAILED' }, { status: 'RUNNING' }, { status: null }]) {
    assert.deepEqual(validate(scope, patchResource(patch)).incompleteResources, ['SIGN_INS'])
  }
})
