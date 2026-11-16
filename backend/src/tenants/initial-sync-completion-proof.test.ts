import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_SYNC_RESOURCE_TYPES } from './initial-sync-status.js'
import {
  validateInitialSyncCompletionProof,
  type InitialSyncCompletionProof,
  type InitialSyncCompletionSnapshot,
} from './initial-sync-completion-proof.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
const scope = { organizationId: id(1), customerTenantId: id(2) }
const instant = new Date('2026-11-16T12:00:00.000Z')
const epoch = id(3)

function baseline(): InitialSyncCompletionSnapshot {
  return {
    scope: { ...scope }, tenantStatus: 'ACTIVE', now: new Date(instant),
    connection: { ...scope, status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED', initialSyncEpochId: epoch, epochStartedAt: new Date(instant) },
    proofs: INITIAL_SYNC_RESOURCE_TYPES.map((resourceType, i) => ({
      ...scope, resourceType, initialSyncAttemptEpochId: epoch,
      initialSyncAttemptId: id(100 + i), initialSyncPersistedAttemptId: id(100 + i), initialSyncCompletedAttemptId: id(100 + i),
      status: 'SUCCEEDED', lastAttemptAt: new Date(instant), lastSuccessfulAt: new Date(instant),
      lastErrorCode: null, coverage: 'FULL', authenticationSource: resourceType === 'SIGN_INS' ? 'GRAPH_SIGN_INS' : null,
    })),
  }
}

function change(resource: string, patch: Partial<InitialSyncCompletionProof>) {
  const input = baseline()
  input.proofs = input.proofs.map(row => row.resourceType === resource ? { ...row, ...patch } : row)
  return input
}

test('accepts thirteen current proofs including genuine same-millisecond completion', () => {
  assert.equal(INITIAL_SYNC_RESOURCE_TYPES.length, 13)
  assert.deepEqual(validateInitialSyncCompletionProof(baseline()), { complete: true, reason: 'COMPLETE', incompleteResources: [] })
})

test('old epoch is rejected at identical timestamps while fresh USERS and SIGN_INS cannot cover other resources', () => {
  const input = baseline()
  input.proofs = input.proofs.map(row => ['USERS', 'SIGN_INS'].includes(row.resourceType) ? row : { ...row, initialSyncAttemptEpochId: id(4) })
  const result = validateInitialSyncCompletionProof(input)
  assert.equal(result.complete, false)
  assert.deepEqual(result.incompleteResources, INITIAL_SYNC_RESOURCE_TYPES.filter(r => !['USERS', 'SIGN_INS'].includes(r)))
  assert.ok(input.proofs.every(row => row.lastSuccessfulAt!.getTime() === instant.getTime()))
})

test('accepts distinct attempts from different visits within one current epoch without mutation', () => {
  const input = baseline()
  input.connection!.connectionMode = 'HAWKVIEW_MANAGED'
  input.now = new Date(instant.getTime() + 100)
  input.proofs = [...input.proofs].reverse().map((row, i) => ({ ...row, lastAttemptAt: new Date(instant.getTime() + i), lastSuccessfulAt: new Date(instant.getTime() + i + 1) }))
  const before = structuredClone(input)
  assert.equal(new Set(input.proofs.map(r => r.initialSyncAttemptId)).size, 13)
  assert.equal(validateInitialSyncCompletionProof(input).complete, true)
  assert.deepEqual(input, before)
})

for (const resource of INITIAL_SYNC_RESOURCE_TYPES) {
  test(`requires the exact ${resource} proof; a duplicate or optional resource cannot fill its slot`, () => {
    const input = baseline()
    input.proofs = input.proofs.filter(row => row.resourceType !== resource)
    assert.deepEqual(validateInitialSyncCompletionProof(input).incompleteResources, [resource])
    input.proofs = [...input.proofs, { ...input.proofs[0]!, resourceType: 'OPTIONAL_RESOURCE' }]
    assert.equal(validateInitialSyncCompletionProof(input).reason, 'INVALID_RESOURCE_SET')
    input.proofs = [...input.proofs.filter(row => row.resourceType !== 'OPTIONAL_RESOURCE'), input.proofs[0]!]
    assert.equal(validateInitialSyncCompletionProof(input).reason, 'INVALID_RESOURCE_SET')
  })
}

test('rejects duplicate required rows in either order, even if one looks complete', () => {
  const input = baseline()
  const stale = { ...input.proofs[0]!, initialSyncAttemptEpochId: id(4) }
  for (const proofs of [[stale, ...input.proofs], [...input.proofs, stale], [...input.proofs, input.proofs[0]!]]) {
    assert.equal(validateInitialSyncCompletionProof({ ...input, proofs }).reason, 'INVALID_RESOURCE_SET')
  }
})

test('required-only projection rejects optional extra rows instead of changing the required set', () => {
  const input = baseline()
  input.proofs = [...input.proofs, { ...input.proofs[0]!, resourceType: 'OPTIONAL_RESOURCE', status: 'FAILED', coverage: 'UNKNOWN' }]
  assert.equal(validateInitialSyncCompletionProof(input).reason, 'INVALID_RESOURCE_SET')
})

for (const field of ['initialSyncAttemptEpochId', 'initialSyncAttemptId', 'initialSyncPersistedAttemptId', 'initialSyncCompletedAttemptId'] as const) {
  test(`rejects absent, malformed or different ${field}`, () => {
    for (const value of [null, '', ' ', 'not-an-id', '00000000-0000-0000-0000-000000000000', id(999)]) {
      assert.deepEqual(validateInitialSyncCompletionProof(change('M365_AUDIT', { [field]: value })).incompleteResources, ['M365_AUDIT'])
    }
  })
}

test('a replacement attempt invalidates retained completion and persistence identities', () => {
  for (const patch of [
    { initialSyncAttemptId: id(999) },
    { initialSyncAttemptId: id(999), initialSyncPersistedAttemptId: id(999), initialSyncCompletedAttemptId: null },
    { initialSyncCompletedAttemptId: null },
  ]) assert.equal(validateInitialSyncCompletionProof(change('USERS', patch)).complete, false)
})

test('retained success timestamps cannot certify nonterminal, failed, partial or unknown outcomes', () => {
  for (const status of ['RUNNING', 'FAILED', 'IDLE', 'UNKNOWN', 'SUCCEEDED ']) {
    assert.equal(validateInitialSyncCompletionProof(change('M365_AUDIT', { status })).complete, false)
  }
  for (const coverage of ['LIMITED', 'PARTIAL', 'INITIALIZING', 'BUDGET_EXHAUSTED', 'UNKNOWN', '']) {
    assert.equal(validateInitialSyncCompletionProof(change('M365_AUDIT', { coverage })).complete, false)
  }
  for (const lastErrorCode of ['sign-ins-record-validation-partial', 'sign-ins-audit-subscription-initializing', 'unexpected-partial-code', '']) {
    assert.equal(validateInitialSyncCompletionProof(change('SIGN_INS', { lastErrorCode })).complete, false)
  }
})

test('full SIGN_INS completion requires Graph source; limited fallback cannot substitute', () => {
  for (const authenticationSource of [null, '', 'M365_AUDIT_STS', 'UNKNOWN']) {
    assert.deepEqual(validateInitialSyncCompletionProof(change('SIGN_INS', { authenticationSource })).incompleteResources, ['SIGN_INS'])
  }
})

test('rejects missing, invalid, inverted, prior-epoch and future proof timestamps', () => {
  const before = new Date(instant.getTime() - 1)
  const after = new Date(instant.getTime() + 1)
  for (const patch of [
    { lastAttemptAt: null }, { lastSuccessfulAt: null },
    { lastAttemptAt: new Date(NaN) }, { lastSuccessfulAt: new Date(NaN) },
    { lastAttemptAt: before }, { lastSuccessfulAt: before },
    { lastAttemptAt: after, lastSuccessfulAt: after }, { lastSuccessfulAt: after },
  ]) assert.equal(validateInitialSyncCompletionProof(change('LICENSES', patch)).complete, false)
})

test('rejects foreign organization or tenant on the connection or any supplied proof', () => {
  for (const field of ['organizationId', 'customerTenantId'] as const) {
    const input = baseline()
    input.connection![field] = id(999)
    assert.equal(validateInitialSyncCompletionProof(input).reason, 'INVALID_CONTEXT')
    assert.equal(validateInitialSyncCompletionProof(change('SIGN_INS', { [field]: id(999) })).reason, 'INVALID_RESOURCE_SET')
  }
})

test('rejects missing/legacy epochs, inactive tenant and pending/error/revoked connections', () => {
  const input = baseline()
  assert.equal(validateInitialSyncCompletionProof({ ...input, connection: null }).complete, false)
  for (const initialSyncEpochId of [null, '', '00000000-0000-0000-0000-000000000000', 'not-an-id']) {
    assert.equal(validateInitialSyncCompletionProof({ ...input, connection: { ...input.connection!, initialSyncEpochId } }).complete, false)
  }
  for (const tenantStatus of ['PENDING', 'SUSPENDED', 'DISCONNECTED', 'UNKNOWN']) {
    assert.equal(validateInitialSyncCompletionProof({ ...input, tenantStatus }).complete, false)
  }
  for (const status of ['PENDING_CONSENT', 'ERROR', 'REVOKED', 'UNKNOWN']) {
    assert.equal(validateInitialSyncCompletionProof({ ...input, connection: { ...input.connection!, status } }).complete, false)
  }
  assert.equal(validateInitialSyncCompletionProof({ ...input, connection: { ...input.connection!, connectionMode: 'UNKNOWN' } }).complete, false)
})

test('invalid scope, snapshot clock and epoch boundaries cannot establish readiness', () => {
  const input = baseline()
  for (const epochStartedAt of [null, new Date(NaN), new Date(instant.getTime() + 1)]) {
    assert.equal(validateInitialSyncCompletionProof({ ...input, connection: { ...input.connection!, epochStartedAt } }).complete, false)
  }
  assert.equal(validateInitialSyncCompletionProof({ ...input, now: new Date(NaN) }).complete, false)
  for (const field of ['organizationId', 'customerTenantId'] as const) {
    assert.equal(validateInitialSyncCompletionProof({ ...input, scope: { ...scope, [field]: '' } }).complete, false)
  }
})
