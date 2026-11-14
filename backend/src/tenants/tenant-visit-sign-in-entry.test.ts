import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITED_SIGN_IN_ENRICHMENT_LIMITS, TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

function serviceWithLostLease(events: string[], changeEvidence: object = {}) {
  const database = {
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) { events.push('organization'); return [{ id: tenant.organizationId }] }
        if (sql.includes('FROM customer_tenants')) { events.push('tenant'); return [{ id: tenant.id }] }
        if (sql.includes('FROM tenant_sync_visit_leases')) { events.push('lease'); return [] }
        assert.fail(`Unexpected query: ${sql}`)
      },
      signInLog: { createMany: async () => assert.fail('lost owner inserted sign-ins') },
      tenantEntraSnapshot: { upsert: async () => assert.fail('lost owner wrote completion window') },
    }),
  }
  const service = new TenantSyncService(database as any, {} as any, {} as any,
    {} as any, changeEvidence as any, {} as any)
  ;(service as any).runSnapshotSync = async (_tenant: unknown, resource: string, work: () => Promise<void>, actualOwner: unknown) => {
    assert.equal(resource, 'SIGN_INS')
    assert.equal(actualOwner, owner)
    await work()
  }
  ;(service as any).logSyncStart = async () => new Date('2026-10-31T12:00:00.000Z')
  ;(service as any).signInEntitlement = async () => 'NON_PREMIUM'
  return service
}

test('SIGN_INS forwards owner to its wrapper before provider work', async () => {
  const service = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  ;(service as any).runSnapshotSync = async (_tenant: unknown, resource: string, _work: unknown, actualOwner: unknown) => {
    assert.equal(resource, 'SIGN_INS')
    assert.equal(actualOwner, owner)
    throw new TenantVisitLeaseLostError()
  }
  ;(service as any).fetchGraphCollection = async () => assert.fail('lost owner fetched provider data')
  await assert.rejects(
    () => (service as any).syncSignInLogs(tenant, 'token', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
})

test('SIGN_INS forwards owner into bounded authentication ingestion', async () => {
  const events: string[] = []
  const service = serviceWithLostLease(events, { pruneExpired: async () => assert.fail('lost owner pruned evidence') })
  ;(service as any).fetchGraphCollection = async () => [{ id: 'event', createdDateTime: new Date().toISOString() }]
  ;(service as any).pruneExpiredSignInLogs = async () => assert.fail('lost owner pruned sign-ins')
  await assert.rejects(
    () => (service as any).syncSignInLogs(tenant, 'token', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, ['organization', 'tenant', 'lease'])
})

test('SIGN_INS forwards owner to cleanup and completion-window transaction', async () => {
  const events: string[] = []
  const service = serviceWithLostLease(events, {
    pruneExpired: async (_tenant: string, _date: Date, actualOwner: unknown) => {
      assert.equal(actualOwner, owner)
      events.push('evidence-prune')
    },
  })
  ;(service as any).fetchGraphCollection = async () => []
  ;(service as any).pruneExpiredSignInLogs = async (_tenant: unknown, _date: Date, actualOwner: unknown) => {
    assert.equal(actualOwner, owner)
    events.push('sign-in-prune')
  }
  await assert.rejects(
    () => (service as any).syncSignInLogs(tenant, 'token', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, ['sign-in-prune', 'evidence-prune', 'organization', 'tenant', 'lease'])
})

test('SIGN_INS forwards owner into limited history enrichment', async () => {
  const events: string[] = []
  const service = serviceWithLostLease(events)
  ;(service as any).fetchGraphCollection = async () => { throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant') }
  ;(service as any).fetchLimitedLoginActivity = async () => []
  ;(service as any).enrichLimitedSignInLocations = async () => ({
    locations: new Map([['192.0.2.1', {}]]), partial: false, reasons: new Set(),
  })
  ;(service as any).backfillLimitedSignInLocations = async (
    _tenant: unknown, _locations: unknown, _limits: unknown, _deadline: unknown, actualOwner: unknown,
  ) => {
    assert.equal(actualOwner, owner)
    throw new TenantVisitLeaseLostError()
  }
  await assert.rejects(
    () => (service as any).syncSignInLogs(tenant, 'token', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(events, [])
})
