import assert from 'node:assert/strict'
import test from 'node:test'
import { runGlobalRiskCycle, RISK_GLOBAL_CANDIDATE_LIMIT } from './risk-global-cycle.js'
import { TenantSyncService, runInSyncMemoryLane } from '../tenants/tenant-sync.service.js'
import { RiskGlobalWorkStore } from './risk-global-work-store.js'

const scope = { organizationId: '00000000-0000-0000-0000-000000000001', customerTenantId: '00000000-0000-0000-0000-000000000002', environment: 'synthetic' }
const settings = { HAWKVIEW_IDENTITY_RISK_ROLLOUT: 'global', HAWKVIEW_IDENTITY_RISK_MODE: 'shadow',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: 'synthetic', HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: undefined }
async function configured(work: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(settings).map(k => [k, process.env[k]]))
  for (const [k,v] of Object.entries(settings)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { await work() } finally { for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
function fixture() {
  let clock = 1_000; let claim = 0; let scanned = 0; let ensure = 0; let evaluated = 0; let released = 0
  const deps = { now: () => clock,
    claimCycle: async (_deadline: number) => { claim++; return { environment: scope.environment, id: scope.organizationId } },
    nextScope: async () => { scanned++; return scope },
    releaseCycle: async () => { released++ },
    recordAttempt: async () => scope.organizationId,
    ensure: async () => { ensure++ },
    evaluate: async () => { evaluated++ },
  }
  return { deps, advance: (ms: number) => { clock += ms }, counts: () => ({ claim, scanned, ensure, evaluated, released }) }
}
test('global risk cycle bounds candidates and remains serial, independent of collector prefix', () => configured(async () => {
  const f = fixture()
  const result = await runGlobalRiskCycle(f.deps, 100_000)
  assert.equal(result.attempted, RISK_GLOBAL_CANDIDATE_LIMIT)
  assert.deepEqual(f.counts(), { claim: 1, scanned: 5, ensure: 5, evaluated: 5, released: 1 })
}))
test('midpage budget exhaustion never scans unseen candidates or starts later work', () => configured(async () => {
  const f = fixture(); let evaluations = 0
  f.deps.evaluate = async () => { evaluations++; f.advance(21_000) }
  const result = await runGlobalRiskCycle(f.deps, 100_000)
  assert.equal(evaluations, 1); assert.equal(result.attempted, 1)
  assert.equal(f.counts().scanned, 1); assert.equal(f.counts().released, 1)
}))
test('ineligible/failed tenant advances, no raw exception escapes; subsequent tenant can evaluate', () => configured(async () => {
  const f = fixture(); let count = 0
  f.deps.ensure = async () => { if (++count < 3) throw new Error('synthetic secret must not escape') }
  const result = await runGlobalRiskCycle(f.deps, 100_000)
  assert.deepEqual(result, { status: 'COMPLETED', attempted: 5, completed: 3, failed: 2 })
  assert.doesNotMatch(JSON.stringify(result), /secret/)
}))
test('OFF, insufficient deadline and overlapping lease do no tenant work', () => configured(async () => {
  const f = fixture()
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'off'
  await runGlobalRiskCycle(f.deps, 100_000)
  assert.equal(f.counts().claim, 0)
  process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'shadow'
  await runGlobalRiskCycle(f.deps, 10_000)
  assert.equal(f.counts().claim, 0)
  const busy = await runGlobalRiskCycle({ ...f.deps, claimCycle: async () => null }, 100_000)
  assert.equal(busy.status, 'BUSY'); assert.equal(f.counts().scanned, 0)
}))
test('mode OFF midcycle stops before next cursor claim; release failure is bounded leased recovery', () => configured(async () => {
  const f = fixture()
  f.deps.evaluate = async () => { process.env.HAWKVIEW_IDENTITY_RISK_MODE = 'off' }
  f.deps.releaseCycle = async () => { throw new Error('synthetic connection error') }
  assert.equal((await runGlobalRiskCycle(f.deps, 100_000)).attempted, 1)
  assert.equal(f.counts().scanned, 1)
}))

test('failed durable attempt prevents key creation and source evaluation', () => configured(async () => {
  const f=fixture()
  f.deps.recordAttempt=async()=>{throw new Error('synthetic DB failure')}
  const result=await runGlobalRiskCycle(f.deps,100_000)
  assert.equal(result.failed,5);assert.equal(f.counts().ensure,0);assert.equal(f.counts().evaluated,0)
}))

test('actual service refuses a busy memory lane without a cursor claim, deferred materializer or queued retry', () => configured(async () => {
  const original = RiskGlobalWorkStore.prototype.claimCycle
  let claims = 0; let materializers = 0
  RiskGlobalWorkStore.prototype.claimCycle = async () => { claims++; return null }
  const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).identityRiskEvaluationScheduler = {}
  ;(service as any).mailboxRiskProjector = { load: async () => { materializers++ } }
  let entered!: () => void; let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = runInSyncMemoryLane(async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  await started
  try {
    assert.equal(await service.runScheduledGlobalRiskCycle(Date.now()+45_000), undefined)
    assert.equal(claims, 0); assert.equal(materializers, 0)
    release(); await held
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(claims, 0, 'No queued callback after memory lane release')
    assert.equal((await service.runScheduledGlobalRiskCycle(Date.now()+45_000))?.status, 'BUSY')
    assert.equal(claims, 1); assert.equal(materializers, 0)
  } finally { release(); await held; RiskGlobalWorkStore.prototype.claimCycle = original }
}))
