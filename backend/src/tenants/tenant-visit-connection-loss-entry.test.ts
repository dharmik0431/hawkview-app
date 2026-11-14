import assert from 'node:assert/strict'
import test from 'node:test'
import { MicrosoftRequestError } from '../microsoft/microsoft-request.js'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = {
  id: 'tenant', organizationId: 'organization', microsoftTenantId: 'microsoft',
  status: 'ACTIVE',
  connection: {
    status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    clientId: 'client', credentialReference: 'secret',
  },
}
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}
const authenticationFailure = () => new MicrosoftRequestError(
  'Synthetic token authentication failure.', 401, 'invalid_client', null,
)

function fixture(failOnToken: number, ownerLiveByCheck: boolean[] = []) {
  const events: string[] = []
  let tokens = 0
  let ownerChecks = 0
  const database: any = utcTestDatabase({
    syncState: {
      findUnique: async () => { events.push('users-read'); return { id: 'users-state', deltaLink: null } },
      updateMany: async () => { events.push('users-claim'); return { count: 1 } },
      update: async (request: { data: { status: string } }) => {
        events.push(`users-${request.data.status}`)
        return {}
      },
    },
    tenantConnection: { update: async () => { events.push('connection-timestamp') } },
  })
  const utcQuery = database.$queryRawUnsafe
  database.$queryRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql.includes('FROM organizations')) {
      assert.deepEqual(values, [tenant.organizationId])
      return [{ id: tenant.organizationId }]
    }
    if (sql.includes('FROM customer_tenants')) {
      assert.deepEqual(values, [tenant.id, tenant.organizationId])
      return [{ id: tenant.id }]
    }
    if (sql.includes('FROM tenant_sync_visit_leases')) {
      assert.deepEqual(values, [tenant.id, tenant.organizationId, owner.token, '4'])
      return (ownerLiveByCheck[ownerChecks++] ?? true) ? [{ generation: '4' }] : []
    }
    if (sql.includes('FROM tenant_audit_reconciliation_work')) {
      assert.deepEqual(values, [tenant.organizationId, tenant.id, 22])
      events.push('pending-audit-read')
      return []
    }
    return utcQuery(sql)
  }
  const service = new TenantSyncService(database as any, {
    getTenantAccessToken: async () => {
      tokens += 1
      events.push(`token-${tokens}`)
      if (tokens === failOnToken) throw authenticationFailure()
      return 'token'
    },
  } as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).synchronizeUsers = async () => {
    events.push('users-collect')
    return { deltaLink: null }
  }
  ;(service as any).markConnectionUnavailable = async (
    _tenant: unknown, _error: unknown, _captured: unknown, visitOwner: unknown,
  ) => {
    assert.deepEqual(visitOwner, owner)
    events.push('connection-loss-owner')
    throw new TenantVisitLeaseLostError()
  }
  return { service: service as any, events, ownerChecks: () => ownerChecks }
}

test('first token failure passes the optional owner and stops before USERS failure state', async () => {
  const { service, events } = fixture(1)
  await assert.rejects(
    () => service.syncConnectedTenant(tenant, true, { visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, ['users-read', 'users-claim', 'token-1', 'connection-loss-owner'])
})

test('post-USERS snapshot token failure passes the optional owner and stops before collectors', async () => {
  const { service, events } = fixture(2)
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, [
    'users-read', 'users-claim', 'token-1', 'users-collect',
    'users-SUCCEEDED', 'connection-timestamp', 'token-2', 'connection-loss-owner',
  ])
})

test('takeover before USERS success cannot advance the watermark or connection timestamp', async () => {
  const { service, events, ownerChecks } = fixture(2, [true, true, false])
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.equal(ownerChecks(), 3)
  assert.deepEqual(events, ['users-read', 'users-claim', 'token-1', 'users-collect'])
})

test('takeover before USERS failure cannot persist FAILED or start independent audit', async () => {
  const { service, events, ownerChecks } = fixture(0, [true, true, false])
  service.synchronizeUsers = async () => {
    events.push('users-collect-failed')
    throw new Error('Synthetic Graph failure')
  }
  service.m365ManagementActivity.syncTenant = async () => { events.push('independent-audit') }
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.equal(ownerChecks(), 3)
  assert.deepEqual(events, ['users-read', 'users-claim', 'token-1', 'users-collect-failed'])
})

test('live owner retains the USERS failure and independent-audit fallback', async () => {
  const { service, events, ownerChecks } = fixture(0, [true, true, true])
  service.synchronizeUsers = async () => {
    events.push('users-collect-failed')
    throw new Error('Synthetic Graph failure')
  }
  service.m365ManagementActivity.syncTenant = async () => { events.push('independent-audit') }
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { visitOwner: owner }),
    /Synthetic Graph failure/,
  )
  assert.equal(ownerChecks(), 3)
  assert.deepEqual(events, [
    'users-read', 'users-claim', 'token-1', 'users-collect-failed',
    'users-FAILED', 'independent-audit',
  ])
})

test('M365 audit reconciliation forwards the exact optional visit owner to collection', async () => {
  const { service, events } = fixture(0)
  service.m365ManagementActivity.syncTenant = async (_tenant: unknown, visitOwner: unknown) => {
    assert.deepEqual(visitOwner, owner)
    events.push('audit-owner')
    return []
  }
  await service.syncM365AuditActivity(tenant, 'graph-token', owner)
  assert.deepEqual(events, ['audit-owner', 'pending-audit-read'])
})

test('independent M365 audit retains ownership and propagates lease loss', async () => {
  const { service, events } = fixture(0)
  service.synchronizeUsers = async () => {
    events.push('users-collect-failed')
    throw new Error('Synthetic Graph failure')
  }
  service.m365ManagementActivity.syncTenant = async (_tenant: unknown, visitOwner: unknown) => {
    assert.deepEqual(visitOwner, owner)
    events.push('audit-owner-lost')
    throw new TenantVisitLeaseLostError()
  }
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, [
    'users-read', 'users-claim', 'token-1', 'users-collect-failed',
    'users-FAILED', 'audit-owner-lost',
  ])
})

test('foreign optional owner is refused before USERS claim or provider work', async () => {
  const { service, events } = fixture(1)
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, {
      visitOwner: { ...owner, customerTenantId: 'foreign-tenant' },
    }),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, [])
})

test('lease loss during token acquisition is not classified as a Microsoft failure', async () => {
  const { service, events } = fixture(0)
  service.microsoftConsent.getTenantAccessToken = async () => {
    events.push('token-lost')
    throw new TenantVisitLeaseLostError()
  }
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, ['users-read', 'users-claim', 'token-lost'])
})
