import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveCollectionReadiness, M365_ACTIVITY_CONTENT_TYPES } from './collection-readiness.js'
import {
  LIMITED_SIGN_IN_FALLBACK_CODES,
  isLimitedSignInFallbackCode,
  projectSyncOutcome,
  recordedTimeAtOrBefore,
} from './sync-outcome-projection.js'
import { TENANT_HEALTH_RESOURCE_REGISTRY, deriveTenantHealth } from './tenant-health.js'

/**
 * HAW-77: the closed fallback-code predicate and the finite, non-future success
 * boundary, in BOTH actual readers.
 *
 * The released decoders matched `/sign-ins-.*fallback-active/` — unanchored, so
 * any string CONTAINING a fallback-looking fragment qualified — and then treated
 * any present timestamp as a measurement. Two consequences this file pins:
 *
 *   1. `Boolean(new Date('nope'))` is true, so an invalid Date passed the
 *      "has a success" gate.
 *   2. `now - future <= window` is true for any FUTURE success, so a timestamp
 *      ahead of the assessment clock read as current.
 *
 * Every assertion here goes through the ACTUAL projections —
 * `deriveCollectionReadiness(...).evidence.signIns` and
 * `deriveTenantHealth(...)` resource health and operational counts — not
 * through the predicate helpers alone.
 */

const NOW = new Date('2026-11-26T12:00:00.000Z')
const AGING_MS = 2 * 60 * 60 * 1000
const CURRENT = new Date(NOW.getTime() - 5 * 60 * 1000)

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

/** A premium-entitled tenant, so entitlement never masks the code-derived path. */
const readinessInput = (signInOverrides: StateOverrides) => ({
  connectionStatus: 'CONNECTED',
  connectionVerifiedAt: CURRENT,
  consentedPermissions: PERMISSIONS,
  syncStates: ALL_RESOURCES.map(resource =>
    resource === 'SIGN_INS' ? syncState(resource, signInOverrides) : syncState(resource)),
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

const signIns = (signInOverrides: StateOverrides) =>
  deriveCollectionReadiness(readinessInput(signInOverrides) as never).evidence.signIns

/** Health over a fully successful fleet, with SIGN_INS replaced. */
const health = (signInOverrides: StateOverrides) => deriveTenantHealth({
  tenantId: 'tenant-haw77', effectiveStatus: 'active', connectionStatus: 'ACTIVE',
  missingPermissions: [], authSnapshot: null, riskyIdentityCount: 0, now: NOW,
  auditEvidence: { status: 'COMPLETE', reason: 'OK', windowComplete: true, observedCount: 0,
    withheldPayloads: 0, assessedAt: NOW.toISOString() },
  syncStates: TENANT_HEALTH_RESOURCE_REGISTRY.map(resource =>
    resource.resourceType === 'SIGN_INS'
      ? syncState(resource.resourceType, signInOverrides)
      : syncState(resource.resourceType)) as never,
})
const signInResource = (result: ReturnType<typeof health>) =>
  result.resourceHealth.find(row => row.resourceType === 'SIGN_INS')!

/** No default on `successAt`: a default would make an explicit `undefined`
 *  indistinguishable from "not supplied" and silently restore a valid
 *  timestamp, which is exactly what this file has to be able to refuse. */
const runningWith = (code: string, successAt: Date | null | undefined) =>
  ({ status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: code, lastSuccessfulAt: successAt })
const RUNNING_CURRENT = (code: string) => runningWith(code, CURRENT)

// ---------------------------------------------------------------------------
// The closed code set
// ---------------------------------------------------------------------------

test('the six recognized fallback codes are accepted by both actual readers', () => {
  assert.equal(LIMITED_SIGN_IN_FALLBACK_CODES.length, 6)
  for (const code of LIMITED_SIGN_IN_FALLBACK_CODES) {
    assert.equal(isLimitedSignInFallbackCode(code), true, code)
    // Readiness: current limited evidence from the activity feed.
    const evidence = signIns(RUNNING_CURRENT(code))
    assert.equal(evidence.availability, 'CURRENT_LIMITED', code)
    assert.equal(evidence.coverage, 'LIMITED', code)
    assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED', code)
    assert.equal(evidence.observedAt, CURRENT.toISOString(), code)
    // Health: the collector is PARTIAL, and counted as partial rather than pending.
    const result = health(RUNNING_CURRENT(code))
    assert.equal(signInResource(result).classification, 'PARTIAL', code)
    assert.equal(result.operations.partialJobs, 1, code)
    assert.equal(result.operations.pendingJobs, 0, code)
  }
})

test('a prefix, suffix, lookalike or unrecognized code is refused by both actual readers', () => {
  const refused = [
    // superstrings and substrings of recognized codes
    'xsign-ins-non-premium-fallback-active',
    'sign-ins-non-premium-fallback-active-geolocation',
    'sign-ins-non-premium-fallback-active-geolocation-partial-extra',
    'sign-ins-non-premium-fallback-activex',
    'sign-ins-non-premium-fallback-activ',
    // the unanchored pattern's wildcard middle: a code that never existed
    'sign-ins-totally-made-up-fallback-active',
    'sign-ins--fallback-active',
    // case and whitespace variants are NOT normalized
    'SIGN-INS-NON-PREMIUM-FALLBACK-ACTIVE',
    ' sign-ins-non-premium-fallback-active',
    'sign-ins-non-premium-fallback-active ',
    // unrelated real codes
    'sign-ins-audit-subscription-initializing',
    'MICROSOFT_THROTTLED',
    '',
  ]
  for (const code of refused) {
    assert.equal(isLimitedSignInFallbackCode(code), false, JSON.stringify(code))
    const evidence = signIns(RUNNING_CURRENT(code))
    assert.notEqual(evidence.availability, 'CURRENT_LIMITED', JSON.stringify(code))
    assert.notEqual(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED', JSON.stringify(code))
    assert.notEqual(evidence.reasonCode, 'SIGN_IN_FALLBACK_STALE', JSON.stringify(code))
    const result = health(RUNNING_CURRENT(code))
    assert.notEqual(signInResource(result).classification, 'PARTIAL', JSON.stringify(code))
    assert.notEqual(signInResource(result).reasonCode, 'sign-in-fallback-stale', JSON.stringify(code))
    // An unrecognized RUNNING collector is simply in progress.
    assert.equal(signInResource(result).classification, 'PENDING', JSON.stringify(code))
    // `MICROSOFT_THROTTLED` is a recognized retryable code that the existing
    // operational filter removes before pending is counted. That behaviour is
    // unrelated to this fix and is deliberately left alone.
    if (code !== 'MICROSOFT_THROTTLED') {
      assert.equal(result.operations.pendingJobs, 1, JSON.stringify(code))
    }
  }
  // Non-string codes cannot qualify either.
  for (const code of [null, undefined, 42, {}, []] as unknown[]) {
    assert.equal(isLimitedSignInFallbackCode(code), false, String(code))
  }
})

// ---------------------------------------------------------------------------
// The clock boundary
// ---------------------------------------------------------------------------

const CODE = 'sign-ins-non-premium-fallback-active'

test('the success boundary is inclusive at 0 and at the aging bound, in both actual readers', () => {
  for (const [name, age] of [['exactly now', 0], ['exactly the aging bound', AGING_MS]] as const) {
    const at = new Date(NOW.getTime() - age)
    const evidence = signIns(runningWith(CODE, at))
    assert.equal(evidence.availability, 'CURRENT_LIMITED', name)
    assert.equal(evidence.observedAt, at.toISOString(), name)
    const result = health(runningWith(CODE, at))
    assert.equal(signInResource(result).classification, 'PARTIAL', name)
    assert.equal(result.operations.partialJobs, 1, name)
  }
})

test('a success one millisecond in the future is not a measurement in either actual reader', () => {
  const future = new Date(NOW.getTime() + 1)
  assert.equal(recordedTimeAtOrBefore(future, NOW), null)
  // This is the defect: `now - future <= aging` is true, so the released
  // decoders reported a future timestamp as current limited evidence.
  assert.equal(NOW.getTime() - future.getTime() <= AGING_MS, true,
    'the arithmetic the released code relied on still accepts the future')

  const evidence = signIns(runningWith(CODE, future))
  assert.notEqual(evidence.availability, 'CURRENT_LIMITED')
  // Unmeasured, not a measured stale success.
  assert.notEqual(evidence.availability, 'STALE')
  assert.notEqual(evidence.reasonCode, 'SIGN_IN_FALLBACK_STALE')
  // The fallback path no longer publishes an unmeasured success as its own
  // observation, and makes no current claim. `observedAt` then falls through to
  // the per-resource dataset, whose own `freshness` already answers UNKNOWN for
  // a negative age; that generic timestamp echo is pre-existing and out of this
  // slice's scope.
  assert.notEqual(evidence.reasonCode, 'SIGN_IN_FALLBACK_ACTIVE')
  // Attribution survives: the recognized code still names the source.
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(evidence.coverage, 'LIMITED')

  const result = health(runningWith(CODE, future))
  assert.notEqual(signInResource(result).classification, 'PARTIAL')
  assert.notEqual(signInResource(result).classification, 'STALE')
  assert.equal(signInResource(result).classification, 'PENDING',
    'an unqualified RUNNING fallback is in progress, not current and not stale')
  assert.equal(result.operations.pendingJobs, 1, 'and it stays counted as pending')
  assert.equal(result.operations.partialJobs, 0)
})

test('a success older than the aging bound is stale, not current, in both actual readers', () => {
  const old = new Date(NOW.getTime() - AGING_MS - 1)
  const evidence = signIns(runningWith(CODE, old))
  assert.equal(evidence.availability, 'STALE')
  assert.equal(evidence.reasonCode, 'SIGN_IN_FALLBACK_STALE')
  // Stale recognized fallback keeps the limited source truth.
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(evidence.observedAt, old.toISOString())
  const result = health(runningWith(CODE, old))
  assert.equal(signInResource(result).classification, 'STALE')
  assert.equal(signInResource(result).reasonCode, 'sign-in-fallback-stale')
  assert.equal(result.operations.partialJobs, 0)
  assert.equal(result.operations.pendingJobs, 0)
})

test('a missing or invalid success is refused without throwing, in both actual readers', () => {
  for (const [name, at] of [['invalid Date', new Date('nope')], ['null', null], ['undefined', undefined]] as const) {
    // The released gate was truthiness, and an invalid Date is truthy.
    if (name === 'invalid Date') assert.equal(Boolean(at), true, 'an invalid Date is truthy')
    assert.equal(recordedTimeAtOrBefore(at as Date | null, NOW), null, name)

    const evidence = signIns(runningWith(CODE, at as Date | null))
    assert.notEqual(evidence.availability, 'CURRENT_LIMITED', name)
    assert.notEqual(evidence.availability, 'STALE', name)
    // An invalid Date used to make `classify` throw RangeError through
    // `toISOString`, aborting the whole health projection. It must now
    // serialize as null and classify as in-progress.
    const result = health(runningWith(CODE, at as Date | null))
    assert.equal(signInResource(result).lastSuccessfulAt, null, name)
    assert.equal(signInResource(result).classification, 'PENDING', name)
    assert.equal(result.operations.pendingJobs, 1, name)
    assert.equal(result.operations.partialJobs, 0, name)
  }
})

// ---------------------------------------------------------------------------
// Contradictory states, retained attempts, and unchanged behaviour
// ---------------------------------------------------------------------------

test('RUNNING is required for current limited evidence; other states are not current', () => {
  for (const status of ['FAILED', 'SUCCEEDED', 'QUEUED', 'IDLE'] as const) {
    const overrides = { status, consecutiveFailures: status === 'FAILED' ? 1 : 0,
      lastErrorCode: CODE, lastSuccessfulAt: CURRENT }
    const evidence = signIns(overrides)
    assert.notEqual(evidence.availability, 'CURRENT_LIMITED', status)
    const result = health(overrides)
    assert.notEqual(signInResource(result).classification, 'PARTIAL', status)
    // FAILED stays failed rather than becoming current evidence.
    if (status === 'FAILED') assert.equal(signInResource(result).classification, 'FAILED', status)
  }
})

test('a newer attempt alongside a retained success is not treated as a completed newer attempt', () => {
  // lastAttemptAt AFTER lastSuccessfulAt is legitimate: a newer attempt is
  // running while the stored qualifier remains. That relation is reported by the
  // outcome projection and must not become a freshness gate here.
  const retained = { ...runningWith(CODE, CURRENT), lastAttemptAt: NOW }
  const evidence = signIns(retained)
  assert.equal(evidence.availability, 'CURRENT_LIMITED')
  assert.equal(signInResource(health(retained)).classification, 'PARTIAL')
  const outcome = projectSyncOutcome('SIGN_INS', {
    status: 'RUNNING', lastAttemptAt: NOW, lastSuccessfulAt: CURRENT, lastErrorCode: CODE,
  }, NOW)
  assert.equal(outcome.recordedOutcome.kind, 'LIMITED_COLLECTION_RECORDED')
  assert.equal(outcome.recordedOutcome.relation, 'PREDATES_ATTEMPT',
    'the projection already reports the relation; readiness does not re-gate on it')
})

test('the readiness decoder now agrees with the closed outcome policy on code recognition', () => {
  for (const code of [...LIMITED_SIGN_IN_FALLBACK_CODES, 'sign-ins-made-up-fallback-active',
    'xsign-ins-non-premium-fallback-active']) {
    const recognizedByOutcome = projectSyncOutcome('SIGN_INS',
      { status: 'RUNNING', lastAttemptAt: CURRENT, lastSuccessfulAt: CURRENT, lastErrorCode: code }, NOW)
      .recordedOutcome.kind === 'LIMITED_COLLECTION_RECORDED'
    const recognizedByReadiness = signIns(RUNNING_CURRENT(code)).selectedSource === 'OFFICE_365_ACTIVITY_FEED'
    assert.equal(recognizedByReadiness, recognizedByOutcome, code)
  }
  // The outcome projector keeps its own temporal semantics: a future success is
  // not a recorded success there either, and that behaviour is unchanged.
  const future = projectSyncOutcome('SIGN_INS',
    { status: 'RUNNING', lastAttemptAt: CURRENT, lastSuccessfulAt: new Date(NOW.getTime() + 1), lastErrorCode: CODE }, NOW)
  // The projector recognizes the code but derives no recorded-success relation
  // from a future timestamp; its own semantics are unchanged by this slice.
  assert.equal(future.recordedOutcome.kind, 'LIMITED_COLLECTION_RECORDED')
  assert.equal(future.lastAttemptAt, CURRENT.toISOString())
})

test('a canonical success and full Graph recovery are unchanged', () => {
  // No fallback code at all: the premium tenant reads full Graph coverage.
  const recovered = signIns({ status: 'SUCCEEDED', lastSuccessfulAt: CURRENT, lastErrorCode: null })
  assert.equal(recovered.coverage, 'FULL')
  assert.equal(recovered.selectedSource, 'MICROSOFT_GRAPH')
  assert.notEqual(recovered.availability, 'CURRENT_LIMITED')
  assert.notEqual(recovered.availability, 'STALE')
  const result = health({ status: 'SUCCEEDED', lastSuccessfulAt: CURRENT, lastErrorCode: null })
  assert.equal(signInResource(result).classification, 'SUCCESS')
  assert.equal(result.operations.partialJobs, 0)
  assert.equal(result.operations.pendingJobs, 0)
})
