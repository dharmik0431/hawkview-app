import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { WorkspaceService } from './workspace.service.js'

/**
 * Explicit administrator account recovery.
 *
 * The state under test is the one with no supported route before this action
 * existed: a member who never completed HawkView account setup, whose email
 * already has a sign-in account at the authentication provider. `sendPasswordReset`
 * refuses them by design, and resend refuses because the provider reports the
 * address is already registered.
 *
 * The hinge property is honesty about delivery. The provider answers HTTP 200
 * with an empty body for an address it cannot find — deliberately, to prevent
 * account enumeration — so a 2xx proves the request was accepted and proves
 * nothing about an email arriving. Every assertion below that forbids "sent"
 * wording exists because the opposite mistake is what this incident is about.
 */

const identity: AuthenticatedIdentity = {
  subject: '11111111-2222-3333-4444-555555555555',
  email: 'owner@example.com',
}
const organizationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const memberEmail = 'pending@example.com'

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

type Options = {
  /** 'PENDING' is the state this action exists for. */
  memberState?: 'PENDING' | 'ACCEPTED' | 'DISABLED' | 'SUSPENDED'
  /** No provider id is the realistic case: the colliding invite never captured one. */
  withProviderId?: boolean
  crossOrganization?: boolean
  notAnOwner?: boolean
  initialAuditFailure?: boolean
  /** 1-based audit write attempts that must fail. Attempt 1 is the durable
   *  intent record; attempt 2 is the post-provider PROVIDER_ACCEPTED write;
   *  attempt 3 is the RECORDING_FAILED record written when 2 fails. */
  failAuditAttempts?: number[]
}

function fixture(options: Options = {}) {
  const state = options.memberState ?? 'PENDING'
  let userWrites = 0
  let membershipWrites = 0
  let auditAttempts = 0
  const audits: Array<Record<string, unknown>> = []
  const member = {
    id: 'membership-pending',
    userId: 'user-pending',
    organizationId,
    role: 'MSP_VIEWER',
    status: state === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
    user: {
      id: 'user-pending',
      email: memberEmail,
      displayName: 'Pending member',
      // Null by default on purpose: a member whose invite collided with an
      // existing provider account never had an id stored for them.
      authProviderUserId: options.withProviderId ? 'auth-user-pending' : null,
      disabledAt: state === 'DISABLED' ? new Date('2026-09-01T00:00:00.000Z') : null,
      inviteSentAt: new Date('2026-08-28T11:00:00.000Z'),
      inviteAcceptedAt:
        state === 'ACCEPTED' ? new Date('2026-08-29T09:00:00.000Z') : null,
      createdAt: new Date('2026-08-28T11:00:00.000Z'),
    },
  }
  const membership = {
    findFirst: async () => (options.crossOrganization ? null : member),
    upsert: async () => {
      membershipWrites += 1
      return member
    },
  }
  const workspaceAdminAuditLog = {
    create: async (entry: { data: Record<string, unknown> }) => {
      auditAttempts += 1
      if (options.initialAuditFailure && auditAttempts === 1) {
        throw new Error('audit storage unavailable')
      }
      if (options.failAuditAttempts?.includes(auditAttempts)) {
        throw new Error('audit storage unavailable')
      }
      audits.push(entry.data)
      return entry
    },
  }
  const user = {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      if (Object.prototype.hasOwnProperty.call(where, 'authProviderUserId')) {
        if (options.notAnOwner) {
          return { id: 'owner-user', email: identity.email, disabledAt: null, memberships: [] }
        }
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
      return member.user
    },
    create: async () => {
      userWrites += 1
      return member.user
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      userWrites += 1
      return { ...member.user, ...data }
    },
  }
  const prisma = {
    user,
    membership,
    workspaceAdminAuditLog,
    $transaction: async <T>(cb: (c: unknown) => Promise<T>) =>
      cb({ membership, user, workspaceAdminAuditLog }),
  } as unknown as PrismaService
  return {
    service: new WorkspaceService(prisma),
    counts: () => ({ userWrites, membershipWrites, auditAttempts }),
    audits,
    actions: () => audits.map((entry) => String(entry.action)),
  }
}

function recover(service: WorkspaceService, membershipId = 'membership-pending') {
  return service.sendAccountRecovery(identity, membershipId, { organizationId })
}

/** Records every provider path touched, so "no provider call" is observable. */
function provider(handler: () => Response | Promise<Response>) {
  const paths: string[] = []
  const bodies: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    paths.push(new URL(String(input)).pathname)
    bodies.push(typeof init?.body === 'string' ? init.body : '')
    return handler()
  }) as typeof globalThis.fetch
  return { paths, bodies }
}

const ok = () =>
  new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

function errorCodeOf(error: unknown): string {
  const response = (error as { getResponse?: () => unknown }).getResponse?.()
  if (response && typeof response === 'object' && 'code' in response) {
    return String((response as { code?: unknown }).code)
  }
  return ''
}

// ---------------------------------------------------------------------------
// The supported path
// ---------------------------------------------------------------------------

test('a pending member with no stored provider id can be sent account recovery', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture()

  const result = await recover(f.service)

  assert.deepEqual(calls.paths, ['/auth/v1/recover'],
    'recovery must use the provider recover endpoint and nothing else')
  assert.equal(result.requested, true)
  assert.equal(result.recorded, true, 'the ordinary path must report its evidence as recorded')
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result, 'sent'),
    'the response must not carry a "sent" field — a 2xx does not establish delivery'
  )
  const body = JSON.parse(calls.bodies[0]) as Record<string, unknown>
  assert.equal(body.email, memberEmail)
  assert.equal(body.redirect_to, 'https://console.hawkviewapp.com/auth/confirm')
})

test('recovery claims acceptance of the request, never delivery of an email', async () => {
  configureEnvironment()
  provider(ok)
  const f = fixture()

  await recover(f.service)

  const actions = f.actions()
  assert.ok(
    actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_PROVIDER_ACCEPTED'),
    'the provider step must be recorded as accepted'
  )
  for (const action of actions) {
    assert.doesNotMatch(action, /SENT|DELIVERED/,
      `no audit action may assert delivery, found: ${action}`)
  }
  assert.doesNotMatch(
    JSON.stringify(f.audits),
    /email_exists|service-role|test-service-role-key/i,
    'provider detail and credentials must never reach the audit record'
  )
})

test('an address the provider cannot find is indistinguishable, and still not reported as sent', async () => {
  configureEnvironment()
  // Exactly what GoTrue returns for an unknown address: 200 with an empty body.
  const calls = provider(ok)
  const f = fixture()

  const result = await recover(f.service)

  assert.equal(result.requested, true,
    'the response must stay uniform — distinguishing it would enumerate accounts')
  assert.deepEqual(calls.paths, ['/auth/v1/recover'])
  for (const action of f.actions()) {
    assert.doesNotMatch(action, /SENT|DELIVERED/,
      'a 200 with an empty body must not become a delivery claim')
  }
})

test('recovery performs no local mutation, so acceptance can never be implied', async () => {
  configureEnvironment()
  provider(ok)
  const f = fixture()

  await recover(f.service)

  const { userWrites, membershipWrites } = f.counts()
  assert.equal(userWrites, 0, 'recovery must not write to the user record')
  assert.equal(membershipWrites, 0, 'recovery must not write to the membership record')
})

test('CONTROL: the write counters do increment, so the zero above is a real observation', async () => {
  configureEnvironment()
  provider(() =>
    new Response(JSON.stringify({ id: 'auth-user-pending' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  )
  const f = fixture({ withProviderId: true })

  // resendMemberInvitation advances inviteSentAt through the same doubles.
  await f.service.resendMemberInvitation(identity, 'membership-pending', { organizationId })

  assert.ok(f.counts().userWrites > 0,
    'if this is zero the instrument is dead and the no-mutation test proves nothing')
})

// ---------------------------------------------------------------------------
// Refusals — each must reach no provider at all
// ---------------------------------------------------------------------------

test('a member who already completed setup is refused and pointed at password reset', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ memberState: 'ACCEPTED' })

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error, 'an accepted member must not be offered recovery')
  assert.equal(errorCodeOf(error), 'ACCOUNT_RECOVERY_NOT_PENDING')
  assert.deepEqual(calls.paths, [], 'no provider request may be made for a refused state')
  assert.ok(f.actions().includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_FAILED'))
})

test('a disabled account is refused', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ memberState: 'DISABLED' })

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.equal(errorCodeOf(error), 'ACCOUNT_RECOVERY_ACCOUNT_DISABLED')
  assert.deepEqual(calls.paths, [], 'a disabled account must never trigger a provider email')
})

test('an inactive membership is refused', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ memberState: 'SUSPENDED' })

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.equal(errorCodeOf(error), 'ACCOUNT_RECOVERY_MEMBERSHIP_INACTIVE')
  assert.deepEqual(calls.paths, [], 'a suspended membership must never trigger a provider email')
})

test('a membership in another organization is not found, and leaks nothing', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ crossOrganization: true })

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error, 'cross-tenant access must fail')
  assert.match(String((error as Error).message), /was not found/i)
  assert.deepEqual(calls.paths, [],
    'a cross-tenant request must not cause an email to another organization member')
})

test('a caller who is not an active owner is refused before anything is recorded', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ notAnOwner: true })

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error, 'a non-owner must not be able to trigger recovery')
  assert.deepEqual(calls.paths, [])
  assert.equal(f.counts().auditAttempts, 0,
    'authorization must fail before the intent record is written')
})

// ---------------------------------------------------------------------------
// Failure surfaces
// ---------------------------------------------------------------------------

test('intent is durable before the provider is called: no audit, no email', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ initialAuditFailure: true })

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error, 'a failed intent record must stop the request')
  assert.deepEqual(calls.paths, [],
    'if evidence storage is unavailable no recovery email may be requested')
})

test('provider rate limiting surfaces as rate limiting, not as a generic failure', async () => {
  configureEnvironment()
  provider(() =>
    new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
  )
  const f = fixture()

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.equal(errorCodeOf(error), 'AUTH_EMAIL_RATE_LIMITED',
    'the owner reported waiting between sends; this must be named, not hidden')
  const actions = f.actions()
  assert.ok(actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_FAILED'))
  assert.ok(
    !actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_PROVIDER_ACCEPTED'),
    'a rate-limited request must not also be recorded as accepted'
  )
})

test('a transport failure is reported as unreachable and never as accepted', async () => {
  configureEnvironment()
  globalThis.fetch = (async () => {
    throw new Error('socket hang up')
  }) as typeof globalThis.fetch
  const f = fixture()

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error)
  assert.match(String((error as Error).message), /could not be reached/i)
  const actions = f.actions()
  assert.ok(
    !actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_PROVIDER_ACCEPTED'),
    'an unreachable provider must not produce an acceptance record'
  )
  assert.ok(actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_FAILED'))
  assert.doesNotMatch(
    JSON.stringify(f.audits),
    /socket hang up/i,
    'transport detail must not be copied into the audit record'
  )
})

test('an unexpected provider rejection does not become a success', async () => {
  configureEnvironment()
  provider(() =>
    new Response(JSON.stringify({ code: 'unexpected_failure' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  )
  const f = fixture()

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error, 'a provider rejection must propagate')
  const actions = f.actions()
  assert.ok(!actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_PROVIDER_ACCEPTED'))
  assert.equal(f.counts().userWrites, 0)
})

// ---------------------------------------------------------------------------
// Post-provider persistence failure.
//
// Root's blocking finding on v1: the PROVIDER_ACCEPTED audit write sat inside
// the provider catch with the stage still AUTH_PROVIDER, so a failure of OUR
// write was recorded and thrown as a provider failure after the provider had
// already accepted. An administrator seeing that failure presses the button
// again and the provider sends a second email.
// ---------------------------------------------------------------------------

test('a failed post-provider audit write is not reported as a provider failure', async () => {
  configureEnvironment()
  const calls = provider(ok)
  // Attempt 1 = durable intent (must succeed). Attempt 2 = PROVIDER_ACCEPTED.
  const f = fixture({ failAuditAttempts: [2] })

  const result = await recover(f.service)

  assert.equal(calls.paths.length, 1, 'exactly one provider request may be made')
  assert.deepEqual(calls.paths, ['/auth/v1/recover'])
  assert.equal(result.requested, true, 'the provider did accept; that must still be reported')
  assert.equal(result.recorded, false, 'our evidence did not survive and must be reported as such')

  const actions = f.actions()
  assert.ok(
    actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_RECORDING_FAILED'),
    'the persistence failure must be recorded at its own stage'
  )
  assert.ok(
    !actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_FAILED'),
    'a persistence failure must never be classified as a provider failure'
  )
  const record = f.audits.find(
    entry => entry.action === 'WORKSPACE_MEMBER_ACCOUNT_RECOVERY_RECORDING_FAILED'
  )
  assert.equal(record?.stage, 'EVIDENCE_PERSISTENCE',
    'the stage must not still read AUTH_PROVIDER after the provider accepted')
  assert.equal(record?.errorCode, 'ACCOUNT_RECOVERY_RECORDING_FAILED')
})

test('it does not throw after the provider accepted, so nothing invites a second send', async () => {
  configureEnvironment()
  const calls = provider(ok)
  const f = fixture({ failAuditAttempts: [2] })

  // The absence of a rejection is the property under test: a thrown error is
  // what a caller retries, and a retry here is a duplicate email.
  const outcome = await recover(f.service).then(() => 'resolved', () => 'rejected')

  assert.equal(outcome, 'resolved', 'an accepted request must not surface as a rejection')
  assert.equal(calls.paths.length, 1, 'still exactly one provider request')
})

test('even an unwritable failure record does not turn acceptance into an error', async () => {
  configureEnvironment()
  const calls = provider(ok)
  // Attempt 2 (PROVIDER_ACCEPTED) and attempt 3 (RECORDING_FAILED) both fail.
  const f = fixture({ failAuditAttempts: [2, 3] })

  const result = await recover(f.service)

  assert.equal(calls.paths.length, 1, 'exactly one provider request may be made')
  assert.equal(result.requested, true)
  assert.equal(result.recorded, false)
  assert.equal(f.counts().auditAttempts, 3,
    'it must attempt the failure record once and then stop, not loop')
  assert.ok(
    !f.actions().includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_FAILED'),
    'still not a provider failure'
  )
  assert.equal(f.counts().userWrites, 0, 'no local mutation on any branch')
})

test('a pre-acceptance failure still throws and is still classified as a failure', async () => {
  configureEnvironment()
  // 429 before acceptance: the caller must see a real error here, otherwise the
  // honest-outcome change above would have swallowed genuine failures too.
  provider(() =>
    new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
  )
  const f = fixture()

  const error = await recover(f.service).then(() => null, (e: unknown) => e)

  assert.ok(error, 'a pre-acceptance failure must still reject')
  assert.equal(errorCodeOf(error), 'AUTH_EMAIL_RATE_LIMITED')
  const actions = f.actions()
  assert.ok(actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_FAILED'))
  assert.ok(!actions.includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_RECORDING_FAILED'),
    'nothing was accepted, so there is no recording-failure to report')
})

test('CONTROL: the audit-failure injector is live', async () => {
  configureEnvironment()
  provider(ok)
  const f = fixture({ failAuditAttempts: [2] })
  await recover(f.service)
  // If injection were inert, PROVIDER_ACCEPTED would have been recorded and the
  // three tests above would pass against unchanged code.
  assert.ok(
    !f.actions().includes('WORKSPACE_MEMBER_ACCOUNT_RECOVERY_PROVIDER_ACCEPTED'),
    'the injected failure did not prevent the write; those assertions prove nothing'
  )
})
