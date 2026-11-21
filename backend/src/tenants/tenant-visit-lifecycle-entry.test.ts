import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ConflictException } from '@nestjs/common'
import { TenantSyncService, runInSyncMemoryLane, settleSyncCollectorModules } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import {
  recordTenantVisitLifecycleFailure, runTenantVisitLifecycle,
  type TenantVisitLifecycleStore,
} from './tenant-visit-lifecycle.js'
import { fetchMicrosoftWithRetry } from '../microsoft/microsoft-request.js'
import { M365ManagementActivityService } from './m365-management-activity.service.js'

function env(t: TestContext, key: string, value: string | undefined) {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
}

const tenant = {
  id: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002',
  microsoftTenantId: '00000000-0000-4000-8000-000000000003', status: 'ACTIVE',
  connection: { status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED' }, syncStates: [],
}
const scope = { customerTenantId: tenant.id, organizationId: tenant.organizationId }
const owner = { ...scope, token: '00000000-0000-4000-8000-000000000004', generation: 7n, expiresAt: new Date('2030-01-01') }
const result = { bundle: { synthetic: true }, status: 'SUCCEEDED', failedResources: [] }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
function fixture(busy = false) {
  const events: string[] = []
  const store: TenantVisitLifecycleStore = {
    acquire: async actual => { assert.deepEqual(actual, scope); events.push('acquire'); return busy ? null : owner },
    renew: async actual => { assert.equal(actual, owner); events.push('renew'); return owner },
    release: async actual => { assert.equal(actual, owner); events.push('release'); return true },
  }
  const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).tenantVisitStore = () => store
  ;(service as any).getReadableTenant = async () => tenant
  ;(service as any).readScheduledCandidateWindow = async () => ({ candidateTenants: [tenant], firstSegmentLength: 1 })
  ;(service as any).syncConnectedTenantWithinMemoryLane = async (_tenant: unknown, _busy: unknown, options: any) => {
    assert.equal(options.visitOwner, owner); events.push('collect'); return result
  }
  ;(service as any).runPostSyncIdentityRiskEvaluation = async (_tenant: unknown, _deadline: unknown, _attempt: unknown, _diagnostic: unknown, actual: unknown) => {
    assert.equal(actual, owner); events.push('risk')
  }
  ;(service as any).logger = { log: () => {}, warn: () => {} }
  return { events, store, service }
}

test('actual manual and scheduled entries keep busy semantics and owner through scheduled risk', async t => {
  env(t, 'HAWKVIEW_TENANT_VISIT_FENCING', 'enabled')
  env(t, 'HAWKVIEW_IDENTITY_RISK_ROLLOUT', undefined)
  const manual = fixture()
  assert.deepEqual(await manual.service.syncUsersForIdentity({} as any, tenant.id), result.bundle)
  assert.deepEqual(manual.events, ['acquire', 'collect', 'release'])

  const scheduled = fixture()
  assert.equal((await scheduled.service.syncDueTenants()).succeeded, 1)
  assert.deepEqual(scheduled.events, ['acquire', 'collect', 'risk', 'release'])

  const busyManual = fixture(true)
  await assert.rejects(busyManual.service.syncUsersForIdentity({} as any, tenant.id), ConflictException)
  assert.deepEqual(busyManual.events, ['acquire'])
  const busyScheduled = fixture(true)
  const summary = await busyScheduled.service.syncDueTenants()
  assert.equal(summary.skipped, 1); assert.equal(summary.failed, 0)
  assert.deepEqual(busyScheduled.events, ['acquire'])
})

test('the default-OFF manual entry does not acquire or supply a visit owner', async t => {
  env(t, 'HAWKVIEW_TENANT_VISIT_FENCING', undefined)
  const f = fixture()
  ;(f.service as any).syncConnectedTenantWithinMemoryLane = async (_tenant: unknown, _busy: unknown, options: any) => {
    assert.equal(options.visitOwner, undefined); f.events.push('legacy-collect'); return result
  }
  await f.service.syncUsersForIdentity({} as any, tenant.id)
  assert.deepEqual(f.events, ['legacy-collect'])
})

test('real manual orchestration admits owner before USERS and token work and does not compensate lease loss', async t => {
  env(t, 'HAWKVIEW_TENANT_VISIT_FENCING', 'enabled')
  const f = fixture()
  const transaction = {
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes("current_setting('TimeZone')")) return [{ timezone: 'UTC' }]
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) { f.events.push('owner-check'); return [{ generation: '7' }] }
      assert.fail(sql)
    },
    syncState: {
      findUnique: async () => { f.events.push('users-read'); return { id: 'users', deltaLink: 'synthetic-delta' } },
      updateMany: async () => { f.events.push('users-claim'); return { count: 1 } },
      update: async () => assert.fail('lease loss must not compensate with FAILED'),
    },
  }
  const service = new TenantSyncService({ $transaction: async (work: any) => work(transaction) } as any,
    { getTenantAccessToken: async () => { f.events.push('provider'); throw new TenantVisitLeaseLostError() } } as any,
    {} as any, {} as any, {} as any, {} as any)
  ;(service as any).getReadableTenant = async () => tenant
  ;(service as any).tenantVisitStore = () => f.store
  await assert.rejects(service.syncUsersForIdentity({} as any, tenant.id), TenantVisitLeaseLostError)
  assert.deepEqual(f.events, ['acquire', 'owner-check', 'users-read', 'owner-check', 'users-claim', 'provider', 'release'])
})

test('queued manual entry acquires only after the process memory lane is available', async t => {
  env(t, 'HAWKVIEW_TENANT_VISIT_FENCING', 'enabled')
  const f = fixture(), unblock = deferred(), entered = deferred()
  const blocker = runInSyncMemoryLane(async () => { entered.resolve(); await unblock.promise })
  await entered.promise
  const waiting = f.service.syncUsersForIdentity({} as any, tenant.id)
  await flush(); assert.deepEqual(f.events, [])
  unblock.resolve(); await blocker; await waiting
  assert.deepEqual(f.events, ['acquire', 'collect', 'release'])
})

test('Exchange verification entry holds the visit through the snapshot and connection callback', async t => {
  env(t, 'HAWKVIEW_TENANT_VISIT_FENCING', 'enabled')
  for (const busy of [false, true]) {
    const f = fixture(busy)
    ;(f.service as any).microsoftConsent = {
      getTenantExchangeAccessToken: async () => { f.events.push('token'); return 'synthetic' },
    }
    ;(f.service as any).collectExchangeReadOnlyMailboxes = async () => { f.events.push('collect'); return [] }
    ;(f.service as any).saveSnapshot = async (_tenant: unknown, resource: string, _result: unknown, persist: any,
      _attestable: unknown, _reason: unknown, _merge: unknown, actualOwner: unknown) => {
      assert.equal(resource, 'EXCHANGE_MAILBOX_CONFIGURATION'); assert.equal(actualOwner, owner)
      f.events.push('snapshot')
      await persist({ tenantConnection: { update: async () => { f.events.push('connection') } } })
    }
    if (busy) {
      await assert.rejects(f.service.verifyExchangeReadOnlyForIdentity({} as any, tenant.id), ConflictException)
      assert.deepEqual(f.events, ['acquire'])
    } else {
      assert.equal((await f.service.verifyExchangeReadOnlyForIdentity({} as any, tenant.id)).enabled, true)
      assert.deepEqual(f.events, ['acquire', 'token', 'collect', 'snapshot', 'connection', 'release'])
    }
  }
})

test('scheduled risk failure drains before cleanup and cannot report successful sync', async t => {
  env(t, 'HAWKVIEW_TENANT_VISIT_FENCING', 'enabled')
  env(t, 'HAWKVIEW_IDENTITY_RISK_ROLLOUT', undefined)
  const f = fixture(), finish = deferred(), entered = deferred()
  ;(f.service as any).runPostSyncIdentityRiskEvaluation = async () => {
    f.events.push('risk'); entered.resolve(); await finish.promise; throw new TenantVisitLeaseLostError()
  }
  const running = f.service.syncDueTenants()
  await entered.promise
  assert.deepEqual(f.events, ['acquire', 'collect', 'risk'])
  finish.resolve()
  assert.equal((await running).failed, 1)
  assert.equal(f.events.at(-1), 'release')
})

test('actual collector settlement stops queued work on peer loss but drains an active peer before release', async () => {
  const f = fixture(), lose = deferred(), finishPeer = deferred()
  const running = runTenantVisitLifecycle(f.store, scope, async () => settleSyncCollectorModules([
    { resource: 'USERS', synchronize: async () => { f.events.push('heavy'); await lose.promise; throw new TenantVisitLeaseLostError() } },
    { resource: 'DOMAINS', synchronize: async () => { assert.fail('queued collector started after loss') } },
    { resource: 'RUNTIME_TELEMETRY', synchronize: async () => { f.events.push('peer'); await finishPeer.promise; f.events.push('peer-settled') } },
  ]))
  const rejected = assert.rejects(running, TenantVisitLeaseLostError)
  await flush(); assert.ok(f.events.includes('heavy')); assert.ok(f.events.includes('peer'))
  lose.resolve(); await flush()
  assert.equal(f.events.includes('release'), false)
  finishPeer.resolve(); await rejected
  assert.deepEqual(f.events.slice(-2), ['peer-settled', 'release'])
})

test('Microsoft retry never starts a new request after known lease loss', async () => {
  const f = fixture()
  let calls = 0
  await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => fetchMicrosoftWithRetry(
    'https://graph.microsoft.com/v1.0/users', {}, {
      label: 'synthetic', fetchImpl: async () => { calls++; return new Response('', { status: 503 }) },
      wait: async () => recordTenantVisitLifecycleFailure(new TenantVisitLeaseLostError()),
    },
  )), TenantVisitLeaseLostError)
  assert.equal(calls, 1)
  const lost = new TenantVisitLeaseLostError()
  await assert.rejects(fetchMicrosoftWithRetry('https://graph.microsoft.com/v1.0/users', {}, {
    label: 'synthetic', fetchImpl: async () => { throw lost }, wait: async () => assert.fail('retried lease loss'),
  }), error => error === lost)
})

test('independent M365 request preserves lease loss and cancels a response received after loss', async t => {
  const f = fixture()
  const service = new M365ManagementActivityService({} as any, {} as any)
  let cancelled = false, calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    recordTenantVisitLifecycleFailure(new TenantVisitLeaseLostError())
    return new Response(new ReadableStream({ cancel: () => { cancelled = true } }))
  })
  await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => (service as any).request(
    `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/list`,
    {}, tenant.microsoftTenantId, tenant.microsoftTenantId, Date.now() + 10000,
  )), TenantVisitLeaseLostError)
  assert.equal(calls, 1); assert.equal(cancelled, true)
})


test('M365 does not start a request when lease loss arrives during preflight commit', async t => {
  const f = fixture()
  const service = new M365ManagementActivityService({
    $transaction: async (work: any) => {
      await work({ $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: owner.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: owner.customerTenantId }]
        return [{ generation: owner.generation.toString() }]
      } })
      recordTenantVisitLifecycleFailure(new TenantVisitLeaseLostError())
    },
  } as any, {} as any)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('provider request started after preflight lost ownership'))
  await assert.rejects(runTenantVisitLifecycle(f.store, scope, async () => (service as any).request(
    `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/list`,
    {}, tenant.microsoftTenantId, tenant.microsoftTenantId, Date.now() + 10000, owner,
  )), TenantVisitLeaseLostError)
})
