import assert from 'node:assert/strict'
import test from 'node:test'
import { RiskGlobalWorkStore } from '../identity-risk/risk-global-work-store.js'
import { WrappedRiskKeyStore } from '../identity-risk/wrapped-risk-key-store.js'
import { LIMITED_SIGN_IN_ENRICHMENT_LIMITS, TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError, tenantVisitLeaseLoss } from './tenant-visit-lease-error.js'

const tenant = { id: 'tenant', organizationId: 'organization' }
const owner = { organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: 'owner-token', generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z') }
const riskConfig = {
  HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'visit-test',
  HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined,
} as const

async function withRiskConfig(work: () => Promise<void>) {
  const prior = Object.fromEntries(Object.keys(riskConfig).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(riskConfig)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { await work() }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function service() {
  const instance = new TenantSyncService({} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any)
  ;(instance as any).riskAssessmentProjector = {}
  ;(instance as any).logger = { warn() {} }
  return instance
}

test('only an exact direct or risk-transaction-wrapped visit loss is unwrapped', () => {
  const lost = new TenantVisitLeaseLostError()
  assert.equal(tenantVisitLeaseLoss(lost), lost)
  assert.equal(tenantVisitLeaseLoss(new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE', { cause: lost })), lost)
  assert.equal(tenantVisitLeaseLoss(new Error('ordinary risk failure')), null)
  assert.equal(tenantVisitLeaseLoss(new Error('nested', { cause: new Error('wrapped', { cause: lost }) })), null)
})

test('scoped risk forwards owner to attempt write and propagates wrapped ownership loss', async () => {
  await withRiskConfig(async () => {
    const prototype = RiskGlobalWorkStore.prototype as any
    const prior = { claimCycle: prototype.claimCycle, recordAttempt: prototype.recordAttempt,
      releaseCycle: prototype.releaseCycle }
    const calls: string[] = []
    const lost = new TenantVisitLeaseLostError()
    try {
      prototype.claimCycle = async () => ({ environment: 'visit-test', id: 'cycle' })
      prototype.recordAttempt = async (scope: any, _lease: unknown, _deadline: number, actualOwner: unknown) => {
        assert.deepEqual(scope, { organizationId: tenant.organizationId, customerTenantId: tenant.id, environment: 'visit-test' })
        assert.equal(actualOwner, owner)
        calls.push('attempt')
        throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE', { cause: lost })
      }
      prototype.releaseCycle = async () => { calls.push('release') }
      await assert.rejects(() => (service() as any).runScopedPostSyncRisk(tenant, owner),
        (error: unknown) => error === lost)
      assert.deepEqual(calls, ['attempt', 'release'])
    } finally { Object.assign(prototype, prior) }
  })
})

test('post-SIGN_INS risk bridge forwards owner and does not swallow ownership loss', async () => {
  await withRiskConfig(async () => {
    const instance = service()
    ;(instance as any).prisma = { syncState: { findFirst: async () => ({
      status: 'SUCCEEDED', lastSuccessfulAt: new Date(), lastAttemptAt: new Date(), lastErrorCode: null,
    }) } }
    ;(instance as any).runSnapshotSync = async (_tenant: unknown, _resource: unknown, _work: unknown, actualOwner: unknown) => {
      assert.equal(actualOwner, owner)
    }
    const lost = new TenantVisitLeaseLostError()
    ;(instance as any).runScopedPostSyncRisk = async (_tenant: unknown, actualOwner: unknown) => {
      assert.equal(actualOwner, owner)
      throw lost
    }
    await assert.rejects(() => (instance as any).syncSignInLogs(tenant, 'token', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, owner),
      (error: unknown) => error === lost)
  })
})

test('ownerless scoped risk still treats an ordinary attempt failure as best effort', async () => {
  await withRiskConfig(async () => {
    const prototype = RiskGlobalWorkStore.prototype as any
    const prior = { claimCycle: prototype.claimCycle, recordAttempt: prototype.recordAttempt,
      releaseCycle: prototype.releaseCycle }
    const calls: string[] = []
    try {
      prototype.claimCycle = async () => ({ environment: 'visit-test', id: 'cycle' })
      prototype.recordAttempt = async (_scope: unknown, _lease: unknown, _deadline: number, actualOwner: unknown) => {
        assert.equal(actualOwner, undefined)
        calls.push('attempt')
        throw new Error('ordinary risk failure')
      }
      prototype.releaseCycle = async () => { calls.push('release') }
      await assert.doesNotReject(() => (service() as any).runScopedPostSyncRisk(tenant))
      assert.deepEqual(calls, ['attempt', 'release'])
    } finally { Object.assign(prototype, prior) }
  })
})

// Call-level ownership witness. A same-transaction database visit check is
// also required before activation.
test('post-attempt key setup receives the exact visit owner', async () => {
  await withRiskConfig(async () => {
    const attempts = RiskGlobalWorkStore.prototype as any
    const keys = WrappedRiskKeyStore.prototype as any
    const prior = {
      claimCycle: attempts.claimCycle,
      recordAttempt: attempts.recordAttempt,
      releaseCycle: attempts.releaseCycle,
      ensureVersion: keys.ensureVersion,
    }
    const calls: string[] = []
    let keyOwner: unknown = null
    try {
      attempts.claimCycle = async () => ({ environment: 'visit-test', id: 'cycle' })
      attempts.recordAttempt = async (_scope: unknown, _lease: unknown, _deadline: number, actualOwner: unknown) => {
        assert.equal(actualOwner, owner)
        calls.push('attempt')
        return 'attempt-id'
      }
      keys.ensureVersion = async (_scope: unknown, _deadline: number, _ineligible: unknown, actualOwner: unknown) => {
        keyOwner = actualOwner
        calls.push('key')
        return {}
      }
      attempts.releaseCycle = async () => { calls.push('release') }
      const instance = service()
      ;(instance as any).runPostSyncIdentityRiskEvaluation = async () => { calls.push('evaluation') }
      await (instance as any).runScopedPostSyncRisk(tenant, owner)
      assert.deepEqual(calls, ['attempt', 'key', 'evaluation', 'release'])
      assert.equal(keyOwner, owner, 'a prior guarded attempt is not a guard on later key writes')
    } finally {
      attempts.claimCycle = prior.claimCycle
      attempts.recordAttempt = prior.recordAttempt
      attempts.releaseCycle = prior.releaseCycle
      keys.ensureVersion = prior.ensureVersion
    }
  })
})

test('post-attempt key ownership loss stops evaluation and survives risk cleanup', async () => {
  await withRiskConfig(async () => {
    const attempts = RiskGlobalWorkStore.prototype as any
    const keys = WrappedRiskKeyStore.prototype as any
    const prior = {
      claimCycle: attempts.claimCycle,
      recordAttempt: attempts.recordAttempt,
      releaseCycle: attempts.releaseCycle,
      ensureVersion: keys.ensureVersion,
    }
    const calls: string[] = []
    const lost = new TenantVisitLeaseLostError()
    try {
      attempts.claimCycle = async () => ({ environment: 'visit-test', id: 'cycle' })
      attempts.recordAttempt = async () => { calls.push('attempt'); return 'attempt-id' }
      keys.ensureVersion = async (_scope: unknown, _deadline: number, _ineligible: unknown, actualOwner: unknown) => {
        assert.equal(actualOwner, owner)
        calls.push('key')
        throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE', { cause: lost })
      }
      attempts.releaseCycle = async () => { calls.push('release') }
      const instance = service()
      ;(instance as any).runPostSyncIdentityRiskEvaluation = async () => { calls.push('evaluation') }
      await assert.rejects(() => (instance as any).runScopedPostSyncRisk(tenant, owner),
        (error: unknown) => error === lost)
      assert.deepEqual(calls, ['attempt', 'key', 'release'])
    } finally {
      attempts.claimCycle = prior.claimCycle
      attempts.recordAttempt = prior.recordAttempt
      attempts.releaseCycle = prior.releaseCycle
      keys.ensureVersion = prior.ensureVersion
    }
  })
})

test('automatic risk key setup checks visit ownership on its transaction connection', async () => {
  await withRiskConfig(async () => {
    const scope = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      customerTenantId: '22222222-2222-4222-8222-222222222222',
      environment: 'visit-test',
    }
    const visitOwner = { ...owner, organizationId: scope.organizationId, customerTenantId: scope.customerTenantId }
    const queries: string[] = []
    const client = { query: async (sql: string) => {
      queries.push(sql)
      if (sql.includes('identity_risk_operational_controls')) return { rows: [] }
      if (sql.includes('FROM organizations')) return { rows: [{ id: scope.organizationId }] }
      if (sql.includes('FROM customer_tenants')) return { rows: [{ id: scope.customerTenantId }] }
      if (sql.includes('FROM tenant_connections')) return { rows: [{ id: 'connection' }] }
      if (sql.includes('FROM tenant_sync_visit_leases')) return { rows: [] }
      return { rows: [] }
    } }
    await assert.rejects(() => (new WrappedRiskKeyStore() as any).assertAutomaticScope(client, scope, undefined, visitOwner),
      TenantVisitLeaseLostError)
    const tenantLock = queries.findIndex(sql => sql.includes('FROM customer_tenants') && sql.includes('FOR NO KEY UPDATE'))
    const leaseCheck = queries.findIndex(sql => sql.includes('FROM tenant_sync_visit_leases') && sql.includes('FOR SHARE'))
    assert.ok(tenantLock >= 0 && leaseCheck > tenantLock, 'tenant lock precedes same-transaction lease check')
    assert.equal(queries.some(sql => sql.includes('identity_risk_pseudonym_key_versions')), false)
  })
})

// Call-level ownership witness for the evaluator handoff. Passing this
// owner is necessary but does not fence evaluator claim/completion writes.
test('post-attempt evaluation receives the exact visit owner', async () => {
  await withRiskConfig(async () => {
    const attempts = RiskGlobalWorkStore.prototype as any
    const keys = WrappedRiskKeyStore.prototype as any
    const prior = {
      claimCycle: attempts.claimCycle,
      recordAttempt: attempts.recordAttempt,
      releaseCycle: attempts.releaseCycle,
      ensureVersion: keys.ensureVersion,
    }
    let evaluationOwner: unknown
    try {
      attempts.claimCycle = async () => ({ environment: 'visit-test', id: 'cycle' })
      attempts.recordAttempt = async (_scope: unknown, _lease: unknown, _deadline: number, actualOwner: unknown) => {
        assert.equal(actualOwner, owner)
        return 'attempt-id'
      }
      keys.ensureVersion = async () => ({})
      attempts.releaseCycle = async () => undefined
      const instance = service()
      // The fourth argument is the existing scheduler diagnostic callback.
      ;(instance as any).runPostSyncIdentityRiskEvaluation = async (
        _tenant: unknown, _deadline: number, _attemptId: string, _diagnostic: unknown, actualOwner: unknown,
      ) => { evaluationOwner = actualOwner }
      await (instance as any).runScopedPostSyncRisk(tenant, owner)
      assert.equal(evaluationOwner, owner, 'a guarded key setup does not guard later evaluator writes')
    } finally {
      attempts.claimCycle = prior.claimCycle
      attempts.recordAttempt = prior.recordAttempt
      attempts.releaseCycle = prior.releaseCycle
      keys.ensureVersion = prior.ensureVersion
    }
  })
})

test('post-attempt evaluator request carries the owner and preserves lease loss', async () => {
  await withRiskConfig(async () => {
    const instance = service()
    const lost = new TenantVisitLeaseLostError()
    ;(instance as any).identityRiskEvaluationScheduler = {
      runAssessmentTenant: async (request: { visitOwner?: unknown; globalAttemptId?: string }) => {
        assert.equal(request.visitOwner, owner)
        assert.equal(request.globalAttemptId, 'attempt-id')
        throw lost
      },
    }
    await assert.rejects(() => (instance as any).runPostSyncIdentityRiskEvaluation(
      tenant, Date.now() + 5_000, 'attempt-id', undefined, owner,
    ), (error: unknown) => error === lost)
  })
})

test('owned post-sync risk carries the visit into source-projector key diagnostics', async () => {
  await withRiskConfig(async () => {
    for (const assessment of [true, false]) {
      const instance = service()
      const lost = new TenantVisitLeaseLostError()
      const projector = { load: async (_scope: unknown, _now: unknown, _deadline: unknown, actual: unknown) => {
        assert.equal(actual, owner)
        throw lost
      } }
      ;(instance as any).riskAssessmentProjector = assessment ? projector : null
      ;(instance as any).mailboxRiskProjector = assessment ? null : projector
      const run = async (request: { loadSources: () => Promise<unknown> }) => request.loadSources()
      ;(instance as any).identityRiskEvaluationScheduler = { runAssessmentTenant: run, runTenant: run }
      await assert.rejects(() => (instance as any).runPostSyncIdentityRiskEvaluation(
        tenant, Date.now() + 20_000, 'attempt-id', undefined, owner,
      ), (error: unknown) => error === lost)
    }
  })
})
