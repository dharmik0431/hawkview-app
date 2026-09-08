import assert from 'node:assert/strict'
import test from 'node:test'
import { API_ORIGIN, CANARY_AUDIENCE, runAuthenticatedCanary } from './authenticated-msp-canary.mjs'

const revision = 'a'.repeat(40)
const ids = {
  orgA: '11111111-1111-4111-8111-111111111111',
  orgB: '22222222-2222-4222-8222-222222222222',
  tenantA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const tokenA = `a.${'x'.repeat(120)}.a`
const tokenB = `b.${'x'.repeat(120)}.b`
const boundedZero = { value: 0, exact: false, capped: false }
const exactCount = value => ({ value, exact: true, capped: false })
const completedAt = '2026-09-02T13:00:00.000Z'
const freshnessNow = Date.parse('2026-09-08T12:00:00.000Z')
const hawkViewUnavailable = {
  version: 1,
  channel: 'HAWKVIEW_IDENTITY_SIGNALS',
  engineVersion: 'hawkview-identity-engine/1',
  catalogVersion: 'hawkview-identity-signals/v1',
  evaluatedAt: null,
  capability: 'UNAVAILABLE',
  status: 'NOT_EVALUATED',
  sourceLabel: 'HawkView Identity Signals',
  observedAt: null,
  freshness: 'UNKNOWN',
  limitation: 'No completed shadow evaluation is available.',
}
const microsoftUnavailable = {
  version: 1,
  channel: 'MICROSOFT_ENTRA_RISKY_USERS',
  engineVersion: null,
  catalogVersion: 'microsoft-entra-risky-users/v1',
  evaluatedAt: null,
  capability: 'UNAVAILABLE',
  status: 'UNAVAILABLE',
  sourceLabel: 'Microsoft Entra Risky Users',
  observedAt: null,
  freshness: 'UNKNOWN',
  limitation: 'Microsoft Entra risky-user display is not enabled.',
}

function riskFixture(route) {
  if (route === 'summary') {
    return {
      ...hawkViewUnavailable,
      counts: {
        identitiesNeedingReview: { ...boundedZero },
        openFindings: { ...boundedZero },
        evaluatedRules: { ...boundedZero },
        matchedResults: { ...boundedZero },
        suppressedResults: { ...boundedZero },
        notMatchedResults: { ...boundedZero },
        notEvaluatedResults: { ...boundedZero },
      },
    }
  }
  if (route === 'findings') {
    return {
      ...hawkViewUnavailable,
      findings: [],
      pageInfo: { hasMore: false, nextCursor: null },
    }
  }
  return {
    ...microsoftUnavailable,
    users: [],
    pageInfo: { hasMore: false, nextCursor: null },
  }
}

function completedUnavailableFixture(route) {
  const meta = {
    ...hawkViewUnavailable,
    evaluatedAt: completedAt,
    limitation:
      'Approved HawkView identity-signal source evidence is not available for this evaluation.',
  }
  if (route === 'summary') {
    return {
      ...meta,
      counts: {
        identitiesNeedingReview: exactCount(0),
        openFindings: exactCount(0),
        evaluatedRules: exactCount(22),
        matchedResults: exactCount(0),
        suppressedResults: exactCount(0),
        notMatchedResults: exactCount(0),
        notEvaluatedResults: exactCount(22),
      },
    }
  }
  return {
    ...meta,
    findings: [],
    pageInfo: { hasMore: false, nextCursor: null },
  }
}

function availableFixture(route, nowMs = freshnessNow) {
  const evaluatedAt = new Date(nowMs - 30 * 60 * 1_000).toISOString()
  const currentObservedAt = new Date(nowMs - 60 * 60 * 1_000).toISOString()
  if (route === 'summary') {
    return {
      ...hawkViewUnavailable,
      capability: 'FULL',
      status: 'AVAILABLE',
      evaluatedAt,
      observedAt: currentObservedAt,
      freshness: 'CURRENT',
      limitation: 'Shadow-mode findings are investigation leads, not compromise verdicts.',
      counts: {
        identitiesNeedingReview: exactCount(0),
        openFindings: exactCount(0),
        evaluatedRules: exactCount(1),
        matchedResults: exactCount(0),
        suppressedResults: exactCount(0),
        notMatchedResults: exactCount(1),
        notEvaluatedResults: exactCount(0),
      },
    }
  }
  if (route === 'findings') {
    return {
      ...hawkViewUnavailable,
      capability: 'FULL',
      status: 'AVAILABLE',
      evaluatedAt,
      observedAt: currentObservedAt,
      freshness: 'CURRENT',
      limitation: 'Shadow-mode findings are investigation leads, not compromise verdicts.',
      findings: [],
      pageInfo: { hasMore: false, nextCursor: null },
    }
  }
  return {
    ...microsoftUnavailable,
    capability: 'FULL',
    status: 'AVAILABLE',
    evaluatedAt,
    observedAt: currentObservedAt,
    freshness: 'CURRENT',
    limitation: null,
    users: [],
    pageInfo: { hasMore: false, nextCursor: null },
  }
}

function staleHawkViewFixture(route, nowMs = freshnessNow) {
  return {
    ...availableFixture(route, nowMs),
    status: 'STALE',
    observedAt: new Date(nowMs - 37 * 60 * 60 * 1_000).toISOString(),
    freshness: 'STALE',
    limitation: 'Shadow-mode findings are investigation leads, not compromise verdicts.',
  }
}

function findingFixture(nowMs = freshnessNow) {
  return {
    id: 'finding-1',
    state: 'OPEN',
    severity: 'HIGH',
    confidence: 'HIGH',
    coverage: 'FULL',
    title: 'Identity protection configuration was weakened',
    explanation: 'Authoritative evidence showed a security control moving to a weaker state.',
    affectedIdentity: {
      id: `hvr1_subject_${'a'.repeat(64)}`,
      label: 'Tenant identity',
      type: 'USER',
    },
    investigationGuidanceCode: 'REVIEW_CONFIGURATION',
    investigationGuidance: 'Review the configuration and confirm the change is authorized.',
    benignAlternativeCodes: [],
    sourceLabels: ['Microsoft Entra directory audit'],
    missingEvidenceLabels: [],
    observedAt: new Date(nowMs - 60 * 60 * 1_000).toISOString(),
    ruleIds: ['HV-ID-CHG-005.v1'],
  }
}

function microsoftUserFixture(nowMs = freshnessNow) {
  return {
    id: `msru_${'b'.repeat(32)}`,
    identityLabel: 'Canary identity',
    riskLevel: 'low',
    riskState: 'atRisk',
    riskDetail: null,
    observedAt: new Date(nowMs - 60 * 60 * 1_000).toISOString(),
  }
}

test('targets only the branded production API', () => {
  assert.equal(API_ORIGIN, 'https://api.hawkviewapp.com')
  assert.equal(
    CANARY_AUDIENCE,
    'https://api.hawkviewapp.com/api/internal/canary/sessions',
  )
})

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function successfulFetch({ riskResponseOverride } = {}) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.origin === 'https://oidc.example.test') {
      assert.equal(url.searchParams.get('audience'), CANARY_AUDIENCE)
      assert.equal(init.headers.Authorization, 'Bearer runner-oidc-request-token')
      return jsonResponse({ value: `oidc.${'y'.repeat(120)}.token` })
    }
    if (url.pathname === '/health') return jsonResponse({ status: 'ok', revision })
    if (url.pathname === '/health/database') {
      return jsonResponse({ status: 'ok', database: 'connected', schema: 'current' })
    }
    if (url.pathname === '/api/internal/canary/sessions') {
      return jsonResponse({
        contractVersion: 1,
        deploymentRevision: revision,
        sessions: [
          { slot: 'A', accessToken: tokenA, tokenType: 'bearer', expiresIn: 3600, email: 'canary-a@example.test', expectedOrganizationId: ids.orgA, expectedTenantId: ids.tenantA },
          { slot: 'B', accessToken: tokenB, tokenType: 'bearer', expiresIn: 3600, email: 'canary-b@example.test', expectedOrganizationId: ids.orgB, expectedTenantId: ids.tenantB },
        ],
      }, 201)
    }
    const authorization = init.headers?.Authorization
    const riskRoute = url.pathname.endsWith('/identity-signals/summary')
      ? 'summary'
      : url.pathname.endsWith('/identity-signals/findings')
        ? 'findings'
        : url.pathname.endsWith('/microsoft-entra-risky-users')
          ? 'microsoft'
          : null
    if (riskRoute && !authorization) {
      return jsonResponse({ message: 'Unauthorized' }, 401)
    }
    const own = authorization === `Bearer ${tokenA}`
      ? { email: 'canary-a@example.test', org: ids.orgA, tenant: ids.tenantA, foreign: ids.tenantB }
      : { email: 'canary-b@example.test', org: ids.orgB, tenant: ids.tenantB, foreign: ids.tenantA }
    if (riskRoute) {
      const relationship = url.pathname.includes(`/api/tenants/${own.tenant}/`)
        ? 'own'
        : url.pathname.includes(`/api/tenants/${own.foreign}/`)
          ? 'foreign'
          : 'unknown'
      const overridden = riskResponseOverride?.({
        authorization,
        relationship,
        route: riskRoute,
      })
      if (overridden) return overridden
      if (relationship === 'foreign') return jsonResponse({ message: 'Not found' }, 404)
      if (relationship === 'own') return jsonResponse(riskFixture(riskRoute))
    }
    if (url.pathname === '/auth/bootstrap') {
      return jsonResponse({ user: { email: own.email, memberships: [{ organization: { id: own.org } }] } }, 201)
    }
    if (url.pathname === '/api/tenants') return jsonResponse({ tenants: [{ id: own.tenant }] })
    if (url.pathname === `/api/tenants/${own.tenant}/onboarding`) return jsonResponse({ tenantId: own.tenant })
    if (url.pathname === `/api/tenants/${own.foreign}/onboarding`) return jsonResponse({ message: 'Not found' }, 404)
    throw new Error(`Unexpected test URL: ${url}`)
  }
  return { calls, fetchImpl }
}

test('accepts truthful no-source and unavailable v1 risk envelopes for two isolated MSPs', async () => {
  const { calls, fetchImpl } = successfulFetch()
  await runAuthenticatedCanary({
    fetchImpl,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token?api-version=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
  assert.equal(calls.filter(call => call.url.pathname === '/api/tenants').length, 2)
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/onboarding')).length, 4)
  assert.equal(calls.filter(call =>
    call.url.pathname.includes('/identity-signals/') ||
    call.url.pathname.endsWith('/microsoft-entra-risky-users')
  ).length, 15)
  assert.equal(calls.filter(call =>
    !call.init.headers?.Authorization &&
    (call.url.pathname.includes('/identity-signals/') ||
      call.url.pathname.endsWith('/microsoft-entra-risky-users'))).length, 3)
  assert.ok(calls.every(call => call.url.origin === API_ORIGIN || call.url.origin === 'https://oidc.example.test'))
})

test('accepts a completed HawkView evaluation with unavailable source evidence', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) =>
      relationship === 'own' && route !== 'microsoft'
        ? jsonResponse(completedUnavailableFixture(route))
        : null,
  })
  await runAuthenticatedCanary({
    fetchImpl,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
})

test('accepts coherent bounded AVAILABLE v1 envelopes', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) =>
      relationship === 'own' ? jsonResponse(availableFixture(route, freshnessNow)) : null,
  })
  await runAuthenticatedCanary({
    fetchImpl,
    now: () => freshnessNow,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
})

test('accepts a genuinely stale HawkView evaluation', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) =>
      relationship === 'own' && route !== 'microsoft'
        ? jsonResponse(staleHawkViewFixture(route, freshnessNow))
        : relationship === 'own'
          ? jsonResponse(availableFixture(route, freshnessNow))
          : null,
  })
  await runAuthenticatedCanary({
    fetchImpl,
    now: () => freshnessNow,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
})

test('accepts valid projected nonempty HawkView and Microsoft rows', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) => {
      if (relationship !== 'own') return null
      const response = availableFixture(route, freshnessNow)
      if (route === 'findings') response.findings = [findingFixture(freshnessNow)]
      if (route === 'microsoft') response.users = [microsoftUserFixture(freshnessNow)]
      return jsonResponse(response)
    },
  })
  await runAuthenticatedCanary({
    fetchImpl,
    now: () => freshnessNow,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
})

test('accepts independently valid HawkView responses across a run transition', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) =>
      relationship === 'own' && route === 'findings'
        ? jsonResponse(availableFixture(route, freshnessNow))
        : relationship === 'own' && route === 'microsoft'
          ? jsonResponse(availableFixture(route, freshnessNow))
          : null,
  })
  await runAuthenticatedCanary({
    fetchImpl,
    now: () => freshnessNow,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
})

test('rejects a 500 from an own-tenant identity-risk route', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? jsonResponse({ message: 'Unavailable' }, 500)
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary own tenant returned an unexpected status/,
  )
})

test('rejects a malformed 200 identity-risk envelope without exposing tenant IDs', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'findings'
        ? jsonResponse({ ...riskFixture('findings'), version: 2 })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    (error) => {
      assert.match(error.message, /identity risk findings version was invalid/)
      assert.doesNotMatch(error.message, new RegExp(ids.tenantA, 'i'))
      assert.doesNotMatch(error.message, new RegExp(ids.tenantB, 'i'))
      return true
    },
  )
})

test('rejects an own-tenant 200 identity-risk ERROR envelope', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? jsonResponse({ ...riskFixture('summary'), status: 'ERROR' })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary reported an error state/,
  )
})

test('rejects an exact zero count in a no-data summary', async () => {
  const invalid = riskFixture('summary')
  invalid.counts.openFindings = { value: 0, exact: true, capped: false }
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? jsonResponse(invalid)
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary counts did not match evaluation availability/,
  )
})

test('rejects an invalid row in an available findings response', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'findings'
        ? jsonResponse({ ...availableFixture('findings', freshnessNow), findings: [null] })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      now: () => freshnessNow,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk findings row 1 row was invalid/,
  )
})

test('rejects unprojected HawkView finding identities and catalog drift', async () => {
  const base = findingFixture(freshnessNow)
  const cases = [
    {
      name: 'raw identity UUID',
      finding: { ...base, affectedIdentity: { ...base.affectedIdentity, id: ids.tenantA } },
      expected: /identity projection was invalid/,
    },
    {
      name: 'wrong-kind opaque reference',
      finding: {
        ...base,
        affectedIdentity: {
          ...base.affectedIdentity,
          id: `hvr1_evidence_${'c'.repeat(64)}`,
        },
      },
      expected: /identity projection was invalid/,
    },
    {
      name: 'arbitrary identity label',
      finding: {
        ...base,
        affectedIdentity: { ...base.affectedIdentity, label: 'Provider user label' },
      },
      expected: /identity label was invalid/,
    },
    {
      name: 'unregistered rule',
      finding: { ...base, ruleIds: ['HV-ID-FAKE-999.v1'] },
      expected: /rules were invalid/,
    },
    {
      name: 'unregistered provider source',
      finding: { ...base, sourceLabels: ['Unregistered provider source'] },
      expected: /sources did not match the registered rule/,
    },
  ]
  for (const invalidCase of cases) {
    const { fetchImpl } = successfulFetch({
      riskResponseOverride: ({ authorization, relationship, route }) =>
        authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'findings'
          ? jsonResponse({
              ...availableFixture('findings', freshnessNow),
              findings: [invalidCase.finding],
            })
          : null,
    })
    await assert.rejects(
      runAuthenticatedCanary({
        fetchImpl,
        now: () => freshnessNow,
        environment: {
          EXPECTED_REVISION: revision,
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
        },
      }),
      invalidCase.expected,
      invalidCase.name,
    )
  }
})

test('rejects a raw Microsoft provider identity ID', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'microsoft'
        ? jsonResponse({
            ...availableFixture('microsoft', freshnessNow),
            users: [{ ...microsoftUserFixture(freshnessNow), id: ids.tenantA }],
          })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      now: () => freshnessNow,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /Microsoft Entra risky users row 1 id was invalid/,
  )
})

test('rejects an array containing an otherwise valid HawkView identity reference', async () => {
  const finding = findingFixture(freshnessNow)
  finding.affectedIdentity.id = [finding.affectedIdentity.id]
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) =>
      relationship === 'own' && route === 'findings'
        ? jsonResponse({ ...availableFixture(route), findings: [finding] })
        : null,
  })
  await assert.rejects(runAuthenticatedCanary({
    fetchImpl,
    now: () => freshnessNow,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  }), /identity projection was invalid/)
})

test('accepts a freshness boundary crossing within each own request timing window', async () => {
  for (const status of ['AVAILABLE', 'STALE']) {
    let clock = freshnessNow
    const { fetchImpl: baseFetch } = successfulFetch({
      riskResponseOverride: ({ authorization, relationship, route }) => {
        if (authorization !== `Bearer ${tokenA}` || relationship !== 'own' || route !== 'summary') return null
        const startedAt = clock
        clock += 2_000
        return jsonResponse({
          ...availableFixture(route, startedAt),
          status,
          freshness: status === 'AVAILABLE' ? 'CURRENT' : 'STALE',
          observedAt: new Date(startedAt - 36 * 60 * 60 * 1_000 + 1_000).toISOString(),
        })
      },
    })
    const fetchImpl = async (input, init) => {
      // Setup time cannot be reused as the observation time of later requests.
      if (new URL(String(input)).pathname === '/health') clock += 60_000
      return baseFetch(input, init)
    }
    await runAuthenticatedCanary({
      fetchImpl,
      now: () => clock,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    })
  }
})

test('rejects current freshness with null no-data timestamps', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'microsoft'
        ? jsonResponse({ ...riskFixture('microsoft'), freshness: 'CURRENT' })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /Microsoft Entra risky users state was contradictory/,
  )
})

test('rejects a future evaluated timestamp', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? jsonResponse({
            ...completedUnavailableFixture('summary'),
            evaluatedAt: '2999-01-01T00:00:00.000Z',
          })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      now: () => freshnessNow,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary timestamp was in the future/,
  )
})

test('rejects CURRENT evidence older than the 36-hour freshness boundary', async () => {
  const staleObservedAt = new Date(freshnessNow - 37 * 60 * 60 * 1_000).toISOString()
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? jsonResponse({
            ...availableFixture('summary', freshnessNow),
            observedAt: staleObservedAt,
          })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      now: () => freshnessNow,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary state was contradictory/,
  )
})

test('rejects HawkView STALE evidence within the 36-hour freshness boundary', async () => {
  const freshObservedAt = new Date(freshnessNow - 35 * 60 * 60 * 1_000).toISOString()
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? jsonResponse({
            ...staleHawkViewFixture('summary', freshnessNow),
            observedAt: freshObservedAt,
          })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      now: () => freshnessNow,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary state was contradictory/,
  )
})

test('rejects Microsoft envelope states the service does not emit', async () => {
  const invalidStates = [
    {
      name: 'stale',
      response: {
        ...availableFixture('microsoft', freshnessNow),
        status: 'STALE',
        observedAt: new Date(freshnessNow - 37 * 60 * 60 * 1_000).toISOString(),
        freshness: 'STALE',
        limitation: 'Microsoft Entra risky-user evidence is stale.',
      },
    },
    {
      name: 'partial available',
      response: {
        ...availableFixture('microsoft', freshnessNow),
        capability: 'PARTIAL',
        limitation: 'Partial Microsoft evidence.',
      },
    },
    {
      name: 'not evaluated',
      response: { ...riskFixture('microsoft'), status: 'NOT_EVALUATED' },
    },
  ]
  for (const invalidState of invalidStates) {
    const { fetchImpl } = successfulFetch({
      riskResponseOverride: ({ authorization, relationship, route }) =>
        authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'microsoft'
          ? jsonResponse(invalidState.response)
          : null,
    })
    await assert.rejects(
      runAuthenticatedCanary({
        fetchImpl,
        now: () => freshnessNow,
        environment: {
          EXPECTED_REVISION: revision,
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
        },
      }),
      /Microsoft Entra risky users state was contradictory/,
      invalidState.name,
    )
  }
})

test('accepts CURRENT evidence exactly at the 36-hour freshness boundary', async () => {
  const boundaryObservedAt = new Date(freshnessNow - 36 * 60 * 60 * 1_000).toISOString()
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ relationship, route }) =>
      relationship === 'own' && route !== 'microsoft'
        ? jsonResponse({
            ...availableFixture(route, freshnessNow),
            observedAt: boundaryObservedAt,
          })
        : null,
  })
  await runAuthenticatedCanary({
    fetchImpl,
    now: () => freshnessNow,
    environment: {
      EXPECTED_REVISION: revision,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
    },
  })
})

test('rejects an empty collection that claims another page', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'findings'
        ? jsonResponse({
            ...riskFixture('findings'),
            pageInfo: { hasMore: true, nextCursor: 'opaque.cursor' },
          })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk findings empty page claimed more results/,
  )
})

test('rejects a 200 risk response without a JSON content type', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'own' && route === 'summary'
        ? new Response(JSON.stringify(riskFixture('summary')), {
            status: 200,
            headers: { 'content-type': 'application/json-seq' },
          })
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary own tenant response was not JSON/,
  )
})

test('rejects a 200 response for a foreign identity-risk route', async () => {
  const { fetchImpl } = successfulFetch({
    riskResponseOverride: ({ authorization, relationship, route }) =>
      authorization === `Bearer ${tokenA}` && relationship === 'foreign' && route === 'summary'
        ? jsonResponse(riskFixture('summary'))
        : null,
  })
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /identity risk summary foreign tenant denial returned an unexpected status/,
  )
})

test('fails closed when an MSP receives the foreign tenant', async () => {
  const { fetchImpl: baseFetch } = successfulFetch()
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/tenants' && init?.headers?.Authorization === `Bearer ${tokenA}`) {
      return jsonResponse({ tenants: [{ id: ids.tenantB }] })
    }
    return baseFetch(input, init)
  }
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /tenant directory was not exactly isolated/,
  )
})

test('fails before authentication when the live revision differs', async () => {
  const { fetchImpl: baseFetch } = successfulFetch()
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/health') return jsonResponse({ status: 'ok', revision: 'b'.repeat(40) })
    return baseFetch(input, init)
  }
  await assert.rejects(
    runAuthenticatedCanary({
      fetchImpl,
      environment: {
        EXPECTED_REVISION: revision,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-oidc-request-token',
      },
    }),
    /expected API revision is not live/i,
  )
})
