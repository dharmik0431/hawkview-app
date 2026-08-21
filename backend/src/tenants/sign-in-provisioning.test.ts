import assert from 'node:assert/strict'
import test from 'node:test'
import { BadGatewayException } from '@nestjs/common'
import {
  CollectionInitializingError,
  CollectionPartialError,
  TenantSyncService,
} from './tenant-sync.service.js'

function serviceWithState(updates: Array<Record<string, unknown>>, resolved: string[]) {
  const prisma: any = {
    syncState: {
      upsert: async () => undefined,
      update: async ({ data }: any) => {
        updates.push(data)
        return {
          ...data,
          consecutiveFailures:
            typeof data.consecutiveFailures === 'object' ? 1 : data.consecutiveFailures,
        }
      },
    },
  }
  const notifications: any = {
    resolveIncident: async (_organizationId: string, dedupeKey: string) => {
      resolved.push(dedupeKey)
    },
    publishIncident: async () => undefined,
  }
  return new TenantSyncService(
    prisma,
    {} as never,
    {} as never,
    notifications,
    {} as never,
    {} as never,
  )
}

test('records expected sign-in dependency provisioning as initializing without a failed incident', async () => {
  const updates: Array<Record<string, unknown>> = []
  const resolved: string[] = []
  const service = serviceWithState(updates, resolved)

  await (service as any).runSnapshotSync(
    { id: 'tenant-1', organizationId: 'org-1' },
    'SIGN_INS',
    async () => {
      throw new CollectionInitializingError(
        'sign-ins-audit-subscription-initializing',
        'Microsoft is activating the audit subscription used for limited-license sign-in collection.',
      )
    },
  )

  assert.deepEqual(updates.at(-1), {
    status: 'RUNNING',
    lastErrorCode: 'sign-ins-audit-subscription-initializing',
    lastErrorMessage:
      'Microsoft is activating the audit subscription used for limited-license sign-in collection.',
    consecutiveFailures: 0,
  })
  assert.deepEqual(resolved, ['tenant:tenant-1:sync:SIGN_INS'])
})

test('does not hide a genuine sign-in collector failure as provisioning', async () => {
  const updates: Array<Record<string, unknown>> = []
  const service = serviceWithState(updates, [])

  await assert.rejects(
    (service as any).runSnapshotSync(
      { id: 'tenant-1', organizationId: 'org-1' },
      'SIGN_INS',
      async () => {
        throw new Error('Microsoft sign-in collection returned 500.')
      },
    ),
    BadGatewayException,
  )

  assert.equal(updates.at(-1)?.status, 'FAILED')
  assert.equal(updates.at(-1)?.lastErrorCode, 'sign_ins-sync-failed')
})

test('records successful bounded fallback evidence as partial without publishing a failure', async () => {
  const updates: Array<Record<string, unknown>> = []
  const resolved: string[] = []
  const service = serviceWithState(updates, resolved)

  await (service as any).runSnapshotSync(
    { id: 'tenant-1', organizationId: 'org-1' },
    'SIGN_INS',
    async () => {
      throw new CollectionPartialError(
        'sign-ins-premium-graph-fallback-active',
        'HawkView collected limited evidence and will retry the full Microsoft Graph source.',
      )
    },
  )

  assert.equal(updates.at(-1)?.status, 'RUNNING')
  assert.ok(updates.at(-1)?.lastSuccessfulAt instanceof Date)
  assert.equal(
    updates.at(-1)?.lastErrorCode,
    'sign-ins-premium-graph-fallback-active',
  )
  assert.equal(updates.at(-1)?.consecutiveFailures, 0)
  assert.deepEqual(resolved, ['tenant:tenant-1:sync:SIGN_INS'])
})

function signInCollectorFixture(servicePlans: unknown) {
  const updates: Array<Record<string, unknown>> = []
  const scopes: Array<Record<string, unknown>> = []
  const prisma: any = {
    syncState: {
      upsert: async () => undefined,
      update: async ({ data }: any) => {
        updates.push(data)
        return { ...data, consecutiveFailures: 0 }
      },
      findFirst: async ({ where }: any) => {
        scopes.push(where)
        return { status: 'SUCCEEDED', lastSuccessfulAt: new Date() }
      },
    },
    tenantLicense: {
      findMany: async ({ where }: any) => {
        scopes.push(where)
        return [{ servicePlans }]
      },
    },
    signInLog: {
      findFirst: async () => null,
      createMany: async () => undefined,
      deleteMany: async () => undefined,
    },
  }
  const service = new TenantSyncService(
    prisma,
    {} as never,
    { lookup: async () => null } as never,
    {
      resolveIncident: async () => undefined,
      publishIncident: async () => undefined,
    } as never,
    {
      pruneExpired: async () => undefined,
    } as never,
    {} as never,
  )
  return { service, scopes, updates }
}

const signInTenant = {
  id: 'tenant-1',
  organizationId: 'org-1',
  microsoftTenantId: '11111111-1111-4111-8111-111111111111',
  connection: {
    connectionMode: 'HAWKVIEW_MANAGED',
    clientId: null,
    credentialReference: null,
  },
}

test('Business Premium evidence makes a Microsoft non-premium response a consent-shaped partial fallback', async () => {
  const { service, scopes, updates } = signInCollectorFixture([
    {
      servicePlanName: 'AAD_PREMIUM',
      servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d',
      provisioningStatus: 'Success',
    },
  ])
  let fallbackCalls = 0
  ;(service as any).fetchGraphCollection = async () => {
    throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant')
  }
  ;(service as any).fetchLimitedLoginActivity = async () => {
    fallbackCalls += 1
    return []
  }

  await (service as any).syncSignInLogs(signInTenant, 'graph-token')

  assert.equal(fallbackCalls, 1)
  assert.equal(
    updates.at(-1)?.lastErrorCode,
    'sign-ins-premium-graph-fallback-active',
  )
  assert.match(String(updates.at(-1)?.lastErrorMessage), /Directory\.Read\.All/)
  assert.ok(
    scopes.every(
      (where) =>
        where.organizationId === 'org-1' &&
        where.customerTenantId === 'tenant-1',
    ),
  )
})

test('a current complete inventory without P1 or P2 uses an honestly limited fallback', async () => {
  const { service, updates } = signInCollectorFixture([
    {
      servicePlanName: 'EXCHANGE_S_STANDARD',
      servicePlanId: 'plan-1',
      provisioningStatus: 'Success',
    },
  ])
  ;(service as any).fetchGraphCollection = async () => {
    throw new Error("Tenant doesn't have premium license")
  }
  ;(service as any).fetchLimitedLoginActivity = async () => []

  await (service as any).syncSignInLogs(signInTenant, 'graph-token')

  assert.equal(
    updates.at(-1)?.lastErrorCode,
    'sign-ins-non-premium-fallback-active',
  )
  assert.match(String(updates.at(-1)?.lastErrorMessage), /limited/i)
})

test('a successful Graph sign-in collection remains authoritative and does not invoke fallback', async () => {
  const { service, updates } = signInCollectorFixture([
    {
      servicePlanName: 'AAD_PREMIUM',
      servicePlanId: '41781fb2-bc02-4b7c-bd55-b576c07bb09d',
      provisioningStatus: 'Success',
    },
  ])
  let fallbackCalls = 0
  ;(service as any).fetchGraphCollection = async () => []
  ;(service as any).fetchLimitedLoginActivity = async () => {
    fallbackCalls += 1
    return []
  }

  await (service as any).syncSignInLogs(signInTenant, 'graph-token')

  assert.equal(fallbackCalls, 0)
  assert.equal(updates.at(-1)?.status, 'SUCCEEDED')
  assert.equal(updates.at(-1)?.lastErrorCode, null)
})

test('the limited-license fallback reports a disabled audit subscription as initializing', async () => {
  const requested: string[] = []
  const service = new TenantSyncService(
    {} as never,
    {
      getTenantManagementActivityContext: async () => ({
        accessToken: 'management-token',
        publisherIdentifier: 'publisher-id',
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    requested.push(String(input))
    return new Response('[]', { status: 200 })
  }
  try {
    await assert.rejects(
      (service as any).fetchLimitedLoginActivity(
        {
          id: 'tenant-1',
          organizationId: 'org-1',
          microsoftTenantId: '11111111-1111-4111-8111-111111111111',
          connection: {
            connectionMode: 'HAWKVIEW_MANAGED',
            clientId: null,
            credentialReference: null,
          },
        },
        new Date('2026-08-21T12:00:00.000Z'),
        new Date('2026-08-21T12:05:00.000Z'),
      ),
      (error: unknown) =>
        error instanceof CollectionInitializingError &&
        error.code === 'sign-ins-audit-subscription-initializing',
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requested.length, 1)
  assert.match(requested[0] ?? '', /subscriptions\/list/)
})
