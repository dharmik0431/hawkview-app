import assert from 'node:assert/strict'
import test from 'node:test'
import { BadGatewayException } from '@nestjs/common'
import {
  CollectionInitializingError,
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
