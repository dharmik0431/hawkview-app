import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthService } from './auth.service.js'
import type { AuthenticatedIdentity } from './auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'

type StoredUser = {
  id: string
  email: string
  displayName: string | null
  authProviderUserId: string | null
  inviteSentAt: Date | null
  inviteAcceptedAt: Date | null
  disabledAt: Date | null
}

type ExistingState =
  | 'pending-invite'
  | 'pending-without-membership'
  | 'disabled-pending-invite'
  | 'disabled-subject'
  | 'accepted-email'
  | 'legacy-email'
  | 'subject'
  | 'subject-no-membership'

function authServiceFixture(options: { existing?: ExistingState } = {}) {
  const existing = options.existing
  let user: StoredUser | null = existing
    ? {
        id: 'existing-user',
        email: 'member@example.com',
        displayName: 'Existing member',
        authProviderUserId:
          existing === 'subject' ||
          existing === 'subject-no-membership' ||
          existing === 'disabled-subject'
            ? '11111111-2222-3333-4444-555555555555'
            : null,
        inviteSentAt:
          existing === 'pending-invite' ||
          existing === 'pending-without-membership' ||
          existing === 'disabled-pending-invite' ||
          existing === 'accepted-email'
            ? new Date('2026-08-01T00:00:00.000Z')
            : null,
        inviteAcceptedAt:
          existing === 'accepted-email'
            ? new Date('2026-08-02T00:00:00.000Z')
            : null,
        disabledAt:
          existing === 'disabled-pending-invite' || existing === 'disabled-subject'
            ? new Date('2026-08-03T00:00:00.000Z')
            : null,
      }
    : null
  const organizations: Array<{
    id: string
    name: string
    slug: string
    status: string
    businessDomain: string | null
    timeZone: string | null
    onboardingCompletedAt: Date | null
    createdByUserId: string | null
  }> = []
  const memberships: Array<{ userId: string; organizationId: string; role: string; status: string }> = existing && existing !== 'pending-without-membership' && existing !== 'subject-no-membership'
    ? [{ userId: 'existing-user', organizationId: 'existing-workspace', role: 'MSP_VIEWER', status: 'ACTIVE' }]
    : []
  const bootstrapLockKeys: string[] = []

  const identityView = () =>
    user
      ? {
          ...user,
          memberships: memberships
            .filter(
              (membership) =>
                membership.userId === user?.id &&
                membership.status === 'ACTIVE',
            )
            .map((membership) => ({ id: `${membership.userId}-${membership.organizationId}` })),
        }
      : null

  const transaction = {
    $executeRawUnsafe: async (sql: string, lockKey: string) => {
      assert.equal(sql, 'SELECT pg_advisory_xact_lock(hashtext($1))')
      bootstrapLockKeys.push(lockKey)
      return 1
    },
    user: {
      findUnique: async ({ where }: { where: { authProviderUserId?: string } }) =>
        where.authProviderUserId && user?.authProviderUserId === where.authProviderUserId
          ? identityView()
          : null,
      findFirst: async () => identityView(),
      create: async ({ data }: { data: Partial<StoredUser> }) => {
        user = {
          id: 'new-user',
          email: data.email ?? '',
          displayName: data.displayName ?? null,
          authProviderUserId: data.authProviderUserId ?? null,
          inviteSentAt: data.inviteSentAt ?? null,
          inviteAcceptedAt: data.inviteAcceptedAt ?? null,
          disabledAt: null,
        }
        return user
      },
      update: async ({ data }: { data: Partial<StoredUser> }) => {
        if (!user) throw new Error('Missing test user')
        user = { ...user, ...data }
        return user
      },
      findUniqueOrThrow: async () => {
        if (!user) throw new Error('Missing test user')
        return {
          ...user,
          timeZone: null,
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
          platformRole: 'STANDARD_USER',
          memberships: memberships
            .filter((membership) => membership.userId === user?.id && membership.status === 'ACTIVE')
            .map((membership) => ({
              id: `${membership.userId}-${membership.organizationId}`,
              role: membership.role,
              status: membership.status,
              organization: organizations.find((organization) => organization.id === membership.organizationId) ?? {
                id: membership.organizationId,
                name: 'Existing workspace',
                slug: 'existing-workspace',
                status: 'ACTIVE',
                businessDomain: null,
                timeZone: 'America/Toronto',
                onboardingCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
                createdByUserId: null,
              },
            })),
        }
      },
    },
    membership: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        memberships.find((membership) => membership.userId === where.userId) ?? null,
      create: async ({ data }: { data: { userId: string; organizationId: string; role: string; status: string } }) => {
        memberships.push(data)
        return data
      },
    },
    organization: {
      create: async ({ data }: { data: { name: string; slug: string; createdByUserId: string } }) => {
        const organization = {
          id: `workspace-${organizations.length + 1}`,
          status: 'ACTIVE',
          businessDomain: null,
          timeZone: null,
          onboardingCompletedAt: null,
          ...data,
        }
        organizations.push(organization)
        return organization
      },
    },
  }

  const prisma = {
    $transaction: async <T>(callback: (client: typeof transaction) => Promise<T>) => callback(transaction),
  } as unknown as PrismaService

  return {
    service: new AuthService(prisma),
    organizations,
    memberships,
    user: () => user,
    bootstrapLockKeys,
  }
}

test('direct sign-up receives an isolated owner workspace', async () => {
  const fixture = authServiceFixture()

  const result = await fixture.service.bootstrap({
    subject: '11111111-2222-3333-4444-555555555555',
    email: 'new.owner@example.com',
    displayName: 'New Owner',
  })

  assert.equal(fixture.organizations.length, 1)
  assert.equal(fixture.memberships.length, 1)
  assert.deepEqual(fixture.memberships[0], {
    userId: 'new-user',
    organizationId: 'workspace-1',
    role: 'MSP_OWNER',
    status: 'ACTIVE',
  })
  assert.equal(result.user.memberships[0]?.organization.id, 'workspace-1')
  assert.deepEqual(result.workspaceOnboarding, {
    required: true,
    organizationId: 'workspace-1',
    organizationName: "New Owner's MSP Workspace",
    businessDomain: null,
    businessDomainVerification: 'UNVERIFIED_INFORMATIONAL',
    timeZone: null,
  })
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      result.user.memberships[0]?.organization ?? {},
      'createdByUserId',
    ),
    false,
  )
})

test('explicit pending invite keeps the user in the inviter workspace', async () => {
  const fixture = authServiceFixture({ existing: 'pending-invite' })

  const result = await fixture.service.bootstrap({
    subject: '11111111-2222-3333-4444-555555555555',
    email: 'member@example.com',
    displayName: 'Invited member',
  })

  assert.equal(fixture.organizations.length, 0)
  assert.equal(fixture.memberships.length, 1)
  assert.equal(result.user.memberships[0]?.organization.id, 'existing-workspace')
  assert.equal(
    fixture.user()?.authProviderUserId,
    '11111111-2222-3333-4444-555555555555',
  )
  assert.equal(result.workspaceOnboarding.required, false)
})

for (const existing of [
  'accepted-email',
  'legacy-email',
  'pending-without-membership',
  'disabled-pending-invite',
] as const) {
  test(`${existing} cannot be relinked or inherit memberships by email`, async () => {
    const fixture = authServiceFixture({ existing })

    await assert.rejects(
      () =>
        fixture.service.bootstrap({
          subject: '11111111-2222-3333-4444-555555555555',
          email: 'member@example.com',
          displayName: 'Different identity',
        }),
      /already associated with another HawkView identity/,
    )

    assert.equal(fixture.user()?.authProviderUserId, null)
    assert.equal(fixture.organizations.length, 0)
    assert.equal(
      fixture.memberships.length,
      existing === 'pending-without-membership' ? 0 : 1,
    )
  })
}

test('a subject and email collision never reassigns either identity', async () => {
  const subjectUser = {
    id: 'subject-user',
    email: 'subject@example.com',
    displayName: 'Subject user',
    authProviderUserId: '11111111-2222-3333-4444-555555555555',
    inviteSentAt: null,
    inviteAcceptedAt: new Date('2026-08-01T00:00:00.000Z'),
    disabledAt: null,
    memberships: [{ id: 'subject-membership' }],
  }
  const emailUser = {
    id: 'email-user',
    email: 'collision@example.com',
    displayName: 'Email user',
    authProviderUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    inviteSentAt: null,
    inviteAcceptedAt: new Date('2026-08-01T00:00:00.000Z'),
    disabledAt: null,
    memberships: [{ id: 'email-membership' }],
  }
  let updates = 0
  const transaction = {
    $executeRawUnsafe: async () => 1,
    user: {
      findUnique: async () => subjectUser,
      findFirst: async () => emailUser,
      update: async () => {
        updates += 1
        throw new Error('Identity collision must fail before update')
      },
    },
  }
  const prisma = {
    $transaction: async <T>(callback: (client: typeof transaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as PrismaService

  await assert.rejects(
    () =>
      new AuthService(prisma).bootstrap({
        subject: subjectUser.authProviderUserId,
        email: emailUser.email,
        displayName: 'Collision',
      }),
    /conflicts with another HawkView account/,
  )
  assert.equal(updates, 0)
})

test('provider subject remains authoritative for its existing workspace', async () => {
  const fixture = authServiceFixture({ existing: 'subject' })

  const result = await fixture.service.bootstrap({
    subject: '11111111-2222-3333-4444-555555555555',
    email: 'member@example.com',
    displayName: 'Existing member',
  })

  assert.equal(fixture.organizations.length, 0)
  assert.equal(result.user.memberships[0]?.organization.id, 'existing-workspace')
})

for (const existing of [undefined, 'subject-no-membership'] as const) {
  test(`concurrent bootstrap creates one workspace for ${existing ?? 'a new user'}`, async () => {
    const fixture = authServiceFixture({ existing })
    // Model PostgreSQL transaction advisory-lock serialization. Both calls
    // start before either completes, but only one transaction can read/write
    // the subject/email identity at a time.
    const servicePrisma = (fixture.service as unknown as {
      prisma: { $transaction: Function }
    }).prisma
    const originalTransaction = servicePrisma.$transaction.bind(servicePrisma)
    let queue = Promise.resolve()
    servicePrisma.$transaction = <T>(callback: unknown) => {
      const run = queue.then(() => originalTransaction(callback)) as Promise<T>
      queue = run.then(() => undefined, () => undefined)
      return run
    }

    const request: AuthenticatedIdentity = {
      subject: '11111111-2222-3333-4444-555555555555',
      email: 'member@example.com',
      displayName: 'Concurrent Owner',
    }
    const [first, second] = await Promise.all([
      fixture.service.bootstrap(request),
      fixture.service.bootstrap(request),
    ])

    assert.equal(fixture.organizations.length, 1)
    assert.equal(fixture.memberships.length, 1)
    assert.equal(
      first.user.memberships[0]?.organization.id,
      second.user.memberships[0]?.organization.id,
    )
    assert.deepEqual(first.workspaceOnboarding, second.workspaceOnboarding)
    assert.equal(fixture.bootstrapLockKeys.length, 4)
    assert.equal(
      new Set(fixture.bootstrapLockKeys).size,
      2,
    )
  })
}

test('bootstrap retries one unique race and rereads the durable workspace', async () => {
  const fixture = authServiceFixture()
  const servicePrisma = (fixture.service as unknown as {
    prisma: { $transaction: Function }
  }).prisma
  const originalTransaction = servicePrisma.$transaction.bind(servicePrisma)
  let transactions = 0
  servicePrisma.$transaction = async <T>(callback: unknown) => {
    transactions += 1
    const result = await originalTransaction(callback) as T
    if (transactions === 1) throw { code: 'P2002' }
    return result
  }

  const result = await fixture.service.bootstrap({
    subject: '11111111-2222-3333-4444-555555555555',
    email: 'new.owner@example.com',
    displayName: 'New Owner',
  })
  assert.equal(transactions, 2)
  assert.equal(fixture.organizations.length, 1)
  assert.equal(fixture.memberships.length, 1)
  assert.equal(result.user.memberships[0]?.organization.id, 'workspace-1')
})

test('bootstrap excludes inactive organizations from session and onboarding candidates', async () => {
  const profile = {
    id: 'owner-user',
    email: 'owner@example.com',
    displayName: 'Owner',
    authProviderUserId: '11111111-2222-3333-4444-555555555555',
    inviteSentAt: null,
    inviteAcceptedAt: new Date('2026-01-01T00:00:00.000Z'),
    disabledAt: null,
  }
  const inactiveOrganization = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    name: 'Inactive founder workspace',
    slug: 'inactive-founder',
    status: 'SUSPENDED',
    businessDomain: null,
    timeZone: null,
    onboardingCompletedAt: null,
    createdByUserId: profile.id,
  }
  const activeOrganization = {
    id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    name: 'Active invited workspace',
    slug: 'active-invited',
    status: 'ACTIVE',
    businessDomain: null,
    timeZone: 'America/Toronto',
    onboardingCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdByUserId: 'another-owner',
  }
  const transaction = {
    $executeRawUnsafe: async () => 1,
    user: {
      findUnique: async () => ({ ...profile, memberships: [{ id: 'active' }] }),
      findFirst: async () => ({ ...profile, memberships: [{ id: 'active' }] }),
      update: async () => profile,
      findUniqueOrThrow: async ({ select }: { select: Record<string, any> }) => {
        assert.deepEqual(select.memberships.where, {
          status: 'ACTIVE',
          organization: { status: 'ACTIVE' },
        })
        return {
          ...profile,
          timeZone: null,
          dateFormat: 'MM/DD/YYYY',
          timeFormat: '12h',
          platformRole: 'STANDARD_USER',
          memberships: [
            {
              id: 'active',
              role: 'MSP_VIEWER',
              status: 'ACTIVE',
              organization: activeOrganization,
            },
          ],
        }
      },
    },
    membership: { findFirst: async () => ({ id: 'active' }) },
  }
  const prisma = {
    $transaction: async <T>(callback: (client: typeof transaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as PrismaService

  const result = await new AuthService(prisma).bootstrap({
    subject: profile.authProviderUserId,
    email: profile.email,
  })
  assert.equal(result.user.memberships.length, 1)
  assert.equal(result.user.memberships[0]?.organization.id, activeOrganization.id)
  assert.equal(result.workspaceOnboarding.required, false)
  assert.equal(result.workspaceOnboarding.organizationId, null)
  assert.notEqual(
    result.workspaceOnboarding.organizationId,
    inactiveOrganization.id,
  )
})

test('disabled subject-linked account is rejected before any profile mutation', async () => {
  const fixture = authServiceFixture({ existing: 'disabled-subject' })
  const before = fixture.user()

  await assert.rejects(
    () =>
      fixture.service.bootstrap({
        subject: '11111111-2222-3333-4444-555555555555',
        email: 'member@example.com',
        displayName: 'Changed name',
      }),
    /account is disabled/,
  )
  assert.deepEqual(fixture.user(), before)
})
