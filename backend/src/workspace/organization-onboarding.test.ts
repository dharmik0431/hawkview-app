import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { AuthenticatedIdentity } from '../auth/auth.types.js'
import type { PrismaService } from '../prisma/prisma.service.js'
import { parseOrganizationSettings } from './organization-onboarding.js'
import { WorkspaceService } from './workspace.service.js'
import { TenantsService } from '../tenants/tenants.service.js'

const ORGANIZATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_ORGANIZATION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const identity: AuthenticatedIdentity = {
  subject: 'subject-owner',
  email: 'owner@example.com',
}

test('organization setup accepts only canonical bounded values', () => {
  assert.deepEqual(
    parseOrganizationSettings({
      organizationId: ORGANIZATION_ID.toUpperCase(),
      organizationName: '  GreenTech   Services  ',
      businessDomain: ' GreenTech-Services.NET ',
      timeZone: 'America/Toronto',
    }),
    {
      organizationId: ORGANIZATION_ID,
      organizationName: 'GreenTech Services',
      businessDomain: 'greentech-services.net',
      timeZone: 'America/Toronto',
    }
  )

  for (const businessDomain of [
    'localhost',
    'https://example.com',
    'example.com/path',
    'user@example.com',
    '-bad.example',
    'bad-.example',
    'example.com.',
    '192.168.1.1',
    '001.002.003.004',
    '0x7f.0.0.1',
    '[2001:db8::1]',
    'example.com:443',
    'example.com\\path',
    'example.com%2fpath',
    `exam\u200bple.com`,
    `example.\u202ecom`,
  ]) {
    assert.throws(
      () =>
        parseOrganizationSettings({
          organizationId: ORGANIZATION_ID,
          organizationName: 'GreenTech',
          businessDomain,
          timeZone: 'America/Toronto',
        }),
      /valid business domain/
    )
  }
  assert.throws(
    () =>
      parseOrganizationSettings({
        organizationId: ORGANIZATION_ID,
        organizationName: '<script>',
        businessDomain: null,
        timeZone: 'America/Toronto',
      }),
    /valid MSP or organization name/
  )
  assert.throws(
    () =>
      parseOrganizationSettings({
        organizationId: ORGANIZATION_ID,
        organizationName: `Green\u200bTech`,
        businessDomain: null,
        timeZone: 'America/Toronto',
      }),
    /valid MSP or organization name/
  )
  assert.throws(
    () =>
      parseOrganizationSettings({
        organizationId: ORGANIZATION_ID,
        organizationName: 'GreenTech',
        businessDomain: null,
        timeZone: `America/Toronto\u202e`,
      }),
    /valid IANA time zone/
  )
  assert.throws(
    () =>
      parseOrganizationSettings({
        organizationId: ORGANIZATION_ID,
        organizationName: 'GreenTech',
        businessDomain: null,
        timeZone: 'Toronto',
      }),
    /valid IANA time zone/
  )
  const inherited = Object.create({ organizationId: ORGANIZATION_ID })
  inherited.organizationName = 'GreenTech'
  inherited.timeZone = 'America/Toronto'
  assert.throws(() => parseOrganizationSettings(inherited), /details are required/)
})

type OrganizationState = {
  id: string
  name: string
  slug: string
  businessDomain: string | null
  timeZone: string | null
  onboardingCompletedAt: Date | null
  createdByUserId: string | null
  updatedAt: Date
}

function workspaceFixture(options: {
  createdByUserId?: string | null
  onboardingCompletedAt?: Date | null
  actorOrganizationId?: string
} = {}) {
  const actorUserId = 'owner-user'
  let organization: OrganizationState = {
    id: ORGANIZATION_ID,
    name: 'Temporary MSP Workspace',
    slug: 'immutable-internal-slug',
    businessDomain: null,
    timeZone: null,
    onboardingCompletedAt: options.onboardingCompletedAt ?? null,
    createdByUserId:
      options.createdByUserId === undefined ? actorUserId : options.createdByUserId,
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  }
  const audits: Array<Record<string, unknown>> = []
  const updatePayloads: Array<Record<string, unknown>> = []

  const transaction = {
    organization: {
      updateMany: async ({ where, data, }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        updatePayloads.push(data)
        const requiresIncomplete = where.onboardingCompletedAt === null
        const requiresComplete =
          typeof where.onboardingCompletedAt === 'object' &&
          where.onboardingCompletedAt !== null
        const expectedUpdatedAt = where.updatedAt
        const requiresFounder = where.createdByUserId !== undefined
        const matches =
          where.id === organization.id &&
          (!requiresFounder || organization.createdByUserId === actorUserId) &&
          (!requiresIncomplete || organization.onboardingCompletedAt === null) &&
          (!requiresComplete || organization.onboardingCompletedAt !== null) &&
          (!expectedUpdatedAt || expectedUpdatedAt === organization.updatedAt)
        if (!matches) return { count: 0 }
        organization = {
          ...organization,
          ...data,
          updatedAt: new Date(organization.updatedAt.getTime() + 1),
        } as OrganizationState
        return { count: 1 }
      },
      findFirst: async () => ({ ...organization }),
      findUniqueOrThrow: async () => ({ ...organization }),
    },
    workspaceAdminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data)
        return data
      },
    },
  }
  const prisma = {
    user: {
      findUnique: async ({ where, }: { where: { authProviderUserId: string } }) => {
        assert.equal(where.authProviderUserId, identity.subject)
        const memberOrganizationId =
          options.actorOrganizationId ?? organization.id
        return {
          id: actorUserId,
          email: identity.email,
          disabledAt: null,
          memberships:
            memberOrganizationId === organization.id
              ? [{ organization: { id: organization.id, name: organization.name, }, },]
              : [],
        }
      },
    },
    workspaceAdminAuditLog: transaction.workspaceAdminAuditLog,
    $transaction: async <T>(callback: (client: typeof transaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as PrismaService

  return {
    service: new WorkspaceService(prisma),
    organization: () => organization,
    audits,
    updatePayloads,
  }
}

const setup = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION_ID,
  organizationName: 'GreenTech Services',
  businessDomain: 'greentech-services.net',
  timeZone: 'America/Toronto',
  ...overrides,
})

test('first completion is atomic and identical concurrent retries are idempotent', async () => {
  const fixture = workspaceFixture()
  const [first, retry] = await Promise.all([
    fixture.service.completeOrganizationOnboarding(identity, setup()),
    fixture.service.completeOrganizationOnboarding(identity, setup()),
  ])

  assert.equal(first.workspaceOnboarding.required, false)
  assert.deepEqual(retry.workspaceOnboarding, first.workspaceOnboarding)
  assert.equal(fixture.audits.length, 1)
  assert.equal(fixture.audits[0]?.action, 'ORGANIZATION_ONBOARDING_COMPLETED')
  assert.equal(fixture.organization().slug, 'immutable-internal-slug')
  assert.equal(
    fixture.updatePayloads.some((data) =>
      Object.prototype.hasOwnProperty.call(data, 'slug')
    ),
    false
  )
})

test('conflicting completion retry cannot overwrite the winning setup', async () => {
  const fixture = workspaceFixture()
  await fixture.service.completeOrganizationOnboarding(identity, setup())
  await assert.rejects(
    () =>
      fixture.service.completeOrganizationOnboarding(
        identity,
        setup({ organizationName: 'Other MSP' })
      ),
    /already complete/
  )
  assert.equal(fixture.organization().name, 'GreenTech Services')
  assert.equal(fixture.audits.length, 2)
  assert.equal(fixture.audits[ 1]?.action, 'ORGANIZATION_ONBOARDING_FAILED')
})

test('an invited owner cannot complete the founder organization before setup', async () => {
  const invitedOwner = workspaceFixture({
    createdByUserId: 'founder-user',
  })
  await assert.rejects(
    () => invitedOwner.service.completeOrganizationOnboarding(identity, setup()),
    /Only the founding MSP owner/
  )
  assert.equal(invitedOwner.organization().name, 'Temporary MSP Workspace')
  assert.equal(invitedOwner.audits.length, 1)
  assert.equal(invitedOwner.audits[ 0]?.outcome, 'FAILED')
})

test('after setup any active MSP owner can update the organization profile', async () => {
  const invitedOwner = workspaceFixture({
    createdByUserId: 'founder-user',
    onboardingCompletedAt: new Date('2026-08-20T01:00:00.000Z'),
  })
  const result = await invitedOwner.service.updateOrganization(
    identity,
    setup({ organizationName: 'Updated by active owner' })
  )
  assert.equal(result.organization.name, 'Updated by active owner')
  assert.equal(invitedOwner.audits.length, 1)
})

test('the founding owner cannot be removed before initial setup is complete', async () => {
  let membershipUpdates = 0
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'invited-owner',
        email: 'invited.owner@example.com',
        disabledAt: null,
        memberships: [
          { organization: { id: ORGANIZATION_ID, name: 'GreenTech' } },
        ],
      }),
    },
    membership: {
      findFirst: async () => ({
        id: 'founder-membership',
        userId: 'founder-user',
        organizationId: ORGANIZATION_ID,
        role: 'MSP_OWNER',
        status: 'ACTIVE',
        user: {
          id: 'founder-user',
          email: 'founder@example.com',
          displayName: 'Founder',
          authProviderUserId: 'founder-subject',
          disabledAt: null,
          inviteSentAt: null,
          inviteAcceptedAt: new Date('2026-01-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      }),
      update: async () => {
        membershipUpdates += 1
        return null
      },
    },
    organization: {
      findUnique: async () => ({
        createdByUserId: 'founder-user',
        onboardingCompletedAt: null,
      }),
    },
    workspaceAdminAuditLog: { create: async () => null },
  } as unknown as PrismaService
  const service = new WorkspaceService(prisma)

  await assert.rejects(
    () =>
      service.updateMember(identity, 'founder-membership', {
        organizationId: ORGANIZATION_ID,
        role: 'MSP_VIEWER',
      }),
    /founding MSP owner cannot be removed or demoted until organization setup is complete/
  )
  assert.equal(membershipUpdates, 0)
})

test('after setup normal self and last-owner policies replace founder permanence', async () => {
  let membershipUpdates = 0
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'second-owner',
        email: identity.email,
        disabledAt: null,
        memberships: [
          { organization: { id: ORGANIZATION_ID, name: 'GreenTech' } },
        ],
      }),
    },
    organization: {
      findUnique: async () => ({
        createdByUserId: 'founder-user',
        onboardingCompletedAt: new Date('2026-08-20T01:00:00.000Z'),
      }),
    },
    membership: {
      findFirst: async () => ({
        id: 'founder-membership',
        userId: 'founder-user',
        organizationId: ORGANIZATION_ID,
        role: 'MSP_OWNER',
        status: 'ACTIVE',
        user: {
          id: 'founder-user',
          email: 'founder@example.com',
          displayName: 'Founder',
          authProviderUserId: 'founder-subject',
          disabledAt: null,
          inviteSentAt: null,
          inviteAcceptedAt: new Date('2026-01-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      }),
      count: async () => 2,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        membershipUpdates += 1
        return {
          id: 'founder-membership',
          userId: 'founder-user',
          organizationId: ORGANIZATION_ID,
          role: data.role,
          status: data.status,
          user: {
            id: 'founder-user',
            email: 'founder@example.com',
            displayName: 'Founder',
            authProviderUserId: 'founder-subject',
            disabledAt: null,
            inviteSentAt: null,
            inviteAcceptedAt: new Date('2026-01-01T00:00:00.000Z'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        }
      },
    },
    workspaceAdminAuditLog: { create: async () => null },
  } as unknown as PrismaService
  ;(
    prisma as unknown as {
      $transaction: (
        callback: (client: PrismaService) => Promise<unknown>
      ) => Promise<unknown>
    }
  ).$transaction = async (callback) => callback(prisma)

  await new WorkspaceService(prisma).updateMember(
    identity,
    'founder-membership',
    { organizationId: ORGANIZATION_ID, role: 'MSP_VIEWER' }
  )
  assert.equal(membershipUpdates, 1)
})

test('organization update is active-owner scoped, optimistic, audited, and never changes slug', async () => {
  const fixture = workspaceFixture({
    onboardingCompletedAt: new Date('2026-08-20T01:00:00.000Z'),
  })
  const result = await fixture.service.updateOrganization(
    identity,
    setup({ organizationName: 'GreenTech MSP', businessDomain: '' })
  )
  assert.equal(result.organization.name, 'GreenTech MSP')
  assert.equal(result.organization.businessDomain, null)
  assert.equal(fixture.organization().slug, 'immutable-internal-slug')
  assert.deepEqual(fixture.audits[0]?.metadata, {
    changedFields: ['name', 'timeZone'],
  })
})

test('cross-organization IDs fail before any organization mutation', async () => {
  const fixture = workspaceFixture({ actorOrganizationId: OTHER_ORGANIZATION_ID, })
  await assert.rejects(
    () => fixture.service.completeOrganizationOnboarding(identity, setup()),
    /Only an active MSP owner/
  )
  assert.equal(fixture.updatePayloads.length, 0)
})

test('migration backfills existing organizations complete and selects a deterministic founder', () => {
  const sql = readFileSync(
    new URL(
      '../../prisma/migrations/20260820200000_add_msp_organization_onboarding/migration.sql',
      import.meta.url
    ),
    'utf8'
  )
  assert.match(sql, /UPDATE "organizations" AS organization/)
  assert.match(sql, /"onboarding_completed_at" = COALESCE/)
  assert.match(sql, /"role" = 'MSP_OWNER'/)
  assert.match(sql, /membership\."status" = 'ACTIVE'/)
  assert.match(sql, /ORDER BY membership\."created_at" ASC, membership\."id" ASC/)
  assert.match(sql, /ON DELETE SET NULL/)
})

test('tenant onboarding requires durable organization setup completion', async () => {
  let membershipWhere: unknown
  let consentCalls = 0
  const prisma = {
    user: {
      findUnique: async ({ select, }: { select: { memberships: { where: unknown } } }) => {
        membershipWhere = select.memberships.where
        return {
          disabledAt: null,
          memberships: [
            {
              organizationId: ORGANIZATION_ID,
              organization: { onboardingCompletedAt: null },
            },
          ],
        }
      },
    },
  } as unknown as PrismaService
  const consent = {
    createTenantDiscoveryConsentUrl: async () => {
      consentCalls += 1
      return null
    },
  }
  const service = new TenantsService(prisma, consent as never, {} as never)

  await assert.rejects(
    () => service.createManagedOnboardingUrlForIdentity(identity),
    /Complete MSP organization setup before onboarding tenants/
  )
  assert.deepEqual(
    (membershipWhere as { organization: unknown }).organization,
    { status: 'ACTIVE' }
  )
  assert.equal(consentCalls, 0)
})
