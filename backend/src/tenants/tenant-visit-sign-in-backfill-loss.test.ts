import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService, LIMITED_SIGN_IN_ENRICHMENT_LIMITS } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const locations = new Map([['192.0.2.1', {
  city: 'Synthetic', state: null, countryOrRegion: 'ZZ',
  geoCoordinates: { latitude: 1, longitude: 2 }, source: 'MAXMIND_GEOLITE2',
}]])
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z'),
}

test('optional sign-in history rejects a mismatched owner before database work', async () => {
  const service = new TenantSyncService({
    $transaction: async () => assert.fail('transaction opened for foreign owner'),
  } as any, {} as any, {} as any, {} as any, {} as any, {} as any)

  await assert.rejects(
    () => (service as any).backfillLimitedSignInLocations(
      tenant, locations, LIMITED_SIGN_IN_ENRICHMENT_LIMITS, undefined,
      { ...owner, customerTenantId: 'other-tenant' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
})

test('optional sign-in history checks the exact owner before page SQL', async () => {
  const operations: string[] = []
  const service = new TenantSyncService({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [] : [{ id: 'synthetic' }]
      },
      $queryRaw: async () => assert.fail('page SQL ran after lost ownership'),
      signInLog: { updateMany: async () => assert.fail('history row changed after lost ownership') },
    }),
  } as any, {} as any, {} as any, {} as any, {} as any, {} as any)

  await assert.rejects(
    () => (service as any).backfillLimitedSignInLocations(
      tenant, locations, LIMITED_SIGN_IN_ENRICHMENT_LIMITS, undefined, owner),
    (error: unknown) => error instanceof TenantVisitLeaseLostError,
  )
  assert.deepEqual(operations, ['organization', 'tenant', 'lease'])
})

test('optional sign-in history orders the owner check before page reads in one transaction', async () => {
  const operations: string[] = []
  const service = new TenantSyncService({
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRawUnsafe: async (query: string) => {
        operations.push(query.includes('organizations') ? 'organization' :
          query.includes('customer_tenants') ? 'tenant' : 'lease')
        return query.includes('tenant_sync_visit_leases') ? [{ generation: '4' }] : [{ id: 'synthetic' }]
      },
      $queryRaw: async (query: { strings: string[] }) => {
        operations.push(query.strings.join('').includes('set_config') ? 'deadline' : 'history')
        return []
      },
      signInLog: { updateMany: async () => assert.fail('empty history had a row update') },
    }),
  } as any, {} as any, {} as any, {} as any, {} as any, {} as any)

  assert.deepEqual(await (service as any).backfillLimitedSignInLocations(
    tenant, locations, LIMITED_SIGN_IN_ENRICHMENT_LIMITS, undefined, owner),
  { partial: false, updatedRows: 0 })
  assert.deepEqual(operations, ['organization', 'tenant', 'lease', 'deadline', 'history'])
})

test('optional sign-in history backfill propagates lost visit ownership', async () => {
  const lost = new TenantVisitLeaseLostError()
  let attempts = 0
  const service = new TenantSyncService({
    $transaction: async () => { attempts++; throw lost },
  } as any, {} as any, {} as any, {} as any, {} as any, {} as any)

  await assert.rejects(
    () => (service as any).backfillLimitedSignInLocations(
      tenant, locations, LIMITED_SIGN_IN_ENRICHMENT_LIMITS),
    (error: unknown) => error === lost,
  )
  assert.equal(attempts, 1)
})

test('ordinary sign-in history backfill page failure remains partial', async () => {
  let attempts = 0
  const service = new TenantSyncService({
    $transaction: async () => { attempts++; throw new Error('Synthetic statement timeout') },
  } as any, {} as any, {} as any, {} as any, {} as any, {} as any)

  assert.deepEqual(await (service as any).backfillLimitedSignInLocations(
    tenant, locations, LIMITED_SIGN_IN_ENRICHMENT_LIMITS),
  { partial: true, updatedRows: 0 })
  assert.equal(attempts, 1)
})
