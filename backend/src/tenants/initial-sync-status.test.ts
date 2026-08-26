import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveInitialSyncStatus,
  INITIAL_SYNC_GRACE_MS,
  INITIAL_SYNC_RESOURCE_TYPES,
  type InitialSyncState,
} from './initial-sync-status.js'

const startedAt = new Date('2026-08-26T17:00:00.000Z')
const now = new Date('2026-08-26T17:05:00.000Z')

function state(
  resourceType: string,
  overrides: Partial<InitialSyncState> = {},
): InitialSyncState {
  return {
    resourceType,
    status: 'SUCCEEDED',
    lastAttemptAt: new Date('2026-08-26T17:01:00.000Z'),
    lastSuccessfulAt: new Date('2026-08-26T17:01:00.000Z'),
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  }
}

test('reports a newly queued tenant as initial synchronization in progress', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now,
    syncStates: [
      state('USERS', {
        status: 'IDLE',
        lastAttemptAt: null,
        lastSuccessfulAt: null,
      }),
    ],
  })

  assert.equal(result.status, 'IN_PROGRESS')
  assert.ok(result.pendingResources.includes('USERS'))
  assert.ok(result.pendingResources.includes('M365_AUDIT'))
})

test('keeps a first transient collector failure in the retrying state', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now,
    syncStates: [
      state('SIGN_INS', {
        status: 'FAILED',
        lastSuccessfulAt: null,
        lastErrorCode: 'MICROSOFT_TRANSIENT',
        lastErrorMessage: 'Microsoft returned a temporary service error.',
      }),
    ],
  })

  assert.equal(result.status, 'IN_PROGRESS')
  assert.deepEqual(result.retryingResources, ['SIGN_INS'])
  assert.deepEqual(result.actionRequiredResources, [])
})

test('surfaces permission failures immediately', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now,
    syncStates: [
      state('M365_AUDIT', {
        status: 'FAILED',
        lastSuccessfulAt: null,
        lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED',
        lastErrorMessage: 'Admin consent is required.',
      }),
    ],
  })

  assert.equal(result.status, 'ACTION_REQUIRED')
  assert.deepEqual(result.actionRequiredResources, ['M365_AUDIT'])
})

test('does not invent administrator action for repeated transient failures', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now: new Date(startedAt.getTime() + INITIAL_SYNC_GRACE_MS + 1),
    syncStates: [
      state('SIGN_INS', {
        status: 'FAILED',
        lastSuccessfulAt: null,
        lastErrorCode: 'MICROSOFT_TRANSIENT',
        lastErrorMessage: 'Microsoft returned a temporary service error.',
      }),
    ],
  })

  assert.equal(result.status, 'DELAYED')
  assert.deepEqual(result.retryingResources, ['SIGN_INS'])
  assert.deepEqual(result.actionRequiredResources, [])
})

test('does not count synchronization evidence from before this connection cycle', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now,
    syncStates: [
      state('USERS', {
        lastAttemptAt: new Date('2026-08-26T16:00:00.000Z'),
        lastSuccessfulAt: new Date('2026-08-26T16:00:00.000Z'),
      }),
    ],
  })

  assert.equal(result.status, 'IN_PROGRESS')
  assert.ok(result.pendingResources.includes('USERS'))
})

test('does not surface a stale failure from an older connection cycle', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now,
    syncStates: [
      state('SIGN_INS', {
        status: 'FAILED',
        lastAttemptAt: new Date('2026-08-26T16:00:00.000Z'),
        lastSuccessfulAt: null,
        lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED',
        lastErrorMessage: 'Admin consent is required.',
      }),
    ],
  })

  assert.equal(result.status, 'IN_PROGRESS')
  assert.ok(result.pendingResources.includes('SIGN_INS'))
  assert.deepEqual(result.actionRequiredResources, [])
})

test('reports completion only after every baseline collector succeeds in this cycle', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now,
    syncStates: INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) =>
      state(resourceType),
    ),
  })

  assert.equal(result.status, 'COMPLETE')
  assert.equal(result.completedResources.length, INITIAL_SYNC_RESOURCE_TYPES.length)
})

test('reports a long-running initial collection as delayed without fabricating errors', () => {
  const result = deriveInitialSyncStatus({
    startedAt,
    now: new Date(startedAt.getTime() + INITIAL_SYNC_GRACE_MS + 1),
    syncStates: [],
  })

  assert.equal(result.status, 'DELAYED')
  assert.equal(result.actionRequiredResources.length, 0)
})
