import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveInitialSyncStatus,
  initialSyncEpochStart,
  INITIAL_SYNC_GRACE_MS,
  INITIAL_SYNC_RESOURCE_TYPES,
  type InitialSyncState,
} from './initial-sync-status.js'

const startedAt = new Date('2026-08-26T17:00:00.000Z')
const now = new Date('2026-08-26T17:05:00.000Z')

test('a later consent starts a new baseline and an older in-flight attempt cannot complete it', () => {
  const consentedAt = new Date('2026-08-26T17:02:00.000Z')
  const epoch = initialSyncEpochStart({
    onboardingCompletedAt: startedAt,
    consentedAt,
  })
  assert.equal(epoch?.getTime(), consentedAt.getTime())
  const rows = INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) => state(resourceType, {
    lastAttemptAt: new Date('2026-08-26T17:01:00.000Z'),
    lastSuccessfulAt: new Date('2026-08-26T17:03:00.000Z'),
  }))
  assert.equal(deriveInitialSyncStatus({ startedAt: epoch, now, syncStates: rows }).status, 'IN_PROGRESS')
  const currentRows = rows.map((row) => ({ ...row, lastAttemptAt: new Date('2026-08-26T17:03:00.000Z') }))
  assert.equal(deriveInitialSyncStatus({ startedAt: epoch, now, syncStates: currentRows }).status, 'COMPLETE')
  assert.equal(initialSyncEpochStart({ onboardingCompletedAt: startedAt })?.getTime(), startedAt.getTime())
  assert.equal(initialSyncEpochStart(null), null)
})

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

test('a running audit backlog cannot inherit completion from an earlier successful attempt', () => {
  const states = INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) =>
    resourceType === 'M365_AUDIT'
      ? state(resourceType, {
          status: 'RUNNING',
          lastAttemptAt: new Date('2026-08-26T17:03:00.000Z'),
          lastErrorCode: 'm365-audit-backlog',
        })
      : state(resourceType))
  const result = deriveInitialSyncStatus({ startedAt, now, syncStates: states })
  assert.equal(result.status, 'IN_PROGRESS')
  assert.deepEqual(result.retryingResources, ['M365_AUDIT'])
  assert.equal(result.completedResources.includes('M365_AUDIT'), false)
})

test('a later failed attempt overrides earlier success in this connection cycle', () => {
  const completed = INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) => state(resourceType))
  for (const [errorCode, expectedStatus] of [
    ['MICROSOFT_PERMISSION_REQUIRED', 'ACTION_REQUIRED'],
    ['MICROSOFT_TRANSIENT', 'IN_PROGRESS'],
  ] as const) {
    const failed = completed.map((item) => item.resourceType === 'SIGN_INS'
      ? state('SIGN_INS', {
        status: 'FAILED',
        lastAttemptAt: new Date('2026-08-26T17:03:00.000Z'),
        lastSuccessfulAt: new Date('2026-08-26T17:01:00.000Z'),
        lastErrorCode: errorCode,
      })
      : item)
    const result = deriveInitialSyncStatus({ startedAt, now, syncStates: failed })
    assert.equal(result.status, expectedStatus)
    assert.equal(result.completedResources.includes('SIGN_INS'), false)
  }
})

test('persisted fallback sign-ins report limited coverage without becoming delayed or complete', () => {
  const completed = INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) => state(resourceType))
  for (const code of [
    'sign-ins-non-premium-fallback-active',
    'sign-ins-non-premium-fallback-active-geolocation-partial',
  ]) {
    const limited = completed.map((item) => item.resourceType === 'SIGN_INS'
      ? { ...item, status: 'RUNNING', lastErrorCode: code }
      : item)
    const result = deriveInitialSyncStatus({ startedAt, now, syncStates: limited })
    assert.equal(result.status, 'LIMITED')
    assert.deepEqual(result.limitedResources, ['SIGN_INS'])
    assert.deepEqual(result.retryingResources, [])
    assert.equal(result.completedResources.includes('SIGN_INS'), false)
    assert.equal(deriveInitialSyncStatus({
      startedAt,
      now: new Date(startedAt.getTime() + INITIAL_SYNC_GRACE_MS + 1),
      syncStates: limited,
    }).status, 'LIMITED')
  }
  assert.equal(deriveInitialSyncStatus({ startedAt, now, syncStates: completed }).status, 'COMPLETE')
})

test('premium or unverified Graph fallback remains retrying with limited evidence', () => {
  const completed = INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) => state(resourceType))
  for (const code of [
    'sign-ins-premium-graph-fallback-active',
    'sign-ins-entitlement-unverified-fallback-active',
  ]) {
    const fallback = completed.map((item) => item.resourceType === 'SIGN_INS'
      ? { ...item, status: 'RUNNING', lastErrorCode: code }
      : item)
    const result = deriveInitialSyncStatus({ startedAt, now, syncStates: fallback })
    assert.equal(result.status, 'IN_PROGRESS')
    assert.deepEqual(result.limitedResources, ['SIGN_INS'])
    assert.deepEqual(result.retryingResources, ['SIGN_INS'])
    assert.equal(result.completedResources.includes('SIGN_INS'), false)
    assert.equal(deriveInitialSyncStatus({
      startedAt,
      now: new Date(startedAt.getTime() + INITIAL_SYNC_GRACE_MS + 1),
      syncStates: fallback,
    }).status, 'DELAYED')
  }
})

test('unproven fallback and initializing sign-ins remain retrying or pending', () => {
  const completed = INITIAL_SYNC_RESOURCE_TYPES.map((resourceType) => state(resourceType))
  for (const signIns of [
    state('SIGN_INS', { status: 'RUNNING', lastSuccessfulAt: null, lastErrorCode: 'sign-ins-non-premium-fallback-active' }),
    state('SIGN_INS', { status: 'FAILED', lastErrorCode: 'sign-ins-non-premium-fallback-active' }),
    state('SIGN_INS', { status: 'RUNNING', lastErrorCode: 'sign-ins-audit-subscription-initializing' }),
  ]) {
    const incomplete = completed.map((item) => item.resourceType === 'SIGN_INS' ? signIns : item)
    const result = deriveInitialSyncStatus({ startedAt, now, syncStates: incomplete })
    assert.equal(result.status, 'IN_PROGRESS')
    assert.deepEqual(result.retryingResources, ['SIGN_INS'])
    assert.deepEqual(result.limitedResources, [])
    assert.equal(deriveInitialSyncStatus({
      startedAt,
      now: new Date(startedAt.getTime() + INITIAL_SYNC_GRACE_MS + 1),
      syncStates: incomplete,
    }).status, 'DELAYED')
  }
  const stale = completed.map((item) => item.resourceType === 'SIGN_INS'
    ? state('SIGN_INS', {
      status: 'RUNNING',
      lastAttemptAt: new Date('2026-08-26T16:00:00.000Z'),
      lastSuccessfulAt: new Date('2026-08-26T16:00:00.000Z'),
      lastErrorCode: 'sign-ins-non-premium-fallback-active',
    })
    : item)
  assert.deepEqual(deriveInitialSyncStatus({ startedAt, now, syncStates: stale }).pendingResources, ['SIGN_INS'])
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
