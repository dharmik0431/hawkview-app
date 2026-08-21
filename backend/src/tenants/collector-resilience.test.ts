import assert from 'node:assert/strict'
import test from 'node:test'
import { MicrosoftRequestError } from '../microsoft/microsoft-request.js'
import { TenantSyncService } from './tenant-sync.service.js'

function tenant() {
  return {
    id: 'tenant-1',
    organizationId: 'org-1',
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Tenant',
    primaryDomain: 'tenant.example',
    status: 'ACTIVE',
    connection: {
      status: 'CONNECTED',
      connectionMode: 'HAWKVIEW_MANAGED',
      clientId: null,
      credentialReference: null,
      lastVerifiedAt: null,
    },
  }
}

test('a collector failure after token acquisition never suspends the tenant connection', async () => {
  const updates: any[] = []
  const prisma = {
    syncState: {
      findUnique: async () => ({
        id: 'state-1',
        deltaLink: 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=old',
        lastSuccessfulAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
      updateMany: async () => ({ count: 1 }),
      update: async (request: any) => {
        updates.push(request.data)
        return { consecutiveFailures: 1 }
      },
    },
    $transaction: async (work: unknown) => work,
  }
  const service = new TenantSyncService(
    prisma as any,
    { getTenantAccessToken: async () => 'token' } as any,
    {} as any,
    {} as any,
    {} as any,
    { syncTenant: async () => [] } as any,
  )
  let connectionSuspensions = 0
  ;(service as any).markConnectionUnavailable = async () => { connectionSuspensions += 1 }
  ;(service as any).synchronizeUsers = async () => {
    throw new MicrosoftRequestError('Microsoft users synchronization returned 500.', 500, 'InternalServerError', 'req-1')
  }

  await assert.rejects(
    () => (service as any).syncConnectedTenant(tenant(), true, { incrementalOnly: true, includeBundle: false }),
    /Microsoft users synchronization returned 500/,
  )
  assert.equal(connectionSuspensions, 0)
  assert.equal(updates.at(-1)?.status, 'FAILED')
  assert.equal(updates.at(-1)?.lastErrorCode, 'MICROSOFT_TRANSIENT')
  assert.match(updates.at(-1)?.lastErrorMessage ?? '', /retry automatically/i)
})

test('an expired users delta checkpoint rebuilds one authoritative full baseline', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  const upserts: any[] = []
  const reconciliations: any[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (urls.length === 1) {
      return new Response(JSON.stringify({ error: { code: 'syncStateNotFound' } }), {
        status: 410,
        headers: { 'request-id': 'req-delta-reset' },
      })
    }
    return new Response(JSON.stringify({
      value: [{ id: 'user-1', displayName: 'User One', userPrincipalName: 'user@tenant.example' }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=new',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const prisma = {
      directoryUser: {
        upsert: (request: any) => { upserts.push(request); return Promise.resolve(request) },
        updateMany: async (request: any) => { reconciliations.push(request); return { count: 1 } },
      },
      $transaction: async (work: Array<Promise<unknown>>) => Promise.all(work),
    }
    const service = new TenantSyncService(
      prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    )
    const result = await (service as any).synchronizeUsers(
      tenant(),
      'token',
      'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=old',
    )
    assert.equal(result.deltaLink, 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=new')
    assert.match(urls[0] ?? '', /deltatoken=old/)
    assert.match(urls[1] ?? '', /users\/delta\?\$select=/)
    assert.equal(upserts.length, 1)
    assert.equal(reconciliations.length, 1)
    assert.equal(reconciliations[0].where.organizationId, 'org-1')
    assert.equal(reconciliations[0].where.customerTenantId, 'tenant-1')
    assert.ok(reconciliations[0].where.lastSeenAt.lt instanceof Date)
  } finally {
    globalThis.fetch = originalFetch
  }
})
