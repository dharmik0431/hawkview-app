import { pathToFileURL } from 'node:url'

export const CANARY_AUDIENCE =
  'https://api.hawkviewapp.com/api/internal/canary/sessions'
export const API_ORIGIN = 'https://api.hawkviewapp.com'
const FULL_GIT_REVISION = /^[0-9a-f]{40}$/i
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

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

async function requestJson(fetchImpl, url, init, expectedStatuses = [200]) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  })
  const body = await boundedJson(response)
  assert(
    expectedStatuses.includes(response.status),
    `Unexpected ${response.status} response from ${new URL(url).pathname}`,
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
  })
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

async function authenticatedJson(fetchImpl, token, path, expectedStatuses = [200]) {
  return requestJson(
    fetchImpl,
    `${API_ORIGIN}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
    expectedStatuses,
  )
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
} = {}) {
  const revision = environment.EXPECTED_REVISION?.trim().toLowerCase() ?? ''
  assert(FULL_GIT_REVISION.test(revision), 'Expected deployment revision is invalid')

  const health = (await requestJson(fetchImpl, `${API_ORIGIN}/health`, {})).body
  assert(
    record(health)?.status === 'ok' && record(health)?.revision === revision,
    'The expected API revision is not live',
  )
  const database = (await requestJson(fetchImpl, `${API_ORIGIN}/health/database`, {})).body
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
  console.log('Authenticated two-MSP canary passed for the exact deployed revision.')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runAuthenticatedCanary()
}
