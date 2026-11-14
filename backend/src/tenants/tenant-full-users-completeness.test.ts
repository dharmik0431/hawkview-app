import assert from 'node:assert/strict'
import test from 'node:test'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'

const tenant = {
  id: 'tenant-users-complete', organizationId: 'organization-users-complete',
  microsoftTenantId: 'microsoft-users-complete', status: 'ACTIVE',
  connection: { status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    clientId: 'client', credentialReference: 'secret', exchangeReadOnlyEnabledAt: null },
}
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 1n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}
const priorDelta = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=prior'
const finalDelta = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=final'

function fixture() {
  const state: any = { id: 'users-state', status: 'SUCCEEDED', deltaLink: priorDelta, lastSuccessfulAt: new Date() }
  const writes: string[] = []
  const terminal: any[] = []
  const database = utcTestDatabase({
    syncState: {
      findUnique: async () => ({ ...state }),
      updateMany: async ({ data }: any) => { Object.assign(state, data); return { count: 1 } },
      update: async ({ data }: any) => { terminal.push(data); Object.assign(state, data); return state },
    },
    directoryUser: {
      upsert: async () => { writes.push('upsert') },
      updateMany: async () => { writes.push('tombstone'); return { count: 1 } },
    },
    tenantConnection: { update: async () => { writes.push('connection-verified') } },
  })
  const utcQuery = database.$queryRawUnsafe
  database.$queryRawUnsafe = async (sql: string) => {
    if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }] as any
    if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }] as any
    if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '1' }] as any
    return utcQuery(sql)
  }
  const service = new TenantSyncService(database as any,
    { getTenantAccessToken: async () => 'synthetic-token' } as any,
    {} as any, {} as any, {} as any, { syncTenant: async () => [] } as any) as any
  return { service, state, writes, terminal }
}

for (const owned of [false, true]) {
  for (const partialPage of [1, 2]) {
    for (const qualification of ['206', 'warning'] as const) {
      test(`forced full USERS ${owned ? 'owned' : 'ownerless'} refuses ${qualification} page ${partialPage} without writes or checkpoint`, async () => {
        const f = fixture()
        let pages = 0
        f.service.fetchGraphPage = async () => {
          assert.equal(f.state.deltaLink, null, 'claim invalidates the prior delta before the first fetch')
          pages++
          const partial = pages === partialPage
          return Response.json({
            value: [{ id: `user-${pages}`, userPrincipalName: `user-${pages}@example.test` }],
            ...(partial ? { '@odata.deltaLink': finalDelta }
              : { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/delta?$skiptoken=2' }),
          }, { status: partial && qualification === '206' ? 206 : 200,
            headers: partial && qualification === 'warning' ? { Warning: '199 partial' } : {} })
        }
        await assert.rejects(() => f.service.syncConnectedTenantWithinMemoryLane(tenant, false, {
          includeBundle: false, forceFullUsers: true, visitOwner: owned ? owner : undefined,
        }), /invalid response/)
        assert.equal(pages, partialPage)
        assert.deepEqual(f.writes, [], 'including unseen-user tombstones and connection publication')
        assert.equal(f.terminal.some(update => update.status === 'SUCCEEDED' || update.deltaLink), false)
        assert.equal(f.state.deltaLink, null)
        assert.equal(f.state.status, 'FAILED')
      })
    }
  }
}

for (const qualification of ['206', 'warning'] as const) {
  test(`owned USERS incremental also refuses ${qualification} before materialization`, async () => {
    const f = fixture()
    f.service.fetchGraphPage = async () => Response.json({
      value: [{ id: 'user-1' }], '@odata.deltaLink': finalDelta,
    }, { status: qualification === '206' ? 206 : 200,
      headers: qualification === 'warning' ? { Warning: '199 partial' } : {} })
    await assert.rejects(() => f.service.synchronizeUsers(tenant, 'synthetic-token', priorDelta,
      true, undefined, undefined, owner), /invalid response/)
    assert.deepEqual(f.writes, [])
  })
}

test('ownerless USERS delta retains its legacy response semantics without a full sweep', async () => {
  const f = fixture()
  f.service.fetchGraphPage = async () => Response.json({ value: [{ id: 'user-1' }], '@odata.deltaLink': finalDelta }, { status: 206 })
  assert.deepEqual(await f.service.synchronizeUsers(tenant, 'synthetic-token', priorDelta), { deltaLink: finalDelta })
  assert.deepEqual(f.writes, ['upsert'])
})

test('ownerless 410 full rebuild refuses a qualified response before tombstone or checkpoint', async () => {
  const f = fixture()
  let pages = 0
  f.service.fetchGraphPage = async () => ++pages === 1
    ? Response.json({ error: { code: 'syncStateNotFound' } }, { status: 410 })
    : Response.json({ value: [], '@odata.deltaLink': finalDelta }, { status: 200, headers: { Warning: '199 partial' } })
  await assert.rejects(() => f.service.synchronizeUsers(tenant, 'synthetic-token', priorDelta), /invalid response/)
  assert.equal(pages, 2)
  assert.deepEqual(f.writes, [])
})

test('complete multi-page full USERS materializes only after all pages and then sweeps', async () => {
  const f = fixture()
  let pages = 0
  f.service.fetchGraphPage = async () => {
    assert.deepEqual(f.writes, [], 'all provider pages must complete before the first user write')
    return Response.json(++pages === 1
      ? { value: [{ id: 'user-1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/delta?$skiptoken=2' }
      : { value: [{ id: 'user-2' }], '@odata.deltaLink': finalDelta })
  }
  assert.deepEqual(await f.service.synchronizeUsers(tenant, 'synthetic-token', null,
    true, undefined, undefined, owner), { deltaLink: finalDelta })
  assert.equal(pages, 2)
  assert.deepEqual(f.writes, ['upsert', 'upsert', 'tombstone'])
})
