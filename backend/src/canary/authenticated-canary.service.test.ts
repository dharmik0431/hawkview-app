import assert from 'node:assert/strict'
import test from 'node:test'
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import {
  AuthenticatedCanaryService,
  canaryConfigurationFromEnvironment,
  parseCanaryIssueBody,
} from './authenticated-canary.service.js'

const revision = 'c'.repeat(40)
const identityA = {
  authUserId: '11111111-1111-4111-8111-111111111111',
  email: 'canary-a@example.test',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: 'abababab-abab-4bab-8bab-abababababab',
}
const identityB = {
  authUserId: '22222222-2222-4222-8222-222222222222',
  email: 'canary-b@example.test',
  organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tenantId: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc',
}

function environment(overrides: Record<string, string> = {}) {
  return {
    HAWKVIEW_CANARY_ENABLED: 'true',
    SUPABASE_URL: 'https://projectref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-never-real',
    HAWKVIEW_CANARY_A_AUTH_USER_ID: identityA.authUserId,
    HAWKVIEW_CANARY_A_EMAIL: identityA.email,
    HAWKVIEW_CANARY_A_ORGANIZATION_ID: identityA.organizationId,
    HAWKVIEW_CANARY_A_TENANT_ID: identityA.tenantId,
    HAWKVIEW_CANARY_B_AUTH_USER_ID: identityB.authUserId,
    HAWKVIEW_CANARY_B_EMAIL: identityB.email,
    HAWKVIEW_CANARY_B_ORGANIZATION_ID: identityB.organizationId,
    HAWKVIEW_CANARY_B_TENANT_ID: identityB.tenantId,
    ...overrides,
  }
}

test('canary configuration is disabled by default and requires isolated fixtures', () => {
  assert.throws(
    () => canaryConfigurationFromEnvironment({}),
    error => error instanceof NotFoundException,
  )
  assert.throws(
    () =>
      canaryConfigurationFromEnvironment(
        environment({ HAWKVIEW_CANARY_B_ORGANIZATION_ID: identityA.organizationId }),
      ),
    /not isolated/,
  )
  assert.throws(
    () => canaryConfigurationFromEnvironment(environment({ SUPABASE_URL: 'http://projectref.supabase.co' })),
    /configuration is invalid/,
  )
})

test('canary request accepts one exact deployment revision only', () => {
  assert.equal(parseCanaryIssueBody({ deploymentRevision: revision.toUpperCase() }), revision)
  assert.throws(() => parseCanaryIssueBody({ deploymentRevision: revision, extra: true }), /Invalid canary request/)
  assert.throws(() => parseCanaryIssueBody({ deploymentRevision: 'short' }), /Invalid canary request/)
  assert.throws(() => parseCanaryIssueBody(Object.create({ deploymentRevision: revision })), /Invalid canary request/)
})

test('issues only bounded short-lived sessions for two verified synthetic fixtures', async () => {
  const originalFetch = globalThis.fetch
  const originalEnvironment = { ...process.env }
  const oidcCalls: Array<[string, string]> = []
  const adminPasswords: string[] = []
  const signInEmails: string[] = []
  try {
    Object.assign(process.env, environment(), { RENDER_GIT_COMMIT: revision })
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: { authProviderUserId: string } }) => {
          const identity = where.authProviderUserId === identityA.authUserId ? identityA : identityB
          return {
            email: identity.email,
            disabledAt: null,
            memberships: [{
              organizationId: identity.organizationId,
              role: 'MSP_OWNER',
              status: 'ACTIVE',
              organization: { status: 'ACTIVE' },
            }],
          }
        },
      },
      membership: {
        count: async () => 1,
      },
      customerTenant: {
        findMany: async ({ where }: { where: { organizationId: string } }) => {
          const identity = where.organizationId === identityA.organizationId ? identityA : identityB
          return [{
            id: identity.tenantId,
            status: 'PENDING',
            connection: {
              status: 'PENDING_CONSENT',
              connectionMode: 'HAWKVIEW_MANAGED',
              clientId: null,
              credentialReference: null,
              consentedPermissions: [],
              consentedAt: null,
              onboardingCompletedAt: null,
            },
          }]
        },
      },
    }
    const oidc = {
      verify: async (token: string, expectedRevision: string) => {
        oidcCalls.push([token, expectedRevision])
      },
    }
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input))
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      if (url.pathname.includes('/admin/users/')) {
        assert.equal(init.method, 'PUT')
        assert.match(String(init.headers && (init.headers as Record<string, string>).Authorization), /^Bearer /)
        adminPasswords.push(String(body.password))
        return new Response(JSON.stringify({ id: url.pathname.split('/').at(-1) }), { status: 200 })
      }
      assert.equal(url.pathname, '/auth/v1/token')
      assert.equal(url.searchParams.get('grant_type'), 'password')
      const identity = body.email === identityA.email ? identityA : identityB
      signInEmails.push(String(body.email))
      return new Response(JSON.stringify({
        access_token: `${identity.authUserId}.${'x'.repeat(120)}.token`,
        refresh_token: 'must-not-leave-backend',
        token_type: 'bearer',
        expires_in: 3600,
        user: { id: identity.authUserId, email: identity.email },
      }), { status: 200 })
    }

    const service = new AuthenticatedCanaryService(prisma as never, oidc as never)
    const result = await service.issueSessions(
      `Bearer oidc.${'z'.repeat(120)}.token`,
      { deploymentRevision: revision },
    )
    assert.equal(result.contractVersion, 1)
    assert.equal(result.deploymentRevision, revision)
    assert.deepEqual(result.sessions.map(session => session.slot), ['A', 'B'])
    assert.deepEqual(signInEmails, [identityA.email, identityB.email])
    assert.equal(adminPasswords.length, 4)
    assert.equal(new Set(adminPasswords).size, 4)
    assert.deepEqual(oidcCalls, [[`oidc.${'z'.repeat(120)}.token`, revision]])
    assert.equal(JSON.stringify(result).includes('refresh_token'), false)
    assert.equal(JSON.stringify(result).includes('must-not-leave-backend'), false)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key]
    }
    Object.assign(process.env, originalEnvironment)
  }
})

test('rejects fixtures that are shared or connected to Microsoft', async () => {
  const originalEnvironment = { ...process.env }
  try {
    Object.assign(process.env, environment(), { RENDER_GIT_COMMIT: revision })
    const baseUser = {
      email: identityA.email,
      disabledAt: null,
      memberships: [{
        organizationId: identityA.organizationId,
        role: 'MSP_OWNER',
        status: 'ACTIVE',
        organization: { status: 'ACTIVE' },
      }],
    }
    const connectedTenant = {
      id: identityA.tenantId,
      status: 'ACTIVE',
      connection: {
        status: 'CONNECTED',
        connectionMode: 'HAWKVIEW_MANAGED',
        clientId: null,
        credentialReference: null,
        consentedPermissions: ['Organization.Read.All'],
        consentedAt: new Date(),
        onboardingCompletedAt: null,
      },
    }
    const service = new AuthenticatedCanaryService({
      user: { findUnique: async () => baseUser },
      membership: { count: async () => 2 },
      customerTenant: { findMany: async () => [connectedTenant] },
    } as never, { verify: async () => undefined } as never)

    await assert.rejects(
      service.issueSessions(`Bearer oidc.${'z'.repeat(120)}.token`, { deploymentRevision: revision }),
      /synthetic canary fixture is not isolated/,
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key]
    }
    Object.assign(process.env, originalEnvironment)
  }
})

test('rejects a session request for a revision that is not live', async () => {
  const originalEnvironment = { ...process.env }
  Object.assign(process.env, environment(), { RENDER_GIT_COMMIT: 'd'.repeat(40) })
  try {
    const service = new AuthenticatedCanaryService({} as never, {} as never)
    await assert.rejects(
      service.issueSessions('Bearer token', { deploymentRevision: revision }),
      error => error instanceof ServiceUnavailableException,
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key]
    }
    Object.assign(process.env, originalEnvironment)
  }
})
