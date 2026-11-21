import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const PRIVATE_ERROR = 'synthetic-access-token=never-log-this provider-payload user@private.example'
const tenantId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

function leaseLoss() {
  const error = new TenantVisitLeaseLostError()
  error.message = PRIVATE_ERROR
  error.stack = PRIVATE_ERROR
  return error
}

const cases = [
  { name: 'direct ownership loss', error: () => leaseLoss(), code: 'TENANT_VISIT_LEASE_LOST' },
  { name: 'wrapped ownership loss', error: () => new Error(PRIVATE_ERROR, { cause: leaseLoss() }), code: 'TENANT_VISIT_LEASE_LOST' },
  { name: 'ordinary failure', error: () => new Error(PRIVATE_ERROR), code: 'TENANT_SYNC_FAILED' },
  { name: 'name-only ownership impersonation', error: () => ({ name: 'TenantVisitLeaseLostError', message: PRIVATE_ERROR }), code: 'TENANT_SYNC_FAILED' },
  { name: 'unrecognized nested cause', error: () => new Error(PRIVATE_ERROR, {
    cause: new Error(PRIVATE_ERROR, { cause: leaseLoss() }),
  }), code: 'TENANT_SYNC_FAILED' },
] as const

for (const scenario of cases) {
  test(`scheduled ${scenario.name} logs only its safe code and internal tenant without retrying`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW })
    const settings = {
      HAWKVIEW_SYNC_ADMISSION_PAUSED: undefined,
      HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
      HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED: 'true',
      SCHEDULED_SYNC_BATCH_SIZE: '2',
      SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT: '2',
    }
    const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    t.after(() => {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    const candidates = [1, 2].map(value => ({
      id: tenantId(value), organizationId: tenantId(100),
      microsoftTenantId: tenantId(200 + value), displayName: 'Private customer',
      primaryDomain: 'private.example', status: 'ACTIVE',
      connection: { status: 'CONNECTED', exchangeReadOnlyEnabledAt: null }, syncStates: [],
    }))
    const before = structuredClone(candidates)
    const calls: string[] = []
    const warnings: unknown[][] = [], logs: unknown[][] = []
    const database: any = {
      scheduledSyncCursor: {
        createMany: async () => { calls.push('cursor-create'); return { count: 1 } },
        findUnique: async () => {
          calls.push('cursor-read')
          return { scopeKey: 'TENANT_SYNC', afterTenantId: null, revision: 0 }
        },
        updateMany: async () => { calls.push('cursor-advance'); return { count: 1 } },
      },
      customerTenant: { findMany: async () => { calls.push('candidate-read'); return candidates } },
    }
    const service = new TenantSyncService(database, {} as any, {} as any, {} as any, {} as any, {} as any)
    ;(service as any).logger = {
      warn: (...args: unknown[]) => { warnings.push(args) },
      log: (...args: unknown[]) => { logs.push(args) },
    }
    ;(service as any).syncConnectedTenant = async (tenant: { id: string }) => {
      calls.push(tenant.id)
      if (tenant.id === candidates[0].id) throw scenario.error()
      return { status: 'SUCCEEDED', failedResources: [] }
    }

    const summary = await service.syncDueTenants(NOW.getTime() + 240_000)
    assert.deepEqual(summary, {
      checkedAt: NOW.toISOString(), due: 2, succeeded: 1, partial: 0, failed: 1, skipped: 0,
    }, 'ownership loss remains FAILED and the API summary remains aggregate-only')
    assert.deepEqual(calls, [
      'cursor-create', 'cursor-read', 'candidate-read', 'cursor-advance', candidates[0].id, candidates[1].id,
    ], 'the scheduler must continue to the next tenant without retrying or additional failure writes')
    assert.deepEqual(candidates, before, 'diagnostics cannot mutate existing retry state')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].length, 1, 'no raw Error or stack is passed as an extra logger argument')
    assert.equal(typeof warnings[0][0], 'string')
    assert.deepEqual(JSON.parse(warnings[0][0] as string), {
      event: 'scheduled_tenant_sync_failure', tenantId: candidates[0].id, failureCode: scenario.code,
    })
    const output = JSON.stringify({ warnings, logs, summary })
    for (const privateValue of [PRIVATE_ERROR, 'Private customer', 'private.example',
      ...candidates.map(tenant => tenant.microsoftTenantId)]) {
      assert.equal(output.includes(privateValue), false, 'diagnostics must not contain provider or customer payloads')
    }
  })
}
