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
    existingUserState?: 'PENDING' | 'ACCEPTED' | 'DISABLED' | 'LEGACY'
    initialAuditFailure?: boolean
    membershipFailure?: boolean
    memberState?: 'PENDING' | 'ACCEPTED' | 'SUSPENDED' | 'DISABLED'
    crossOrganization?: boolean } = {}) {
  let membershipWrites = 0
  let userWrites = 0
  let auditAttempts = 0
  const audits: Array<{ data: Record<string, unknown> }> = []
  const email = 'fourth@example.com'
  const existingUserState = options.existingUserState ??
    (options.existingPendingUser ? 'PENDING' : undefined)
  const pendingUser = existingUserState
    ? {
        id: 'user-four',
        email,
        displayName: 'Fourth member',
        authProviderUserId: existingUserState === 'LEGACY' ? null : 'auth-user-four',
        disabledAt:
          existingUserState === 'DISABLED'
            ? new Date('2026-08-28T12:30:00.000Z')
            : null,
        inviteSentAt: new Date('2026-08-28T11:00:00.000Z'),
        inviteAcceptedAt:
          existingUserState === 'ACCEPTED'
            ? new Date('2026-08-28T12:30:00.000Z')
            : null,
        createdAt: new Date('2026-08-28T11:00:00.000Z'),
      }
    : null
  const baseMember = memberRecord(email)
  const managedMember = {
    ...baseMember,
    status: options.memberState === 'SUSPENDED' ? 'SUSPENDED' : baseMember.status,
    user: {
      ...baseMember.user,
      inviteAcceptedAt:
        options.memberState === 'ACCEPTED'
          ? new Date('2026-08-28T13:00:00.000Z')
          : null as Date | null,
      disabledAt:
        options.memberState === 'DISABLED'
          ? new Date('2026-08-28T13:00:00.000Z')
          : null as Date | null,
    },
  }
  const membership = {
    findFirst: async () => options.crossOrganization ? null : managedMember,
    upsert: async () => {
      membershipWrites += 1
      if (options.membershipFailure)
        throw new Error('database detail must not escape')
      return managedMember
    },
  }
  const workspaceAdminAuditLog = {
    create: async (entry: { data: Record<string, unknown> }) => {
      auditAttempts += 1
      if (options.initialAuditFailure && auditAttempts === 1) {
        throw new Error('audit storage unavailable')
      }
      audits.push(entry)
      return entry
    },
  }
  const user = {
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
      update: async ({ data }: { data: Record<string, unknown> }) => {
        userWrites += 1
        return { ...managedMember.user, ...data }
      },
  }
  const prisma = {
    user,
    membership,
    workspaceAdminAuditLog,
    $transaction: async <T>(
      callback: (client: {
        membership: typeof membership
        user: typeof user
        workspaceAdminAuditLog: typeof workspaceAdminAuditLog
      }) => Promise<T>
    ) => callback( { membership, user,
    workspaceAdminAuditLog }),
  } as unknown as PrismaService

  return {
    service: new WorkspaceService(prisma),
    counts: () => ({ auditAttempts, membershipWrites, userWrites }),
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

async function resend(service: WorkspaceService) {
  return service.resendMemberInvitation(identity, 'membership-four', {
    organizationId,
  })
}

async function passwordReset(service: WorkspaceService) {
  return service.sendPasswordReset(identity, 'membership-four', {
    organizationId,
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

  assert.equal(result.accepted, true)
  assert.equal(result.delivery, 'INVITE')
  assert.deepEqual(requestedPaths, ['/auth/v1/invite'])
  assert.deepEqual(subject.counts(), { auditAttempts: 3, membershipWrites: 1, userWrites: 1 })
  assert.deepEqual(
    subject.audits.map((entry) => entry.data.action),
    [
      'WORKSPACE_MEMBER_INVITE_REQUESTED',
      'WORKSPACE_MEMBER_INVITE_PROVIDER_RESOLVED',
      'WORKSPACE_MEMBER_INVITE_REQUEST_RESOLVED',
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
  assert.deepEqual(subject.counts(), { auditAttempts: 2, membershipWrites: 0, userWrites: 0 })
  assert.deepEqual(
    subject.audits.map((entry) => entry.data.action),
    ['WORKSPACE_MEMBER_INVITE_REQUESTED', 'WORKSPACE_MEMBER_INVITE_FAILED']
  )
  assert.equal(subject.audits.at(-1)?.data.errorCode, 'AUTH_EMAIL_RATE_LIMITED')
  assert.doesNotMatch(
    JSON.stringify(subject.audits),
    /fourth@example|provider detail/i)
})

test('the email-address invite endpoint accepts an existing account without local mutation', async () => {
  configureEnvironment()
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls += 1
    return new Response(JSON.stringify({ id: 'auth-user-four' }), { status: 200 })
  }
  const subject = fixture({ existingPendingUser: true })

  const result = await invite(subject.service)

  assert.deepEqual(
    { accepted: result.accepted, delivery: result.delivery },
    { accepted: true, delivery: 'INVITE' }
  )
  assert.equal(providerCalls, 1)
  assert.deepEqual(subject.counts(), { auditAttempts: 3, membershipWrites: 0, userWrites: 0 })
  assert.deepEqual(
    subject.audits.map((entry) => entry.data.action),
    [
      'WORKSPACE_MEMBER_INVITE_REQUESTED',
      'WORKSPACE_MEMBER_INVITE_PROVIDER_RESOLVED',
      'WORKSPACE_MEMBER_INVITE_REQUEST_RESOLVED',
    ]
  )
  assert.equal(subject.audits.at(-1)?.data.targetUserId, null)
})

test('ordinary invite has one generic response and audit contract for new and existing accounts', async () => {
  configureEnvironment()
  const responses: Array<{ accepted: boolean; delivery: string }> = []
  const auditContracts: string[] = []
  let providerCalls = 0

  for (const existingUserState of [undefined, 'PENDING', 'ACCEPTED', 'DISABLED', 'LEGACY'] as const) {
    globalThis.fetch = async () => {
      providerCalls += 1
      return existingUserState === 'ACCEPTED'
        ? new Response(JSON.stringify({ code: 'email_exists', message: 'private detail' }), {
            status: 422,
          })
        : new Response(JSON.stringify({ id: 'auth-user-four' }), { status: 200 })
    }
    const subject = fixture({ existingUserState })
    const result = await invite(subject.service)
    responses.push({ accepted: result.accepted, delivery: result.delivery })
    auditContracts.push(
      JSON.stringify(
        subject.audits.map((entry) => ({
          action: entry.data.action,
          outcome: entry.data.outcome,
          stage: entry.data.stage,
          targetUserId: entry.data.targetUserId,
          metadata: entry.data.metadata,
        }))
      )
    )
  }

  assert.equal(providerCalls, 5)
  assert.equal(new Set(responses.map((response) => JSON.stringify(response))).size, 1)
  assert.equal(new Set(auditContracts).size, 1)
  assert.doesNotMatch(
    JSON.stringify({ responses, auditContracts }),
    /disabled|pending|legacy|private detail/i
  )
})

test('only the exact provider email-exists contract is privacy-normalized', async () => {
  configureEnvironment()
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 'unexpected_provider_error', message: 'private detail' }), {
      status: 422,
    })
  const subject = fixture({ existingUserState: 'ACCEPTED' })

  await assert.rejects(() => invite(subject.service), /could not be completed/i)
  assert.deepEqual(subject.counts(), { auditAttempts: 2, membershipWrites: 0, userWrites: 0 })
  assert.doesNotMatch(JSON.stringify(subject.audits), /private detail|unexpected_provider_error/i)
})

test('a pending or expired member receives a fresh invitation without role or status mutation', async () => {
  configureEnvironment()
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    return new Response(JSON.stringify({ id: 'auth-user-four' }), { status: 200 })
  }
  const subject = fixture({ memberState: 'PENDING' })

  const result = await resend(subject.service)

  assert.equal(result.delivery, 'INVITE_RESEND')
  assert.deepEqual(requests.map((request) => request.path), ['/auth/v1/invite'])
  assert.equal(requests[0].body.redirect_to, 'https://console.hawkviewapp.com/auth/confirm')
  assert.doesNotMatch(JSON.stringify(requests), /recover|password/i)
  assert.equal(result.member.role, 'MSP_VIEWER')
  assert.equal(result.member.status, 'ACTIVE')
  assert.equal(result.member.hasHawkViewAccount, false)
  assert.deepEqual(subject.counts(), { auditAttempts: 3, membershipWrites: 0, userWrites: 1 })
  assert.deepEqual(
    subject.audits.map((entry) => entry.data.action),
    [
      'WORKSPACE_MEMBER_INVITE_RESEND_REQUESTED',
      'WORKSPACE_MEMBER_INVITE_RESEND_PROVIDER_ACCEPTED',
      'WORKSPACE_MEMBER_INVITATION_RESENT',
    ]
  )
  assert.equal(
    new Set(subject.audits.map((entry) => entry.data.operationId)).size,
    1
  )
})

test('resend rate limiting is safe and leaves invitation state unchanged', async () => {
  configureEnvironment()
  globalThis.fetch = async () => new Response(null, { status: 429 })
  const subject = fixture({ memberState: 'PENDING' })

  await assert.rejects(
    () => resend(subject.service),
    (error: unknown) => {
      const candidate = error as { getStatus?: () => number; getResponse?: () => unknown }
      assert.equal(candidate.getStatus?.(), 429)
      assert.equal((candidate.getResponse?.() as { code?: unknown }).code, 'AUTH_EMAIL_RATE_LIMITED')
      return true
    }
  )
  assert.deepEqual(subject.counts(), { auditAttempts: 2, membershipWrites: 0, userWrites: 0 })
  assert.equal(subject.audits.at(-1)?.data.action, 'WORKSPACE_MEMBER_INVITE_RESEND_FAILED')
  assert.equal(subject.audits.at(-1)?.data.errorCode, 'AUTH_EMAIL_RATE_LIMITED')
})

test('an unavailable resend intent audit fails closed before the provider call', async () => {
  configureEnvironment()
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls += 1
    return new Response(null, { status: 200 })
  }
  const subject = fixture({ memberState: 'PENDING', initialAuditFailure: true })

  await assert.rejects(() => resend(subject.service), /audit storage unavailable/)
  assert.equal(providerCalls, 0)
  assert.deepEqual(subject.counts(), { auditAttempts: 1, membershipWrites: 0, userWrites: 0 })
  assert.deepEqual(subject.audits, [])
})

test('provider resend failure never falls back to recovery or changes local state', async () => {
  configureEnvironment()
  const paths: string[] = []
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input)).pathname)
    return new Response(JSON.stringify({ message: 'private provider detail' }), { status: 500 })
  }
  const subject = fixture({ memberState: 'PENDING' })

  await assert.rejects(() => resend(subject.service), /could not be completed/i)
  assert.deepEqual(paths, ['/auth/v1/invite'])
  assert.deepEqual(subject.counts(), { auditAttempts: 2, membershipWrites: 0, userWrites: 0 })
  assert.doesNotMatch(JSON.stringify(subject.audits), /private provider detail|fourth@example/i)
})

test('accepted, suspended, and disabled members cannot receive a resent invitation', async () => {
  configureEnvironment()
  for (const memberState of ['ACCEPTED', 'SUSPENDED', 'DISABLED'] as const) {
    let providerCalls = 0
    globalThis.fetch = async () => {
      providerCalls += 1
      return new Response(null, { status: 200 })
    }
    const subject = fixture({ memberState })
    await assert.rejects(
      () => resend(subject.service),
      (error: unknown) => {
        const candidate = error as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(candidate.getStatus?.(), 409)
        assert.equal(
          (candidate.getResponse?.() as { code?: unknown }).code,
          'INVITATION_NOT_PENDING'
        )
        return true
      }
    )
    assert.equal(providerCalls, 0)
    assert.deepEqual(subject.counts(), { auditAttempts: 2, membershipWrites: 0, userWrites: 0 })
  }
})

test('cross-organization resend fails before provider or audit side effects', async () => {
  configureEnvironment()
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls += 1
    return new Response(null, { status: 200 })
  }
  const subject = fixture({ crossOrganization: true })

  await assert.rejects(() => resend(subject.service), /not found/i)
  assert.equal(providerCalls, 0)
  assert.deepEqual(subject.counts(), { auditAttempts: 0, membershipWrites: 0, userWrites: 0 })
})

test('password reset is blocked for pending invitations and remains separate for accepted accounts', async () => {
  configureEnvironment()
  const paths: string[] = []
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input)).pathname)
    return new Response(null, { status: 200 })
  }

  const pending = fixture({ memberState: 'PENDING' })
  await assert.rejects(
    () => passwordReset(pending.service),
    (error: unknown) => {
      const candidate = error as { getStatus?: () => number; getResponse?: () => unknown }
      assert.equal(candidate.getStatus?.(), 409)
      assert.equal(
        (candidate.getResponse?.() as { code?: unknown }).code,
        'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT'
      )
      return true
    }
  )
  assert.deepEqual(paths, [])
  assert.equal(pending.audits.at(-1)?.data.stage, 'REQUEST_VALIDATION')
  assert.equal(
    pending.audits.at(-1)?.data.errorCode,
    'PASSWORD_RESET_REQUIRES_ACCEPTED_ACCOUNT'
  )

  const accepted = fixture({ memberState: 'ACCEPTED' })
  const result = await passwordReset(accepted.service)
  assert.equal(result.sent, true)
  assert.deepEqual(paths, ['/auth/v1/recover'])
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
        'WORKSPACE_MEMBER_INVITE_PROVIDER_RESOLVED',
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

test('an unavailable initial audit write fails closed before Supabase or local persistence', async () => {
  configureEnvironment()
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls += 1
    return new Response(JSON.stringify({ id: 'auth-user-four' }), { status: 200 })
  }
  const subject = fixture({ initialAuditFailure: true })

  await assert.rejects(() => invite(subject.service), /audit storage unavailable/)

  assert.equal(providerCalls, 0)
  assert.deepEqual(subject.counts(), {
    auditAttempts: 1,
    membershipWrites: 0,
    userWrites: 0,
  })
  assert.deepEqual(subject.audits, [])
})
