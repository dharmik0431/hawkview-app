import assert from 'node:assert/strict'
import test from 'node:test'
import { NotificationsService } from '../notifications/notifications.service.js'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = {
  id: 'tenant', organizationId: 'organization', microsoftTenantId: 'microsoft',
  status: 'ACTIVE',
  connection: {
    status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    clientId: 'client', credentialReference: 'secret', exchangeReadOnlyEnabledAt: null,
  },
}
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function fixture(liveAtNotice: boolean) {
  const events: string[] = []
  let live = true
  const database: any = utcTestDatabase({
    syncState: {
      findUnique: async () => ({ id: 'users-state', lastSuccessfulAt: null, deltaLink: null }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
      findMany: async () => [],
    },
    tenantConnection: { update: async () => ({}) },
    notification: { upsert: async ({ create }: any) => {
      events.push(`notice:${create.eventType}`)
      return { ...create, id: 'notice', occurrenceCount: 1 }
    } },
    notificationUserState: { deleteMany: async () => {
      events.push('reset-read-state')
      return { count: 0 }
    } },
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
      events.push('lease-check')
      return live ? [{ generation: '4' }] : []
    }
    return utcQuery(sql)
  }
  const notifications = new NotificationsService(database)
  ;(notifications as any).logger = { log: () => undefined, error: () => undefined }
  const service = new TenantSyncService(database, {
    getTenantAccessToken: async () => 'synthetic-token',
  } as any, {} as any, notifications, {} as any, {} as any)
  ;(service as any).synchronizeUsers = async () => ({ deltaLink: null })
  for (const method of [
    'syncLicenses', 'syncOrganizationConfiguration', 'syncDomains', 'syncGroups',
    'syncSharePointSites', 'syncSharePointSettings', 'syncSharePointUsage',
    'syncExchangeMailboxDirectory', 'syncExchangeMailboxSettings',
    'syncExchangeAcceptedDomains', 'syncExchangeMailboxUsage', 'syncExchangeMailboxRules',
    'syncDomainDnsHealth', 'syncAuthenticationRegistrations', 'syncAuthenticationMethodPolicy',
    'syncSignInLogs', 'syncDirectoryAuditLogs', 'syncM365AuditActivity', 'syncDirectoryRoles',
    'syncCurrentSecureScore', 'syncSecurityDefaults',
  ]) (service as any)[method] = async () => undefined
  ;(service as any).syncEntraCollection = async () => undefined
  ;(service as any).refreshCollectionFieldStates = async () => {
    events.push('readiness')
    live = liveAtNotice
  }
  return { service: service as any, events }
}

test('initial full-sync notice rejects a superseded visit after readiness without a notice write', async () => {
  const { service, events } = fixture(false)
  await assert.rejects(
    () => service.syncConnectedTenantWithinMemoryLane(tenant, true, { includeBundle: false, visitOwner: owner }),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events.slice(-2), ['readiness', 'lease-check'])
  assert.equal(events.some(event => event.startsWith('notice:') || event === 'reset-read-state'), false)
})

test('initial full-sync notice publishes with a live visit owner and keeps legacy ownerless behavior', async () => {
  const owned = fixture(true)
  assert.equal((await owned.service.syncConnectedTenantWithinMemoryLane(
    tenant, true, { includeBundle: false, visitOwner: owner },
  )).status, 'SUCCEEDED')
  assert.deepEqual(owned.events.slice(-4), [
    'readiness', 'lease-check', 'notice:tenant.initial_sync_completed', 'reset-read-state',
  ])

  const legacy = fixture(false)
  assert.equal((await legacy.service.syncConnectedTenantWithinMemoryLane(
    tenant, true, { includeBundle: false },
  )).status, 'SUCCEEDED')
  assert.deepEqual(legacy.events, [
    'readiness', 'notice:tenant.initial_sync_completed', 'reset-read-state',
  ])
})
