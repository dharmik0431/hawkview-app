import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceService } from './workspace.service.js'

const identity = {
  subject: '11111111-2222-4333-8444-555555555555',
  email: 'owner@example.test',
  assuranceLevel: 'aal2' as const,
}
const organizationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function fixture(targetUserId = 'target-user') {
  const auditEntries: unknown[] = []
  const membershipQueries: unknown[] = []
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'actor-user',
        email: identity.email,
        disabledAt: null,
        memberships: [
          {
            organization: {
              id: organizationId,
              name: 'MSP A',
              businessDomain: null,
              timeZone: null,
              onboardingCompletedAt: new Date(),
            },
          },
        ],
      }),
    },
    membership: {
      findFirst: async (query: unknown) => {
        membershipQueries.push(query)
        return {
          id: 'membership-target',
          userId: targetUserId,
          organizationId,
          role: 'MSP_TECHNICIAN',
          status: 'ACTIVE',
          user: {
            id: targetUserId,
            email: 'member@example.test',
            displayName: 'Member',
            authProviderUserId: 'auth-target-user',
            disabledAt: null,
            inviteSentAt: null,
            inviteAcceptedAt: new Date(),
            createdAt: new Date(),
          },
        }
      },
    },
    workspaceAdminAuditLog: {
      create: async (entry: unknown) => {
        auditEntries.push(entry)
        return entry
      },
    },
  }
  return {
    service: new WorkspaceService(prisma as never),
    auditEntries,
    membershipQueries,
  }
}

test('an MSP owner resets every factor only for a member in the selected workspace', async () => {
  const previousUrl = process.env.SUPABASE_URL
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const previousFetch = globalThis.fetch
  process.env.SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret'
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input)
    requests.push({ url, method: init?.method || 'GET' })
    if (init?.method === 'GET') {
      return new Response(
        JSON.stringify({ factors: [{ id: 'factor-1' }, { id: 'factor-2' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    }
    return new Response(null, { status: 204 })
  }) as typeof fetch

  try {
    const { service, auditEntries, membershipQueries } = fixture()
    const result = await service.resetHawkViewMfa(
      identity,
      'membership-target',
      { organizationId }
    )
    assert.equal(result.factorsRemoved, 2)
    assert.match(result.operationId, /^[0-9a-f-]{36}$/i)
    assert.match(result.requestId, /^[0-9a-f-]{36}$/i)
    assert.deepEqual(
      requests.map(({ method }) => method),
      ['GET', 'DELETE', 'DELETE']
    )
    assert.match(requests[1].url, /auth-target-user\/factors\/factor-1$/)
    const membershipQuery = membershipQueries[0] as {
      where: { id: string; organizationId: string }
      include: unknown
    }
    assert.deepEqual(membershipQuery.where, {
      id: 'membership-target',
      organizationId,
    })
    assert.ok(membershipQuery.include)
    assert.equal(auditEntries.length, 2)
    assert.equal(
      (auditEntries[1] as { data: { action: string } }).data.action,
      'HAWKVIEW_MFA_RESET'
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
  }
})

test('the owner administration endpoint refuses self-service MFA reset', async () => {
  const previousFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = (async () => {
    fetchCalled = true
    throw new Error('unexpected fetch')
  }) as typeof fetch
  try {
    const { service } = fixture('actor-user')
    await assert.rejects(
      service.resetHawkViewMfa(identity, 'membership-target', {
        organizationId,
      }),
      /Use Account & Security to manage your own HawkView authenticators/
    )
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = previousFetch
  }
})
