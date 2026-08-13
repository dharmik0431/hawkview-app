import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthService } from './auth.service.js'
import type { PrismaService } from '../prisma/prisma.service.js'

type StoredUser = {
  id: string
  email: string
  displayName: string | null
  authProviderUserId: string | null
  inviteAcceptedAt: Date | null
  disabledAt: Date | null
}

function authServiceFixture(options: { invited?: boolean } = {}) {
  let user: StoredUser | null = options.invited
    ? {
        id: 'invited-user',
        email: 'member@example.com',
        displayName: 'Invited member',
        authProviderUserId: null,
        inviteAcceptedAt: null,
        disabledAt: null,
      }
    : null
  const organizations: Array<{ id: string; name: string; slug: string }> = []
  const memberships: Array<{ userId: string; organizationId: string; role: string; status: string }> = options.invited
    ? [{ userId: 'invited-user', organizationId: 'existing-workspace', role: 'MSP_VIEWER', status: 'ACTIVE' }]
    : []

  const transaction = {
    user: {
      findUnique: async ({ where }: { where: { authProviderUserId?: string } }) =>
        where.authProviderUserId && user?.authProviderUserId === where.authProviderUserId ? user : null,
      findFirst: async () => user,
      create: async ({ data }: { data: Omit<StoredUser, 'id' | 'disabledAt'> }) => {
        user = { id: 'new-user', disabledAt: null, ...data }
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

  return { service: new AuthService(prisma), organizations, memberships }
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

test('accepted invite keeps the user in the inviter workspace', async () => {
  const fixture = authServiceFixture({ invited: true })

  const result = await fixture.service.bootstrap({
    subject: '11111111-2222-3333-4444-555555555555',
    email: 'member@example.com',
    displayName: 'Invited member',
  })

  assert.equal(fixture.organizations.length, 0)
  assert.equal(fixture.memberships.length, 1)
  assert.equal(result.user.memberships[0]?.organization.id, 'existing-workspace')
})
