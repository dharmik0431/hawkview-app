import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthService } from './auth.service.js'
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

function authServiceFixture(options: { existing?: ExistingState } = {}) {
  const existing = options.existing
  let user: StoredUser | null = existing
    ? {
        id: 'existing-user',
        email: 'member@example.com',
        displayName: 'Existing member',
        authProviderUserId:
          existing === 'subject' || existing === 'disabled-subject'
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
  const organizations: Array<{ id: string; name: string; slug: string }> = []
  const memberships: Array<{ userId: string; organizationId: string; role: string; status: string }> = existing && existing !== 'pending-without-membership'
    ? [{ userId: 'existing-user', organizationId: 'existing-workspace', role: 'MSP_VIEWER', status: 'ACTIVE' }]
    : []

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
      create: async ({ data }: { data: { name: string; slug: string } }) => {
        const organization = { id: `workspace-${organizations.length + 1}`, ...data }
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
