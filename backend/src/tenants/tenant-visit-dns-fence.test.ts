import assert from 'node:assert/strict'
import { Resolver } from 'node:dns/promises'
import test, { mock } from 'node:test'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant-dns', organizationId: 'organization-dns' }
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

test('DNS result cannot advance snapshot, status or evidence after visit takeover', async () => {
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
      upsert: async () => { events.push('snapshot-upsert') },
    },
    changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
  }
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
    tenantDomain: { findMany: async () => { events.push('domain-read'); return [{ name: 'example.test' }] } },
  }
  const service = new TenantSyncService(prisma as any, {} as any, {} as any,
    { resolveIncident: async () => { events.push('resolve') },
      publishIncident: async () => { events.push('publish') } } as any,
    {} as any, {} as any)
  const txt = mock.method(Resolver.prototype, 'resolveTxt', async () => {
    events.push('dns-txt')
    return [['v=spf1 -all']]
  })
  const cname = mock.method(Resolver.prototype, 'resolveCname', async () => {
    events.push('dns-cname')
    return ['dkim.example.test']
  })
  try {
    await assert.rejects(() => (service as any).syncDomainDnsHealth(tenant, owner),
      TenantVisitLeaseLostError)
  } finally {
    txt.mock.restore()
    cname.mock.restore()
  }
  assert.deepEqual(events.slice(0, 3), ['owner-check', 'running', 'domain-read'])
  assert.equal(events.filter((event) => event === 'dns-txt').length, 2)
  assert.equal(events.filter((event) => event === 'dns-cname').length, 2)
  assert.equal(events.at(-1), 'owner-check')
  assert.equal(events.some((event) =>
    ['snapshot-lock', 'snapshot-read', 'snapshot-upsert', 'evidence-write', 'terminal', 'resolve', 'publish'].includes(event)), false)
})

test('between-inventory and audit-triggered DNS reentry forward the visit owner', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  const calls: unknown[][] = []
  ;(service as any).syncDomainDnsHealth = async (...args: unknown[]) => { calls.push(args) }
  const module = (service as any).incrementalInventoryModule(
    tenant, 'synthetic-token', 'DOMAIN_DNS_HEALTH', owner,
  )
  await module.synchronize()
  ;(service as any).pendingAuditReconciliationWork = async () => []
  await (service as any).reconcileDirectoryAuditResources(
    tenant, 'synthetic-token', ['DOMAIN_DNS_HEALTH'], owner,
  )
  assert.deepEqual(calls, [[tenant, owner], [tenant, owner]])
})

test('full secondary DNS catch rethrows exact visit loss', async () => {
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
    'syncSharePointSites', 'syncSharePointSettings', 'syncSharePointUsage',
    'syncExchangeMailboxDirectory', 'syncExchangeMailboxSettings',
    'syncExchangeAcceptedDomains', 'syncExchangeMailboxUsage', 'syncExchangeMailboxRules',
    'syncAuthenticationRegistrations', 'syncAuthenticationMethodPolicy',
    'syncSignInLogs', 'syncDirectoryAuditLogs', 'syncM365AuditActivity', 'syncDirectoryRoles',
    'syncCurrentSecureScore', 'syncSecurityDefaults',
  ]) (service as any)[method] = async () => undefined
  ;(service as any).syncEntraCollection = async () => undefined
  let passedOwner: unknown
  ;(service as any).syncDomainDnsHealth = async (_tenant: unknown, candidate: unknown) => {
    passedOwner = candidate
    throw new TenantVisitLeaseLostError()
  }
  await assert.rejects(
    () => (service as any).syncConnectedTenantWithinMemoryLane(
      fullTenant, true, { includeBundle: false, visitOwner: owner },
    ), TenantVisitLeaseLostError,
  )
  assert.equal(passedOwner, owner)
})
