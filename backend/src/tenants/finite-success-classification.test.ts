import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCollectionReadiness, M365_ACTIVITY_CONTENT_TYPES } from './collection-readiness.js'
import { TENANT_HEALTH_RESOURCE_REGISTRY, deriveTenantHealth } from './tenant-health.js'

/**
 * HAW-77 v5: an UNUSABLE recorded success must not be reported as a success.
 *
 * v1 stopped `classify()` throwing on an invalid stored timestamp by
 * serializing it through `isoTime`, which deliberately answers `null`. But the
 * two success decisions below that line kept reading the RAW
 * `state.lastSuccessfulAt`:
 *
 *   - `if (!state.lastSuccessfulAt)` — every Date object is truthy whatever its
 *     validity, so `new Date(NaN)` skipped the missing-success branch;
 *   - `now - state.lastSuccessfulAt.getTime()` — that is `NaN`, and
 *     `NaN > agingMs` is `false`, so it skipped the stale branch too.
 *
 * A SUCCEEDED non-sign-in resource with an invalid success therefore fell all
 * the way through to `classification: 'SUCCESS'` while reporting
 * `lastSuccessfulAt: null`: a row claiming a completion it could not name. It
 * was then counted in `successful`, excluded from `data.issues` (which filters
 * on `classification !== 'SUCCESS'`), and able to carry `data.status` to
 * COMPLETE and `overallStatus` to HEALTHY. Readiness independently rejects the
 * same value as UNVERIFIED, so the composed response contradicted itself.
 *
 * Measured on the exact v4 head `0aa98d7` with one required non-sign-in row
 * invalid and every other registry row valid-current:
 *
 *   successfulResources 21/21, completenessPercent 100, pendingResources 0,
 *   data.status COMPLETE, overallStatus HEALTHY, USERS absent from issues.
 *
 * The correction is that ONE validated finite Date now feeds both the reported
 * field and every decision taken from it, so an output and a classification
 * cannot disagree about whether a value was usable.
 *
 * ORDERING RULE observed throughout: the meaningful COUNT or CLASSIFICATION is
 * asserted FIRST in every regression case. `lastSuccessfulAt` is `null` on the
 * base head too, so asserting that first would pass there and rob the negative
 * control of its meaning.
 */

const NOW = new Date('2026-11-26T12:00:00.000Z')
/** USERS is an `incremental` resource: currentMs 15m, agingMs 2h. Chosen for
 *  the stale control precisely because the `daily` window consults
 *  `HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED`, and a control must not depend on
 *  an environment variable. */
const USERS_AGING_MS = 2 * 60 * 60 * 1000
const CURRENT = new Date(NOW.getTime() - 5 * 60 * 1000)
const STALE_SUCCESS = new Date(NOW.getTime() - USERS_AGING_MS - 60 * 1000)
const INVALID = new Date('not-a-timestamp')
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

/** Premium-entitled, so nothing here is masked by an entitlement branch. */
const readinessInput = (signIn: StateOverrides) => ({
  connectionStatus: 'CONNECTED',
  connectionVerifiedAt: CURRENT,
  consentedPermissions: PERMISSIONS,
  syncStates: ALL_RESOURCES.map(resource =>
    resource === 'SIGN_INS' ? syncState(resource, signIn) : syncState(resource)),
  licenseServicePlans: [
    { servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' },
    { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' },
    { servicePlanName: 'AAD_PREMIUM', servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d', provisioningStatus: 'Success' },
  ],
  subscriptions: M365_ACTIVITY_CONTENT_TYPES.map(contentType => ({
    contentType, status: 'ENABLED', lastStartRequestedAt: CURRENT, lastVerifiedAt: CURRENT,
    lastSuccessfulPollAt: CURRENT, lastError: null,
  })),
  now: NOW,
})

/**
 * THE COMPOSITION UNDER TEST, identical in shape to the one this candidate
 * already exercises: readiness is derived first and its `evidence.signIns` is
 * handed to health as `signInEvidence`, against ONE clock and ONE set of sync
 * states. `usersOverrides` perturbs exactly one required non-sign-in row.
 */
const compose = (usersOverrides: StateOverrides = {}, signIn: StateOverrides = {}) => {
  const evidence = deriveCollectionReadiness(readinessInput(signIn) as never).evidence.signIns
  const health = deriveTenantHealth({
    tenantId: 'tenant-haw77-v5', effectiveStatus: 'active', connectionStatus: 'ACTIVE',
    missingPermissions: [], authSnapshot: null, riskyIdentityCount: 0, now: NOW,
    auditEvidence: AUDIT_COMPLETE,
    signInEvidence: evidence,
    syncStates: TENANT_HEALTH_RESOURCE_REGISTRY.map(resource =>
      resource.resourceType === 'SIGN_INS'
        ? syncState(resource.resourceType, signIn)
        : resource.resourceType === 'USERS'
          ? syncState(resource.resourceType, usersOverrides)
          : syncState(resource.resourceType)) as never,
  } as never)
  return { evidence, health, users: health.resourceHealth.find(r => r.resourceType === 'USERS')! }
}

/** The plain, non-composed path: no `signInEvidence`, so `classify()` alone
 *  decides every row. Binds the defect in the simpler call too. */
const direct = (rows: unknown[]) => deriveTenantHealth({
  tenantId: 'tenant-haw77-v5', effectiveStatus: 'active', connectionStatus: 'ACTIVE',
  missingPermissions: [], authSnapshot: null, riskyIdentityCount: 0, now: NOW,
  auditEvidence: AUDIT_COMPLETE, syncStates: rows as never,
} as never)

/** USERS is `required: true` in the registry, and is not the sign-in source. */
test('registry precondition: USERS is a required non-sign-in resource', () => {
  const users = TENANT_HEALTH_RESOURCE_REGISTRY.find(r => r.resourceType === 'USERS')
  assert.equal(users?.required, true, 'the blocker is about a REQUIRED row')
  assert.notEqual(users?.resourceType, 'SIGN_INS')
  assert.equal(TENANT_HEALTH_RESOURCE_REGISTRY.length, 21)
})

// ---------------------------------------------------------------------------
// 1. The blocker: an invalid SUCCEEDED success is not a success
// ---------------------------------------------------------------------------

test('composed: an invalid SUCCEEDED success is not counted successful and cannot make data COMPLETE', () => {
  const { health, users } = compose({ lastSuccessfulAt: INVALID })

  // COUNT FIRST. On 0aa98d7 this is 21 and data.status is COMPLETE.
  assert.equal(health.data.successfulResources, 20,
    'a row whose recorded success is unusable must not be counted among the successful resources')
  assert.equal(health.data.expectedResources, 21)
  assert.notEqual(health.data.status, 'COMPLETE',
    'an unusable success must not be able to complete the data status')
  assert.equal(health.data.status, 'PARTIAL')
  assert.equal(health.data.completenessPercent, 95)
  assert.equal(health.data.pendingResources, 1)

  // Then the classification.
  assert.notEqual(users.classification, 'SUCCESS')
  assert.equal(users.classification, 'NOT_CONFIGURED')
  assert.equal(users.reasonCode, 'never-succeeded')

  // Only then the field, which is already null on the base head.
  assert.equal(users.lastSuccessfulAt, null,
    'the unusable value is still refused as output, exactly as v1 intended')

  // It must be REPORTED, not silently dropped: `data.issues` filters on
  // `classification !== 'SUCCESS'`, so a false SUCCESS made the row vanish.
  assert.ok(health.data.issues.some(i => i.resourceType === 'USERS'),
    'the row must appear as an issue rather than disappearing from the response')
  assert.notEqual(health.overallStatus, 'HEALTHY',
    'a tenant with an unusable required success must not read HEALTHY')
})

test('direct: the same invalid SUCCEEDED success is refused without the composition', () => {
  const health = direct(TENANT_HEALTH_RESOURCE_REGISTRY.map(r =>
    r.resourceType === 'USERS' ? syncState(r.resourceType, { lastSuccessfulAt: INVALID }) : syncState(r.resourceType)))
  assert.equal(health.data.successfulResources, 20)
  assert.notEqual(health.data.status, 'COMPLETE')
  assert.equal(health.resourceHealth.find(r => r.resourceType === 'USERS')!.classification, 'NOT_CONFIGURED')
})

test('an invalid SUCCEEDED success does not throw, in either call shape', () => {
  assert.doesNotThrow(() => compose({ lastSuccessfulAt: INVALID }))
  assert.doesNotThrow(() => direct([syncState('USERS', { lastSuccessfulAt: INVALID })]))
  // A lone invalid row: no usable completion anywhere, so nothing is collected.
  const lone = direct([syncState('USERS', { lastSuccessfulAt: INVALID })])
  assert.equal(lone.data.successfulResources, 0)
  assert.equal(lone.data.freshnessStatus, 'NEVER_SYNCED')
  assert.equal(lone.data.lastSyncCompletedAt, null, 'latestDate still refuses the unusable value')
})

test('an invalid recorded ATTEMPT alongside a valid success leaves the success intact', () => {
  // Scoped deliberately: the attempt field is a separate sink and this
  // correction does not change it. Asserted only to show it is unaffected.
  const { users } = compose({ lastAttemptAt: INVALID, lastSuccessfulAt: CURRENT })
  assert.equal(users.classification, 'SUCCESS')
  assert.equal(users.lastSuccessfulAt, CURRENT.toISOString())
  assert.equal(users.lastAttemptAt, null)
})

// ---------------------------------------------------------------------------
// 2. Preservation: valid current, valid stale, missing, FAILED, RUNNING
// ---------------------------------------------------------------------------

test('preserved: a valid current success is still SUCCESS and still completes the data status', () => {
  const { health, users } = compose()
  assert.equal(health.data.successfulResources, 21)
  assert.equal(health.data.expectedResources, 21)
  assert.equal(health.data.status, 'COMPLETE')
  assert.equal(health.data.completenessPercent, 100)
  assert.equal(users.classification, 'SUCCESS')
  assert.equal(users.reasonCode, null)
  assert.equal(users.lastSuccessfulAt, CURRENT.toISOString(),
    'a valid success still serializes exactly as recorded')
})

test('preserved: a valid stale success is still a MEASURED stale success', () => {
  const { health, users } = compose({ lastSuccessfulAt: STALE_SUCCESS })
  assert.equal(health.data.staleResources, 1)
  assert.equal(health.data.successfulResources, 20)
  assert.equal(users.classification, 'STALE')
  assert.equal(users.reasonCode, 'stale-success')
  assert.equal(users.lastSuccessfulAt, STALE_SUCCESS.toISOString(),
    'a stale success is reported, not discarded - it is a measurement')
  assert.notEqual(users.classification, 'NOT_CONFIGURED',
    'a usable but old success must not be confused with an unusable one')
})

test('preserved: the boundary between current and stale is unmoved', () => {
  const atBound = compose({ lastSuccessfulAt: new Date(NOW.getTime() - USERS_AGING_MS) })
  assert.equal(atBound.users.classification, 'SUCCESS', 'exactly at the aging bound is not yet stale')
  const pastBound = compose({ lastSuccessfulAt: new Date(NOW.getTime() - USERS_AGING_MS - 1) })
  assert.equal(pastBound.users.classification, 'STALE', 'one millisecond past the bound is stale')
})

test('preserved: a missing success keeps its own semantics', () => {
  for (const [label, value] of [['null', null], ['undefined', undefined]] as const) {
    const { health, users } = compose({ lastSuccessfulAt: value })
    assert.equal(health.data.successfulResources, 20, label)
    assert.equal(users.classification, 'NOT_CONFIGURED', label)
    assert.equal(users.reasonCode, 'never-succeeded', label)
    assert.equal(users.lastSuccessfulAt, null, label)
  }
})

test('preserved: FAILED precedence survives an invalid success', () => {
  // FAILED is decided ABOVE the success branch, so an invalid success must not
  // be able to demote a reported failure into "never succeeded".
  const { health, users } = compose({
    status: 'FAILED', lastErrorCode: 'MICROSOFT_SERVER_ERROR', lastErrorMessage: 'upstream failed',
    consecutiveFailures: 5, lastSuccessfulAt: INVALID,
  })
  assert.equal(health.data.failedResources, 1)
  assert.equal(users.classification, 'FAILED')
  assert.equal(users.reasonCode, 'MICROSOFT_SERVER_ERROR')
  assert.notEqual(users.classification, 'NOT_CONFIGURED')
})

test('preserved: a permission failure with an invalid success is still PERMISSION_REQUIRED', () => {
  const { health, users } = compose({
    status: 'FAILED', lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED', lastErrorMessage: 'consent required',
    consecutiveFailures: 5, lastSuccessfulAt: INVALID,
  })
  assert.equal(health.data.failedResources, 1)
  assert.equal(users.classification, 'PERMISSION_REQUIRED')
})

test('preserved: RUNNING precedence survives an invalid success', () => {
  const { health, users } = compose({ status: 'RUNNING', lastSuccessfulAt: INVALID })
  assert.equal(health.data.pendingResources, 1)
  assert.equal(users.classification, 'PENDING')
  assert.equal(users.reasonCode, 'collector-running')
  assert.notEqual(users.classification, 'NOT_CONFIGURED')
})

test('preserved: a retryable FAILED row with an invalid success is still PENDING', () => {
  const { users } = compose({
    status: 'FAILED', lastErrorCode: 'MICROSOFT_THROTTLED', consecutiveFailures: 1, lastSuccessfulAt: INVALID,
  })
  assert.equal(users.classification, 'PENDING')
  assert.equal(users.reasonCode, 'MICROSOFT_THROTTLED')
})

// ---------------------------------------------------------------------------
// 3. The invariant the defect violated, over the local input space
// ---------------------------------------------------------------------------

test('invariant: a reported SUCCESS always names the completion it claims', () => {
  const successValues: Array<[string, Date | null | undefined]> = [
    ['valid current', CURRENT], ['valid stale', STALE_SUCCESS],
    ['invalid', INVALID], ['null', null], ['undefined', undefined],
  ]
  let checked = 0
  for (const status of ['SUCCEEDED', 'FAILED', 'RUNNING', 'QUEUED', 'IDLE']) {
    for (const [label, value] of successValues) {
      const { users } = compose({ status, lastSuccessfulAt: value, consecutiveFailures: 5 })
      const where = `${status} / ${label}`
      if (users.classification === 'SUCCESS' || users.classification === 'STALE') {
        assert.notEqual(users.lastSuccessfulAt, null,
          `${where}: a SUCCESS or STALE verdict is a claim about a completion, so it must report one`)
      }
      if (users.lastSuccessfulAt === null) {
        assert.notEqual(users.classification, 'SUCCESS',
          `${where}: nothing may be called SUCCESS while reporting no completion time`)
      }
      checked += 1
    }
  }
  assert.equal(checked, 25, 'every status x success-value pair was actually exercised')
})

// ---------------------------------------------------------------------------
// 4. The HAW-77 sign-in controls this change must not disturb
// ---------------------------------------------------------------------------

test('preserved: full Microsoft Graph recovery still reads SUCCESS and COMPLETE', () => {
  const { health, evidence } = compose()
  assert.equal(health.data.status, 'COMPLETE')
  assert.equal(evidence.availability, 'READY')
  assert.equal(evidence.selectedSource, 'MICROSOFT_GRAPH')
  assert.equal(health.resourceHealth.find(r => r.resourceType === 'SIGN_INS')!.classification, 'SUCCESS')
})

test('preserved: a current limited sign-in fallback is still PARTIAL with its attribution', () => {
  const { health, evidence } = compose({}, { status: 'RUNNING', lastErrorCode: CODE, lastSuccessfulAt: CURRENT })
  assert.equal(evidence.availability, 'CURRENT_LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(health.resourceHealth.find(r => r.resourceType === 'SIGN_INS')!.classification, 'PARTIAL')
  assert.equal(health.operations.partialJobs, 1)
})

test('preserved: an unqualified RUNNING sign-in fallback is still counted as pending work', () => {
  // The v4 correction, asserted here so this change cannot silently undo it.
  const { health, evidence } = compose({}, { status: 'RUNNING', lastErrorCode: CODE, lastSuccessfulAt: INVALID })
  assert.equal(health.operations.pendingJobs, 1,
    'a genuinely RUNNING collector is still counted as pending work')
  assert.equal(health.operations.status, 'SYNCING')
  // INITIALIZING, not UNVERIFIED: every other collector here succeeded, so the
  // sign-in dataset is PARTIAL, and PARTIAL is the one state v3's relabel
  // allowlist permits to be re-described as in progress. UNVERIFIED arises from
  // an authoritative blocker instead, which is covered in
  // `fallback-access-precedence.test.ts` rather than restated here.
  assert.equal(evidence.availability, 'INITIALIZING')
  assert.equal(evidence.observedAt, null, 'an unusable success publishes no observation')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED', 'attribution survives an unusable timestamp')
  assert.equal(evidence.coverage, 'LIMITED')
})
