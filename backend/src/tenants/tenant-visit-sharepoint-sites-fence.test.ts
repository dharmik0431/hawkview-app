import assert from 'node:assert/strict'
import test from 'node:test'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-sites', organizationId: 'organization-sites' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

test('SharePoint site result cannot advance snapshot, status or evidence after visit takeover', async () => {
  const events: string[] = []
  let checks = 0
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        events.push('owner-check')
        return ++checks === 1 ? [{ generation: '4' }] : []
      }
      assert.fail(`Unexpected SQL: ${sql}`)
    },
    syncState: {
      upsert: async () => { events.push('running'); return { lastSuccessfulAt: null } },
      update: async () => { events.push('terminal') },
    },
    $executeRawUnsafe: async () => { events.push('snapshot-lock') },
    tenantEntraSnapshot: {
      findUnique: async () => { events.push('snapshot-read'); return null },
      upsert: async () => { events.push('snapshot-write') },
    },
    changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
  }
  const service = new TenantSyncService({
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as any, {} as any, {} as any,
  { resolveIncident: async () => { events.push('resolve') },
    publishIncident: async () => { events.push('publish') } } as any,
  {} as any, {} as any)
  ;(service as any).fetchGraphPage = async (url: string) => {
    events.push(url.includes('/sites/root?') ? 'provider-root' : 'provider-search')
    return url.includes('/sites/root?')
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ value: [{ id: 'site-one', displayName: 'Site One' }] }), { status: 200 })
  }

  await assert.rejects(
    () => (service as any).syncSharePointSites(tenant, 'synthetic-token', undefined, owner),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(events.slice(0, 4), ['owner-check', 'running', 'provider-root', 'provider-search'])
  assert.equal(checks, 2)
  assert.equal(events.at(-1), 'owner-check')
  assert.equal(events.some((event) =>
    ['snapshot-lock', 'snapshot-read', 'snapshot-write', 'evidence-write', 'terminal', 'resolve', 'publish'].includes(event)), false)
})

test('between-inventory and audit SharePoint site dispatch forward the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncSharePointSites = async (...args: unknown[]) => { calls.push(args) }
  const module = (service as any).incrementalInventoryModule(
    tenant, 'synthetic-token', 'SHAREPOINT_SITES', owner,
  )
  await module.synchronize()
  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['SHAREPOINT_SITES'], owner,
  )
  assert.deepEqual(calls, [
    [tenant, 'synthetic-token', undefined, owner],
    [tenant, 'synthetic-token', undefined, owner],
  ])
})

test('full secondary SharePoint site dispatch forwards the visit owner', async () => {
  const fullTenant = {
    ...tenant, microsoftTenantId: 'microsoft', status: 'ACTIVE',
    connection: {
      status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
      clientId: 'client', credentialReference: 'secret', exchangeReadOnlyEnabledAt: null,
    },
  }
  const database: any = utcTestDatabase({
    syncState: {
      findUnique: async () => ({ id: 'users-state', lastSuccessfulAt: null, deltaLink: null }),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
      findMany: async () => [],
    },
    tenantConnection: { update: async () => ({}) },
  })
  const utcQuery = database.$queryRawUnsafe
  database.$queryRawUnsafe = async (sql: string) => {
    if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
    if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
    if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: '4' }]
    return utcQuery(sql)
  }
  const service = new TenantSyncService(database, {
    getTenantAccessToken: async () => 'synthetic-token',
  } as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).synchronizeUsers = async () => ({ deltaLink: null })
  for (const method of [
    'syncLicenses', 'syncOrganizationConfiguration', 'syncDomains', 'syncGroups',
    'syncSharePointSettings', 'syncSharePointUsage',
    'syncExchangeMailboxDirectory', 'syncExchangeMailboxSettings',
    'syncExchangeAcceptedDomains', 'syncExchangeMailboxUsage', 'syncExchangeMailboxRules',
    'syncAuthenticationRegistrations', 'syncAuthenticationMethodPolicy',
    'syncSignInLogs', 'syncDirectoryAuditLogs', 'syncM365AuditActivity', 'syncDirectoryRoles',
    'syncCurrentSecureScore', 'syncSecurityDefaults', 'syncDomainDnsHealth',
    'refreshCollectionFieldStates',
  ]) (service as any)[method] = async () => undefined
  ;(service as any).syncEntraCollection = async () => undefined
  let passedOwner: unknown
  ;(service as any).syncSharePointSites = async (
    _tenant: unknown, _token: string, _limits: unknown, candidate: unknown,
  ) => { passedOwner = candidate; throw new TenantVisitLeaseLostError() }
  await assert.rejects(
    () => (service as any).syncConnectedTenantWithinMemoryLane(
      fullTenant, true, { includeBundle: false, visitOwner: owner },
    ), TenantVisitLeaseLostError,
  )
  assert.equal(passedOwner, owner)
})
