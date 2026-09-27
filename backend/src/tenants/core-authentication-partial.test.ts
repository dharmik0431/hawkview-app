import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { persistAuthenticationRecords } from '../identity-risk/authentication-ingestion-integrity.js'
import { CORE_AUTHENTICATION_PARTIAL } from './authentication-collection-outcome.js'
import { prepareAuthenticationEvaluation, selectedAuthenticationSource } from '../identity-risk/authentication-source-readiness.js'

const at = new Date('2030-01-02T12:00:00Z')
const scope = { organizationId: 'org-a', customerTenantId: 'tenant-a', microsoftTenantId: '11111111-1111-4111-8111-111111111111' }
function harness() {
  const tenant = { id: scope.customerTenantId, organizationId: scope.organizationId }
  const priorSuccess = new Date(at.getTime() - 30 * 60_000)
  const state: any = { status: 'SUCCEEDED', lastSuccessfulAt: priorSuccess, lastAttemptAt: priorSuccess, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 }
  let snapshot: any = { schemaVersion: 'hawkview-authentication-window/v2', source: 'GRAPH_SIGN_INS', start: new Date(at.getTime() - 60 * 60_000).toISOString(), end: priorSuccess.toISOString(), paginationComplete: true, observedEvents: 1, latestObservedEventAt: priorSuccess.toISOString() }
  const logs: any[] = [], published: any[] = [], resolved: any[] = [], writes: string[] = []
  const valid = { id: 'valid', createdDateTime: at.toISOString(), status: { errorCode: 0 }, isInteractive: true }
  let rows: any[] = [valid, { id: 'invalid', createdDateTime: 'invalid' }]
  const scoped = (where: any) => assert.equal(where.customerTenantId_resourceType.customerTenantId, tenant.id)
  const update = (data: any) => { const failures = data.consecutiveFailures?.increment ? state.consecutiveFailures + data.consecutiveFailures.increment : data.consecutiveFailures ?? state.consecutiveFailures; Object.assign(state, data, { consecutiveFailures: failures }); return { ...state } }
  const db: any = {
    syncState: {
      upsert: async ({ where, update: data }: any) => { scoped(where); writes.push('attempt'); return update(data) },
      update: async ({ where, data }: any) => { scoped(where); writes.push(data.status); return update(data) },
    },
    signInLog: {
      createMany: async ({ data }: any) => { data.forEach((row: any) => { assert.equal(row.organizationId, scope.organizationId); assert.equal(row.customerTenantId, scope.customerTenantId) }); logs.push(...data); writes.push('records'); return { count: data.length } },
      deleteMany: async ({ where }: any) => { assert.equal(where.customerTenantId, tenant.id); return { count: 0 } },
    },
    tenantEntraSnapshot: { upsert: async ({ where, create, update: data }: any) => { scoped(where); assert.equal(create.organizationId, scope.organizationId); snapshot = structuredClone(data.payload); writes.push('window'); return {} } },
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async (sql: string, ...args: any[]) => {
      if (sql.includes("current_setting('TimeZone')")) return [{ timezone: 'UTC' }]
      assert.equal(args[0], scope.organizationId); assert.equal(args[1], scope.customerTenantId)
      if (sql.includes('FROM sign_in_logs')) return logs.filter(row => args[2].includes(row.microsoftSignInId)).map(row => ({ id: row.microsoftSignInId, raw: row.raw, bounded: true }))
      if (sql.includes('FROM tenant_entra_snapshots')) return [{ payload: snapshot, observedAt: priorSuccess }]
      throw new Error('Unexpected synthetic query')
    },
    $transaction: async (work: any) => work(db),
  }
  const service: any = new TenantSyncService(db, {} as any, {} as any, {
    publishIncident: async (incident: any) => published.push(incident), resolveIncident: async (...args: any[]) => resolved.push(args),
  } as any, { pruneExpired: async () => {} } as any, {} as any)
  service.logger = { warn() {}, log() {} }
  service.logSyncStart = async () => new Date(at.getTime() - 60 * 60_000)
  service.signInEntitlement = async () => 'NON_PREMIUM'
  service.fetchGraphCollection = async () => rows
  return { db, service, state, priorSuccess, logs, published, resolved, writes, valid, get snapshot() { return snapshot }, setRows(next: any[]) { rows = next }, run: () => service.syncSignInLogs(tenant, 'synthetic-token') }
}

test('mixed valid/invalid records retain evidence but cannot certify success across repeated partial, paused retry, and complete recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at })
  const h = harness(), oldWindow = structuredClone(h.snapshot)
  for (let cycle = 1; cycle <= 3; cycle++) {
    t.mock.timers.setTime(at.getTime() + cycle * 60_000)
    await assert.rejects(h.run, /coverage remains incomplete/)
    assert.equal(h.logs.length, 1, 'accepted evidence persists without duplicate replay rows')
    assert.equal(h.logs[0].microsoftSignInId, 'valid')
    assert.deepEqual(h.snapshot, oldWindow, 'the actual completed-window writer was not invoked')
    assert.equal(h.state.status, 'FAILED'); assert.equal(h.state.lastErrorCode, CORE_AUTHENTICATION_PARTIAL)
    assert.equal(h.state.lastSuccessfulAt, h.priorSuccess); assert.equal(h.state.consecutiveFailures, cycle)
    assert.equal(h.resolved.length, 0); assert.equal(h.published.length, cycle)
    assert.equal(h.published.at(-1).metadata.reasonCode, CORE_AUTHENTICATION_PARTIAL)
    assert.equal(h.published.at(-1).organizationId, scope.organizationId)
    assert.equal(h.published.at(-1).dedupeKey, 'tenant:tenant-a:sync:SIGN_INS')
    assert.equal(selectedAuthenticationSource(h.state), null)
  }
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  h.service.fetchGraphCollection = async () => { started(); await held; return [h.valid] }
  t.mock.timers.setTime(at.getTime() + 4 * 60_000)
  const retry = h.run(); await entered
  assert.equal(h.state.status, 'RUNNING'); assert.equal(h.state.lastErrorCode, CORE_AUTHENTICATION_PARTIAL)
  assert.match(h.state.lastErrorMessage, /coverage remains incomplete/)
  assert.equal(h.state.lastSuccessfulAt, h.priorSuccess); assert.equal(h.state.consecutiveFailures, 3)
  const blocked = await prepareAuthenticationEvaluation(scope, [], [], h.state, h.snapshot, true, new Date(), async () => 'unused')
  assert.equal(blocked.input, null); assert.equal(h.resolved.length, 0)
  release(); await retry
  assert.equal(h.state.status, 'SUCCEEDED'); assert.equal(h.state.lastErrorCode, null)
  assert.equal(h.state.lastErrorMessage, null); assert.equal(h.state.consecutiveFailures, 0)
  assert.equal(+h.state.lastSuccessfulAt, Date.now()); assert.equal(h.resolved.length, 1)
  assert.equal(h.snapshot.end, new Date().toISOString()); assert.equal(h.snapshot.paginationComplete, true)
  assert.ok(h.writes.indexOf('window') < h.writes.indexOf('SUCCEEDED'))
  assert.equal(selectedAuthenticationSource(h.state), 'GRAPH_SIGN_INS')
})

test('complete limited source and optional geolocation preserve their source/window qualification through refresh', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at })
  const h = harness()
  h.service.fetchGraphCollection = async () => { throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant') }
  h.service.fetchLimitedLoginActivity = async () => []
  h.service.enrichLimitedSignInLocations = async () => ({ locations: new Map(), partial: true })
  await h.run()
  assert.equal(h.state.status, 'RUNNING'); assert.match(h.state.lastErrorCode, /fallback-active-geolocation-partial$/)
  assert.equal(selectedAuthenticationSource(h.state), 'M365_AUDIT_STS')
  assert.equal(h.snapshot.source, 'M365_AUDIT_STS'); assert.equal(h.snapshot.paginationComplete, true)
  assert.equal(h.snapshot.observedEvents, 0); assert.equal(+h.state.lastSuccessfulAt, +at)
  const prepared = await prepareAuthenticationEvaluation(scope, [], [], h.state, h.snapshot, true, new Date(), async () => 'unused')
  assert.ok(prepared.input, 'complete selected primary window remains usable')
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(r => { started = r }), held = new Promise<void>(r => { release = r })
  h.service.fetchGraphCollection = async () => { started(); await held; return [] }
  t.mock.timers.setTime(at.getTime() + 60_000)
  const run = h.run(); await entered
  assert.match(h.state.lastErrorCode, /geolocation-partial$/)
  assert.equal(selectedAuthenticationSource(h.state), 'M365_AUDIT_STS')
  assert.equal((await prepareAuthenticationEvaluation(scope, [], [], h.state, h.snapshot, true, new Date(), async () => 'unused')).input, null, 'retained qualifier does not bypass in-flight timestamp coherence')
  release(); await run
  assert.equal(h.state.status, 'SUCCEEDED'); assert.equal(h.snapshot.source, 'GRAPH_SIGN_INS')
  assert.equal(h.snapshot.observedEvents, 0); assert.equal(selectedAuthenticationSource(h.state), 'GRAPH_SIGN_INS')
})

test('first-ever core loss keeps success unknown; foreign ingestion cannot enter this tenant store', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at })
  const h = harness()
  h.state.lastSuccessfulAt = null
  h.setRows([{ id: 'invalid', createdDateTime: 'invalid' }])
  await assert.rejects(h.run)
  assert.equal(h.state.lastSuccessfulAt, null); assert.equal(h.logs.length, 0)
  assert.equal(h.state.consecutiveFailures, 1)
  await assert.rejects(() => persistAuthenticationRecords(h.db, scope, [{ organizationId: 'other-org', customerTenantId: 'tenant-b', microsoftSignInId: 'foreign', raw: h.valid }] as never), /IDENTITY_AUTH_RECORD_INVALID/)
  assert.equal(h.logs.length, 0)
  assert.equal(h.published[0].customerTenantId, scope.customerTenantId)
})
