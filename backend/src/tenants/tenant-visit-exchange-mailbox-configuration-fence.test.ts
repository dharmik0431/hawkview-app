import assert from 'node:assert/strict'
import test from 'node:test'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = {
  id: 'tenant-mailbox-configuration', organizationId: 'organization-mailbox-configuration',
  microsoftTenantId: 'microsoft-mailbox-configuration', status: 'ACTIVE',
  connection: {
    status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    clientId: 'synthetic-client', credentialReference: 'synthetic-reference',
    exchangeReadOnlyEnabledAt: new Date('2026-10-01T00:00:00Z'),
  },
}
const owner = {
  customerTenantId: tenant.id, organizationId: tenant.organizationId,
  token: 'visit-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

for (const outcome of ['provider-result', 'provider-failure'] as const) {
  test(`Exchange mailbox configuration ${outcome} cannot write after visit takeover`, async () => {
    const events: string[] = []
    let checks = 0
    const transaction = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql === "SELECT current_setting('TimeZone') AS timezone") return [{ timezone: 'UTC' }]
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          events.push('owner-check')
          return ++checks === 1 ? [{ generation: '4' }] : []
        }
        assert.fail(`Unexpected SQL: ${sql}`)
      },
      $executeRawUnsafe: async (sql: string) => {
        if (sql === "SET LOCAL TIME ZONE 'UTC'") return 0
        events.push('snapshot-lock')
      },
      syncState: {
        upsert: async () => { events.push('running'); return { lastSuccessfulAt: null } },
        update: async () => { events.push('terminal'); return { consecutiveFailures: 1 } },
      },
      tenantEntraSnapshot: {
        findUnique: async () => { events.push('snapshot-read'); return null },
        upsert: async () => { events.push('snapshot-write') },
      },
      changeEvidenceEvent: { createMany: async () => { events.push('evidence-write') } },
    }
    const service = new TenantSyncService({
      ...transaction,
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
    } as any, {
      getTenantExchangeAccessToken: async () => { events.push('exchange-token'); return 'synthetic-token' },
    } as any, {} as any,
    { resolveIncident: async () => { events.push('resolve') },
      publishIncident: async () => { events.push('publish') } } as any,
    { buildSnapshotDifferenceEvidence: () => [] } as any, {} as any)
    ;(service as any).logger = { log: () => undefined, warn: () => undefined }
    ;(service as any).collectExchangeReadOnlyMailboxes = async () => {
      events.push('provider-configuration')
      if (outcome === 'provider-failure') throw new Error('Provider unavailable')
      return []
    }

    await assert.rejects(
      () => (service as any).syncExchangeMailboxConfiguration(tenant, owner),
      TenantVisitLeaseLostError,
    )
    assert.deepEqual(events, [
      'owner-check', 'running', 'exchange-token', 'provider-configuration', 'owner-check',
    ])
    assert.equal(checks, 2)
  })
}

test('optional full Exchange mailbox configuration dispatch forwards exact visit loss', async () => {
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
    'syncCurrentSecureScore', 'syncSecurityDefaults', 'syncDomainDnsHealth',
    'refreshCollectionFieldStates',
  ]) (service as any)[method] = async () => undefined
  ;(service as any).syncEntraCollection = async () => undefined
  let passedOwner: unknown
  ;(service as any).syncExchangeMailboxConfiguration = async (_tenant: unknown, candidate: unknown) => {
    passedOwner = candidate
    throw new TenantVisitLeaseLostError()
  }
  await assert.rejects(
    () => (service as any).syncConnectedTenantWithinMemoryLane(
      tenant, true, { includeBundle: false, visitOwner: owner },
    ), TenantVisitLeaseLostError,
  )
  assert.equal(passedOwner, owner)
})
