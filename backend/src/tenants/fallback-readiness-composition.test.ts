import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCollectionReadiness, M365_ACTIVITY_CONTENT_TYPES } from './collection-readiness.js'
import type { PilotEvidenceProjection } from './collection-readiness.js'
import { TENANT_HEALTH_RESOURCE_REGISTRY, deriveTenantHealth } from './tenant-health.js'

/**
 * HAW-77 v2: the COMPOSED path, which is the one a selected sign-in source
 * actually takes in production.
 *
 * `fallback-readiness-boundary.test.ts` drives readiness and health from the
 * same sync state but as two INDEPENDENT calls, so health never received the
 * readiness projection. That hid three defects that only exist in the
 * composition, where `deriveCollectionReadiness(...).evidence.signIns` is
 * passed to `deriveTenantHealth` as `signInEvidence`:
 *
 *   1. An unqualified RUNNING fallback fell through to the dataset state. The
 *      selected-source mapper had no branch for it, so health called it
 *      NOT_CONFIGURED — and because a truthy `selectedSource` EXCLUDES SIGN_INS
 *      from the operational states, `pendingJobs` was 0 for a collector that
 *      was genuinely running. Running work was hidden, not merely mislabelled.
 *   2. `observedAt` fell through to the dataset timestamp, so a FUTURE success
 *      was published as an observation and became the resource's
 *      `lastSuccessfulAt`.
 *   3. `classifySelectedSignInEvidence` serialized `state.lastAttemptAt` with a
 *      bare `toISOString()`. That throws `RangeError` on an invalid Date, and
 *      this function runs ONLY in the composed path, so one malformed stored
 *      attempt timestamp aborted the entire health projection.
 *
 * And `latestDate` admitted dates on truthiness, so a single invalid row — or
 * an invalid row ordered first, since a NaN comparator leaves the order alone —
 * reached `toISOString()` and threw.
 *
 * Every case here goes through both ACTUAL projections with ONE clock and ONE
 * sync state. Nothing is restated from a stand-in.
 */

const NOW = new Date('2026-11-26T12:00:00.000Z')
const AGING_MS = 2 * 60 * 60 * 1000
const CURRENT = new Date(NOW.getTime() - 5 * 60 * 1000)
const CODE = 'sign-ins-premium-graph-fallback-active'

const PERMISSIONS = ['Organization.Read.All', 'User.Read.All', 'GroupMember.Read.All', 'Member.Read.Hidden',
  'Device.Read.All', 'RoleManagement.Read.Directory', 'UserAuthenticationMethod.Read.All',
  'Policy.Read.AuthenticationMethod', 'Policy.Read.All', 'IdentityRiskyUser.Read.All', 'Application.Read.All',
  'AuditLog.Read.All', 'Directory.Read.All', 'Sites.Read.All', 'SharePointTenantSettings.Read.All',
  'Reports.Read.All', 'MailboxSettings.Read', 'ActivityFeed.Read', 'SecurityEvents.Read.All']

const ALL_RESOURCES = ['AUDIT_LOGS', 'SIGN_INS', 'USERS', 'GROUPS', 'DEVICES', 'DIRECTORY_ROLES',
  'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS',
  'NAMED_LOCATIONS', 'RISKY_USERS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS',
  'SECURE_SCORES', 'ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH',
  'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE', 'EXCHANGE_MAILBOXES',
  'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS',
  'EXCHANGE_MAILBOX_RULES', 'M365_AUDIT']

type StateOverrides = Record<string, unknown>
const syncState = (resourceType: string, overrides: StateOverrides = {}) => ({
  resourceType, status: 'SUCCEEDED', lastAttemptAt: CURRENT, lastSuccessfulAt: CURRENT,
  lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0, ...overrides,
})

const AUDIT_COMPLETE = { status: 'COMPLETE', reason: 'OK', windowComplete: true, observedCount: 0,
  withheldPayloads: 0, assessedAt: NOW.toISOString() } as const

/** Premium-entitled, so the code-derived path is never masked by entitlement. */
const readinessInput = (signIn: StateOverrides, premium = true) => ({
  connectionStatus: 'CONNECTED',
  connectionVerifiedAt: CURRENT,
  consentedPermissions: PERMISSIONS,
  syncStates: ALL_RESOURCES.map(resource =>
    resource === 'SIGN_INS' ? syncState(resource, signIn) : syncState(resource)),
  licenseServicePlans: [
    { servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' },
    { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' },
    ...(premium
      ? [{ servicePlanName: 'AAD_PREMIUM', servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d', provisioningStatus: 'Success' }]
      : []),
  ],
  subscriptions: M365_ACTIVITY_CONTENT_TYPES.map(contentType => ({
    contentType, status: 'ENABLED', lastStartRequestedAt: CURRENT, lastVerifiedAt: CURRENT,
    lastSuccessfulPollAt: CURRENT, lastError: null,
  })),
  now: NOW,
})

/**
 * THE COMPOSITION UNDER TEST: readiness is derived first, and its
 * `evidence.signIns` is handed to health as `signInEvidence`, against the same
 * `now` and the same SIGN_INS sync state. `rows` overrides the health sync
 * states when a case needs a sparse or reordered fleet.
 */
const compose = (signIn: StateOverrides, options: { premium?: boolean; rows?: unknown[] } = {}) => {
  const evidence = deriveCollectionReadiness(readinessInput(signIn, options.premium ?? true) as never).evidence.signIns
  const health = deriveTenantHealth({
    tenantId: 'tenant-haw77-v2', effectiveStatus: 'active', connectionStatus: 'ACTIVE',
    missingPermissions: [], authSnapshot: null, riskyIdentityCount: 0, now: NOW,
    auditEvidence: AUDIT_COMPLETE,
    signInEvidence: evidence,
    syncStates: (options.rows ?? TENANT_HEALTH_RESOURCE_REGISTRY.map(resource =>
      resource.resourceType === 'SIGN_INS'
        ? syncState(resource.resourceType, signIn)
        : syncState(resource.resourceType))) as never,
  })
  const resource = health.resourceHealth.find(row => row.resourceType === 'SIGN_INS')!
  return { evidence, health, resource }
}

const RUNNING = (successAt: Date | null) =>
  ({ status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: CODE, lastSuccessfulAt: successAt })

// ---------------------------------------------------------------------------
// 1. An unqualified RUNNING fallback must not be able to hide running work
// ---------------------------------------------------------------------------

/** The two unmeasurable timestamps, asserted through the SAME composed path. */
const UNMEASURABLE: Array<[string, Date]> = [
  ['one millisecond in the future', new Date(NOW.getTime() + 1)],
  ['an invalid Date', new Date('not-a-timestamp')],
]

for (const [label, successAt] of UNMEASURABLE) {
  test(`composed: a RUNNING fallback whose success is ${label} stays pending work`, () => {
    const { evidence, health, resource } = compose(RUNNING(successAt))

    // Readiness must say "unmeasured" HERE, because this value is what health
    // consumes. Falling through to the dataset state is what hid the work.
    assert.equal(evidence.availability, 'INITIALIZING',
      'readiness must report an unqualified RUNNING fallback as in progress')
    assert.equal(evidence.observedAt, null,
      'an unmeasurable success must not be published as an observation')
    assert.equal(evidence.reasonCode, CODE)

    // Attribution survives: dropping it sends a premium tenant down the
    // entitlement branch and manufactures a FULL Microsoft Graph claim.
    assert.equal(evidence.coverage, 'LIMITED', 'source attribution must survive an unusable timestamp')
    assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')

    // Health, through the composition.
    assert.equal(resource.classification, 'PENDING',
      'the selected-source mapper must classify unmeasured limited evidence as pending')
    assert.equal(resource.lastSuccessfulAt, null,
      'health must not echo an unmeasurable success as a recorded success')
    assert.equal(health.operations.pendingJobs, 1,
      'a genuinely running collector must still be counted as pending work')
    assert.equal(health.operations.partialJobs, 0, 'unmeasured evidence is not current limited evidence')
    assert.equal(health.operations.failedJobs, 0)
    assert.equal(health.operations.status, 'SYNCING')
    assert.equal(health.data.pendingResources, 1)
    assert.equal(health.data.staleResources, 0, 'unmeasured is not a measured stale success')
    assert.equal(health.data.status, 'PARTIAL')
  })
}

test('composed: a future success is never published as an observation or a success', () => {
  const future = new Date(NOW.getTime() + 60_000)
  const { evidence, resource } = compose(RUNNING(future))
  assert.equal(evidence.observedAt, null)
  assert.equal(resource.lastSuccessfulAt, null)
  // The released arithmetic accepted it: this is the defect, stated as code.
  assert.equal(NOW.getTime() - future.getTime() <= AGING_MS, true,
    'now - future <= window is true, which is why a bare comparison accepted it')
})

// ---------------------------------------------------------------------------
// 2. The composed projection must not throw on a malformed ATTEMPT timestamp
// ---------------------------------------------------------------------------

test('composed: an invalid recorded attempt timestamp does not abort the projection', () => {
  const signIn = { status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: CODE,
    lastAttemptAt: new Date('not-a-timestamp'), lastSuccessfulAt: CURRENT }
  // `classifySelectedSignInEvidence` runs ONLY when a source is selected, so
  // this path is reachable only through the composition.
  const { evidence, health, resource } = compose(signIn)
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED', 'the composed mapper must be the one that ran')
  assert.equal(resource.classification, 'PARTIAL', 'a current limited success is unaffected by the bad attempt')
  assert.equal(resource.lastSuccessfulAt, CURRENT.toISOString())
  assert.equal(health.operations.partialJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
})

// ---------------------------------------------------------------------------
// 3. Preserved composed behaviour — the point of the partition
// ---------------------------------------------------------------------------

test('composed: a canonical current limited success is unchanged', () => {
  const { evidence, health, resource } = compose(RUNNING(CURRENT))
  assert.equal(evidence.availability, 'CURRENT_LIMITED')
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(evidence.observedAt, CURRENT.toISOString())
  assert.equal(resource.classification, 'PARTIAL')
  assert.equal(resource.lastSuccessfulAt, CURRENT.toISOString())
  assert.equal(health.operations.partialJobs, 1)
  assert.equal(health.operations.pendingJobs, 0, 'qualified fallback evidence is not pending work')
  assert.equal(health.operations.status, 'HEALTHY')
  assert.equal(health.data.status, 'PARTIAL')
})

test('composed: the inclusive boundaries still qualify', () => {
  for (const [label, successAt] of [
    ['exactly now', NOW],
    ['exactly the aging bound', new Date(NOW.getTime() - AGING_MS)],
  ] as Array<[string, Date]>) {
    const { evidence, health } = compose(RUNNING(successAt))
    assert.equal(evidence.availability, 'CURRENT_LIMITED', label)
    assert.equal(evidence.observedAt, successAt.toISOString(), label)
    assert.equal(health.operations.partialJobs, 1, label)
    assert.equal(health.operations.pendingJobs, 0, label)
  }
})

test('composed: a success older than the bound is a measured stale success', () => {
  const stale = new Date(NOW.getTime() - AGING_MS - 1)
  const { evidence, health, resource } = compose(RUNNING(stale))
  assert.equal(evidence.availability, 'STALE')
  assert.equal(evidence.coverage, 'LIMITED', 'limited source truth is kept while refusing freshness')
  assert.equal(evidence.observedAt, stale.toISOString(), 'a measured success is still reported')
  assert.equal(resource.classification, 'STALE')
  assert.equal(health.operations.pendingJobs, 0, 'a measured stale success is not pending work')
  assert.equal(health.operations.activeIssues, 1)
  assert.equal(health.operations.status, 'DEGRADED')
  assert.equal(health.data.staleResources, 1)
})

test('composed: attribution survives a FAILED fallback collector', () => {
  const { evidence, health, resource } = compose({
    status: 'FAILED', consecutiveFailures: 3, lastErrorCode: CODE, lastSuccessfulAt: CURRENT,
  })
  assert.equal(evidence.coverage, 'LIMITED', 'failure must not erase source attribution')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(evidence.availability, 'FAILED_TRANSIENT')
  assert.equal(resource.classification, 'FAILED')
  assert.equal(health.operations.failedJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
})

test('composed: a non-premium tenant keeps its entitlement-derived limited source', () => {
  const { evidence, health, resource } = compose(
    { status: 'SUCCEEDED', lastErrorCode: null, lastSuccessfulAt: CURRENT }, { premium: false })
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(evidence.availability, 'READY')
  assert.equal(resource.classification, 'SUCCESS')
  assert.equal(health.operations.pendingJobs, 0)
  assert.equal(health.operations.partialJobs, 0)
})

test('composed: full Microsoft Graph recovery is unchanged', () => {
  const { evidence, health, resource } = compose({ status: 'SUCCEEDED', lastErrorCode: null, lastSuccessfulAt: CURRENT })
  assert.equal(evidence.availability, 'READY')
  assert.equal(evidence.coverage, 'FULL')
  assert.equal(evidence.selectedSource, 'MICROSOFT_GRAPH')
  assert.equal(resource.classification, 'SUCCESS')
  assert.equal(health.data.status, 'COMPLETE')
  assert.equal(health.operations.status, 'HEALTHY')
  assert.equal(health.overallStatus, 'HEALTHY')
})

test('composed: an existing required-collector failure is still reported alongside limited sign-ins', () => {
  const signIn = RUNNING(CURRENT)
  const rows = TENANT_HEALTH_RESOURCE_REGISTRY.map(resource =>
    resource.resourceType === 'SIGN_INS' ? syncState(resource.resourceType, signIn)
      : resource.resourceType === 'USERS'
        ? syncState(resource.resourceType, { status: 'FAILED', consecutiveFailures: 4, lastErrorCode: 'MICROSOFT_UNKNOWN', lastSuccessfulAt: null })
        : syncState(resource.resourceType))
  const { health } = compose(signIn, { rows })
  assert.equal(health.operations.failedJobs, 1, 'the real failure must survive the partition')
  assert.equal(health.operations.partialJobs, 1, 'and the limited sign-in evidence is still partial')
  assert.equal(health.operations.status, 'DEGRADED')
  assert.equal(health.overallStatus, 'DEGRADED')
})

// ---------------------------------------------------------------------------
// 4. Sparse and reordered rows: `latestDate` must not throw, and must be honest
// ---------------------------------------------------------------------------

const INVALID_SIGN_IN_ROW = syncState('SIGN_INS', {
  status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: CODE,
  lastAttemptAt: new Date('not-a-timestamp'), lastSuccessfulAt: new Date('not-a-timestamp'),
})
const VALID_ROW = syncState('USERS')

const direct = (rows: unknown[]) => deriveTenantHealth({
  tenantId: 'tenant-haw77-v2', effectiveStatus: 'active', connectionStatus: 'ACTIVE',
  missingPermissions: [], authSnapshot: null, riskyIdentityCount: 0, now: NOW,
  auditEvidence: AUDIT_COMPLETE, syncStates: rows as never,
})

test('sparse: a lone invalid SIGN_INS row yields null summary dates, not a RangeError', () => {
  const health = direct([INVALID_SIGN_IN_ROW])
  assert.equal(health.data.lastSyncStartedAt, null, 'an invalid attempt is not a recorded start')
  assert.equal(health.data.lastSyncCompletedAt, null, 'an invalid success is not a recorded completion')
  assert.equal(health.operations.lastSuccessfulJobAt, null)
  assert.equal(health.data.status, 'NOT_COLLECTED')
  assert.equal(health.resourceHealth.find(row => row.resourceType === 'SIGN_INS')!.classification, 'PENDING',
    'the row is still reported as in progress rather than discarded')
  assert.equal(health.operations.pendingJobs, 1)
})

test('sparse: an invalid row first and last give the same honest summary dates', () => {
  // A NaN comparator leaves `sort` order alone, so an invalid row ordered first
  // stayed first and reached `toISOString()`. Valid-first never threw, which is
  // why order has to be part of the acceptance rather than assumed.
  const invalidFirst = direct([INVALID_SIGN_IN_ROW, VALID_ROW])
  const validFirst = direct([VALID_ROW, INVALID_SIGN_IN_ROW])
  for (const [label, health] of [['invalid first', invalidFirst], ['valid first', validFirst]] as const) {
    assert.equal(health.data.lastSyncStartedAt, CURRENT.toISOString(), label)
    assert.equal(health.data.lastSyncCompletedAt, CURRENT.toISOString(), label)
    assert.equal(health.operations.lastSuccessfulJobAt, CURRENT.toISOString(), label)
    assert.equal(health.operations.pendingJobs, 1, label)
    assert.equal(health.data.status, 'PARTIAL', label)
  }
  assert.deepEqual(invalidFirst.data, validFirst.data, 'the summary must not depend on row order')
})

test('composed sparse: the same rows through the composition stay honest and pending', () => {
  const signIn = {
    status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: CODE,
    lastAttemptAt: new Date('not-a-timestamp'), lastSuccessfulAt: new Date('not-a-timestamp'),
  }
  const lone = compose(signIn, { rows: [INVALID_SIGN_IN_ROW] })
  assert.equal(lone.evidence.availability, 'INITIALIZING')
  assert.equal(lone.evidence.observedAt, null)
  assert.equal(lone.resource.classification, 'PENDING')
  assert.equal(lone.resource.lastAttemptAt, null, 'an unserializable attempt reports null, not a thrown projection')
  assert.equal(lone.resource.lastSuccessfulAt, null)
  assert.equal(lone.health.data.lastSyncStartedAt, null)
  assert.equal(lone.health.data.lastSyncCompletedAt, null)
  assert.equal(lone.health.operations.lastSuccessfulJobAt, null)
  assert.equal(lone.health.operations.pendingJobs, 1, 'the running collector is still counted')
  assert.equal(lone.health.operations.status, 'SYNCING')

  const invalidFirst = compose(signIn, { rows: [INVALID_SIGN_IN_ROW, VALID_ROW] })
  const validFirst = compose(signIn, { rows: [VALID_ROW, INVALID_SIGN_IN_ROW] })
  for (const [label, result] of [['invalid first', invalidFirst], ['valid first', validFirst]] as const) {
    assert.equal(result.health.data.lastSyncCompletedAt, CURRENT.toISOString(), label)
    assert.equal(result.health.operations.pendingJobs, 1, label)
    assert.equal(result.resource.classification, 'PENDING', label)
  }
  assert.deepEqual(invalidFirst.health.data, validFirst.health.data,
    'the composed summary must not depend on row order either')
})

// ---------------------------------------------------------------------------
// 5. A recorded limit, measured rather than claimed closed
// ---------------------------------------------------------------------------

test('recorded limit: the fleet-wide sync summary still echoes a future recorded success', () => {
  // `latestDate` reports the latest RECORDED timestamp across every resource.
  // It is not the fallback freshness decision, and filtering future values
  // there would change every resource's semantics, so this slice guards
  // finiteness only. Measured here so the limit is evidence, not prose.
  const future = new Date(NOW.getTime() + 1)
  const { evidence, health, resource } = compose(RUNNING(future))
  assert.equal(health.data.lastSyncCompletedAt, future.toISOString(),
    'the generic recorded-latest summary is unchanged by this slice')
  // The decisions that matter are still refused.
  assert.equal(evidence.observedAt, null)
  assert.equal(resource.lastSuccessfulAt, null)
  assert.equal(health.data.freshnessStatus, 'CURRENT')
})

test('type guard: the composed evidence is the readiness projection type health consumes', () => {
  const evidence: PilotEvidenceProjection['signIns'] =
    deriveCollectionReadiness(readinessInput(RUNNING(CURRENT)) as never).evidence.signIns
  assert.equal(typeof evidence.availability, 'string')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
})
