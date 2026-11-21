import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import { IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'

const scope = { organizationId: 'organization', customerTenantId: 'tenant' }
const owner = { ...scope, token: 'owner-token', generation: 3n,
  expiresAt: new Date('2030-01-01T00:00:00Z') }

test('risk hard-stop diagnostic forwards the exact optional visit owner', async () => {
  let recordedOwner: unknown
  const evaluator = new IdentityRiskEvaluatorService({} as any, {
    recordHardStopBlocked: async (input: { visitOwner?: unknown }) => {
      recordedOwner = input.visitOwner
    },
  } as any)
  const result = await (evaluator as any).hardDisabledResult(
    { ...scope, visitOwner: owner },
    { evaluationHardDisabled: true, alertDeliveryDisabled: true,
      hardDisableEpisodeId: 'episode', hardDisableScopeType: 'GLOBAL' },
    new Date(),
  )
  assert.equal(recordedOwner, owner)
  assert.equal(result.status, 'HARD_DISABLED')
})

test('risk detector rejection forwards the exact optional visit owner', async () => {
  let recordedOwner: unknown
  const evaluator = new IdentityRiskEvaluatorService({} as any, {
    recordDetectorRejection: async (input: { visitOwner?: unknown }) => {
      recordedOwner = input.visitOwner
    },
  } as any)
  await assert.rejects(() => (evaluator as any).runDetectors(
    [{ ruleId: 'HV-ID-CHG-001.v1', evaluate: async () => { throw new Error('detector failed') } }],
    { context: {}, capability: {} }, new Date(), 'run',
    scope.organizationId, scope.customerTenantId, undefined, owner,
  ), /detector output was rejected/)
  assert.equal(recordedOwner, owner)
})

test('risk claim holds exact visit owner before run or attempt writes', async () => {
  const calls: string[] = []
  const transaction = {
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      calls.push([sql, ...values].join(' ')); return 0
    },
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('current_setting')) return [{ timezone: 'UTC' }]
      if (sql.includes('FROM organizations')) return [{ id: scope.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: scope.customerTenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return []
      throw new Error('Unexpected query before visit-owner assertion')
    },
    identityRiskOperationalControl: { findMany: async () => { calls.push('control-read'); return [] } },
    get identityRiskEvaluationRun() { throw new Error('Run write escaped lost-owner assertion') },
  }
  const evaluator = new IdentityRiskEvaluatorService({
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as any, {} as any)

  await assert.rejects(() => (evaluator as any).claimRun({
    request: { ...scope, visitOwner: owner }, platformNow: new Date(),
  }), TenantVisitLeaseLostError)

  const controlLock = calls.findIndex(call => call.includes('hawkview:identity-risk-control:'))
  const tenantLock = calls.findIndex(call => call.includes('FROM customer_tenants') && call.includes('FOR NO KEY UPDATE'))
  const leaseCheck = calls.findIndex(call => call.includes('FROM tenant_sync_visit_leases') && call.includes('FOR SHARE'))
  assert.ok(controlLock >= 0 && tenantLock > controlLock && leaseCheck > tenantLock)
  assert.equal(calls.some(call => call.includes('identity_risk_evaluation_runs')), false)
})

test('risk claim rejects a foreign visit owner before opening a transaction', async () => {
  let opened = false
  const evaluator = new IdentityRiskEvaluatorService({
    $transaction: async () => { opened = true },
  } as any, {} as any)
  await assert.rejects(() => (evaluator as any).claimRun({
    request: { ...scope, visitOwner: { ...owner, organizationId: 'foreign' } },
    platformNow: new Date(),
  }), TenantVisitLeaseLostError)
  assert.equal(opened, false)
})

test('risk completion holds the visit generation before marking a claimed run failed', async () => {
  const calls: string[] = []
  const transaction = {
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      calls.push([sql, ...values].join(' ')); return 0
    },
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('current_setting')) return [{ timezone: 'UTC' }]
      if (sql.includes('FROM organizations')) return [{ id: scope.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: scope.customerTenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return []
      throw new Error('Unexpected query before visit-owner assertion')
    },
    identityRiskOperationalControl: { findMany: async () => {
      calls.push('control-read')
      return [{ controlType: 'EVALUATION_HARD_DISABLED', episodeId: 'episode', scopeType: 'TENANT' }]
    } },
    get identityRiskEvaluationRun() { throw new Error('Run failure write escaped lost-owner assertion') },
  }
  const evaluator = new IdentityRiskEvaluatorService({
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as any, {} as any)

  await assert.rejects(() => (evaluator as any).persistCompletedRun({
    request: { ...scope, visitOwner: owner },
  }), TenantVisitLeaseLostError)

  const controlLock = calls.findIndex(call => call.includes('hawkview:identity-risk-control:'))
  const tenantLock = calls.findIndex(call => call.includes('FROM customer_tenants') && call.includes('FOR NO KEY UPDATE'))
  const leaseCheck = calls.findIndex(call => call.includes('FROM tenant_sync_visit_leases') && call.includes('FOR SHARE'))
  assert.ok(controlLock >= 0 && tenantLock > controlLock && leaseCheck > tenantLock)
  assert.equal(calls.some(call => call.includes('identity_risk_evaluation_runs')), false)
})

test('risk failure disposition rejects a lost visit owner before writing FAILED', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('FROM organizations')) return [{ id: scope.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: scope.customerTenantId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return []
      throw new Error('Unexpected visit-owner query')
    },
    get identityRiskEvaluationRun() { throw new Error('FAILED write escaped lost-owner assertion') },
  }
  const evaluator = new IdentityRiskEvaluatorService({
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as any, {} as any)

  await assert.rejects(() => (evaluator as any).failOwnedRun(
    { ...scope, visitOwner: owner }, 'run', 'run-lease', 'EVALUATION_FAILED',
  ), TenantVisitLeaseLostError)

  assert.equal(calls.length, 3)
  assert.ok(calls[1].includes('FOR NO KEY UPDATE'))
  assert.ok(calls[2].includes('FOR SHARE'))
})

test('risk failure disposition keeps ownerless scheduled writes available', async () => {
  let wrote = false
  const evaluator = new IdentityRiskEvaluatorService({
    get $transaction() { throw new Error('Ownerless write unexpectedly opened a visit transaction') },
    identityRiskEvaluationRun: { updateMany: async (input: any) => {
      assert.equal(input.where.leaseToken, 'run-lease')
      assert.equal(input.data.status, 'FAILED')
      wrote = true
    } },
  } as any, {} as any)

  await (evaluator as any).failOwnedRun(scope, 'run', 'run-lease', 'EVALUATION_FAILED')
  assert.equal(wrote, true)
})
