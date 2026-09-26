import assert from 'node:assert/strict'
import test from 'node:test'
import { runGlobalRiskCycle } from '../identity-risk/risk-global-cycle.js'
import { WrappedRiskKeyStore } from '../identity-risk/wrapped-risk-key-store.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { publishNativeAssessment } from './native-alert-publisher.js'
import { composeTenantAssessment } from '../evaluation-core/compose.js'

const scope = { organizationId: '11111111-1111-4111-8111-111111111111', customerTenantId: '22222222-2222-4222-8222-222222222222', environment: 'offline' }
const now = new Date('2026-09-10T21:05:00Z')
const input = { ...scope, rowsFetched: 5, sources: [], windowStart: new Date('2026-08-11T21:05:00Z'), windowEnd: now, completedAt: now, expiresAt: new Date('2026-12-09T21:05:00Z') }
const assessment = { ...composeTenantAssessment([]), findings: { complete: true, items: [{ detectorId: 'repeated-credential-failure', subject: { kind: 'DIRECTORY_USER', userRef: 'opaque-fixture', correlation: { available: true, matchedBy: 'DIRECTORY_OBJECT_ID', ref: 'opaque-fixture' } }, signals: [{ signal: 'PASSWORD_REJECTED', count: 5, capped: false, latest: { at: '2026-09-09T00:00:00Z', kind: 'EVENT_OCCURRED' } }, { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 0, capped: false, latest: null }] }] } }
const denied = ['inactive-organization', 'disconnected', 'global-stop', 'tenant-stop', 'inactive-tenant', 'foreign-tenant', 'foreign-connection'] as const
type State = 'eligible' | typeof denied[number]

function fixture(initial: State = 'eligible') {
  let state: State = initial
  let sourceReads = 0
  let revokeAfterRead: State | undefined
  const queries: { sql: string; values: unknown[] }[] = []
  const pending: string[] = []; const committed: string[] = []
  const query = async (sql: string, ...values: unknown[]) => {
    queries.push({ sql, values })
    if (sql.includes('pg_advisory_xact_lock')) {
      assert.ok([`hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:GLOBAL`, `hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:${scope.organizationId}:${scope.customerTenantId}`].includes(String(values[0])))
      return []
    }
    if (sql.includes('FROM identity_risk_operational_controls')) {
      assert.match(sql, /state='ACTIVE'/); assert.match(sql, /control_type='EVALUATION_HARD_DISABLED'/)
      assert.match(sql, /scope_type='GLOBAL'/); assert.match(sql, /scope_type='TENANT'/)
      assert.deepEqual(values, [scope.organizationId, scope.customerTenantId, `${scope.organizationId}:${scope.customerTenantId}`])
      return state.endsWith('-stop') ? [{ id: 'stop' }] : []
    }
    if (sql.includes('FROM organizations')) {
      assert.match(sql, /status='ACTIVE'/); assert.match(sql, /FOR SHARE/)
      assert.deepEqual(values, [scope.organizationId])
      return state === 'inactive-organization' ? [] : [{ id: scope.organizationId }]
    }
    if (sql.includes('FROM customer_tenants')) {
      assert.match(sql, /status\s*=\s*'ACTIVE'/); assert.match(sql, /organization_id\s*=\s*\$2/)
      assert.deepEqual(values, [scope.customerTenantId, scope.organizationId])
      return state === 'inactive-tenant' || state === 'foreign-tenant' ? [] : [{ id: scope.customerTenantId }]
    }
    if (sql.includes('FROM tenant_connections')) {
      assert.match(sql, /status='CONNECTED'/); assert.match(sql, /FOR SHARE/)
      assert.deepEqual(values, [scope.customerTenantId, scope.organizationId])
      return state === 'disconnected' || state === 'foreign-connection' ? [] : [{ id: 'connection' }]
    }
    throw new Error('Unexpected synthetic SQL')
  }
  const tx = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) { await query(sql, ...values); return 1 }
      pending.push('standing'); return 1
    },
    identityRiskEvaluationRun: { findUnique: async () => null, findFirst: async () => null,
      create: async () => { pending.push('run'); return { id: 'run' } }, update: async () => { pending.push('marker'); return {} } },
    identityRiskMatchedResult: { createMany: async () => { pending.push('matched'); return { count: 1 } } },
    identityRiskFinding: { updateMany: async () => ({ count: 0 }) },
  }
  const db = { ...tx,
    $transaction: async (work: any, options: { isolationLevel?: string }) => {
      assert.equal(options.isolationLevel, 'ReadCommitted', 'stop rows must be reread after advisory-lock waits')
      const start = pending.length
      try { const result = await work(tx); committed.push(...pending.splice(start)); return result }
      catch (error) { pending.splice(start); throw error }
    },
    syncState: { findMany: async () => [{ resourceType: 'SIGN_INS', status: 'SUCCEEDED', lastAttemptAt: now, lastSuccessfulAt: now, lastErrorCode: null, lastErrorMessage: null }] },
    customerTenant: { findFirst: async () => ({ microsoftTenantId: 'synthetic' }) },
    signInLog: { findMany: async () => { sourceReads++; if (revokeAfterRead) state = revokeAfterRead; return [] } },
    directoryUser: { findMany: async () => [] },
  }
  const pg = { query: async (sql: string, args: unknown[]) => { const rows = await query(sql, ...args); return { rows, rowCount: rows.length } } }
  return { db, pg, queries, committed, get sourceReads() { return sourceReads }, revokeDuringRead: (next: State) => { revokeAfterRead = next } }
}

async function configured(work: () => Promise<void>) {
  const settings = { HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global', HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'offline' }
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]))
  Object.assign(process.env, settings)
  try { await work() } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

for (const state of ['eligible', ...denied] as const) {
  test(`cycle admission ${state} gates native source reads and publication`, () => configured(async () => {
    const h = fixture(state); const outcomes: string[] = []
    let selected = false, native = 0, primary = 0, released = 0
    const store = new WrappedRiskKeyStore()
    const result = await runGlobalRiskCycle({ now: () => 1000, claimCycle: async () => ({} as never), nextScope: async () => { if (selected) return null; selected = true; return scope }, releaseCycle: async () => { released++ }, recordAttempt: async () => 'attempt', ensure: async (s, _d, cb) => (store as any).assertAutomaticScope(h.pg, s, cb), evaluate: async () => { primary++ }, alsoEvaluate: async () => { native++; await evaluateAndPersistTenant(h.db as never, scope, { now }) }, alsoObserve: outcome => outcomes.push(outcome) }, 46000)
    assert.equal(primary, state === 'eligible' ? 1 : 0)
    assert.equal(native, state === 'eligible' ? 1 : 0)
    assert.equal(h.sourceReads, state === 'eligible' ? 1 : 0)
    assert.equal(released, 1)
    assert.equal(result.failed, state === 'eligible' ? 0 : 1)
    assert.deepEqual(outcomes, [state === 'eligible' ? 'COMPLETED' : 'SKIPPED'])
    assert.deepEqual(h.committed, state === 'eligible' ? ['run', 'marker'] : [])
  }))
  test(`direct native evaluation ${state} checks scope before source reads`, async () => {
    const h = fixture(state)
    if (state === 'eligible') await evaluateAndPersistTenant(h.db as never, scope, { now })
    else await assert.rejects(() => evaluateAndPersistTenant(h.db as never, scope, { now }), /NATIVE_PUBLICATION_SCOPE_UNAVAILABLE/)
    assert.equal(h.sourceReads, state === 'eligible' ? 1 : 0)
    assert.deepEqual(h.committed, state === 'eligible' ? ['run', 'marker'] : [])
  })
  test(`positive publication ${state} checks eligibility in the write transaction`, async () => {
    const h = fixture(state)
    if (state === 'eligible') await publishNativeAssessment(h.db as never, assessment as never, input)
    else await assert.rejects(() => publishNativeAssessment(h.db as never, assessment as never, input), /NATIVE_PUBLICATION_SCOPE_UNAVAILABLE/)
    assert.deepEqual(h.committed, state === 'eligible' ? ['run', 'matched', 'standing', 'marker'] : [])
  })
}

for (const state of denied) test(`revocation after admission (${state}) is checked again before persistence`, async () => {
  const h = fixture()
  h.revokeDuringRead(state)
  await assert.rejects(() => evaluateAndPersistTenant(h.db as never, scope, { now }), /NATIVE_PUBLICATION_SCOPE_UNAVAILABLE/)
  assert.equal(h.sourceReads, 1)
  assert.deepEqual(h.committed, [])
})

test('publication takes control locks in shared order before row locks and retains exclusive tenant serialization', async () => {
  const h = fixture()
  await publishNativeAssessment(h.db as never, assessment as never, input)
  assert.deepEqual(h.queries.slice(0, 2).map(q => q.values[0]), ['GLOBAL', `${scope.organizationId}:${scope.customerTenantId}`].map(key => `hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:${key}`).sort())
  const tableOrder = h.queries.slice(2).map(q => /FROM ([a-z_]+)/.exec(q.sql)?.[1])
  assert.deepEqual(tableOrder, ['identity_risk_operational_controls', 'organizations', 'customer_tenants', 'tenant_connections'])
  assert.match(h.queries.find(q => q.sql.includes('FROM customer_tenants'))!.sql, /FOR UPDATE/)
})

test('primary detector failure after successful admission does not suppress independent native evaluation', () => configured(async () => {
  let selected = false, native = 0
  const outcomes: string[] = []
  const h = fixture()
  const store = new WrappedRiskKeyStore()
  const result = await runGlobalRiskCycle({ now: () => 1000, claimCycle: async () => ({} as never), nextScope: async () => { if (selected) return null; selected = true; return scope }, releaseCycle: async () => {}, recordAttempt: async () => 'attempt', ensure: async (s, _d, cb) => (store as any).assertAutomaticScope(h.pg, s, cb), evaluate: async () => { throw new Error('detector unavailable') }, alsoEvaluate: async () => { native++; await evaluateAndPersistTenant(h.db as never, scope, { now }) }, alsoObserve: outcome => outcomes.push(outcome) }, 46000)
  assert.equal(result.failed, 1)
  assert.equal(native, 1)
  assert.deepEqual(outcomes, ['COMPLETED'])
  assert.deepEqual(h.committed, ['run', 'marker'])
}))

test('failed attempt record cannot enter native evaluation', () => configured(async () => {
  let selected = false, native = 0, ensured = 0
  const result = await runGlobalRiskCycle({ now: () => 1000, claimCycle: async () => ({} as never), nextScope: async () => { if (selected) return null; selected = true; return scope }, releaseCycle: async () => {}, recordAttempt: async () => { throw new Error('record unavailable') }, ensure: async () => { ensured++ }, evaluate: async () => {}, alsoEvaluate: async () => { native++ } }, 46000)
  assert.equal(result.failed, 1)
  assert.equal(ensured, 0)
  assert.equal(native, 0)
}))
