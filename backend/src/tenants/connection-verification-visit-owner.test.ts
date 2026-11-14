import assert from 'node:assert/strict'
import test from 'node:test'
import { publishConnectionVerification, type CapturedConnectionVerification } from './connection-verification-store.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { TenantSyncService } from './tenant-sync.service.js'

const captured: CapturedConnectionVerification = {
  tenant: { id: 'tenant', organizationId: 'organization', microsoftTenantId: 'microsoft', status: 'ACTIVE', revision: 'tenant-v1' },
  connection: { id: 'connection', incarnation: 'incarnation', mode: 'HAWKVIEW_MANAGED', clientId: 'client',
    credentialReference: 'credential', permissions: ['Directory.Read.All'], status: 'CONNECTED', revision: 'connection-v1' },
  authority: { configurationRevision: 'revision', clientId: 'client', homeTenantId: 'home',
    credentialReference: 'encrypted-secret:revision' },
}
const owner = { organizationId: 'organization', customerTenantId: 'tenant', token: 'token',
  generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z') }
const failure = { outcome: 'failed' as const, message: 'Synthetic authentication failure.', authenticationFailure: true }

function fixture(live: boolean) {
  const trace: string[] = []
  let active = false
  const db = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      assert.equal(active, false)
      trace.push('transaction')
      active = true
      try { return await work(db) } finally { active = false }
    },
    $queryRawUnsafe: async (sql: string) => {
      assert.equal(active, true)
      if (sql.includes('pg_advisory_xact_lock_shared')) { trace.push('G-lock'); return [{ locked: 1 }] }
      if (sql.includes('FROM platform_microsoft_connectors')) { trace.push('G-row'); return [captured.authority] }
      if (sql.includes('FROM organizations')) { trace.push('organization-lock'); return [{ id: owner.organizationId }] }
      if (sql.includes('FROM customer_tenants') && !sql.includes('verification:tenant')) {
        trace.push('owner-tenant-lock'); return [{ id: owner.customerTenantId }]
      }
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        trace.push('owner-lock'); return live ? [{ generation: '4' }] : []
      }
      if (sql.includes('verification:tenant')) { trace.push('tenant-lock'); return [captured.tenant] }
      if (sql.includes('verification:connection')) { trace.push('connection-lock'); return [captured.connection] }
      if (sql.includes('verification:roles')) { trace.push('roles-lock'); return [{ id: 'roles' }] }
      assert.fail(`Unexpected query: ${sql}`)
    },
    $executeRawUnsafe: async (sql: string) => {
      assert.equal(active, true)
      if (sql.includes('verification:publish-tenant')) { trace.push('tenant-write'); return 1 }
      if (sql.includes('verification:publish-connection')) { trace.push('connection-write'); return 1 }
      if (sql.includes('verification:invalidate-roles')) { trace.push('roles-write'); return 1 }
      assert.fail(`Unexpected write: ${sql}`)
    },
  }
  const publish = (visitOwner?: typeof owner) => publishConnectionVerification(db as any, captured, failure, visitOwner)
  return { db, trace, publish }
}

test('managed publication rejects a foreign visit scope before entering a transaction', async () => {
  const { trace, publish } = fixture(true)
  await assert.rejects(publish({ ...owner, customerTenantId: 'another-tenant' }),
    (error: unknown) => error instanceof TenantVisitLeaseLostError)
  assert.deepEqual(trace, [])
})

test('managed publication rejects a superseded visit before captured tenant or connection writes', async () => {
  const { trace, publish } = fixture(false)
  await assert.rejects(publish(owner), (error: unknown) => error instanceof TenantVisitLeaseLostError)
  assert.deepEqual(trace, ['transaction', 'G-lock', 'G-row', 'organization-lock', 'owner-tenant-lock', 'owner-lock'])
})

test('managed publication holds visit ownership with the authority and connection writes', async () => {
  const { trace, publish } = fixture(true)
  assert.deepEqual(await publish(owner), { status: 'applied', connected: false })
  assert.deepEqual(trace, [
    'transaction', 'G-lock', 'G-row', 'organization-lock', 'owner-tenant-lock', 'owner-lock',
    'tenant-lock', 'connection-lock', 'roles-lock', 'tenant-write', 'connection-write', 'roles-write',
  ])
})

test('ownerless managed publication retains the existing captured-authority path', async () => {
  const { trace, publish } = fixture(false)
  assert.deepEqual(await publish(), { status: 'applied', connected: false })
  assert.deepEqual(trace, [
    'transaction', 'G-lock', 'G-row', 'tenant-lock', 'connection-lock', 'roles-lock',
    'tenant-write', 'connection-write', 'roles-write',
  ])
})

test('managed connection-loss caller forwards a live visit owner into publication', async () => {
  const { db, trace } = fixture(true)
  const service: any = Object.create(TenantSyncService.prototype)
  service.prisma = db
  service.notifications = { publishIncident: () => assert.fail('managed failure emits no separate incident') }
  await service.markConnectionUnavailable(
    { id: 'tenant', organizationId: 'organization', connection: { connectionMode: 'HAWKVIEW_MANAGED' } },
    new Error('Synthetic authentication failure.'), captured, owner,
  )
  assert.deepEqual(trace, [
    'transaction', 'G-lock', 'G-row', 'organization-lock', 'owner-tenant-lock', 'owner-lock',
    'tenant-lock', 'connection-lock', 'roles-lock', 'tenant-write', 'connection-write', 'roles-write',
  ])
})

test('managed connection-loss caller forwards a superseded owner and makes no writes', async () => {
  const { db, trace } = fixture(false)
  const service: any = Object.create(TenantSyncService.prototype)
  service.prisma = db
  service.notifications = { publishIncident: () => assert.fail('managed failure emits no separate incident') }
  await assert.rejects(() => service.markConnectionUnavailable(
    { id: 'tenant', organizationId: 'organization', connection: { connectionMode: 'HAWKVIEW_MANAGED' } },
    new Error('Synthetic authentication failure.'), captured, owner,
  ), (error: unknown) => error instanceof TenantVisitLeaseLostError)
  assert.deepEqual(trace, ['transaction', 'G-lock', 'G-row', 'organization-lock', 'owner-tenant-lock', 'owner-lock'])
})
