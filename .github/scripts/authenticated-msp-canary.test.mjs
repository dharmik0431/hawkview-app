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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function successfulFetch() {
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
    const own = authorization === `Bearer ${tokenA}`
      ? { email: 'canary-a@example.test', org: ids.orgA, tenant: ids.tenantA, foreign: ids.tenantB }
      : { email: 'canary-b@example.test', org: ids.orgB, tenant: ids.tenantB, foreign: ids.tenantA }
    if (url.pathname === '/auth/bootstrap') {
      return jsonResponse({ user: { email: own.email, memberships: [{ organization: { id: own.org } }] } })
    }
    if (url.pathname === '/api/tenants') return jsonResponse({ tenants: [{ id: own.tenant }] })
    if (url.pathname === `/api/tenants/${own.tenant}/onboarding`) return jsonResponse({ tenantId: own.tenant })
    if (url.pathname === `/api/tenants/${own.foreign}/onboarding`) return jsonResponse({ message: 'Not found' }, 404)
    throw new Error(`Unexpected test URL: ${url}`)
  }
  return { calls, fetchImpl }
}

test('checks two exact MSP identities, own tenants, and foreign denial', async () => {
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
  assert.ok(calls.every(call => call.url.origin === API_ORIGIN || call.url.origin === 'https://oidc.example.test'))
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
