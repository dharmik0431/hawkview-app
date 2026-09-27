import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'

/** Source failures precede the transaction; publication completes atomically.
 * Real database rollback/isolation is exercised by the integration suite. */

const scope = { organizationId: 'org', customerTenantId: 'tenant' }

/** Unit double for the production orchestration seam. */
function client(options: Readonly<{ failAt?: 'syncState' | 'tenant' | 'rows' }> = {}) {
  const created: Record<string, unknown>[] = []
  const calls: string[] = []
  const fail = (stage: string) => { throw new Error(`${stage} unavailable`) }
  return {
    created,
    calls,
    db: {
      async $transaction<T>(run: (tx: unknown) => Promise<T>): Promise<T> {
        calls.push('begin')
        const result = await run(this)
        calls.push('commit')
        return result
      },
      $queryRawUnsafe: async (sql: string) => sql.includes('FROM identity_risk_operational_controls') ? [] : [{ id: scope.customerTenantId }],
      $executeRawUnsafe: async () => 0,
      identityRiskFinding: { updateMany: async () => ({ count: 0 }) },
      syncState: {
        findMany: async () => {
          calls.push('syncState')
          if (options.failAt === 'syncState') fail('syncState')
          return [{
            resourceType: 'SIGN_INS', status: 'SUCCEEDED',
            lastAttemptAt: new Date('2026-09-10T21:00:00.000Z'),
            lastSuccessfulAt: new Date('2026-09-10T21:00:00.000Z'),
            lastErrorCode: null, lastErrorMessage: null,
          }]
        },
      },
      customerTenant: {
        findFirst: async () => {
          calls.push('tenant')
          if (options.failAt === 'tenant') fail('customerTenant')
          return { microsoftTenantId: 'ms-tenant' }
        },
      },
      signInLog: {
        findMany: async () => {
          calls.push('rows')
          if (options.failAt === 'rows') fail('signInLog')
          return []
        },
      },
      directoryUser: { findMany: async () => { calls.push('directory'); return [] } },
      identityRiskEvaluationRun: {
        findUnique: async () => null,
        findFirst: async () => null,
        update: async () => { calls.push('marker'); return {} },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          calls.push('create')
          created.push(data)
          return { id: 'run-1' }
        },
      },
    },
  }
}

const now = new Date('2026-09-10T21:05:00.000Z')

test('a completed assessment commits its run and publication marker before returning', async () => {
  const { db, created, calls } = client()
  const result = await evaluateAndPersistTenant(db as never, scope, { now })

  assert.equal(created.length, 1)
  assert.equal(result.runId, 'run-1')
  assert.equal(result.publication, 'PUBLISHED')
  assert.deepEqual(calls.slice(-4), ['begin', 'create', 'marker', 'commit'])
  // And one clock: the window end, the completion stamp and the retention
  // horizon are all derived from the same instant.
  assert.equal((created[0]!.windowEnd as Date).getTime(), now.getTime())
  assert.equal((created[0]!.completedAt as Date).getTime(), now.getTime())
})

test('an assessment that fails writes NOTHING — no row claiming a completion that did not happen', async () => {
  // Every stage before the write, in turn. A row written on any of these paths
  // would describe an evaluation that never finished, and the status value that
  // hides these rows from the live reader does nothing to hide a half-written
  // one from our own.
  for (const failAt of ['syncState', 'tenant', 'rows'] as const) {
    const { db, created, calls } = client({ failAt })
    await assert.rejects(() => evaluateAndPersistTenant(db as never, scope, { now }))
    assert.deepEqual(created, [], `a row was written despite ${failAt} failing`)
    assert.equal(calls.includes('create'), false)
  }

  // POSITIVE CONTROL: the same double with nothing failing does write, so the
  // assertions above are about the failures rather than a double that never
  // reaches the writer.
  const healthy = client()
  await evaluateAndPersistTenant(healthy.db as never, scope, { now })
  assert.equal(healthy.created.length, 1)
})

test('the run it writes is invisible to the live reader', async () => {
  // Asserted here as well as at the writer, because this is the function the
  // cycle actually calls — the place a future refactor would change the status
  // without noticing the writer's own test.
  const { db, created } = client()
  await evaluateAndPersistTenant(db as never, scope, { now })
  assert.notEqual(created[0]!.status, 'COMPLETED')
  assert.equal(created[0]!.status, 'COMPLETED_EVALUATION_CORE')
})


test('core-partial feed stays failed through retry without hiding ordinary retained complete evidence', async () => {
  const completeAt = new Date('2026-09-10T21:00:00Z')
  for (const scenario of [
    { name: 'complete', status: 'SUCCEEDED', code: null, success: completeAt, expected: 'SUCCESS' },
    { name: 'ordinary refresh', status: 'RUNNING', code: null, success: completeAt, expected: 'SUCCESS' },
    { name: 'stale retained refresh', status: 'RUNNING', code: null, success: new Date('2026-08-01'), expected: 'STALE' },
    { name: 'never complete', status: 'RUNNING', code: null, success: null, expected: 'RUNNING' },
    { name: 'legacy core partial', status: 'RUNNING', code: 'sign-ins-record-validation-partial', success: completeAt, expected: 'FAILED' },
    { name: 'settled core partial', status: 'FAILED', code: 'sign-ins-record-validation-partial', success: completeAt, expected: 'FAILED' },
    { name: 'retry of core partial', status: 'RUNNING', code: 'sign-ins-record-validation-partial', success: completeAt, expected: 'FAILED' },
    { name: 'core partial with no baseline', status: 'RUNNING', code: 'sign-ins-record-validation-partial', success: null, expected: 'FAILED' },
    { name: 'valid fallback', status: 'RUNNING', code: 'sign-ins-non-premium-fallback-active-geolocation-partial', success: completeAt, expected: 'SUCCESS' },
  ]) {
    const { db, created } = client()
    ;(db.syncState as any).findMany = async ({ where }: any) => {
      assert.equal(where.organizationId, scope.organizationId); assert.equal(where.customerTenantId, scope.customerTenantId)
      return [
        { resourceType: 'SIGN_INS', status: scenario.status, lastSuccessfulAt: scenario.success, lastAttemptAt: now, lastErrorCode: scenario.code, lastErrorMessage: null },
        { resourceType: 'M365_AUDIT', status: 'SUCCEEDED', lastSuccessfulAt: completeAt, lastAttemptAt: completeAt, lastErrorCode: null, lastErrorMessage: null },
      ]
    }
    await evaluateAndPersistTenant(db as never, scope, { now })
    const findings = created[0]!.evaluationFindings as any
    assert.equal(findings.sources.find((s: any) => s.source === 'GRAPH_SIGN_INS').status, scenario.expected, scenario.name)
    assert.equal(findings.sources.find((s: any) => s.source === 'M365_AUDIT_STS').status, scenario.expected, 'both feeds read SIGN_INS; unrelated M365_AUDIT state cannot override it')
    assert.equal(findings.sources.find((s: any) => s.source === 'GRAPH_SIGN_INS').lastSuccessfulCollectionAt, scenario.success?.toISOString() ?? null)
    if (scenario.expected === 'FAILED') {
      assert.equal(findings.claim.permitted, false, scenario.name + ' cannot certify a clean empty assessment')
      assert.notEqual(findings.count.accuracy, 'EXACT', scenario.name + ' unknown coverage is not exact zero')
    }
  }
})
