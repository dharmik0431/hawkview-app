import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import {
  tenantVisitLeaseLossAt, type TenantVisitLeaseLossPair,
} from './tenant-visit-lease-diagnostics.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const PRIVATE_ERROR = 'synthetic-access-token=never-log-this provider-payload user@private.example'
const tenantId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

/** Every lease-loss fixture carries a synthetic secret in its own message,
 *  stack and forged metadata, so any of those leaking is a hard failure. */
function taint<T extends object>(error: T): T {
  return Object.assign(error, {
    message: PRIVATE_ERROR, stack: PRIVATE_ERROR,
    phase: 'admission', reason: PRIVATE_ERROR, diagnostic: PRIVATE_ERROR,
  })
}
const leaseLoss = () => taint(new TenantVisitLeaseLostError())
/** A pair recorded by a labelled lifecycle branch. */
function labelled(...pair: TenantVisitLeaseLossPair) {
  return taint(tenantVisitLeaseLossAt(...pair))
}
/** A pair that no branch may produce, to exercise emission-time validation. */
const refusedPair = (phase: string, reason: string) =>
  labelled(...([phase, reason] as unknown as TenantVisitLeaseLossPair))

const UNSPECIFIED = { phase: 'unspecified', reason: 'unspecified' } as const

/**
 * This suite's OWN expectation of the closed table, written out independently
 * rather than imported: production validation state must stay module-private,
 * and a test that imported it could not detect the table being widened.
 */
const EXPECTED_PAIRS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  admission: ['scope_mismatch'],
  local_guard: ['context_closed', 'deadline_elapsed', 'owner_mismatch'],
  renewal: ['deadline_elapsed', 'no_matching_owner', 'owner_mismatch', 'response_late', 'store_rejected'],
  release: ['no_matching_owner', 'store_rejected'],
  unspecified: ['unspecified'],
})
const isExpectedPair = (phase: unknown, reason: unknown) =>
  typeof phase === 'string' && typeof reason === 'string'
    && Object.hasOwn(EXPECTED_PAIRS, phase) && EXPECTED_PAIRS[phase].includes(reason)

const cases = [
  // Recognized by identity, produced outside a labelled branch: the fallback.
  { name: 'direct ownership loss', error: () => leaseLoss(),
    code: 'TENANT_VISIT_LEASE_LOST', pair: UNSPECIFIED },
  { name: 'wrapped ownership loss', error: () => taint(new Error('outer', { cause: leaseLoss() })),
    code: 'TENANT_VISIT_LEASE_LOST', pair: UNSPECIFIED },
  // Labelled branches, directly and through the existing single-cause unwrap.
  { name: 'labelled renewal rejection', error: () => labelled('renewal', 'store_rejected'),
    code: 'TENANT_VISIT_LEASE_LOST', pair: { phase: 'renewal', reason: 'store_rejected' } },
  { name: 'labelled renewal without a matching owner',
    error: () => taint(new Error('outer', { cause: labelled('renewal', 'no_matching_owner') })),
    code: 'TENANT_VISIT_LEASE_LOST', pair: { phase: 'renewal', reason: 'no_matching_owner' } },
  { name: 'labelled local guard', error: () => labelled('local_guard', 'deadline_elapsed'),
    code: 'TENANT_VISIT_LEASE_LOST', pair: { phase: 'local_guard', reason: 'deadline_elapsed' } },
  { name: 'labelled release', error: () => labelled('release', 'no_matching_owner'),
    code: 'TENANT_VISIT_LEASE_LOST', pair: { phase: 'release', reason: 'no_matching_owner' } },
  // A pair outside the closed table is refused at emission, not emitted.
  { name: 'pair outside the closed table',
    error: () => refusedPair('renewal', 'synthetic-secret'),
    code: 'TENANT_VISIT_LEASE_LOST', pair: UNSPECIFIED },
  { name: 'prototype-shaped phase',
    error: () => refusedPair('__proto__', 'unspecified'),
    code: 'TENANT_VISIT_LEASE_LOST', pair: UNSPECIFIED },
  // Not recognized: no pair may be emitted at all.
  { name: 'ordinary failure', error: () => new Error(PRIVATE_ERROR), code: 'TENANT_SYNC_FAILED', pair: null },
  { name: 'name-only ownership impersonation',
    error: () => ({ name: 'TenantVisitLeaseLostError', message: PRIVATE_ERROR, phase: 'renewal', reason: 'store_rejected' }),
    code: 'TENANT_SYNC_FAILED', pair: null },
  { name: 'unrecognized nested cause', error: () => taint(new Error('outer', {
    cause: taint(new Error('inner', { cause: leaseLoss() })),
  })), code: 'TENANT_SYNC_FAILED', pair: null },
  { name: 'doubly wrapped labelled loss', error: () => taint(new Error('outer', {
    cause: taint(new Error('inner', { cause: labelled('renewal', 'store_rejected') })),
  })), code: 'TENANT_SYNC_FAILED', pair: null },
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
    const logged = JSON.parse(warnings[0][0] as string) as Record<string, unknown>
    // Read before asserting: `assert.deepEqual` is declared `asserts actual is
    // T`, so asserting first narrows `logged` and hides these reads.
    const emittedKeys = Object.keys(logged)
    const emittedPhase = logged.phase, emittedReason = logged.reason
    if (scenario.pair) {
      assert.ok(isExpectedPair(emittedPhase, emittedReason),
        'the emitted pair must be one this suite independently allows')
    }
    assert.deepEqual(emittedKeys, scenario.pair
      ? ['event', 'tenantId', 'failureCode', 'phase', 'reason']
      : ['event', 'tenantId', 'failureCode'], 'an unrecognized failure gains no diagnostic keys')
    assert.deepEqual(logged, {
      event: 'scheduled_tenant_sync_failure', tenantId: candidates[0].id, failureCode: scenario.code,
      ...(scenario.pair ?? {}),
    }, 'exactly the allowed keys, and only an allowed pair')
    const output = JSON.stringify({ warnings, logs, summary })
    for (const privateValue of [PRIVATE_ERROR, 'synthetic-secret', 'Private customer', 'private.example',
      ...candidates.map(tenant => tenant.microsoftTenantId)]) {
      assert.equal(output.includes(privateValue), false, 'diagnostics must not contain provider or customer payloads')
    }
  })
}

test('successful and skipped scheduled visits log no failure diagnostics at all', async t => {
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
  const warnings: unknown[][] = []
  const database: any = {
    scheduledSyncCursor: {
      createMany: async () => ({ count: 1 }),
      findUnique: async () => ({ scopeKey: 'TENANT_SYNC', afterTenantId: null, revision: 0 }),
      updateMany: async () => ({ count: 1 }),
    },
    customerTenant: { findMany: async () => candidates },
  }
  const service = new TenantSyncService(database, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).logger = { warn: (...args: unknown[]) => { warnings.push(args) }, log: () => {} }
  ;(service as any).syncConnectedTenant = async (tenant: { id: string }) => ({
    status: tenant.id === candidates[0].id ? 'SKIPPED' : 'SUCCEEDED', failedResources: [],
  })
  const summary = await service.syncDueTenants(NOW.getTime() + 240_000)
  assert.deepEqual(summary, {
    checkedAt: NOW.toISOString(), due: 2, succeeded: 1, partial: 0, failed: 0, skipped: 1,
  }, 'the busy and successful aggregate is unchanged')
  assert.deepEqual(warnings, [], 'no failure diagnostics are emitted without a failure')
})
