import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { WorkspaceService } from './workspace.service.js'

const identity: AuthenticatedIdentity = {
  subject: '11111111-2222-3333-4444-555555555555',
  email: 'owner@example.com',
}
const organizationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const originalFetch = globalThis.fetch
const originalSupabaseUrl = process.env.SUPABASE_URL
const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const originalRedirectUrl = process.env.HAWKVIEW_AUTH_REDIRECT_URL

function configureEnvironment() {
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  process.env.HAWKVIEW_AUTH_REDIRECT_URL = 'https://console.hawkviewapp.com/auth/confirm'
}

test.after(() => {
  globalThis.fetch = originalFetch
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL
  else process.env.SUPABASE_URL = originalSupabaseUrl
  if (originalServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey
  if (originalRedirectUrl === undefined) delete process.env.HAWKVIEW_AUTH_REDIRECT_URL
  else process.env.HAWKVIEW_AUTH_REDIRECT_URL = originalRedirectUrl
})

function memberRecord(email: string) {
  return {
    id: 'membership-four',
    userId: 'user-four',
    organizationId,
    role: 'MSP_VIEWER',
    status: 'ACTIVE',
    user: {
      id: 'user-four',
      email,
      displayName: 'Fourth member',
      authProviderUserId: 'auth-user-four',
      disabledAt: null,
      inviteSentAt: new Date('2026-08-28T12:00:00.000Z'),
      inviteAcceptedAt: null,
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
    },
  }
}

function fixture(options: { existingPendingUser?: boolean
    membershipFailure?: boolean } = {}) {
  let membershipWrites = 0
  let userWrites = 0
  const audits: Array<{ data: Record<string, unknown> }> = []
  const email = 'fourth@example.com'
  const pendingUser = options.existingPendingUser
    ? {
        id: 'user-four',
        email,
        displayName: 'Fourth member',
        authProviderUserId: 'auth-user-four',
        disabledAt: null,
        inviteSentAt: new Date('2026-08-28T11:00:00.000Z'),
        inviteAcceptedAt: null,
        createdAt: new Date('2026-08-28T11:00:00.000Z'),
      }
    : null
  const membership = {
    upsert: async () => {
      membershipWrites += 1
      if (options.membershipFailure)
        throw new Error('database detail must not escape')
      return memberRecord(email)
    },
  }
  const workspaceAdminAuditLog = {
    create: async (entry: { data: Record<string, unknown> }) => {
      audits.push(entry)
      return entry
    },
  }
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        if (Object.prototype.hasOwnProperty.call(where, 'authProviderUserId')) {
          return {
            id: 'owner-user',
            email: identity.email,
            disabledAt: null,
            memberships: [
              {
                organization: {
                  id: organizationId,
                  name: 'Example MSP',
                  businessDomain: 'example.com',
                  timeZone: 'America/Toronto',
                  onboardingCompletedAt: new Date('2026-08-01T00:00:00.000Z'),
                },
              },
            ],
          }
        }
        return pendingUser
      },
      create: async () => {
        userWrites += 1
        return memberRecord(email).user
      },
      update: async () => {
        userWrites += 1
        return memberRecord(email).user
      },
    },
    membership,
    workspaceAdminAuditLog,
    $transaction: async <T>(
      callback: (client: {
        membership: typeof membership
        workspaceAdminAuditLog: typeof workspaceAdminAuditLog
      }) => Promise<T>
    ) => callback( { membership,
    workspaceAdminAuditLog }),
  } as unknown as PrismaService

  return {
    service: new WorkspaceService(prisma),
    counts: () => ({ membershipWrites, userWrites }),
    audits,
  }
}

async function invite(service: WorkspaceService) {
  return service.inviteMember(identity, {
    organizationId,
    email: 'fourth@example.com',
    displayName: 'Fourth member',
    role: 'MSP_VIEWER',
  })
}

test('a fourth workspace member is allowed when the authentication provider accepts the email', async () => {
  configureEnvironment()
  const requestedPaths: string[] = []
  globalThis.fetch = async (input) => {
    requestedPaths.push(new URL(String(input)).pathname)
    return new Response(JSON.stringify({ id: 'auth-user-four' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const subject = fixture()

  const result = await invite(subject.service)

  assert.equal(result.delivery, 'INVITE')
  assert.deepEqual(requestedPaths, ['/auth/v1/invite'])
  assert.deepEqual(subject.counts(), { membershipWrites: 1, userWrites: 1 })
  assert.deepEqual(
    subject.audits.map((entry) => entry.data.action),
    [
      'WORKSPACE_MEMBER_INVITE_REQUESTED',
      'WORKSPACE_MEMBER_INVITE_PROVIDER_ACCEPTED',
      'WORKSPACE_MEMBER_INVITED',
    ]
  )
  assert.equal(
    new Set(subject.audits.map((entry) => entry.data.operationId)).size,
    1
  )
  assert.equal(subject.audits.at(-1)?.data.outcome, 'SUCCEEDED')
})

test('invite email rate limiting returns a safe stable API contract and performs no local writes', async () => {
  configureEnvironment()
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: 'provider detail must not escape' }), { status: 429 })
  const subject = fixture()

  await assert.rejects(
    () => invite(subject.service),
    (error: unknown) => {
      assert.equal(typeof error, 'object')
      const candidate = error as { getStatus?: () => number; getResponse?: () => unknown }
      assert.equal(candidate.getStatus?.(), 429)
      assert.deepEqual(candidate.getResponse?.(), {
        statusCode: 429,
        code: 'AUTH_EMAIL_RATE_LIMITED',
        message:
          'Authentication email sending is temporarily rate-limited. Please wait a few minutes and try again.',
      })
      assert.doesNotMatch(JSON.stringify(candidate.getResponse?.()), /provider detail/i)
      return true
    }
  )
  assert.deepEqual(subject.counts(), { membershipWrites: 0, userWrites: 0 })
  assert.deepEqual(
    subject.audits.map((entry) => entry.data.action),
    ['WORKSPACE_MEMBER_INVITE_REQUESTED', 'WORKSPACE_MEMBER_INVITE_FAILED']
  )
  assert.equal(subject.audits.at(-1)?.data.errorCode, 'AUTH_EMAIL_RATE_LIMITED')
  assert.doesNotMatch(
    JSON.stringify(subject.audits),
    /fourth@example|provider detail/i)
})

test('pending-member setup email rate limiting uses the same safe contract and performs no local writes', async () => {
  configureEnvironment()
  let requestedPath = ''
  globalThis.fetch = async (input) => {
    requestedPath = new URL(String(input)).pathname
    return new Response(null, { status: 429 })
  }
  const subject = fixture({ existingPendingUser: true })

  await assert.rejects(
    () => invite(subject.service),
    (error: unknown) => {
      const candidate = error as { getStatus?: () => number; getResponse?: () => unknown }
      assert.equal(candidate.getStatus?.(), 429)
      assert.equal((candidate.getResponse?.() as { code?: unknown }).code, 'AUTH_EMAIL_RATE_LIMITED')
      return true
    }
  )
  assert.equal(requestedPath, '/auth/v1/recover')
  assert.deepEqual(subject.counts(), { membershipWrites: 0, userWrites: 0 })
  assert.equal(subject.audits.at(-1)?.data.errorCode, 'AUTH_EMAIL_RATE_LIMITED')
})

test('provider acceptance remains durably provable when membership persistence fails', async () => {
  configureEnvironment()
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id: 'auth-user-four' }), { status: 200 })
  const subject = fixture({ membershipFailure: true })

  await assert.rejects(() => invite(subject.service), /database detail/)

  assert.deepEqual(
    subject.audits.map((entry) => [
      entry.data.action,
      entry.data.outcome,
      entry.data.stage,
    ]),
    [
      ['WORKSPACE_MEMBER_INVITE_REQUESTED', 'STARTED', 'REQUEST_ACCEPTED'],
      [
        'WORKSPACE_MEMBER_INVITE_PROVIDER_ACCEPTED',
        'SUCCEEDED',
        'AUTH_PROVIDER',
      ],
      ['WORKSPACE_MEMBER_INVITE_FAILED', 'FAILED', 'MEMBERSHIP_PERSISTENCE'],
    ]
  )
  assert.equal(
    subject.audits.at(-1)?.data.errorCode,
    'WORKSPACE_OPERATION_FAILED'
  )
  assert.doesNotMatch(
    JSON.stringify(subject.audits),
    /database detail|fourth@example/i
  )
})
