import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { Logger } from '@nestjs/common'
import { runGlobalRiskCycle } from './risk-global-cycle.js'
import { RiskCycleDiagnostic, type CycleReason } from './risk-operational-diagnostics.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { wrappedRiskName, WRAPPED_RISK_PROVIDER } from './wrapped-risk-crypto.js'
import { ScheduledSyncController } from '../tenants/scheduled-sync.controller.js'

const scope = { organizationId: '00000000-0000-0000-0000-000000000001', customerTenantId: '00000000-0000-0000-0000-000000000002', environment: 'synthetic' }
const settings = { HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global', HAWKVIEW_IDENTITY_RISK_MODE: 'shadow',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'synthetic',
  HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined, SECRET_ENCRYPTION_KEY: '52'.repeat(32),
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic' }
async function configured(work: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(settings).map(k => [k, process.env[k]]))
  for (const [k,v] of Object.entries(settings)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { await work() } finally { for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
// Any error property inspection is a test failure, not merely a redaction test.
const hostile = new Proxy({ token: 'SECRET', password: 'SECRET' }, {
  get() { assert.fail('caught error inspected') }, ownKeys() { assert.fail('caught error enumerated') },
  getPrototypeOf() { assert.fail('caught error prototype inspected') },
})
const stages = { claimCycle: 'CYCLE_CLAIM_FAILED', nextScope: 'SCOPE_SELECTION_FAILED',
  recordAttempt: 'ATTEMPT_RECORD_FAILED', ensure: 'KEY_ENSURE_FAILED', evaluate: 'EVALUATION_FAILED' } as const
function fixture() {
  let released = 0; let scans = 0; let attempts = 0; let ensured = 0; let evaluated = 0
  const deps = { now: () => 1_000,
    claimCycle: async () => ({ id: scope.organizationId, environment: scope.environment }),
    nextScope: async () => { scans++; return scope }, releaseCycle: async () => { released++ },
    recordAttempt: async () => { attempts++; return scope.organizationId },
    ensure: async (_scope: typeof scope, _deadline: number, _ineligible?: () => void) => { ensured++ },
    evaluate: async () => { evaluated++ },
  }
  return { deps, counts: () => ({ released, scans, attempts, ensured, evaluated }) }
}
function assertRecord(lines: string[], reason: CycleReason) {
  assert.deepEqual(lines.map(line => JSON.parse(line)), [{ version: 1, eventName: 'risk_cycle_diagnostic', reason }])
  assert.doesNotMatch(lines.join(''), /SECRET|password|token|00000000|synthetic/)
}

test('each real cycle await boundary preserves hostile throw/result and lease cleanup despite observer/sink failure', () => configured(async () => {
  for (const [boundary, reason] of Object.entries(stages)) {
    for (const mode of ['normal','throw-observer','throw-sink']) {
      const f = fixture(); const lines: string[] = []
      const d = new RiskCycleDiagnostic(line => { lines.push(line); if (mode === 'throw-sink') throw hostile })
      const observe = (value: CycleReason) => { d.record(value); if (mode === 'throw-observer') throw hostile }
      const deps = { ...f.deps, [boundary]: async () => { throw hostile }, observe }
      if (boundary === 'claimCycle' || boundary === 'nextScope') {
        let caught = false
        try { await runGlobalRiskCycle(deps, 100_000) }
        catch (error) { caught = true; assert.equal(error, hostile); d.record('ATTEMPT_FAILED') }
        assert.equal(caught, true)
        assert.equal(f.counts().released, boundary === 'claimCycle' ? 0 : 1)
      } else {
        assert.deepEqual(await runGlobalRiskCycle(deps, 100_000), { status: 'COMPLETED', attempted: 5, completed: 0, failed: 5 })
        assert.equal(f.counts().released, 1); assert.equal(f.counts().scans, 5)
        if (boundary === 'recordAttempt') { assert.equal(f.counts().ensured, 0); assert.equal(f.counts().evaluated, 0) }
        if (boundary === 'ensure') assert.equal(f.counts().evaluated, 0)
      }
      d.record('COMMITTED'); d.finish(); d.finish()
      assertRecord(lines, reason)
    }
  }
}))

test('actual controller generic catch cannot erase a specific cycle stage', () => configured(async () => {
  const original = Logger.prototype.log
  try {
    for (const [boundary, reason] of Object.entries(stages)) {
      const lines: string[] = []; const f = fixture()
      Logger.prototype.log = function(message: unknown) { if (typeof message === 'string' && message.includes('risk_cycle_diagnostic')) lines.push(message) }
      const controller = new ScheduledSyncController({ verify: async () => {} } as any, {
        runScheduledGlobalRiskCycle: async (_deadline: number, observe: (reason: CycleReason) => void) =>
          runGlobalRiskCycle({ ...f.deps, [boundary]: async () => { throw hostile }, observe }, 100_000),
        syncDueTenants: async () => ({ status: 'unchanged' }),
      } as any, { runAuthorizedScheduledMaintenance: async () => ({ hasMore: false }) } as any, { runOnce: async () => null } as any)
      ;(controller as any).logger = { log() {}, warn() {} }
      assert.deepEqual(await controller.syncDueTenants({ headers: {} } as any), { status: 'unchanged' })
      assertRecord(lines, reason)
    }
  } finally { Logger.prototype.log = original }
}))

test('expected skips never hide commits, generic outer failures, or any specific failure', () => configured(async () => {
  for (const expected of ['CANDIDATE_INELIGIBLE','COMMITTED','ATTEMPT_FAILED', ...Object.values(stages)] as const) {
    const lines: string[] = []; const d = new RiskCycleDiagnostic(line => lines.push(line)); const f = fixture()
    let attempt = 0
    const result = await runGlobalRiskCycle({ ...f.deps, observe: reason => d.record(reason),
      ensure: async (_scope, _deadline, ineligible) => { if (attempt++ === 0) { ineligible?.(); throw hostile } },
      evaluate: async () => { if (expected !== 'CANDIDATE_INELIGIBLE') d.record(expected) },
    }, 100_000)
    assert.deepEqual(result, { status: 'COMPLETED', attempted: 5, completed: 4, failed: 1 })
    assert.equal(f.counts().released, 1); assert.equal(f.counts().scans, 5)
    d.finish(); assertRecord(lines, expected)
  }
}))

test('an expected rejection followed by a real scope/attempt/key/evaluation failure preserves advancement and cleanup', () => configured(async () => {
  for (const boundary of ['nextScope','recordAttempt','ensure','evaluate'] as const) {
    const lines: string[] = []; const d = new RiskCycleDiagnostic(line => lines.push(line)); const f = fixture()
    let candidate = 0
    const deps = { ...f.deps, observe: (reason: CycleReason) => d.record(reason),
      nextScope: async () => { candidate++; if (candidate > 1 && boundary === 'nextScope') throw hostile; return f.deps.nextScope() },
      recordAttempt: async () => { if (candidate > 1 && boundary === 'recordAttempt') throw hostile; return f.deps.recordAttempt() },
      ensure: async (_scope: typeof scope, _deadline: number, ineligible?: () => void) => {
        if (candidate === 1) { ineligible?.(); throw hostile }
        if (boundary === 'ensure') throw hostile
      },
      evaluate: async () => { if (boundary === 'evaluate') throw hostile },
    }
    if (boundary === 'nextScope') {
      let caught = false
      try { await runGlobalRiskCycle(deps, 100_000) }
      catch (error) { caught = true; assert.equal(error, hostile); d.record('ATTEMPT_FAILED') }
      assert.equal(caught, true); assert.equal(candidate, 2)
    } else {
      assert.deepEqual(await runGlobalRiskCycle(deps, 100_000), { status: 'COMPLETED', attempted: 5, completed: 0, failed: 5 })
      assert.equal(candidate, 5)
    }
    assert.equal(f.counts().released, 1); d.finish(); assertRecord(lines, stages[boundary])
  }
}))

test('known locked admission branches alone classify expected skips; actual ensure path keeps other failures distinct', () => configured(async () => {
  const original = { connect: pg.Client.prototype.connect, query: pg.Client.prototype.query, end: pg.Client.prototype.end }
  try {
    for (const branch of ['owner','tenant','connection','control','query','history','cipher','config','root']) {
      for (const observerThrows of [false, true]) {
        let closed = 0; let signaled = 0
        pg.Client.prototype.connect = (async function(this: pg.Client) { return this }) as typeof original.connect
        pg.Client.prototype.end = (async () => { closed++ }) as typeof original.end
        pg.Client.prototype.query = (async (sql: string) => {
          if (sql.includes("current_setting('TimeZone')")) return { rows: [{ timezone: 'UTC' }], rowCount: 1 }
          if (sql.includes('pg_advisory_xact_lock') && branch === 'query') throw hostile
          if (sql.includes('identity_risk_operational_controls')) return { rows: [], rowCount: branch === 'control' ? 1 : 0 }
          for (const [name, table] of [['owner','organizations'],['tenant','customer_tenants'],['connection','tenant_connections']]) {
            if (sql.includes(`FROM ${table} WHERE`) || sql.includes(`FROM ${table}\n`)) return { rows: [], rowCount: branch === name ? 0 : 1 }
          }
          if (sql.includes('identity_risk_pseudonym_key_versions')) {
            if (branch === 'cipher') {
              const key = { ...scope, id: '00000000-0000-0000-0000-000000000003', provider: WRAPPED_RISK_PROVIDER, immutableKeyId: '' }
              return { rows: [{ ...key, immutableKeyId: wrappedRiskName(key) }], rowCount: 1 }
            }
            return { rows: [], rowCount: branch === 'history' && sql.includes('LIMIT 1') ? 1 : 0 }
          }
          if (sql.includes('identity_risk_wrapped_keys')) return { rows: [], rowCount: 0 }
          return { rows: [], rowCount: 1 }
        }) as typeof original.query
        if (branch === 'config') process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'off'
        if (branch === 'root') process.env.SECRET_ENCRYPTION_KEY = ''
        const store = new WrappedRiskKeyStore(); const f = fixture(); const lines: string[] = []
        const d = new RiskCycleDiagnostic(line => lines.push(line))
        // Configure cycle first, then switch config only at the actual key boundary.
        process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
        const result = await runGlobalRiskCycle({ ...f.deps, observe: reason => d.record(reason),
          ensure: async (selected, _deadline, ineligible) => {
            if (branch === 'config') process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'off'
            try { await store.ensureVersion(selected, Date.now() + 6_000, () => { signaled++; ineligible?.(); if (observerThrows) throw hostile }) }
            finally { process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow' }
          },
        }, 100_000)
        assert.deepEqual(result, { status: 'COMPLETED', attempted: 5, completed: 0, failed: 5 })
        assert.equal(f.counts().released, 1); assert.equal(f.counts().evaluated, 0)
        const expected = ['owner','tenant','connection'].includes(branch)
        assert.equal(signaled, expected ? 5 : 0)
        assert.equal(closed, ['config','root'].includes(branch) ? 0 : 5)
        d.finish(); assertRecord(lines, expected ? 'CANDIDATE_INELIGIBLE' : 'KEY_ENSURE_FAILED')
        process.env.SECRET_ENCRYPTION_KEY = settings.SECRET_ENCRYPTION_KEY
      }
    }
  } finally { Object.assign(pg.Client.prototype, original) }
}))
