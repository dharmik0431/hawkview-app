import { pathToFileURL } from 'node:url'

export const CANARY_AUDIENCE =
  'https://api.hawkviewapp.com/api/internal/canary/sessions'
export const API_ORIGIN = 'https://api.hawkviewapp.com'
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/i
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
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

function assertIdentityRiskEnvelope(body, route, trustedNowMs) {
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
  const observedAgeMs = observedAt === null
    ? null
    : trustedNowMs - Date.parse(observedAt)
  const coherent =
    (envelope.status === 'AVAILABLE' &&
      envelope.capability !== 'UNAVAILABLE' &&
      envelope.freshness === 'CURRENT' &&
      evaluatedAt !== null &&
      observedAt !== null &&
      observedAgeMs <= IDENTITY_RISK_CURRENT_MAX_AGE_MS &&
      (envelope.capability === 'FULL' || envelope.limitation !== null)) ||
    (envelope.status === 'STALE' &&
      envelope.capability !== 'UNAVAILABLE' &&
      envelope.freshness === 'STALE' &&
      evaluatedAt !== null &&
      observedAt !== null &&
      observedAgeMs > IDENTITY_RISK_CURRENT_MAX_AGE_MS &&
      envelope.limitation !== null) ||
    (envelope.status === 'LEARNING' &&
      envelope.capability !== 'UNAVAILABLE' &&
      envelope.freshness === 'UNKNOWN' &&
      evaluatedAt !== null &&
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
  boundedString(identity.id, 128, `${label} identity id`, /^[A-Za-z0-9._:-]+$/)
  boundedString(identity.label, 160, `${label} identity label`)
  assert(IDENTITY_TYPES.has(identity.type), `${label} identity type was invalid`)
  assert(
    INVESTIGATION_GUIDANCE_CODES.has(finding.investigationGuidanceCode),
    `${label} guidance code was invalid`,
  )
  boundedString(finding.investigationGuidance, 300, `${label} guidance`)
  assertStringList(finding.benignAlternativeCodes, `${label} alternatives`)
  assertStringList(finding.sourceLabels, `${label} sources`)
  assertStringList(finding.missingEvidenceLabels, `${label} missing evidence`)
  assertStringList(finding.ruleIds, `${label} rules`, { requireItem: true })
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
  boundedString(user.id, 200, `${label} id`, /^[A-Za-z0-9._:-]+$/)
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

function assertIdentityRiskResponse(body, route, trustedNowMs) {
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
        : [...commonKeys, route.collection, 'pageInfo'],
    ),
    `${route.label} envelope keys were invalid`,
  )
  const envelope = assertIdentityRiskEnvelope(body, route, trustedNowMs)
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
  assertPageInfo(envelope.pageInfo, route.label, collection.length)
}

function assertMatchingHawkViewMeta(summary, findings) {
  for (const key of [
    'version', 'channel', 'engineVersion', 'catalogVersion', 'evaluatedAt',
    'capability', 'status', 'sourceLabel', 'observedAt', 'freshness', 'limitation',
  ]) {
    assert(summary[key] === findings[key], 'HawkView risk route metadata did not match')
  }
}

async function verifyIdentityRiskRoutes(
  fetchImpl,
  session,
  foreignSession,
  verifyUnauthenticated,
  trustedNowMs,
) {
  const hawkViewResponses = []
  for (const route of IDENTITY_RISK_ROUTES) {
    const ownPath = `/api/tenants/${encodeURIComponent(session.expectedTenantId)}/${route.suffix}`
    const own = await authenticatedJson(
      fetchImpl,
      session.accessToken,
      ownPath,
      [200],
      `${route.label} own tenant`,
    )
    assertIdentityRiskResponse(own.body, route, trustedNowMs)
    if (route.channel === 'HAWKVIEW_IDENTITY_SIGNALS') {
      hawkViewResponses.push(own.body)
    }

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
  assertMatchingHawkViewMeta(hawkViewResponses[0], hawkViewResponses[1])
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

export async function runAuthenticatedCanary({
  fetchImpl = fetch,
  environment = process.env,
  now = Date.now,
} = {}) {
  const trustedNowMs = now()
  assert(Number.isFinite(trustedNowMs), 'Canary clock was invalid')
  const revision = environment.EXPECTED_REVISION?.trim().toLowerCase() ?? ''
  assert(FULL_GIT_REVISION.test(revision), 'Expected deployment revision is invalid')

  const health = (
    await requestJson(fetchImpl, `${API_ORIGIN}/health`, {}, [200], 'API health')
  ).body
  assert(
    record(health)?.status === 'ok' && record(health)?.revision === revision,
    'The expected API revision is not live',
  )
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
  await verifyIdentityRiskRoutes(fetchImpl, sessionA, sessionB, true, trustedNowMs)
  await verifyIdentityRiskRoutes(fetchImpl, sessionB, sessionA, false, trustedNowMs)
  console.log('Authenticated two-MSP canary and identity-risk route checks passed.')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runAuthenticatedCanary()
}
