import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const CANARY_AUDIENCE =
  'https://api.hawkviewapp.com/api/internal/canary/sessions'
export const API_ORIGIN = 'https://api.hawkviewapp.com'
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/i
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
// Match the existing deployed-health readiness window; never retry authenticated work.
const READINESS_ATTEMPTS = 6
const READINESS_DELAY_MS = 10_000
const IDENTITY_RISK_CURRENT_MAX_AGE_MS = 36 * 60 * 60 * 1_000
const IDENTITY_RISK_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
const IDENTITY_RISK_API_VERSION = 1
const IDENTITY_RISK_STATUSES = new Set([
  'AVAILABLE',
  'STALE',
  'LEARNING',
  'NOT_EVALUATED',
  'UNAVAILABLE',
  'ERROR',
])
const IDENTITY_RISK_CAPABILITIES = new Set(['FULL', 'PARTIAL', 'UNAVAILABLE'])
const IDENTITY_RISK_FRESHNESS = new Set(['CURRENT', 'STALE', 'UNKNOWN'])
const FINDING_STATES = new Set(['OPEN', 'UPDATED', 'RESOLVED', 'EXPIRED'])
const FINDING_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const FINDING_CONFIDENCES = new Set(['LOW', 'MEDIUM', 'HIGH'])
const IDENTITY_TYPES = new Set(['USER', 'MAILBOX', 'APPLICATION', 'UNKNOWN'])
const INVESTIGATION_GUIDANCE_CODES = new Set([
  'REVIEW_ACTIVITY',
  'REVIEW_ACCESS',
  'REVIEW_MAILBOX_RULE',
  'REVIEW_CONFIGURATION',
])
const MICROSOFT_RISK_LEVELS = new Set([
  'none', 'low', 'medium', 'high', 'hidden', 'unknownFutureValue',
])
const MICROSOFT_RISK_STATES = new Set([
  'none', 'atRisk', 'remediated', 'dismissed', 'confirmedSafe',
  'confirmedCompromised', 'unknownFutureValue',
])
const MICROSOFT_RISK_DETAILS = new Set([
  'none',
  'adminGeneratedTemporaryPassword',
  'userPerformedSecuredPasswordChange',
  'userPerformedSecuredPasswordReset',
  'adminConfirmedSigninSafe',
  'aiConfirmedSigninSafe',
  'userPassedMFADrivenByRiskBasedPolicy',
  'adminDismissedAllRiskForUser',
  'adminConfirmedSigninCompromised',
  'hidden',
  'adminConfirmedUserCompromised',
  'm365DAdminDismissedDetection',
  'userChangedPasswordOnPremises',
  'adminDismissedRiskForSignIn',
  'adminConfirmedAccountSafe',
  'unknownFutureValue',
])
const MICROSOFT_SUMMARY_MAX_ROWS = 50_000
const MICROSOFT_SUMMARY_UNAVAILABLE_REASONS = new Set([
  'SOURCE_UNAVAILABLE',
  'COLLECTION_NOT_SUCCEEDED',
  'INVALID_CLOCK',
  'STALE_EVIDENCE',
  'INVALID_SNAPSHOT',
])
const MICROSOFT_SUMMARY_EARLY_REASONS = new Set([
  'SOURCE_UNAVAILABLE',
  'COLLECTION_NOT_SUCCEEDED',
])
const HAWKVIEW_RULE_SOURCE_LABELS = new Map([
  ...[
    'HV-ID-EXP-001.v1',
    'HV-ID-EXP-002.v1',
    'HV-ID-CHG-001.v1',
    'HV-ID-CHG-002.v1',
    'HV-ID-CHG-003.v1',
    'HV-ID-CHG-004.v1',
    'HV-ID-CHG-005.v1',
    'HV-ID-APP-001.v1',
    'HV-ID-APP-002.v1',
  ].map(ruleId => [ruleId, ['Microsoft Entra directory audit']]),
  ['HV-ID-EXP-003.v1', ['Microsoft Entra sign-in activity']],
  ['HV-ID-MBX-001.v1', [
    'Microsoft Graph mailbox-rule snapshot',
    'Microsoft Graph verified tenant domains',
  ]],
  ['HV-ID-MBX-002.v1', ['Exchange Online mailbox audit']],
  ['HV-ID-MBX-003.v1', ['Exchange Online mailbox audit']],
  ...[
    'HV-ID-AUTH-001.v1',
    'HV-ID-AUTH-002.v1',
    'HV-ID-AUTH-003.v1',
    'HV-ID-AUTH-004.v1',
    'HV-ID-AUTH-005.v1',
    'HV-ID-AUTH-006.v1',
    'HV-ID-AUTH-007.v1',
    'HV-ID-AUTH-008.v1',
    'HV-ID-AUTH-009.v1',
  ].map(ruleId => [ruleId, ['Microsoft Entra sign-in activity']]),
])
const HAWKVIEW_IDENTITY_REFERENCE_KIND = new Map([
  ['USER', ['subject']],
  ['MAILBOX', ['mailbox']],
  ['APPLICATION', ['application']],
  ['UNKNOWN', ['source', 'tenant']],
])
const IDENTITY_RISK_COUNT_KEYS = [
  'identitiesNeedingReview',
  'openFindings',
  'evaluatedRules',
  'matchedResults',
  'suppressedResults',
  'notMatchedResults',
  'notEvaluatedResults',
]
const IDENTITY_RISK_ROUTES = [
  {
    label: 'identity risk summary',
    suffix: 'identity-signals/summary',
    channel: 'HAWKVIEW_IDENTITY_SIGNALS',
    catalogVersion: 'hawkview-identity-signals/v1',
    engineVersion: 'hawkview-identity-engine/1',
    sourceLabel: 'HawkView Identity Signals',
    collection: 'counts',
  },
  {
    label: 'identity risk findings',
    suffix: 'identity-signals/findings',
    channel: 'HAWKVIEW_IDENTITY_SIGNALS',
    catalogVersion: 'hawkview-identity-signals/v1',
    engineVersion: 'hawkview-identity-engine/1',
    sourceLabel: 'HawkView Identity Signals',
    collection: 'findings',
  },
  {
    label: 'Microsoft Entra risky users',
    suffix: 'microsoft-entra-risky-users',
    channel: 'MICROSOFT_ENTRA_RISKY_USERS',
    catalogVersion: 'microsoft-entra-risky-users/v1',
    engineVersion: null,
    sourceLabel: 'Microsoft Entra Risky Users',
    collection: 'users',
  },
]

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value : null
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function boundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader()
  assert(reader, 'Response body is unavailable')
  const chunks = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new Error('Response exceeded the canary limit')
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : null
  } catch {
    throw new Error('Response was not valid JSON')
  }
}

async function requestJson(
  fetchImpl,
  url,
  init,
  expectedStatuses = [200],
  label = 'canary request',
) {
  let response
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { accept: 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error(`${label} failed`)
  }
  const mediaType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() ?? ''
  assert(mediaType === 'application/json', `${label} response was not JSON`)
  let body
  try {
    body = await boundedJson(response)
  } catch {
    throw new Error(`${label} response was not usable`)
  }
  assert(
    expectedStatuses.includes(response.status),
    `${label} returned an unexpected status`,
  )
  return { response, body }
}

async function githubOidcToken(fetchImpl, environment) {
  const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL?.trim()
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim()
  assert(requestUrl && requestToken, 'GitHub OIDC is unavailable')
  const url = new URL(requestUrl)
  assert(url.protocol === 'https:', 'GitHub OIDC URL must use HTTPS')
  url.searchParams.set('audience', CANARY_AUDIENCE)
  const { body } = await requestJson(fetchImpl, url, {
    headers: { Authorization: `Bearer ${requestToken}` },
  }, [200], 'GitHub OIDC request')
  const token = record(body)?.value
  assert(typeof token === 'string' && token.length > 100, 'GitHub OIDC response was invalid')
  return token
}

function normalizedSession(value, expectedSlot) {
  const candidate = record(value)
  assert(candidate?.slot === expectedSlot, `Canary slot ${expectedSlot} was missing`)
  assert(
    typeof candidate.accessToken === 'string' && candidate.accessToken.length > 100,
    `Canary slot ${expectedSlot} did not receive an access token`,
  )
  assert(candidate.tokenType === 'bearer', `Canary slot ${expectedSlot} token type was invalid`)
  assert(
    Number.isInteger(candidate.expiresIn) && candidate.expiresIn >= 60 && candidate.expiresIn <= 3600,
    `Canary slot ${expectedSlot} token lifetime was invalid`,
  )
  for (const key of ['expectedOrganizationId', 'expectedTenantId']) {
    assert(UUID_PATTERN.test(candidate[key] ?? ''), `Canary slot ${expectedSlot} ${key} was invalid`)
  }
  assert(
    typeof candidate.email === 'string' && candidate.email.includes('@'),
    `Canary slot ${expectedSlot} email was invalid`,
  )
  return candidate
}

async function authenticatedJson(
  fetchImpl,
  token,
  path,
  expectedStatuses = [200],
  label = 'authenticated canary request',
) {
  return requestJson(
    fetchImpl,
    `${API_ORIGIN}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
    expectedStatuses,
    label,
  )
}

function canonicalTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null
}

function assertNullableTimestamp(value, label, trustedNowMs) {
  const timestamp = value === null ? null : canonicalTimestamp(value)
  assert(value === null || timestamp !== null, `${label} timestamp contract was invalid`)
  assert(
    timestamp === null ||
      Date.parse(timestamp) <= trustedNowMs + IDENTITY_RISK_MAX_FUTURE_SKEW_MS,
    `${label} timestamp was in the future`,
  )
  return timestamp
}

function exactKeys(value, expected) {
  const keys = Object.keys(value)
  return keys.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function boundedString(value, max, label, pattern = null) {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      (!pattern || pattern.test(value)),
    `${label} was invalid`,
  )
}

function assertStringList(value, label, { maxItems = 10, requireItem = false } = {}) {
  assert(
    Array.isArray(value) &&
      value.length <= maxItems &&
      (!requireItem || value.length > 0),
    `${label} was invalid`,
  )
  for (const item of value) boundedString(item, 160, label)
  assert(new Set(value).size === value.length, `${label} contained duplicates`)
}

function assertMicrosoftRiskSummary(value, label, requestWindow) {
  const trustedNowMs = requestWindow.completedAt
  const summary = record(value)
  assert(
    summary && exactKeys(summary, [
      'source', 'availability', 'completeness', 'rawRecordCount',
      'observedActiveDistinctUserCount', 'activeDistinctUserCount',
      'snapshotObservedAt', 'collectionSucceededAt', 'reasonCode',
    ]),
    `${label} summary keys were invalid`,
  )
  assert(
    summary.source === 'MICROSOFT_IDENTITY_PROTECTION',
    `${label} summary source was invalid`,
  )
  const observation = assertNullableTimestamp(summary.snapshotObservedAt, `${label} summary observation`, trustedNowMs)
  const collection = assertNullableTimestamp(summary.collectionSucceededAt, `${label} summary collection`, trustedNowMs)
  const ordered = observation !== null && collection !== null &&
    Date.parse(collection) >= Date.parse(observation)
  if (summary.availability === 'UNAVAILABLE') {
    assert(
      summary.completeness === 'UNKNOWN' &&
        summary.rawRecordCount === null &&
        summary.observedActiveDistinctUserCount === null &&
        summary.activeDistinctUserCount === null &&
        MICROSOFT_SUMMARY_UNAVAILABLE_REASONS.has(summary.reasonCode),
      `${label} unavailable summary was contradictory`,
    )
    // Source/collection gates precede clock validation in the emitter. Their
    // independently valid clocks are diagnostics, never current evidence.
    const staleAtEnd = ordered &&
      (trustedNowMs - Date.parse(observation) > IDENTITY_RISK_CURRENT_MAX_AGE_MS ||
        trustedNowMs - Date.parse(collection) > IDENTITY_RISK_CURRENT_MAX_AGE_MS)
    const currentAtStart = ordered &&
      requestWindow.startedAt - Date.parse(observation) <= IDENTITY_RISK_CURRENT_MAX_AGE_MS &&
      requestWindow.startedAt - Date.parse(collection) <= IDENTITY_RISK_CURRENT_MAX_AGE_MS
    const coherentReason = MICROSOFT_SUMMARY_EARLY_REASONS.has(summary.reasonCode) ||
      (summary.reasonCode === 'INVALID_CLOCK' && !ordered) ||
      (summary.reasonCode === 'STALE_EVIDENCE' && staleAtEnd) ||
      (summary.reasonCode === 'INVALID_SNAPSHOT' && currentAtStart)
    assert(coherentReason, `${label} unavailable summary clocks were contradictory`)
    return summary
  }
  assert(ordered, `${label} summary clocks were contradictory`)
  assert(
    Number.isInteger(summary.rawRecordCount) &&
      summary.rawRecordCount >= 0 && summary.rawRecordCount <= MICROSOFT_SUMMARY_MAX_ROWS &&
      Number.isInteger(summary.observedActiveDistinctUserCount) &&
      summary.observedActiveDistinctUserCount >= 0 &&
      summary.observedActiveDistinctUserCount <= summary.rawRecordCount,
    `${label} summary counts were invalid`,
  )
  const exact = summary.availability === 'AVAILABLE' &&
    summary.completeness === 'COMPLETE' && summary.reasonCode === null &&
    summary.activeDistinctUserCount === summary.observedActiveDistinctUserCount
  const partial = summary.availability === 'PARTIAL' &&
    summary.activeDistinctUserCount === null &&
    ((summary.completeness === 'CONFLICTING' && summary.reasonCode === 'CONFLICTING_RECORDS') ||
      ((summary.completeness === 'PARTIAL' || summary.completeness === 'UNKNOWN') &&
        summary.reasonCode === 'PARTIAL_RECORDS'))
  assert(exact || partial, `${label} summary state was contradictory`)
  return summary
}

function assertIdentityRiskEnvelope(body, route, requestWindow, microsoftSummary) {
  const trustedNowMs = requestWindow.completedAt
  const envelope = record(body)
  assert(envelope?.version === IDENTITY_RISK_API_VERSION, `${route.label} version was invalid`)
  assert(envelope.channel === route.channel, `${route.label} channel was invalid`)
  assert(envelope.catalogVersion === route.catalogVersion, `${route.label} catalog was invalid`)
  assert(envelope.engineVersion === route.engineVersion, `${route.label} engine was invalid`)
  assert(IDENTITY_RISK_STATUSES.has(envelope.status), `${route.label} status was invalid`)
  assert(
    IDENTITY_RISK_CAPABILITIES.has(envelope.capability),
    `${route.label} capability was invalid`,
  )
  assert(
    IDENTITY_RISK_FRESHNESS.has(envelope.freshness),
    `${route.label} freshness was invalid`,
  )
  assert(envelope.sourceLabel === route.sourceLabel, `${route.label} source label was invalid`)
  const evaluatedAt = assertNullableTimestamp(
    envelope.evaluatedAt,
    route.label,
    trustedNowMs,
  )
  const observedAt = assertNullableTimestamp(
    envelope.observedAt,
    route.label,
    trustedNowMs,
  )
  assert(
    observedAt === null ||
      (evaluatedAt !== null &&
        Date.parse(observedAt) <=
          Date.parse(evaluatedAt) + IDENTITY_RISK_MAX_FUTURE_SKEW_MS),
    `${route.label} observation timestamp was invalid`,
  )
  assert(
    envelope.limitation === null ||
      (typeof envelope.limitation === 'string' &&
        envelope.limitation.length > 0 &&
        envelope.limitation.length <= 500),
    `${route.label} limitation was invalid`,
  )
  assert(envelope.status !== 'ERROR', `${route.label} reported an error state`)
  const observedAgeAtEndMs = observedAt === null
    ? null
    : trustedNowMs - Date.parse(observedAt)
  const observedAgeAtStartMs = observedAt === null
    ? null
    : requestWindow.startedAt - Date.parse(observedAt)
  // The server may evaluate anywhere within this read's timing window. At the
  // 36h crossing, either classification can be valid; outside it, fail closed.
  const hawkViewCoherent =
    ((envelope.status === 'AVAILABLE' || envelope.status === 'STALE') &&
      (envelope.capability === 'FULL' || envelope.capability === 'PARTIAL') &&
      envelope.freshness === (envelope.status === 'AVAILABLE' ? 'CURRENT' : 'STALE') &&
      evaluatedAt !== null &&
      observedAt !== null &&
      (envelope.status === 'AVAILABLE'
        ? observedAgeAtStartMs <= IDENTITY_RISK_CURRENT_MAX_AGE_MS
        : observedAgeAtEndMs > IDENTITY_RISK_CURRENT_MAX_AGE_MS) &&
      envelope.limitation !== null) ||
    (envelope.status === 'NOT_EVALUATED' &&
      envelope.capability === 'UNAVAILABLE' &&
      envelope.freshness === 'UNKNOWN' &&
      observedAt === null &&
      envelope.limitation !== null) ||
    (envelope.status === 'UNAVAILABLE' &&
      envelope.capability === 'UNAVAILABLE' &&
      envelope.freshness === 'UNKNOWN' &&
      evaluatedAt === null &&
      observedAt === null &&
      envelope.limitation !== null)
  const microsoftCoherent =
    (envelope.status === 'AVAILABLE' &&
      ((envelope.capability === 'FULL' && microsoftSummary?.availability === 'AVAILABLE' && envelope.limitation === null) ||
        (envelope.capability === 'PARTIAL' && microsoftSummary?.availability === 'PARTIAL' && envelope.limitation !== null)) &&
      envelope.freshness === 'CURRENT' &&
      evaluatedAt !== null &&
      observedAt !== null &&
      observedAgeAtStartMs <= IDENTITY_RISK_CURRENT_MAX_AGE_MS &&
      microsoftSummary.snapshotObservedAt === observedAt &&
      microsoftSummary.collectionSucceededAt === evaluatedAt) ||
    (envelope.status === 'UNAVAILABLE' &&
      envelope.capability === 'UNAVAILABLE' &&
      envelope.freshness === 'UNKNOWN' &&
      evaluatedAt === null &&
      observedAt === null &&
      envelope.limitation !== null &&
      microsoftSummary?.availability === 'UNAVAILABLE')
  const coherent = route.channel === 'HAWKVIEW_IDENTITY_SIGNALS'
    ? hawkViewCoherent
    : microsoftCoherent
  assert(coherent, `${route.label} state was contradictory`)
  return envelope
}

function assertBoundedCount(value, label) {
  const count = record(value)
  assert(
    Number.isInteger(count?.value) && count.value >= 0 && count.value <= 10_000,
    `${label} value was invalid`,
  )
  assert(typeof count.exact === 'boolean', `${label} exact marker was invalid`)
  assert(typeof count.capped === 'boolean', `${label} capped marker was invalid`)
  assert(!(count.exact && count.capped), `${label} exact and capped markers conflicted`)
  assert(
    (!count.capped || count.value === 10_000) &&
      (count.exact || count.capped || count.value === 0),
    `${label} bounded-count markers were invalid`,
  )
  return count
}

function assertPageInfo(value, label, collectionLength) {
  const pageInfo = record(value)
  assert(
    pageInfo && exactKeys(pageInfo, ['hasMore', 'nextCursor']) &&
      typeof pageInfo.hasMore === 'boolean',
    `${label} pagination was invalid`,
  )
  assert(
    pageInfo.hasMore
      ? typeof pageInfo.nextCursor === 'string' &&
          pageInfo.nextCursor.length > 0 &&
          pageInfo.nextCursor.length <= 256 &&
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pageInfo.nextCursor)
      : pageInfo.nextCursor === null,
    `${label} cursor contract was invalid`,
  )
  assert(collectionLength > 0 || !pageInfo.hasMore, `${label} empty page claimed more results`)
}

function assertFinding(value, envelope, label, trustedNowMs) {
  const finding = record(value)
  const keys = [
    'id', 'state', 'severity', 'confidence', 'coverage', 'title', 'explanation',
    'affectedIdentity', 'investigationGuidanceCode', 'investigationGuidance',
    'benignAlternativeCodes', 'sourceLabels', 'missingEvidenceLabels',
    'observedAt', 'ruleIds',
  ]
  assert(finding && exactKeys(finding, keys), `${label} row was invalid`)
  boundedString(finding.id, 200, `${label} id`, /^[A-Za-z0-9._:-]+$/)
  assert(FINDING_STATES.has(finding.state), `${label} state was invalid`)
  assert(FINDING_SEVERITIES.has(finding.severity), `${label} severity was invalid`)
  assert(FINDING_CONFIDENCES.has(finding.confidence), `${label} confidence was invalid`)
  assert(IDENTITY_RISK_CAPABILITIES.has(finding.coverage), `${label} coverage was invalid`)
  boundedString(finding.title, 160, `${label} title`)
  boundedString(finding.explanation, 1_000, `${label} explanation`)
  const identity = record(finding.affectedIdentity)
  assert(identity && exactKeys(identity, ['id', 'label', 'type']), `${label} identity was invalid`)
  assert(IDENTITY_TYPES.has(identity.type), `${label} identity type was invalid`)
  const allowedKinds = HAWKVIEW_IDENTITY_REFERENCE_KIND.get(identity.type) ?? []
  assert(
    typeof identity.id === 'string' &&
      allowedKinds.some(kind =>
        new RegExp(`^hvr1_${kind}_[a-f0-9]{64}$`).test(identity.id)),
    `${label} identity projection was invalid`,
  )
  assert(
    identity.label === (identity.type === 'MAILBOX'
      ? 'Affected mailbox (restricted details)'
      : 'Tenant identity'),
    `${label} identity label was invalid`,
  )
  assert(
    INVESTIGATION_GUIDANCE_CODES.has(finding.investigationGuidanceCode),
    `${label} guidance code was invalid`,
  )
  boundedString(finding.investigationGuidance, 300, `${label} guidance`)
  assertStringList(finding.benignAlternativeCodes, `${label} alternatives`)
  assertStringList(finding.sourceLabels, `${label} sources`)
  assertStringList(finding.missingEvidenceLabels, `${label} missing evidence`)
  assertStringList(finding.ruleIds, `${label} rules`, { requireItem: true })
  const expectedSources = finding.ruleIds.length === 1
    ? HAWKVIEW_RULE_SOURCE_LABELS.get(finding.ruleIds[0])
    : null
  assert(expectedSources, `${label} rules were invalid`)
  assert(
    finding.sourceLabels.length === expectedSources.length &&
      finding.sourceLabels.every((source, index) => source === expectedSources[index]),
    `${label} sources did not match the registered rule`,
  )
  const observedAt = assertNullableTimestamp(
    finding.observedAt,
    `${label} observed`,
    trustedNowMs,
  )
  assert(
    observedAt && envelope.evaluatedAt &&
      Date.parse(observedAt) <= Date.parse(envelope.evaluatedAt) + 5 * 60 * 1_000,
    `${label} observed timestamp was invalid`,
  )
}

function assertMicrosoftUser(value, envelope, label, trustedNowMs) {
  const user = record(value)
  assert(
    user && exactKeys(user, [
      'id', 'identityLabel', 'riskLevel', 'riskState', 'riskDetail', 'observedAt',
    ]),
    `${label} row was invalid`,
  )
  boundedString(user.id, 37, `${label} id`, /^msru_[a-f0-9]{32}$/)
  boundedString(user.identityLabel, 160, `${label} identity label`)
  assert(MICROSOFT_RISK_LEVELS.has(user.riskLevel), `${label} risk level was invalid`)
  assert(MICROSOFT_RISK_STATES.has(user.riskState), `${label} risk state was invalid`)
  assert(
    user.riskDetail === null || MICROSOFT_RISK_DETAILS.has(user.riskDetail),
    `${label} risk detail was invalid`,
  )
  const observedAt = assertNullableTimestamp(
    user.observedAt,
    `${label} observed`,
    trustedNowMs,
  )
  assert(
    observedAt && envelope.evaluatedAt &&
      Date.parse(observedAt) <= Date.parse(envelope.evaluatedAt) + 5 * 60 * 1_000,
    `${label} observed timestamp was invalid`,
  )
}

function assertIdentityRiskResponse(body, route, requestWindow) {
  const trustedNowMs = requestWindow.completedAt
  const candidate = record(body)
  const commonKeys = [
    'version', 'channel', 'engineVersion', 'catalogVersion', 'evaluatedAt',
    'capability', 'status', 'sourceLabel', 'observedAt', 'freshness', 'limitation',
  ]
  assert(
    candidate && exactKeys(
      candidate,
      route.collection === 'counts'
        ? [...commonKeys, 'counts']
        : route.channel === 'MICROSOFT_ENTRA_RISKY_USERS'
          ? [...commonKeys, route.collection, 'pageInfo', 'microsoftRiskSummary']
          : [...commonKeys, route.collection, 'pageInfo'],
    ),
    `${route.label} envelope keys were invalid`,
  )
  const microsoftSummary = route.channel === 'MICROSOFT_ENTRA_RISKY_USERS'
    ? assertMicrosoftRiskSummary(candidate.microsoftRiskSummary, route.label, requestWindow)
    : null
  const envelope = assertIdentityRiskEnvelope(body, route, requestWindow, microsoftSummary)
  if (route.collection === 'counts') {
    const counts = record(envelope.counts)
    assert(
      counts && exactKeys(counts, IDENTITY_RISK_COUNT_KEYS),
      `${route.label} counts were invalid`,
    )
    const validatedCounts = []
    for (const key of IDENTITY_RISK_COUNT_KEYS) {
      validatedCounts.push(assertBoundedCount(counts[key], `${route.label} ${key}`))
    }
    assert(
      envelope.evaluatedAt === null
        ? validatedCounts.every(count =>
            count.value === 0 && !count.exact && !count.capped)
        : validatedCounts.every(count => count.exact || count.capped),
      `${route.label} counts did not match evaluation availability`,
    )
    const evaluatedRules = counts.evaluatedRules
    const evaluatedRulesUnavailable =
      evaluatedRules.value === 0 && !evaluatedRules.exact && !evaluatedRules.capped
    assert(
      evaluatedRulesUnavailable ||
        (evaluatedRules.exact && !evaluatedRules.capped && evaluatedRules.value <= 22),
      `${route.label} evaluated-rules count was invalid`,
    )
    return
  }
  const collection = envelope[route.collection]
  assert(
    Array.isArray(collection) && collection.length <= 100,
    `${route.label} collection was invalid`,
  )
  if (envelope.capability === 'UNAVAILABLE') {
    assert(collection.length === 0, `${route.label} unavailable collection was not empty`)
  }
  collection.forEach((value, index) => {
    if (route.collection === 'findings') {
      assertFinding(value, envelope, `${route.label} row ${index + 1}`, trustedNowMs)
    } else {
      assertMicrosoftUser(value, envelope, `${route.label} row ${index + 1}`, trustedNowMs)
    }
  })
  const rowIds = collection.map(value => record(value)?.id)
  assert(new Set(rowIds).size === rowIds.length, `${route.label} row IDs were duplicated`)
  if (microsoftSummary && microsoftSummary.availability !== 'UNAVAILABLE') {
    assert(collection.length <= microsoftSummary.rawRecordCount, `${route.label} page exceeded its source summary`)
  }
  assertPageInfo(envelope.pageInfo, route.label, collection.length)
}

async function verifyIdentityRiskRoutes(
  fetchImpl,
  session,
  foreignSession,
  verifyUnauthenticated,
  now,
) {
  for (const route of IDENTITY_RISK_ROUTES) {
    const ownPath = `/api/tenants/${encodeURIComponent(session.expectedTenantId)}/${route.suffix}`
    const startedAt = now()
    assert(Number.isFinite(startedAt), 'Canary clock was invalid')
    const own = await authenticatedJson(
      fetchImpl,
      session.accessToken,
      ownPath,
      [200],
      `${route.label} own tenant`,
    )
    const completedAt = now()
    assert(
      Number.isFinite(completedAt) && completedAt >= startedAt,
      'Canary request timing window was invalid',
    )
    assertIdentityRiskResponse(own.body, route, { startedAt, completedAt })
    const foreignPath = `/api/tenants/${encodeURIComponent(foreignSession.expectedTenantId)}/${route.suffix}`
    await authenticatedJson(
      fetchImpl,
      session.accessToken,
      foreignPath,
      [403, 404],
      `${route.label} foreign tenant denial`,
    )

    if (verifyUnauthenticated) {
      await requestJson(
        fetchImpl,
        `${API_ORIGIN}${ownPath}`,
        { cache: 'no-store' },
        [401],
        `${route.label} unauthenticated denial`,
      )
    }
  }
}

function assertBaselineCatalog(value, label) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 200, `${label} catalog was invalid`)
  const ids = new Set()
  for (const candidate of value) {
    const check = record(candidate)
    assert(check, `${label} catalog row was invalid`)
    boundedString(check.id, 120, `${label} check ID`, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    boundedString(check.title, 200, `${label} check title`)
    boundedString(check.service, 80, `${label} check service`)
    boundedString(check.recommendation, 80, `${label} check recommendation`)
    boundedString(check.source, 200, `${label} check source`)
    boundedString(check.resourceType, 80, `${label} check resource`)
    boundedString(check.expected, 1_000, `${label} check expectation`)
    boundedString(check.guidance, 1_000, `${label} check guidance`)
    assert(
      check.choiceGroup === null ||
        (typeof check.choiceGroup === 'string' && check.choiceGroup.length <= 120),
      `${label} check choice group was invalid`,
    )
    if (check.parameterKind !== undefined) {
      boundedString(check.parameterKind, 80, `${label} check parameter`)
    }
    assert(!ids.has(check.id), `${label} catalog IDs were duplicated`)
    ids.add(check.id)
  }
  return ids
}

function assertBaselineStarter(value, catalogIds, label) {
  const starter = record(value)
  assert(starter, `${label} starter was invalid`)
  boundedString(starter.id, 100, `${label} starter ID`)
  boundedString(starter.name, 100, `${label} starter name`)
  boundedString(starter.description, 1_000, `${label} starter description`)
  boundedString(starter.boundary, 1_000, `${label} starter boundary`)
  assert(
    Array.isArray(starter.checkIds) && starter.checkIds.length > 0 &&
      starter.checkIds.length <= catalogIds.size &&
      starter.checkIds.every(id => catalogIds.has(id)) &&
      new Set(starter.checkIds).size === starter.checkIds.length,
    `${label} starter checks were invalid`,
  )
  return starter
}

function assertBaselineList(body) {
  const list = record(body)
  assert(list && list.page === 1 && list.pageSize === 25, 'Baseline library pagination was invalid')
  assert(
    Number.isSafeInteger(list.total) && list.total >= 0 &&
      Array.isArray(list.items) && list.items.length <= 25 &&
      list.items.length <= list.total,
    'Baseline library list was invalid',
  )
  const catalogIds = assertBaselineCatalog(list.catalog, 'Baseline library')
  const starter = assertBaselineStarter(list.starter, catalogIds, 'Baseline library')
  const ids = new Set()
  for (const candidate of list.items) {
    const baseline = record(candidate)
    assert(baseline && UUID_PATTERN.test(baseline.id ?? ''), 'Baseline library row was invalid')
    boundedString(baseline.name, 100, 'Baseline library name')
    assert(
      Array.isArray(baseline.checkIds) && baseline.checkIds.length <= catalogIds.size &&
        baseline.checkIds.every(id =>
          typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 120) &&
        new Set(baseline.checkIds).size === baseline.checkIds.length &&
        Number.isSafeInteger(baseline.revision) && baseline.revision >= 1 &&
        baseline.assignedTenantCount === 0 &&
        canonicalTimestamp(baseline.updatedAt) !== null,
      'Baseline library row contract was invalid',
    )
    assert(!ids.has(baseline.id), 'Baseline library IDs were duplicated')
    ids.add(baseline.id)
  }
  return { catalogIds, starter }
}

function assertBaselineTenantChoices(body, session) {
  const choices = record(body)
  assert(
    choices && choices.page === 1 && choices.pageSize === 25 &&
      choices.total === 1 && Array.isArray(choices.items) &&
      choices.items.length === 1,
    'Baseline tenant choices were not isolated',
  )
  const tenant = record(choices.items[0])
  assert(
    tenant?.id === session.expectedTenantId && tenant.baselineId === null &&
      (tenant.displayName === null ||
        (typeof tenant.displayName === 'string' && tenant.displayName.length <= 200)) &&
      (tenant.primaryDomain === null ||
        (typeof tenant.primaryDomain === 'string' && tenant.primaryDomain.length <= 255)),
    'Baseline tenant choice was invalid',
  )
}

function assertBaselineAssessment(body, session, library) {
  const assessment = record(body)
  assert(
    assessment && assessment.tenantId === session.expectedTenantId &&
      assessment.canManage === true && assessment.assignment === null,
    'Baseline tenant assessment scope was invalid',
  )
  boundedString(assessment.tenantName, 200, 'Baseline tenant name')
  assert(
    assessment.tenantDomain === null ||
      (typeof assessment.tenantDomain === 'string' && assessment.tenantDomain.length <= 255),
    'Baseline tenant domain was invalid',
  )
  assert(canonicalTimestamp(assessment.assessedAt) !== null, 'Baseline assessment time was invalid')
  boundedString(assessment.evidenceNote, 500, 'Baseline evidence note')
  const catalogIds = assertBaselineCatalog(assessment.catalog, 'Baseline assessment')
  const starter = assertBaselineStarter(assessment.starter, catalogIds, 'Baseline assessment')
  assert(
    catalogIds.size === library.catalogIds.size &&
      [...catalogIds].every(id => library.catalogIds.has(id)) &&
      starter.id === library.starter.id &&
      starter.checkIds.length === library.starter.checkIds.length &&
      starter.checkIds.every((id, index) => id === library.starter.checkIds[index]),
    'Baseline catalog differed between library and assessment',
  )
  assert(Array.isArray(assessment.baselines), 'Baseline assessment library was invalid')
  const baselineIds = new Set()
  for (const candidate of assessment.baselines) {
    const baseline = record(candidate)
    assert(baseline && UUID_PATTERN.test(baseline.id ?? ''), 'Baseline assessment library row was invalid')
    boundedString(baseline.name, 100, 'Baseline assessment library name')
    assert(
      Number.isSafeInteger(baseline.revision) && baseline.revision >= 1 &&
        Array.isArray(baseline.checkIds) && baseline.checkIds.length <= catalogIds.size &&
        baseline.checkIds.every(id =>
          typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 120) &&
        new Set(baseline.checkIds).size === baseline.checkIds.length &&
        canonicalTimestamp(baseline.updatedAt) !== null,
      'Baseline assessment library row contract was invalid',
    )
    assert(!baselineIds.has(baseline.id), 'Baseline assessment library IDs were duplicated')
    baselineIds.add(baseline.id)
  }
  assert(Array.isArray(assessment.results) && assessment.results.length === 0, 'Unassigned canary tenant had baseline results')
  const summary = record(assessment.summary)
  assert(
    summary && summary.selected === 0 && summary.met === 0 &&
      summary.needsAction === 0 && summary.unableToAssess === 0,
    'Unassigned canary tenant had baseline counts',
  )
}

async function verifyBaselineRoutes(fetchImpl, session, foreignSession, verifyUnauthenticated) {
  const ownLibrary = `/api/policies/workspaces/${encodeURIComponent(session.expectedOrganizationId)}/baselines`
  const foreignLibrary = `/api/policies/workspaces/${encodeURIComponent(foreignSession.expectedOrganizationId)}/baselines`
  const ownAssessment = `/api/tenants/${encodeURIComponent(session.expectedTenantId)}/security-requirements`
  const foreignAssessment = `/api/tenants/${encodeURIComponent(foreignSession.expectedTenantId)}/security-requirements`
  const library = assertBaselineList((await authenticatedJson(
    fetchImpl, session.accessToken, `${ownLibrary}?page=1`, [200], 'Baseline own library',
  )).body)
  assertBaselineTenantChoices((await authenticatedJson(
    fetchImpl, session.accessToken, `${ownLibrary}/tenant-choices?page=1`, [200], 'Baseline own tenant choices',
  )).body, session)
  assertBaselineAssessment((await authenticatedJson(
    fetchImpl, session.accessToken, ownAssessment, [200], 'Baseline own tenant assessment',
  )).body, session, library)
  await authenticatedJson(
    fetchImpl, session.accessToken, `${foreignLibrary}?page=1`, [403, 404], 'Baseline foreign workspace denial',
  )
  await authenticatedJson(
    fetchImpl, session.accessToken, `${foreignLibrary}/tenant-choices?page=1`, [403, 404],
    'Baseline foreign tenant choices denial',
  )
  await authenticatedJson(
    fetchImpl, session.accessToken, foreignAssessment, [403, 404], 'Baseline foreign tenant denial',
  )
  if (verifyUnauthenticated) {
    for (const [path, label] of [
      [`${ownLibrary}?page=1`, 'Baseline unauthenticated library denial'],
      [ownAssessment, 'Baseline unauthenticated assessment denial'],
    ]) {
      await requestJson(fetchImpl, `${API_ORIGIN}${path}`, { cache: 'no-store' }, [401], label)
    }
  }
}

async function verifyIdentityBoundary(fetchImpl, session, foreignSession) {
  const bootstrap = (
    await requestJson(fetchImpl, `${API_ORIGIN}/auth/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      cache: 'no-store',
    }, [201])
  ).body
  const bootstrapRecord = record(bootstrap)
  const user = record(bootstrapRecord?.user)
  const memberships = Array.isArray(user?.memberships) ? user.memberships : []
  assert(
    typeof user?.email === 'string' && user.email.toLowerCase() === session.email.toLowerCase(),
    `Canary ${session.slot} bootstrap identity was incorrect`,
  )
  assert(memberships.length === 1, `Canary ${session.slot} must have exactly one membership`)
  assert(
    record(record(memberships[0])?.organization)?.id === session.expectedOrganizationId,
    `Canary ${session.slot} organization was incorrect`,
  )

  const tenantList = (await authenticatedJson(fetchImpl, session.accessToken, '/api/tenants')).body
  const tenants = Array.isArray(record(tenantList)?.tenants) ? record(tenantList).tenants : []
  const tenantIds = tenants.map(tenant => record(tenant)?.id).filter(value => typeof value === 'string')
  assert(
    tenantIds.length === 1 && tenantIds[0] === session.expectedTenantId,
    `Canary ${session.slot} tenant directory was not exactly isolated`,
  )
  assert(
    !tenantIds.includes(foreignSession.expectedTenantId),
    `Canary ${session.slot} received the foreign tenant`,
  )

  await authenticatedJson(
    fetchImpl,
    session.accessToken,
    `/api/tenants/${encodeURIComponent(session.expectedTenantId)}/onboarding`,
  )
  await authenticatedJson(
    fetchImpl,
    session.accessToken,
    `/api/tenants/${encodeURIComponent(foreignSession.expectedTenantId)}/onboarding`,
    [403, 404],
  )
}

const READINESS_REQUEST_FAILURES = new Map([
  ['API health failed', 'transport'],
  ['API health response was not JSON', 'media-type'],
  ['API health response was not usable', 'body'],
  ['API health returned an unexpected status', 'http-status'],
])

function healthReadiness(body, expectedRevision) {
  const health = record(body)
  if (!health) return { reason: 'shape', status: 'unavailable', revision: 'unavailable' }
  const status = health.status === 'ok' ? 'ok'
    : health.status === undefined ? 'absent'
      : typeof health.status === 'string' ? 'not-ok' : 'invalid'
  // Only a full SHA can be printed. Never echo arbitrary provider/body content.
  const revision = health.revision === undefined ? 'absent'
    : typeof health.revision === 'string' && health.revision.length === 40 && FULL_GIT_REVISION.test(health.revision)
      ? health.revision : 'invalid'
  const reason = status !== 'ok' ? 'status'
    : health.revision !== expectedRevision ? 'revision' : null
  return { reason, status, revision }
}

async function waitForExpectedRevision(fetchImpl, expectedRevision, sleep) {
  let failure
  for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
    try {
      const { body } = await requestJson(fetchImpl, `${API_ORIGIN}/health`, {}, [200], 'API health')
      failure = healthReadiness(body, expectedRevision)
    } catch (error) {
      failure = {
        reason: READINESS_REQUEST_FAILURES.get(error instanceof Error ? error.message : '') ?? 'request',
        status: 'unavailable',
        revision: 'unavailable',
      }
    }
    if (failure.reason === null) return
    if (attempt < READINESS_ATTEMPTS) await sleep(READINESS_DELAY_MS)
  }
  throw new Error(
    `API readiness failed after ${READINESS_ATTEMPTS} attempts: reason=${failure.reason}; ` +
    `status=${failure.status}; revision=${failure.revision}; expected=${expectedRevision}`,
  )
}

export async function runAuthenticatedCanary({
  fetchImpl = fetch,
  environment = process.env,
  now = Date.now,
  sleep = delay,
} = {}) {
  assert(Number.isFinite(now()), 'Canary clock was invalid')
  const revision = environment.EXPECTED_REVISION?.trim().toLowerCase() ?? ''
  assert(FULL_GIT_REVISION.test(revision), 'Expected deployment revision is invalid')

  await waitForExpectedRevision(fetchImpl, revision, sleep)
  const database = (
    await requestJson(fetchImpl, `${API_ORIGIN}/health/database`, {}, [200], 'database health')
  ).body
  assert(
    record(database)?.status === 'ok' &&
      record(database)?.database === 'connected' &&
      record(database)?.schema === 'current',
    'The deployment database is not healthy',
  )

  const oidcToken = await githubOidcToken(fetchImpl, environment)
  const issued = (
    await requestJson(fetchImpl, `${API_ORIGIN}/api/internal/canary/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deploymentRevision: revision }),
    }, [201])
  ).body
  const issuedRecord = record(issued)
  assert(issuedRecord?.contractVersion === 1, 'Canary session contract was unsupported')
  assert(issuedRecord?.deploymentRevision === revision, 'Canary session revision did not match')
  assert(Array.isArray(issuedRecord?.sessions) && issuedRecord.sessions.length === 2, 'Two canary sessions are required')
  const sessionA = normalizedSession(issuedRecord.sessions[0], 'A')
  const sessionB = normalizedSession(issuedRecord.sessions[1], 'B')
  assert(sessionA.expectedOrganizationId !== sessionB.expectedOrganizationId, 'Canary organizations must differ')
  assert(sessionA.expectedTenantId !== sessionB.expectedTenantId, 'Canary tenants must differ')

  await verifyIdentityBoundary(fetchImpl, sessionA, sessionB)
  await verifyIdentityBoundary(fetchImpl, sessionB, sessionA)
  await verifyIdentityRiskRoutes(fetchImpl, sessionA, sessionB, true, now)
  await verifyIdentityRiskRoutes(fetchImpl, sessionB, sessionA, false, now)
  await verifyBaselineRoutes(fetchImpl, sessionA, sessionB, true)
  await verifyBaselineRoutes(fetchImpl, sessionB, sessionA, false)
  console.log('Authenticated two-MSP canary, identity-risk, and Baseline route checks passed.')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runAuthenticatedCanary()
}
