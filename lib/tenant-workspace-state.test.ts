import assert from 'node:assert/strict'
import test from 'node:test'
import { projectSyncOutcome } from '../backend/src/tenants/sync-outcome-projection.ts'
import type { TenantBundle, TenantSyncStatus, SyncOutcomeProjection } from '../types/tenant-data.ts'
import { tenantActionableHealthProjection } from './attention/computeTenantAttention.ts'
import { deriveTenantWorkspaceDisplay } from './tenant-workspace-state.ts'

function bundle(overrides: Partial<TenantBundle> = {}): TenantBundle {
  return {
    tenant: {
      id: 'tenant-1',
      status: 'healthy',
      lastSync: '2026-08-26T16:00:00.000Z',
      initialSync: {
        status: 'IN_PROGRESS',
        startedAt: '2026-08-26T17:00:00.000Z',
        pendingResources: [],
        retryingResources: ['SIGN_INS', 'M365_AUDIT'],
        actionRequiredResources: [],
      },
    },
    users: [],
    signIns: [],
    exchange: {},
    sharepoint: {},
    teams: {},
    sync: {
      signIns: {
        status: 'failed',
        lastSuccessfulAt: '2026-08-26T16:00:00.000Z',
        lastError: 'Microsoft returned a temporary service error.',
      },
      m365Audit: {
        status: 'failed',
        lastSuccessfulAt: null,
        lastError: 'Microsoft is preparing the audit subscription.',
      },
    },
    ...overrides,
  }
}

test('preserves failures while initial collection is incomplete', () => {
  const display = deriveTenantWorkspaceDisplay(bundle())

  assert.equal(display.state, 'partially-synchronized')
  assert.equal(display.stateLabel, 'Partially Synchronized')
  assert.equal(display.isInitialSync, true)
  assert.equal(display.issueCount, 2)
  assert.equal(display.lastSuccessfulSync, null)
})

test('does not hide a collector that requires administrator action', () => {
  const data = bundle()
  data.tenant.initialSync = {
    ...data.tenant.initialSync,
    status: 'ACTION_REQUIRED',
    retryingResources: [],
    actionRequiredResources: ['SIGN_INS'],
  }
  data.sync = {
    signIns: {
      status: 'failed',
      lastSuccessfulAt: null,
      lastError: 'Microsoft returned 403 Forbidden: admin consent required.',
    },
  }

  const display = deriveTenantWorkspaceDisplay(data)

  assert.equal(display.state, 'needs-attention')
  assert.equal(display.issueCount, 1)
  assert.equal(display.issues[0]?.title, 'Sign-ins collection needs review')
})

test('preserves recorded failures alongside the initial delay warning', () => {
  const data = bundle()
  data.tenant.initialSync = {
    ...data.tenant.initialSync,
    status: 'DELAYED',
  }

  const display = deriveTenantWorkspaceDisplay(data)

  assert.equal(display.state, 'partially-synchronized')
  assert.equal(display.isInitialSync, true)
  assert.equal(display.issueCount, 3)
  assert.equal(
    display.issues[2]?.title,
    'Initial synchronization is taking longer than expected'
  )
})

test('does not promote a failed non-selected Graph attempt over current limited sign-in evidence', () => {
  const data = bundle()
  data.tenant.initialSync = undefined
  data.sync = {
    signIns: {
      status: 'failed',
      lastSuccessfulAt: null,
      lastError: 'Microsoft Graph returned 403 for premium sign-in logs.',
      resourceType: 'SIGN_INS',
    },
  }

  const display = deriveTenantWorkspaceDisplay(data, false, {
    availability: 'CURRENT_LIMITED',
    coverage: 'LIMITED',
    selectedSource: 'OFFICE_365_ACTIVITY_FEED',
    observedAt: '2026-08-26T17:10:00.000Z',
    reasonCode: 'SIGN_IN_FALLBACK_ACTIVE',
    reason: 'Current limited sign-in evidence is available.',
  })

  assert.equal(display.issueCount, 0)
  assert.equal(display.issues.some((issue) => issue.action === 'Retry synchronization'), false)
})

test('creates exactly one action for an actionable selected sign-in source', () => {
  const data = bundle()
  data.tenant.initialSync = undefined
  data.sync = {
    signIns: {
      status: 'failed',
      lastSuccessfulAt: null,
      lastError: 'A non-selected source also failed.',
      resourceType: 'SIGN_INS',
    },
  }

  const display = deriveTenantWorkspaceDisplay(data, false, {
    availability: 'STALE',
    coverage: 'LIMITED',
    selectedSource: 'OFFICE_365_ACTIVITY_FEED',
    observedAt: '2026-08-26T16:00:00.000Z',
    reasonCode: 'SIGN_IN_FALLBACK_STALE',
    reason: 'The selected audit-feed evidence is stale.',
  })

  assert.equal(display.issueCount, 1)
  assert.equal(display.issues[0]?.title, 'Selected sign-in evidence is stale')
  assert.equal(display.issues[0]?.action, 'Retry synchronization')
})

test('uses an authoritative core permission finding instead of a healthy-looking detail bundle', () => {
  const data = bundle()
  data.tenant.initialSync = undefined
  ;(data.tenant as Record<string, unknown>).missingPermissions = ['IdentityRiskyUser.Read.All']
  data.sync = {
    users: {
      ...sync('SUCCEEDED', 'succeeded'),
      lastSuccessfulAt: '2026-08-26T17:00:00.000Z',
      lastError: null,
    },
  }
  const health = tenantActionableHealthProjection({
    tenantHealth: {
      attention: [{
        key: 'authorization-required',
        label: 'Required Microsoft permissions are missing',
        severity: 'high',
        why: 'A connection-required Microsoft permission is missing.',
      }],
    },
  })

  const display = deriveTenantWorkspaceDisplay(data, false, null, health)

  assert.equal(display.state, 'needs-attention')
  assert.equal(display.stateLabel, 'Needs Attention')
  assert.equal(display.attentionVerified, true)
  assert.equal(display.issueCount, 1)
  assert.equal(display.issues[0]?.id, 'authorization-required')
})

test('keeps Microsoft risk attention pointed at the canonical tenant evidence page', () => {
  const data = bundle()
  data.tenant.initialSync = undefined
  const health = tenantActionableHealthProjection({
    tenantHealth: {
      attention: [{
        key: 'risky-identities',
        label: '2 identities have active Microsoft-risk evidence requiring review',
        severity: 'high',
        why: 'Microsoft Identity Protection evidence is incomplete.',
        detectedAt: '2026-09-15T11:00:00.000Z',
        actionLabel: 'Review Microsoft risk',
        actionUrl: '/tenants/123e4567-e89b-42d3-a456-426614174000/risky-users',
      }],
    },
  })

  const display = deriveTenantWorkspaceDisplay(data, false, null, health)
  assert.equal(display.issues[0]?.targetModule, 'risky-users')
  assert.equal(display.issues[0]?.action, 'Review Microsoft risk')
  assert.equal(
    display.issues[0]?.actionUrl,
    '/tenants/123e4567-e89b-42d3-a456-426614174000/risky-users',
  )
})

test('preserves an authoritative healthy zero and multiple tenant-wide findings exactly', () => {
  const data = bundle()
  data.tenant.initialSync = undefined
  ;(data.tenant as Record<string, unknown>).missingPermissions = ['IdentityRiskyUser.Read.All']
  data.sync = {
    users: {
      ...sync('SUCCEEDED', 'succeeded'),
      lastSuccessfulAt: '2026-08-26T17:00:00.000Z',
      lastError: null,
    },
  }

  const healthy = deriveTenantWorkspaceDisplay(
    data,
    false,
    null,
    tenantActionableHealthProjection({ attention: [] }),
  )
  assert.equal(healthy.state, 'healthy')
  assert.equal(healthy.issueCount, 0)

  const multiple = deriveTenantWorkspaceDisplay(
    data,
    false,
    null,
    tenantActionableHealthProjection({
      attention: [
        { key: 'sync-users', label: 'User collection failed', severity: 'high', why: 'Collection failed.' },
        { key: 'mfa-coverage', label: 'MFA registration needs review', severity: 'medium', why: 'Coverage is below target.' },
      ],
    }),
  )
  assert.equal(multiple.state, 'needs-attention')
  assert.equal(multiple.issueCount, 2)
})

test('does not call tenant health healthy when the tenant-list projection is unavailable', () => {
  const data = bundle()
  data.tenant.initialSync = undefined
  data.sync = {}

  const display = deriveTenantWorkspaceDisplay(data, false, null, {
    status: 'UNAVAILABLE',
    items: [],
  })

  assert.equal(display.state, 'unverified')
  assert.equal(display.stateLabel, 'Health Not Verified')
  assert.equal(display.attentionVerified, false)
  assert.equal(display.issueCount, 0)
})

function sync(kind: SyncOutcomeProjection['recordedOutcome']['kind'], status = 'running',
  relation?: SyncOutcomeProjection['recordedOutcome']['relation']): TenantSyncStatus {
  const resource = keyFor(kind)
  const resourceType = resource === 'signIns' ? 'SIGN_INS' : resource === 'm365Audit' ? 'M365_AUDIT' : 'USERS'
  const raw = kind === 'AWAITING_EXECUTION' ? 'queued' : kind === 'NOT_STARTED_OR_IDLE' ? 'idle' : status
  const success = '2026-09-29T12:00:00.000Z'
  const attempt = relation === 'PREDATES_ATTEMPT' ? '2026-09-29T12:01:00.000Z' : '2026-09-29T11:59:00.000Z'
  const code = kind === 'LIMITED_COLLECTION_RECORDED' ? 'sign-ins-non-premium-fallback-active'
    : kind === 'INITIALIZATION_WAIT_RECORDED' ? 'sign-ins-audit-subscription-initializing'
      : kind === 'DEFERRED_WORK_RECORDED' ? 'm365-audit-backlog' : null
  return {
    status: raw, lastSuccessfulAt: success, lastError: null,
    outcomeProjection: projectSyncOutcome(resourceType, {
      status: raw.toUpperCase(), lastSuccessfulAt: new Date(success), lastAttemptAt: new Date(attempt), lastErrorCode: code,
    }, new Date('2026-09-29T13:00:00.000Z')),
  }
}
function keyFor(kind: SyncOutcomeProjection['recordedOutcome']['kind']) {
  return kind === 'LIMITED_COLLECTION_RECORDED' || kind === 'INITIALIZATION_WAIT_RECORDED' ? 'signIns'
    : kind === 'DEFERRED_WORK_RECORDED' ? 'm365Audit' : 'users'
}

function current(syncEntries: TenantBundle['sync']): TenantBundle {
  return bundle({ tenant: { id: 'tenant-1', status: 'connected' }, sync: syncEntries })
}
const verifiedHealth = tenantActionableHealthProjection({ attention: [] })

test('recorded optional partial stays partial even when every resource has a success timestamp', () => {
  const data = current({ users: sync('SUCCEEDED', 'succeeded'), signIns: sync('LIMITED_COLLECTION_RECORDED') })
  const display = deriveTenantWorkspaceDisplay(data, false, null, verifiedHealth)
  assert.equal(display.state, 'partially-synchronized')
  assert.match(display.syncObservations[1].detail, /Limited collection recorded/)
  assert.equal(display.lastSuccessfulSync, '2026-09-29T12:00:00.000Z')
})

test('queued, initialization, deferred and unknown records describe distinct outcomes without attesting execution', () => {
  for (const [kind, label] of [
    ['AWAITING_EXECUTION', 'Collection queued'],
    ['INITIALIZATION_WAIT_RECORDED', 'Initialization wait recorded'],
    ['DEFERRED_WORK_RECORDED', 'Deferred work recorded'],
    ['UNKNOWN', 'Collection outcome unknown'],
  ] as const) {
    const display = deriveTenantWorkspaceDisplay(current({ [keyFor(kind)]: sync(kind) }), false, null, verifiedHealth)
    assert.equal(display.state, 'unverified', kind)
    assert.ok(display.syncObservations[0].detail.includes(label))
    assert.match(display.syncObservations[0].detail, /activity is not verified/)
  }
})

test('legacy and malformed projections do not claim healthy or active execution', () => {
  for (const projection of [undefined, null, {}, { version: 2 }, { version: 1 },
    { ...sync('SUCCEEDED').outcomeProjection, recordedOutcome: null },
    { ...sync('SUCCEEDED').outcomeProjection, recordedOutcome: { kind: 'FUTURE_VALUE' } },
  ]) {
    for (const status of ['running', 'pending', 'queued', 'syncing', 'success']) {
      const entry = { ...sync('SUCCEEDED', status), outcomeProjection: projection } as TenantSyncStatus
      const display = deriveTenantWorkspaceDisplay(current({ users: entry }), false, null, verifiedHealth)
      assert.equal(display.state, 'unverified', `${status} / ${JSON.stringify(projection)}`)
      assert.doesNotMatch(display.syncObservations[0].detail, /collecting|crashed|orphaned/i)
    }
  }
})

test('stored error text does not infer permissions, token expiry, partial outcome or opt-out', () => {
  for (const message of ['403 Forbidden', '401 token expired', 'CollectionPartialError', 'intentionally disabled']) {
    const entry = { ...sync('UNKNOWN'), lastError: message }
    const display = deriveTenantWorkspaceDisplay(current({ users: entry }))
    assert.equal(display.state, 'needs-attention')
    assert.equal(display.issues[0].technicalDetails, message)
    assert.equal(display.issues[0].title, 'Entra Users collection needs review')
    assert.equal(display.issues[0].action, 'Retry synchronization')
    assert.match(display.syncObservations[0].detail, /outcome unknown/)
  }
})

test('independent authoritative warnings and raw failures outrank unknown execution and manual requests', () => {
  const health = tenantActionableHealthProjection({ attention: [
    { key: 'authorization-required', label: 'Required permission missing', severity: 'high', why: 'Review consent.' },
  ] })
  const data = current({ users: sync('UNKNOWN'), teams: { ...sync('FAILED', 'failed'), lastError: '403' } })
  const display = deriveTenantWorkspaceDisplay(data, true, null, health)
  assert.equal(display.state, 'needs-attention')
  assert.equal(display.issueCount, 1)
  assert.equal(display.issues[0].title, 'Required permission missing')
  assert.equal(display.syncRequestPending, true)
  assert.match(display.syncObservations[1].detail, /failure recorded/)
})

test('stale data remains stale with unknown execution and retained outcomes keep attempt ambiguity', () => {
  const data = current({ users: sync('UNKNOWN') })
  data.tenant.isStale = true
  const display = deriveTenantWorkspaceDisplay(data, true, null, verifiedHealth)
  assert.equal(display.state, 'stale')
  assert.equal(display.isStale, true)
  for (const [relation, label] of [['PREDATES_ATTEMPT', 'predates a newer attempt'], ['RETAINED_OR_CURRENT', 'may be a retained outcome']] as const) {
    const view = deriveTenantWorkspaceDisplay(current({ signIns: sync('LIMITED_COLLECTION_RECORDED', 'running', relation) }))
    assert.equal(view.state, 'partially-synchronized')
    assert.ok(view.syncObservations[0].detail.includes(label))
  }
})

test('selected current limited sign-in evidence is preserved independently of nonselected Graph RUNNING', () => {
  const entry = sync('UNKNOWN')
  entry.outcomeProjection!.resourceType = 'SIGN_INS'
  entry.lastSuccessfulAt = null
  const display = deriveTenantWorkspaceDisplay(current({ signIns: entry }), false, {
    availability: 'CURRENT_LIMITED', coverage: 'LIMITED', selectedSource: 'OFFICE_365_ACTIVITY_FEED',
    observedAt: '2026-09-29T12:00:00.000Z', reasonCode: 'SIGN_IN_FALLBACK_ACTIVE', reason: 'Current limited audit evidence.',
  }, verifiedHealth)
  assert.equal(display.state, 'partially-synchronized')
  assert.equal(display.issueCount, 0)
  assert.equal(display.isInitialSync, false)
  assert.equal(display.syncObservations.length, 1)
  assert.match(display.syncObservations[0].detail, /Current limited sign-in evidence available/)
  assert.doesNotMatch(display.syncObservations[0].detail, /outcome unknown/)
})

test('nested Exchange recorded failures are included and projected resource aliases are deduplicated', () => {
  const entry = sync('FAILED', 'failed')
  entry.outcomeProjection!.resourceType = 'EXCHANGE_MAILBOX_RULES'
  const data = current({ rules: entry })
  data.exchange = { sync: { inboxRules: entry, mailboxes: sync('UNKNOWN') } }
  const display = deriveTenantWorkspaceDisplay(data, false, null, verifiedHealth)
  assert.equal(display.state, 'needs-attention')
  assert.equal(display.syncObservations.length, 2)
})

test('malformed projection identity cannot hide an independent failure as a nonselected sign-in record', () => {
  const failure = { ...sync('FAILED', 'failed'), resourceType: 'SIGN_INS', lastError: 'Users permission failure' }
  failure.outcomeProjection!.resourceType = 'SIGN_INS'
  const display = deriveTenantWorkspaceDisplay(current({ users: failure }), false, {
    availability: 'READY', coverage: 'FULL', selectedSource: 'OFFICE_365_ACTIVITY_FEED',
    observedAt: '2026-09-29T12:00:00.000Z', reasonCode: null, reason: null,
  }, verifiedHealth)
  assert.equal(display.state, 'needs-attention')
  assert.ok(display.syncObservations.some(row => row.resource === 'users' && row.diagnostic === 'Users permission failure'))
  assert.match(display.syncObservations[0].detail, /Collection failure recorded/)
})

test('contradictory status, identity, basis, reason and relation use conservative descriptions', () => {
  const cases: TenantSyncStatus[] = [
    { ...sync('SUCCEEDED', 'succeeded'), status: 'failed' },
    { ...sync('SUCCEEDED', 'succeeded'), status: 'running' },
    { ...sync('FAILED', 'failed'), outcomeProjection: { ...sync('SUCCEEDED', 'succeeded').outcomeProjection!,
      recordedOutcome: { kind: 'SUCCEEDED', basis: 'LEGACY_LABEL', relation: 'LATEST_RECORDED' } } },
  ]
  for (const key of ['basis', 'relation', 'kind'] as const) {
    const entry = sync('SUCCEEDED', 'succeeded')
    const replacements = { basis: 'UNCLASSIFIED', relation: 'PREDATES_ATTEMPT', kind: 'AWAITING_EXECUTION' } as const
    ;(entry.outcomeProjection!.recordedOutcome as Record<string, string>)[key] = replacements[key]
    cases.push(entry)
  }
  for (const value of cases) {
    const display = deriveTenantWorkspaceDisplay(current({ users: value }), false, null, verifiedHealth)
    assert.notEqual(display.state, 'healthy')
    assert.doesNotMatch(display.syncObservations[0].detail, /Successful collection recorded|Collection queued/)
  }
  for (const mutate of [
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.recordedOutcome.relation = 'LATEST_RECORDED' },
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.recordedOutcome.basis = 'STORED_STATUS' },
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.reasonCode = 'unrecognized-partial' },
    (entry: TenantSyncStatus) => { entry.outcomeProjection!.resourceType = 'USERS' },
  ]) {
    const entry = sync('LIMITED_COLLECTION_RECORDED')
    mutate(entry)
    const display = deriveTenantWorkspaceDisplay(current({ signIns: entry }), false, null, verifiedHealth)
    assert.equal(display.state, 'unverified')
    assert.doesNotMatch(display.syncObservations[0].detail, /Limited collection recorded|Successful collection recorded/)
  }
})

test('accepts actual producer combinations including all reason codes and clock relationships', () => {
  const now = new Date('2026-09-29T13:00:00.000Z')
  const success = new Date('2026-09-29T12:00:00.000Z')
  const limitedCodes = [
    'sign-ins-premium-graph-fallback-active', 'sign-ins-non-premium-fallback-active',
    'sign-ins-entitlement-unverified-fallback-active',
    'sign-ins-premium-graph-fallback-active-geolocation-partial',
    'sign-ins-non-premium-fallback-active-geolocation-partial',
    'sign-ins-entitlement-unverified-fallback-active-geolocation-partial',
  ]
  for (const [resourceType, resource, code, label] of [
    ...limitedCodes.map(code => ['SIGN_INS', 'signIns', code, 'Limited collection recorded']),
    ['SIGN_INS', 'signIns', 'sign-ins-audit-subscription-initializing', 'Initialization wait recorded'],
    ['M365_AUDIT', 'm365Audit', 'm365-audit-backlog', 'Deferred work recorded'],
    ['M365_AUDIT', 'm365Audit', 'm365-audit-budget-exhausted', 'Deferred work recorded'],
  ]) {
    for (const attempt of [null, new Date('2026-09-29T11:59:00.000Z'), success, new Date('2026-09-29T12:01:00.000Z')]) {
      const projected = projectSyncOutcome(resourceType, { status: 'RUNNING', lastSuccessfulAt: success, lastAttemptAt: attempt, lastErrorCode: code }, now)
      const display = deriveTenantWorkspaceDisplay(current({ [resource]: { status: 'running', lastSuccessfulAt: success.toISOString(), lastError: null, outcomeProjection: projected } }), false, null, verifiedHealth)
      assert.ok(display.syncObservations[0].detail.includes(label), `${code} / ${attempt}`)
      assert.notEqual(display.state, 'healthy')
    }
  }
  for (const [status, label] of [['SUCCEEDED', 'Successful collection recorded'], ['FAILED', 'Collection failure recorded'], ['IDLE', 'collector idle'], ['PENDING', 'Collection queued'], ['QUEUED', 'Collection queued'], ['RUNNING', 'Collection outcome unknown']]) {
    const value = { status: status.toLowerCase(), lastSuccessfulAt: success.toISOString(), lastError: null,
      outcomeProjection: projectSyncOutcome('USERS', { status }, now) }
    const display = deriveTenantWorkspaceDisplay(current({ users: value }), false, null, verifiedHealth)
    assert.ok(display.syncObservations[0].detail.includes(label), status)
  }
})

test('absent and malformed actionable health never certify zero; legacy diagnostics remain visible', () => {
  for (const health of [null, undefined, { status: 'BOGUS', items: [] }, { status: 'VERIFIED', items: null }, { status: 'VERIFIED', items: [{}] }]) {
    const unknown = deriveTenantWorkspaceDisplay(current({ users: sync('UNKNOWN') }), false, null, health as any)
    assert.equal(unknown.attentionVerified, false)
    assert.equal(unknown.state, 'unverified')
    const failure = deriveTenantWorkspaceDisplay(current({ users: { ...sync('FAILED', 'failed'), lastError: 'Retained diagnostic' } }), false, null, health as any)
    assert.equal(failure.attentionVerified, false)
    assert.equal(failure.state, 'needs-attention')
    assert.equal(failure.issues[0].technicalDetails, 'Retained diagnostic')
  }
  assert.equal(deriveTenantWorkspaceDisplay(current({ users: sync('SUCCEEDED', 'succeeded') }), false, null, verifiedHealth).attentionVerified, true)
})

test('complete otherwise-valid projections reject unsupported version and execution independently', () => {
  for (const changedField of [{ version: 2 }, { execution: 'RUNNING' }]) {
    const value = sync('SUCCEEDED', 'succeeded')
    value.outcomeProjection = { ...value.outcomeProjection!, ...changedField } as SyncOutcomeProjection
    const display = deriveTenantWorkspaceDisplay(current({ users: value }), false, null, verifiedHealth)
    assert.equal(display.state, 'unverified', JSON.stringify(changedField))
    assert.match(display.syncObservations[0].detail, /Collection outcome not verified/)
    assert.doesNotMatch(display.syncObservations[0].detail, /Successful collection recorded|collecting|in progress/i)
    assert.equal(display.lastSuccessfulSync, '2026-09-29T12:00:00.000Z')
  }
})
