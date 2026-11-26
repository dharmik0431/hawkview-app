import assert from 'node:assert/strict'
import test from 'node:test'
// Only symbols that ALSO exist on the uncorrected base commit are imported here,
// so reverting the source yields behavioural failures and never an import failure.
// The exhaustive relabel policy is asserted in `fallback-relabel-policy.test.ts`.
import {
  deriveCollectionReadiness,
  effectiveMicrosoftConnectionStatus,
  M365_ACTIVITY_CONTENT_TYPES,
} from './collection-readiness.js'
import { deriveTenantHealth } from './tenant-health.js'

/**
 * HAW-77 v3: the limited sign-in "unmeasured running" relabel must not replace
 * an AUTHORITATIVE dataset verdict.
 *
 * The relabel added in 60b2560 closed a real defect - an unqualified RUNNING
 * fallback was reported as not configured with zero pending work - but it was
 * written against the sync row alone and consulted no dataset state, so it
 * also replaced:
 *
 *   - BLOCKED_PERMISSION / MICROSOFT_CONNECTION_NOT_READY, which the connection
 *     gate writes onto every dataset for a revoked, errored, consent-pending,
 *     expired or invalid connection;
 *   - BLOCKED_PERMISSION / MICROSOFT_PERMISSION_NOT_CONFIRMED, for a dataset
 *     whose required permission is verified missing;
 *   - UNVERIFIED / SIGN_IN_ENTITLEMENT_UNVERIFIED and
 *     UNVERIFIED / MICROSOFT_PERMISSION_UNVERIFIED;
 *   - BACKLOGGED, the collector's own more specific in-progress reason.
 *
 * A customer cannot act on "initializing", and the remediation the blocked row
 * carries is discarded with it.
 *
 * ## Why the earlier suites could not see this
 *
 * `fallback-readiness-composition.test.ts` composes the two real projections,
 * but its fixture gives readiness `connectionStatus: 'CONNECTED'` while giving
 * health `'ACTIVE'`, hardcodes health's `missingPermissions: []`, builds a
 * SECOND sync-state array for health, and passes no applicability arrays. The
 * production call site passes ONE effective connection status, ONE
 * `tenant.syncStates` object, ONE clock, the derived connection-required
 * permission set and readiness's own applicability arrays to both readers
 * (`tenants.service.ts:472-562`). Every case in that suite therefore resolves
 * to a PARTIAL sign-in dataset, which is exactly the one state where the
 * relabel is correct.
 *
 * `compose()` below mirrors that call site instead: one persisted status in,
 * every downstream field derived the way the service derives it. That is what
 * makes the blocked, unverified and backlogged input classes reachable at all.
 */

const NOW = new Date('2026-11-26T12:00:00.000Z')
const AGING_MS = 2 * 60 * 60 * 1000
const CURRENT = new Date(NOW.getTime() - 5 * 60 * 1000)
const FUTURE = new Date(NOW.getTime() + 1)
const INVALID = new Date('not-a-timestamp')
const CODE = 'sign-ins-premium-graph-fallback-active'

/** `Organization.Read.All` is the only permission the access contract marks connectionRequired. */
const CONNECTION_REQUIRED_PERMISSIONS = ['Organization.Read.All']

const ALL_PERMISSIONS = ['Organization.Read.All', 'User.Read.All', 'GroupMember.Read.All',
  'Member.Read.Hidden', 'Device.Read.All', 'RoleManagement.Read.Directory',
  'UserAuthenticationMethod.Read.All', 'Policy.Read.AuthenticationMethod', 'Policy.Read.All',
  'IdentityRiskyUser.Read.All', 'Application.Read.All', 'AuditLog.Read.All', 'Directory.Read.All',
  'Sites.Read.All', 'SharePointTenantSettings.Read.All', 'Reports.Read.All', 'MailboxSettings.Read',
  'ActivityFeed.Read', 'SecurityEvents.Read.All']

const ALL_RESOURCES = ['AUDIT_LOGS', 'SIGN_INS', 'USERS', 'GROUPS', 'DEVICES', 'DIRECTORY_ROLES',
  'AUTH_REGISTRATIONS', 'AUTH_METHOD_POLICIES', 'CONDITIONAL_ACCESS', 'AUTHENTICATION_STRENGTHS',
  'NAMED_LOCATIONS', 'RISKY_USERS', 'APPLICATIONS', 'SERVICE_PRINCIPALS', 'SECURITY_DEFAULTS',
  'SECURE_SCORES', 'ORGANIZATION_CONFIGURATION', 'DOMAINS', 'LICENSES', 'DOMAIN_DNS_HEALTH',
  'SHAREPOINT_SITES', 'SHAREPOINT_SETTINGS', 'SHAREPOINT_USAGE', 'EXCHANGE_MAILBOXES',
  'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_ACCEPTED_DOMAINS',
  'EXCHANGE_MAILBOX_RULES', 'M365_AUDIT']

const PREMIUM_PLAN = { servicePlanName: 'AAD_PREMIUM',
  servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d', provisioningStatus: 'Success' }

type Overrides = Record<string, unknown>
const syncState = (resourceType: string, overrides: Overrides = {}) => ({
  resourceType, status: 'SUCCEEDED', lastAttemptAt: CURRENT, lastSuccessfulAt: CURRENT,
  lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0, ...overrides,
})

type ComposeCase = {
  /** The PERSISTED connection status, as the column stores it. */
  connectionStatus?: string
  connectionLastErrorCode?: string | null
  connectionVerifiedAt?: Date | null
  consentedPermissions?: string[]
  premium?: boolean
  /** The LICENSES collector row: its currency decides whether entitlement is authoritative. */
  licenses?: Overrides
  signIn: Overrides
}

/**
 * The production composition, mirrored field by field from `tenants.service.ts`:
 * one derived `effectiveConnectionStatus` to both readers, the derived
 * `effectiveStatus`, `missingRequiredPermissions` (NOT every missing
 * permission), the SAME sync-state array, the same verification timestamp,
 * readiness's own applicability arrays, readiness's risky-identity projection,
 * `signInEvidence` from readiness, and one captured clock.
 */
const compose = (input: ComposeCase) => {
  const persisted = input.connectionStatus ?? 'CONNECTED'
  const consentedPermissions = input.consentedPermissions ?? ALL_PERMISSIONS
  const connectionVerifiedAt = input.connectionVerifiedAt === undefined ? CURRENT : input.connectionVerifiedAt
  const missingRequiredPermissions = CONNECTION_REQUIRED_PERMISSIONS
    .filter((permission) => !consentedPermissions.includes(permission))
  const effectiveConnectionStatus = effectiveMicrosoftConnectionStatus(
    persisted, input.connectionLastErrorCode ?? null, missingRequiredPermissions)
  const effectiveStatus = effectiveConnectionStatus === 'ERROR' || effectiveConnectionStatus === 'REVOKED'
    ? 'disconnected'
    : effectiveConnectionStatus === 'PENDING_CONSENT' ? 'pending' : 'active'
  const syncStates = ALL_RESOURCES.map((resource) =>
    resource === 'SIGN_INS' ? syncState(resource, input.signIn)
      : resource === 'LICENSES' ? syncState(resource, input.licenses ?? {})
        : syncState(resource))

  const readiness = deriveCollectionReadiness({
    now: NOW,
    connectionStatus: effectiveConnectionStatus,
    connectionVerifiedAt,
    consentedPermissions,
    syncStates,
    licenseServicePlans: [
      { servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' },
      { servicePlanName: 'EXCHANGE_S_ENTERPRISE', provisioningStatus: 'Success' },
      ...((input.premium ?? true) ? [PREMIUM_PLAN] : []),
    ],
    subscriptions: M365_ACTIVITY_CONTENT_TYPES.map((contentType) => ({
      contentType, status: 'ENABLED', lastStartRequestedAt: CURRENT, lastVerifiedAt: CURRENT,
      lastSuccessfulPollAt: CURRENT, lastError: null,
    })),
  } as never)

  // Derived exactly as the service derives them, from readiness's own rows.
  const readinessResourceTypes = (state: 'NOT_LICENSED' | 'UNSUPPORTED') => readiness.workloads
    .flatMap((workload) => [
      ...(workload.state === state ? (workload.components?.map((component) => component.key) ?? []) : []),
      ...(workload.datasets?.filter((dataset) => dataset.state === state)
        .flatMap((dataset) => dataset.resourceTypes) ?? []),
    ])
    .filter((key) => !['LICENSE_APPLICABILITY', 'PERMISSION_GRANT'].includes(key))

  const health = deriveTenantHealth({
    tenantId: 'tenant-haw77-v3',
    effectiveStatus,
    connectionStatus: effectiveConnectionStatus,
    connectionLastVerifiedAt: connectionVerifiedAt,
    missingPermissions: missingRequiredPermissions,
    syncStates: syncStates as never,
    authSnapshot: null,
    riskyIdentityCount: readiness.evidence.riskyIdentities.count,
    microsoftRiskSummary: readiness.evidence.riskyIdentities.microsoftRiskSummary,
    signInEvidence: readiness.evidence.signIns,
    auditEvidence: { status: 'COMPLETE', reason: 'OK', windowComplete: true, observedCount: 0,
      withheldPayloads: 0, assessedAt: NOW.toISOString() },
    notApplicableResourceTypes: readinessResourceTypes('NOT_LICENSED'),
    unsupportedResourceTypes: readinessResourceTypes('UNSUPPORTED'),
    now: NOW,
  })

  const signInRow = readiness.workloads.find((workload) => workload.key === 'sign_ins')
  const dataset = signInRow?.datasets?.find((candidate) => candidate.key ===
    ((input.premium ?? true) ? 'entra_sign_ins_graph' : 'entra_sign_ins_activity_feed'))
  return {
    dataset, evidence: readiness.evidence.signIns, health,
    resource: health.resourceHealth.find((row) => row.resourceType === 'SIGN_INS')!,
    effectiveConnectionStatus, effectiveStatus, missingRequiredPermissions,
  }
}

const RUNNING = (successAt: unknown, extra: Overrides = {}) =>
  ({ status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: CODE, lastSuccessfulAt: successAt, ...extra })

/** The two unmeasurable recorded successes, asserted through the same composed path. */
const UNMEASURABLE: Array<[string, Date]> = [
  ['one millisecond in the future', FUTURE],
  ['an invalid Date', INVALID],
]

// ---------------------------------------------------------------------------
// 1. A revoked or unavailable connection keeps its blocked verdict
// ---------------------------------------------------------------------------

for (const [label, successAt] of UNMEASURABLE) {
  test(`composed: a revoked connection keeps its blocked verdict when the fallback success is ${label}`, () => {
    const { dataset, evidence, health, resource, missingRequiredPermissions } =
      compose({ connectionStatus: 'REVOKED', signIn: RUNNING(successAt) })

    // The faithful derivation: a revoked connection reaches BOTH readers, and
    // the connection-required set is still fully consented, so health is given
    // no missing permissions. Only the sign-in verdict is under test.
    assert.deepEqual(missingRequiredPermissions, [])
    assert.equal(dataset?.state, 'BLOCKED_PERMISSION', 'the connection gate must have written the blocker')
    assert.equal(dataset?.reasonCode, 'MICROSOFT_CONNECTION_NOT_READY')

    assert.equal(evidence.availability, 'BLOCKED_PERMISSION',
      'an unmeasurable success must not relabel an authoritative access blocker as in progress')
    assert.equal(evidence.reasonCode, 'MICROSOFT_CONNECTION_NOT_READY',
      'the authoritative reason code must survive, not the collector fallback code')
    assert.equal(evidence.reason, 'Microsoft connection consent is pending, revoked, or unavailable.')
    assert.equal(evidence.observedAt, null, 'an unmeasurable success is still not an observation')
    // Attribution is a separate question and is deliberately preserved.
    assert.equal(evidence.coverage, 'LIMITED')
    assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')

    assert.equal(resource.classification, 'PERMISSION_REQUIRED',
      'health must present the blocker, not pending work')
    assert.equal(resource.reasonCode, 'MICROSOFT_CONNECTION_NOT_READY')
    assert.equal(resource.lastSuccessfulAt, null)
    assert.equal(health.operations.failedJobs, 1, 'a blocked source is a failed job, not a pending one')
    assert.equal(health.operations.pendingJobs, 0)
    assert.equal(health.operations.partialJobs, 0)
    assert.equal(health.operations.activeIssues, 1)
    assert.equal(health.operations.status, 'DEGRADED')
    assert.equal(health.data.failedResources, 1)
    assert.equal(health.data.pendingResources, 0)
    assert.equal(health.connection.status, 'DISCONNECTED')
    assert.equal(health.overallStatus, 'DISCONNECTED')
    assert.equal(health.healthScore, 50)
    assert.deepEqual(health.attention.map((item) => item.key),
      ['connection-unavailable', 'sync-sign_ins'],
      'the tenant is told to reconnect and that sign-ins need attention')
  })
}

test('composed: the blocked verdict reaches HEALTH, asserted before the availability', () => {
  // Assertion ORDER matters for the negative control. In the cases above the
  // first `evidence.availability` assertion throws on the uncorrected base, so
  // every health assertion below it is never reached and the control proves the
  // readiness relabel only. This case asserts the composed health side FIRST,
  // so the control exercises both halves of the claim.
  const { health, resource } = compose({ connectionStatus: 'REVOKED', signIn: RUNNING(FUTURE) })
  assert.equal(resource.classification, 'PERMISSION_REQUIRED',
    'health must present the blocker before anything else is checked')
  assert.equal(resource.reasonCode, 'MICROSOFT_CONNECTION_NOT_READY')
  assert.equal(health.operations.failedJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
  assert.equal(health.operations.status, 'DEGRADED')
  assert.equal(health.data.failedResources, 1)
  assert.equal(health.data.pendingResources, 0)
  assert.equal(health.healthScore, 50)
  // Only now the readiness field the other cases lead with.
  assert.equal(health.resourceHealth.length > 0, true)
})

test('composed: a consent-pending connection keeps its blocked verdict too', () => {
  const { evidence, health, resource } = compose({ connectionStatus: 'PENDING_CONSENT', signIn: RUNNING(FUTURE) })
  assert.equal(evidence.availability, 'BLOCKED_PERMISSION')
  assert.equal(evidence.reasonCode, 'MICROSOFT_CONNECTION_NOT_READY')
  assert.equal(resource.classification, 'PERMISSION_REQUIRED')
  assert.equal(health.operations.failedJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
  assert.equal(health.connection.status, 'PENDING')
  assert.equal(health.overallStatus, 'DEGRADED')
  assert.deepEqual(health.attention.map((item) => item.key), ['authorization-required', 'sync-sign_ins'])
})

// ---------------------------------------------------------------------------
// 2. A verified-missing permission keeps its blocked verdict
// ---------------------------------------------------------------------------

test('composed: a verified-missing sign-in permission keeps its blocked verdict', () => {
  // `AuditLog.Read.All` is a premium sign-in permission and is NOT
  // connection-required, so health is given an empty missing set. The blocker
  // must therefore arrive through the sign-in evidence or not at all.
  // The LICENSES row is deliberately a current success: the entitlement branch
  // precedes the grants branch inside `datasetReadiness`, so a non-current
  // LICENSES collector would answer UNVERIFIED instead and this case would
  // silently stop testing the permission path. The next test pins that order.
  const { dataset, evidence, health, resource, missingRequiredPermissions } = compose({
    consentedPermissions: ALL_PERMISSIONS.filter((permission) => permission !== 'AuditLog.Read.All'),
    signIn: RUNNING(FUTURE),
  })
  assert.deepEqual(missingRequiredPermissions, [],
    'a non-connection-required permission reaches health as no missing permission at all')
  assert.equal(dataset?.state, 'BLOCKED_PERMISSION')
  assert.equal(dataset?.reasonCode, 'MICROSOFT_PERMISSION_NOT_CONFIRMED')

  assert.equal(evidence.availability, 'BLOCKED_PERMISSION')
  assert.equal(evidence.reasonCode, 'MICROSOFT_PERMISSION_NOT_CONFIRMED')
  assert.equal(evidence.reason, 'HawkView verified that this dataset is missing: AuditLog.Read.All.')
  assert.equal(evidence.observedAt, null)
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')

  assert.equal(resource.classification, 'PERMISSION_REQUIRED')
  assert.equal(resource.reasonCode, 'MICROSOFT_PERMISSION_NOT_CONFIRMED')
  assert.equal(health.operations.failedJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
  assert.equal(health.operations.status, 'DEGRADED')
  assert.equal(health.connection.status, 'HEALTHY', 'the connection itself is fine; only this dataset is blocked')
  assert.equal(health.overallStatus, 'DEGRADED')
  assert.equal(health.healthScore, 80)
  assert.deepEqual(health.attention.map((item) => item.key), ['sync-sign_ins'])
})

test('composed: entitlement-unverified outranks a verified-missing permission', () => {
  // Branch order inside `datasetReadiness`: licence NOT_LICENSED, then
  // entitlement UNVERIFIED, then grants MISSING. Pinned here so the permission
  // case above cannot drift into this one unnoticed.
  const { dataset, evidence, resource, health } = compose({
    consentedPermissions: ALL_PERMISSIONS.filter((permission) => permission !== 'AuditLog.Read.All'),
    licenses: { status: 'RUNNING', lastSuccessfulAt: null },
    signIn: RUNNING(FUTURE),
  })
  assert.equal(dataset?.state, 'UNVERIFIED')
  assert.equal(dataset?.reasonCode, 'SIGN_IN_ENTITLEMENT_UNVERIFIED',
    'the entitlement answer, not the permission answer')
  assert.equal(evidence.availability, 'UNVERIFIED')
  assert.equal(evidence.reasonCode, 'SIGN_IN_ENTITLEMENT_UNVERIFIED')
  assert.equal(evidence.observedAt, null)
  assert.equal(resource.classification, 'NOT_CONFIGURED')
  assert.equal(health.data.pendingResources, 2, 'the sign-in resource and the running LICENSES collector')
})

// ---------------------------------------------------------------------------
// 3. An unverified dataset keeps its unverified verdict, and the carried gap
// ---------------------------------------------------------------------------

test('composed: a RUNNING collector under an unverified verdict is counted as pending work', () => {
  // THE REGRESSION THIS SUITE USED TO PIN. v3 withheld the relabel here, which
  // is right - an unverified verdict is authoritative about what HawkView has
  // NOT established - but the selected-evidence mapper has no UNVERIFIED branch,
  // so the resource became NOT_CONFIGURED, and a truthy selected source excludes
  // SIGN_INS from the operational states, so the row's own RUNNING status
  // reached no count. Operations read HEALTHY with pendingJobs 0 while the
  // collector was running. An unverified verdict is not completion.
  //
  // The operational counts are asserted FIRST, deliberately: `assert` throws at
  // the first failure, so with the availability assertion leading, a control run
  // against the uncorrected parent would never reach these lines and would prove
  // only the published string.
  const { dataset, evidence, health, resource } = compose({ connectionVerifiedAt: null, signIn: RUNNING(FUTURE) })
  assert.equal(health.operations.pendingJobs, 1,
    'a genuinely RUNNING collector must be counted even when its source is unverified')
  assert.equal(health.operations.status, 'SYNCING', 'so operations must not read healthy')
  assert.equal(health.operations.failedJobs, 0, 'and an unverified source is not a failed one')
  assert.equal(health.operations.partialJobs, 0)
  assert.equal(health.operations.activeIssues, 0)
  assert.equal(health.data.pendingResources, 1)
  assert.equal(health.data.status, 'PARTIAL')
  assert.equal(health.data.completenessPercent, 95)
  assert.equal(health.overallStatus, 'ATTENTION')

  // The readiness verdict, its reason and its refusal to publish an observation
  // are unchanged. The correction is a count, not a relabel.
  assert.equal(dataset?.state, 'UNVERIFIED')
  assert.equal(dataset?.reasonCode, 'MICROSOFT_PERMISSION_UNVERIFIED')
  assert.equal(evidence.availability, 'UNVERIFIED',
    'the authoritative verdict stays; the old INITIALIZING override is NOT restored')
  assert.equal(evidence.reasonCode, 'MICROSOFT_PERMISSION_UNVERIFIED')
  assert.equal(evidence.reason,
    'HawkView has not completed resource-specific permission verification for this dataset.')
  assert.equal(evidence.observedAt, null, 'an unmeasurable success is still not an observation')
  assert.equal(evidence.coverage, 'LIMITED', 'and source attribution is still preserved')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  // The resource itself is still not confirmed configured: the permission has
  // not been verified. The JOB is running; the RESOURCE is unverified. Both are
  // reported, and neither is dressed up as the other.
  assert.equal(resource.classification, 'NOT_CONFIGURED')
  assert.equal(resource.reasonCode, 'MICROSOFT_PERMISSION_UNVERIFIED')
  assert.equal(resource.lastSuccessfulAt, null)
})

test('composed: an invalid recorded success under an unverified verdict counts the same', () => {
  const { evidence, health } = compose({ connectionVerifiedAt: null, signIn: RUNNING(INVALID) })
  assert.equal(health.operations.pendingJobs, 1)
  assert.equal(health.operations.status, 'SYNCING')
  assert.equal(evidence.availability, 'UNVERIFIED')
  assert.equal(evidence.reasonCode, 'MICROSOFT_PERMISSION_UNVERIFIED')
  assert.equal(evidence.observedAt, null)
})

test('composed: an entitlement-unverified RUNNING collector is counted as pending work', () => {
  // The second reachable cause of an unverified sign-in verdict. The running
  // LICENSES collector that makes the entitlement unverified is itself pending
  // work, so the expected count here is two, not one.
  const { dataset, evidence, health, resource } = compose({
    licenses: { status: 'RUNNING', lastSuccessfulAt: null }, signIn: RUNNING(FUTURE),
  })
  assert.equal(health.operations.pendingJobs, 2,
    'the sign-in collector plus the running LICENSES collector')
  assert.equal(health.operations.status, 'SYNCING')
  assert.equal(health.operations.failedJobs, 0)
  assert.equal(health.data.pendingResources, 2)
  assert.equal(dataset?.state, 'UNVERIFIED')
  assert.equal(evidence.availability, 'UNVERIFIED')
  assert.equal(evidence.reasonCode, 'SIGN_IN_ENTITLEMENT_UNVERIFIED')
  assert.equal(evidence.reason, 'HawkView does not yet have current service-plan evidence to '
    + 'select the licensed Graph source or limited audit-feed fallback.')
  assert.equal(evidence.observedAt, null)
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(resource.classification, 'NOT_CONFIGURED')
})

test('composed: an unverified verdict without a recognized code is counted too', () => {
  // Same principle, reached without any fallback code at all: the verdict is
  // unverified and the collector is running, so the work is pending. This input
  // read HEALTHY / 0 on every earlier candidate; the correction is deliberately
  // not narrowed to the recognized-code case, because the untruth is the same.
  const { evidence, health, resource } = compose({
    connectionVerifiedAt: null,
    signIn: { status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: 'SOMETHING_ELSE', lastSuccessfulAt: FUTURE },
  })
  assert.equal(health.operations.pendingJobs, 1)
  assert.equal(health.operations.status, 'SYNCING')
  assert.equal(evidence.availability, 'UNVERIFIED')
  assert.equal(evidence.selectedSource, 'MICROSOFT_GRAPH', 'no fallback was selected')
  assert.equal(resource.classification, 'NOT_CONFIGURED')
  // The dataset-timestamp echo this correction does not touch: with no fallback
  // selected, `observedAt` still falls through to the dataset value.
  assert.equal(evidence.observedAt, FUTURE.toISOString())
})

const NON_RUNNING: Array<[string, Record<string, unknown>]> = [
  ['SUCCEEDED', { status: 'SUCCEEDED', consecutiveFailures: 0, lastErrorCode: CODE, lastSuccessfulAt: FUTURE }],
  ['QUEUED', { status: 'QUEUED', consecutiveFailures: 0, lastErrorCode: CODE, lastSuccessfulAt: FUTURE }],
  ['IDLE', { status: 'IDLE', consecutiveFailures: 0, lastErrorCode: CODE, lastSuccessfulAt: FUTURE }],
  ['FAILED', { status: 'FAILED', consecutiveFailures: 4, lastErrorCode: CODE, lastSuccessfulAt: FUTURE }],
]

for (const [status, signIn] of NON_RUNNING) {
  test(`composed: a ${status} collector under an unverified verdict is NOT counted as pending`, () => {
    // The scope boundary. Only a genuinely RUNNING row earns the count; an
    // unverified verdict on its own must not manufacture pending work.
    const { evidence, health, resource } = compose({ connectionVerifiedAt: null, signIn })
    assert.equal(health.operations.pendingJobs, 0, `${status} is not running work`)
    assert.equal(health.operations.status, 'HEALTHY')
    assert.equal(health.operations.failedJobs, 0, 'and it is not double counted as failed either')
    assert.equal(evidence.availability, 'UNVERIFIED')
    assert.equal(resource.classification, 'NOT_CONFIGURED')
    assert.equal(health.data.pendingResources, 1, 'the data section is unchanged by this correction')
    assert.equal(health.overallStatus, 'ATTENTION')
  })
}

// ---------------------------------------------------------------------------
// 4. A backlogged collector keeps its own more specific in-progress reason
// ---------------------------------------------------------------------------

test('composed: a backlogged collector keeps its own reason and is still pending work', () => {
  // None of the six recognized fallback codes matches the backlog pattern, so
  // this state is reached through the collector's own message, which is the
  // axis the earlier reachability sweep omitted.
  const { dataset, evidence, health, resource } = compose({
    signIn: RUNNING(FUTURE, { lastErrorMessage: 'Continuation token pending; daily budget partially consumed.' }),
  })
  assert.equal(dataset?.state, 'BACKLOGGED')
  assert.equal(evidence.availability, 'BACKLOGGED', 'the specific in-progress reason is not flattened')
  assert.equal(evidence.reasonCode, CODE)
  assert.equal(evidence.reason, 'Continuation token pending; daily budget partially consumed.')
  assert.equal(evidence.observedAt, null)
  assert.equal(resource.classification, 'PENDING', 'and it is still correctly pending in health')
  assert.equal(health.operations.pendingJobs, 1)
  assert.equal(health.operations.status, 'SYNCING')
})

// ---------------------------------------------------------------------------
// 5. The ordinary in-progress case must STILL be relabelled
// ---------------------------------------------------------------------------

for (const [label, successAt] of UNMEASURABLE) {
  test(`composed: an ordinary in-progress dataset is still relabelled when the success is ${label}`, () => {
    const { dataset, evidence, health, resource } = compose({ signIn: RUNNING(successAt) })
    assert.equal(dataset?.state, 'PARTIAL', 'the one ordinary state the relabel may take')
    assert.equal(evidence.availability, 'INITIALIZING',
      'the correction must not withdraw the relabel from the case it exists for')
    assert.equal(evidence.reasonCode, CODE)
    assert.equal(evidence.reason,
      'Limited sign-in collection is in progress and its last success cannot be measured.')
    assert.equal(evidence.observedAt, null)
    assert.equal(resource.classification, 'PENDING')
    assert.equal(health.operations.pendingJobs, 1, 'the running collector is still counted')
    assert.equal(health.operations.partialJobs, 0)
    assert.equal(health.operations.status, 'SYNCING')
    assert.equal(health.data.pendingResources, 1)
  })
}

// ---------------------------------------------------------------------------
// 6. Missing, null and undefined success through the composed path
// ---------------------------------------------------------------------------

for (const [label, successAt] of [['null', null], ['undefined', undefined]] as Array<[string, Date | null | undefined]>) {
  test(`composed: a ${label} recorded success is pending work with no measured observation`, () => {
    const { dataset, evidence, health, resource } = compose({ signIn: RUNNING(successAt) })
    // No recorded Date at all, so the fallback is not the SELECTED source and
    // the relabel is never consulted; the dataset's own in-progress state is
    // already the honest answer. Asserted here because it was only ever covered
    // in the separate-reader suite, never through the composition.
    assert.equal(dataset?.state, 'INITIALIZING')
    assert.equal(evidence.availability, 'INITIALIZING')
    assert.equal(evidence.observedAt, null, 'no measured fallback success')
    assert.equal(evidence.coverage, 'NONE', 'and no limited attribution, because no source was selected')
    assert.equal(evidence.selectedSource, 'MICROSOFT_GRAPH')
    assert.equal(resource.classification, 'PENDING')
    assert.equal(resource.lastSuccessfulAt, null)
    assert.equal(health.operations.pendingJobs, 1, 'pending work is reported')
    assert.equal(health.operations.failedJobs, 0)
    assert.equal(health.operations.status, 'SYNCING')
  })
}

// ---------------------------------------------------------------------------
// 7. Preserved controls, through the faithful composition
// ---------------------------------------------------------------------------

test('composed: a canonical current limited success is unchanged', () => {
  const { evidence, health, resource } = compose({ signIn: RUNNING(CURRENT) })
  assert.equal(evidence.availability, 'CURRENT_LIMITED')
  assert.equal(evidence.observedAt, CURRENT.toISOString())
  assert.equal(resource.classification, 'PARTIAL')
  assert.equal(health.operations.partialJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
  assert.equal(health.operations.status, 'HEALTHY')
})

test('composed: the inclusive boundaries still qualify', () => {
  for (const [label, successAt] of [
    ['exactly now', NOW], ['exactly the aging bound', new Date(NOW.getTime() - AGING_MS)],
  ] as Array<[string, Date]>) {
    const { evidence, health } = compose({ signIn: RUNNING(successAt) })
    assert.equal(evidence.availability, 'CURRENT_LIMITED', label)
    assert.equal(evidence.observedAt, successAt.toISOString(), label)
    assert.equal(health.operations.partialJobs, 1, label)
  }
})

test('composed: a measured stale success is still stale', () => {
  const stale = new Date(NOW.getTime() - AGING_MS - 1)
  const { evidence, health, resource } = compose({ signIn: RUNNING(stale) })
  assert.equal(evidence.availability, 'STALE')
  assert.equal(evidence.reasonCode, 'SIGN_IN_FALLBACK_STALE')
  assert.equal(evidence.observedAt, stale.toISOString())
  assert.equal(resource.classification, 'STALE')
  assert.equal(health.operations.status, 'DEGRADED')
  assert.equal(health.data.staleResources, 1)
})

test('composed: a FAILED fallback keeps its attribution and stays failed', () => {
  const { evidence, health, resource } = compose({
    signIn: { status: 'FAILED', consecutiveFailures: 3, lastErrorCode: CODE, lastSuccessfulAt: CURRENT },
  })
  assert.equal(evidence.availability, 'FAILED_TRANSIENT')
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(resource.classification, 'FAILED')
  assert.equal(health.operations.failedJobs, 1)
  assert.equal(health.operations.pendingJobs, 0)
})

test('composed: full Microsoft Graph recovery is unchanged', () => {
  const { evidence, health, resource } = compose({
    signIn: { status: 'SUCCEEDED', lastErrorCode: null, lastSuccessfulAt: CURRENT },
  })
  assert.equal(evidence.availability, 'READY')
  assert.equal(evidence.coverage, 'FULL')
  assert.equal(evidence.selectedSource, 'MICROSOFT_GRAPH')
  assert.equal(resource.classification, 'SUCCESS')
  assert.equal(health.data.status, 'COMPLETE')
  assert.equal(health.overallStatus, 'HEALTHY')
})

test('composed: a non-premium tenant selects the limited feed and it reads READY', () => {
  const { evidence, health } = compose({
    premium: false, signIn: { status: 'SUCCEEDED', lastErrorCode: null, lastSuccessfulAt: CURRENT },
  })
  assert.equal(evidence.availability, 'READY')
  assert.equal(evidence.coverage, 'LIMITED')
  assert.equal(evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
  assert.equal(health.operations.status, 'HEALTHY')
  // Faithful-composition consequence, measured rather than assumed: the
  // premium Graph dataset is NOT_LICENSED for this tenant, so the service's own
  // applicability array makes the SIGN_INS resource not-applicable even while
  // the selected limited feed is READY. Pre-existing and untouched here.
  assert.equal(health.resourceHealth.find((row) => row.resourceType === 'SIGN_INS')!.classification,
    'NOT_LICENSED')
})

test('recorded limit: the gate reads the entitlement-chosen dataset, not the attributed one', () => {
  // Every field in this projection falls through to the dataset the ENTITLEMENT
  // selects - the Graph one for a premium tenant - while `selectedSource` names
  // the activity feed whenever a fallback code is recognized. The two can
  // disagree, and then the relabel still fires over the attributed source's own
  // blocked verdict. Pinned because keying the gate on the attributed dataset
  // would change which dataset the whole evidence block reads, which is a
  // source-attribution redesign rather than a precedence fix.
  const premiumMissingFeedPermission = compose({
    consentedPermissions: ALL_PERMISSIONS.filter((permission) => permission !== 'ActivityFeed.Read'),
    signIn: RUNNING(FUTURE),
  })
  assert.equal(premiumMissingFeedPermission.dataset?.state, 'PARTIAL',
    'the entitlement-chosen Graph dataset is ordinary in-progress')
  assert.equal(premiumMissingFeedPermission.evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED',
    'but the published source is the feed')
  assert.equal(premiumMissingFeedPermission.evidence.availability, 'INITIALIZING',
    'so the relabel still fires over the feed dataset blocker: the limit this pins')
  assert.equal(premiumMissingFeedPermission.resource.classification, 'PENDING')
  assert.equal(premiumMissingFeedPermission.health.operations.failedJobs, 0)

  // The same disagreement in the other direction: the relabel is withheld for a
  // tenant whose attributed feed dataset IS the ordinary in-progress state.
  const entitlementUnverified = compose({ licenses: { status: 'RUNNING', lastSuccessfulAt: null }, signIn: RUNNING(FUTURE) })
  assert.equal(entitlementUnverified.dataset?.state, 'UNVERIFIED')
  assert.equal(entitlementUnverified.evidence.availability, 'UNVERIFIED')
  assert.equal(entitlementUnverified.evidence.selectedSource, 'OFFICE_365_ACTIVITY_FEED')
})

// ---------------------------------------------------------------------------
// 8. Recorded limits, measured rather than claimed closed
// ---------------------------------------------------------------------------

test('recorded limit: a MEASURED fallback success still outranks a blocked verdict', () => {
  // The relabel under correction was the third arm of the availability chain.
  // The first two - current and stale - still take precedence over an
  // authoritative blocked dataset, and the current arm publishes a real
  // observedAt, which is a stronger claim than the one this slice removes.
  // That is released-main behaviour, outside "only the precedence of the new
  // override may change", and it is measured here so the correction is not read
  // as closing the whole precedence class.
  for (const [label, successAt, availability] of [
    ['five minutes ago', CURRENT, 'CURRENT_LIMITED'],
    ['exactly now', NOW, 'CURRENT_LIMITED'],
    ['exactly the aging bound', new Date(NOW.getTime() - AGING_MS), 'CURRENT_LIMITED'],
    ['one millisecond past the bound', new Date(NOW.getTime() - AGING_MS - 1), 'STALE'],
  ] as Array<[string, Date, string]>) {
    const { dataset, evidence } = compose({ connectionStatus: 'REVOKED', signIn: RUNNING(successAt) })
    assert.equal(dataset?.state, 'BLOCKED_PERMISSION', label)
    assert.equal(evidence.availability, availability, label)
    assert.equal(evidence.observedAt, successAt.toISOString(),
      `${label}: a measured success is still published over the blocker`)
  }
})

test('recorded limit: a null selected source discards the authoritative verdict in health', () => {
  // `classifySelectedSignInEvidence` returns null when no source was selected,
  // so health falls back to the raw sync row and never reads the authoritative
  // availability. Reachable with an unrecognized error code plus an unverified
  // entitlement, and unchanged by this correction.
  const { evidence, resource, health } = compose({
    connectionStatus: 'REVOKED',
    licenses: { status: 'RUNNING', lastSuccessfulAt: null },
    signIn: { status: 'RUNNING', consecutiveFailures: 0, lastErrorCode: 'SOMETHING_ELSE', lastSuccessfulAt: CURRENT },
  })
  assert.equal(evidence.availability, 'BLOCKED_PERMISSION', 'readiness does carry the blocker')
  assert.equal(evidence.selectedSource, null)
  assert.equal(resource.classification, 'PENDING', 'but health reads the sync row instead')
  assert.equal(resource.reasonCode, 'collector-running')
  assert.equal(health.operations.pendingJobs, 2,
    'the sign-in row counted from the raw state, plus the running LICENSES collector this input needs')
})
