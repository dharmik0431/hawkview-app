import assert from 'node:assert/strict'
import test from 'node:test'
import { ScheduledSyncController } from './scheduled-sync.controller.js'
import { TenantSyncService } from './tenant-sync.service.js'

test('one entry clock charges auth/maintenance/risk and preserves the fixed collector admission boundary', async () => {
  const config = { HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
    HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'synthetic',
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined }
  const prior = Object.fromEntries(Object.keys(config).map(k => [k, process.env[k]]))
  const clock = Date.now; let now = 1_000_000
  Date.now = () => now
  for (const [k,v] of Object.entries(config)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try {
    for (const scenario of ['normal', 'busy', 'risk-failure', 'maintenance-failure', 'auth-slow', 'auth-expired'] as const) {
      now = 1_000_000; const started = now; const calls: string[] = []
      const controller = new ScheduledSyncController({ verify: async () => {
        calls.push('auth'); now += scenario === 'auth-expired' ? 250_000 : scenario === 'auth-slow' ? 20_000 : 7_000
      } } as any, {
        runScheduledGlobalRiskCycle: async (deadline: number) => {
          calls.push('risk'); assert.equal(deadline, started + 45_000)
          if (scenario !== 'busy') now = deadline
          if (scenario === 'risk-failure') throw new Error('Synthetic failure')
        },
        syncDueTenants: async (deadline: number) => {
          calls.push('collect'); assert.equal(deadline, started + 240_000)
          if (scenario !== 'auth-expired') assert.ok(deadline - now >= 195_000)
          else assert.ok(now > deadline, 'downstream receives expired budget, not a fresh clock')
          return { status: 'ok' }
        },
      } as any, { runAuthorizedScheduledMaintenance: async (deadline: number) => {
        calls.push('maintenance'); assert.equal(deadline, started + 15_000)
        now += 5_000
        if (scenario === 'maintenance-failure') throw new Error('Synthetic failure')
        return { hasMore: false }
      } } as any)
      ;(controller as any).logger = { log() {}, warn() {} }
      assert.deepEqual(await controller.syncDueTenants({ headers: {} } as any), { status: 'ok' })
      assert.deepEqual(calls, scenario === 'auth-expired' || scenario === 'auth-slow' ? ['auth','collect'] :
        scenario === 'maintenance-failure' ? ['auth','maintenance','collect'] : ['auth','maintenance','risk','collect'])
    }
  } finally {
    Date.now = clock
    for (const [k,v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

test('expired/invalid admission performs no DB work; a slow first collector prevents a second without cancelling the first', async () => {
  const clock = Date.now; let now = clock(); const initial = now
  Date.now = () => now
  let scans = 0; const attempted: string[] = []; let completed = false
  const service = new TenantSyncService({ customerTenant: { findMany: async () => {
    scans++
    return [1,2].map(id => ({ id: `synthetic-${id}`, organizationId: 'synthetic-org',
      microsoftTenantId: `synthetic-ms-${id}`, status: 'ACTIVE', connection: { status: 'CONNECTED' }, syncStates: [] }))
  } } } as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).logger = { log() {} }
  ;(service as any).syncConnectedTenant = async (tenant: { id: string }) => {
    attempted.push(tenant.id); now += 600_000; completed = true
    return { status: 'SUCCEEDED', failedResources: [] }
  }
  ;(service as any).runPostSyncIdentityRiskEvaluation = async () => undefined
  try {
    for (const deadline of [now, now - 1, NaN, Infinity]) {
      const result = await service.syncDueTenants(deadline)
      assert.equal('admissionDeferred' in result && result.admissionDeferred, true)
    }
    assert.equal(scans, 0)
    const result = await service.syncDueTenants(initial + 240_000)
    assert.equal(scans, 1); assert.equal(completed, true)
    assert.deepEqual(attempted, ['synthetic-1']); assert.equal(result.succeeded, 1)
  } finally { Date.now = clock }
})
