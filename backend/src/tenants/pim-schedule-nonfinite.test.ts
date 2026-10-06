import assert from 'node:assert/strict'
import test from 'node:test'
import { collectAndReadPimSchedule, type PimCollectionRequest } from './pim-schedule-orchestration.js'
import { PIM_ENDPOINTS, type PimLimits } from './pim-schedule-contract.js'
import { PimDatabaseDouble, testTenant } from './pim-schedule-test-double.js'

// Explicit synthetic policy only; no production defaults or external effects.
const limits: PimLimits = { pages: 4, rows: 20, pageBytes: 10000, materializedBytes: 50000,
  requestTimeoutMs: 1000, collectorDeadlineMs: 4000, wireBytes: 100000, requests: 4,
  retryAttempts: 0, retryDelayMs: 1, maxConflictVersions: 4, maxConflictEvidenceBytes: 10000 }
const continuation = PIM_ENDPOINTS.ACTIVE + '?$skiptoken=next'
const prefix = { value: [{ id: 'prefix', extension: null }], '@odata.nextLink': continuation }
function collect(db: PimDatabaseDouble, bodies: readonly string[], overrides: Partial<PimLimits> = {}) {
  const calls: string[] = []
  const request: PimCollectionRequest = { ...testTenant, plane: 'ACTIVE', scopeVersion: 'injected-pim-v1',
    attemptLifetimeMs: 10000, limits: { ...limits, ...overrides } }
  const result = collectAndReadPimSchedule(request, {
    db, authorization: { subjectId: 'injected-user', organizationId: testTenant.organizationId,
      tenantMemberships: new Set([testTenant.customerTenantId]) },
    transport: {
      token: async () => { assert.equal(db.inTransaction, false); return 'injected-token' },
      fetchPage: async r => {
        assert.equal(db.inTransaction, false); assert.equal(r.redirect, 'error')
        assert.equal(r.microsoftTenantId, testTenant.microsoftTenantId)
        assert.ok(calls.length < bodies.length, 'unexpected transport call')
        const body = bodies[calls.length]; calls.push(r.url)
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      },
    },
  })
  return { result, calls }
}
async function withPrevious() {
  const db = new PimDatabaseDouble()
  const seed = await collect(db, [JSON.stringify({ value: [{ id: 'previous' }] })]).result
  assert.equal(seed.collection.status, 'committed')
  return { db, prior: structuredClone(db.attempts[0]) }
}

for (const [label, body] of [
  ['positive overflow', '{"value":[{"id":"unrepresentable","unknown":1e999}]}'],
  ['negative overflow', '{"value":[{"id":"unrepresentable","unknown":-1e999}]}'],
  ['existing syntax failure', '{'],
] as const) test('real collect/persist/read retains bounded invalid-JSON metadata: ' + label, async () => {
  if (label !== 'existing syntax failure') assert.equal(Number.isFinite(JSON.parse(body).value[0].unknown), false)
  const { db, prior } = await withPrevious()
  const { result, calls } = collect(db, [JSON.stringify(prefix), body])
  const r = await result, latest = db.attempts[1]
  assert.equal(r.collection.status, 'recorded'); assert.equal(r.persisted.status, 'last-attempt-failed')
  // This single assertion exposes BOTH v1 defects in the preserved failing TAP diff.
  assert.deepEqual({ failureKind: latest.failure_kind, traversal: latest.traversal_outcome,
    metadata: db.wireFailures.filter(w => w.attempt_id === latest.id) },
  { failureKind: 'INVALID_JSON', traversal: 'ERRORED',
    metadata: [{ attempt_id: latest.id, page_index: 1, byte_length: Buffer.byteLength(body), failure_kind: 'INVALID_JSON' }] })
  assert.deepEqual(calls, [PIM_ENDPOINTS.ACTIVE, continuation])
  assert.deepEqual(db.envelopes.filter(e => e.attempt_id === latest.id).map(e => e.envelope), [prefix])
  assert.deepEqual(db.attempts[0], prior); assert.equal(latest.is_current, false)
  assert.equal(db.rows.filter(row => row.attempt_id === latest.id).length, 0)
  if (r.persisted.status !== 'last-attempt-failed') return assert.fail()
  assert.equal(r.persisted.view?.attemptId, prior.id); assert.equal(r.persisted.view?.rows[0].instanceId, 'previous')
  assert.equal(r.persisted.view?.assurance, 'UNKNOWN'); assert.equal(r.persisted.view?.coverage, 'NOT_ESTABLISHED')
  // No failed body or coerced nonfinite value is persisted in the metadata representation.
  assert.deepEqual(Object.keys(db.wireFailures[0]).sort(), ['attempt_id', 'byte_length', 'failure_kind', 'page_index'])
})

for (const [label, overrides, size] of [
  ['wire page cap', { pageBytes: 800 }, 1200],
  ['parsed materialized cap', { materializedBytes: 500 }, 600],
] as const) test('genuine capacity remains TRUNCATED_BUDGET: ' + label, async () => {
  const { db, prior } = await withPrevious()
  const body = JSON.stringify({ value: [{ id: 'oversize', extension: 'x'.repeat(size) }] })
  const { result, calls } = collect(db, [JSON.stringify(prefix), body], overrides)
  const r = await result
  assert.equal(r.collection.status, 'recorded'); assert.equal(db.attempts[1].failure_kind, 'CAPACITY')
  assert.equal(db.attempts[1].traversal_outcome, 'TRUNCATED_BUDGET'); assert.deepEqual(db.wireFailures, [])
  assert.deepEqual(db.attempts[0], prior); assert.deepEqual(calls, [PIM_ENDPOINTS.ACTIVE, continuation])
  assert.deepEqual(db.envelopes.filter(e => e.attempt_id === db.attempts[1].id).map(e => e.envelope), [prefix])
})

test('ordinary finite JSON still publishes the full parsed values without failure metadata', async () => {
  const { db, prior } = await withPrevious()
  const body = '{"value":[{"id":"finite","unknown":1e3,"mixed":[null,true,"Case",1.25]}],"extension":{"keep":null}}'
  const { result, calls } = collect(db, [JSON.stringify(prefix), body])
  const r = await result
  assert.equal(r.collection.status, 'committed'); assert.equal(r.persisted.status, 'observed')
  assert.deepEqual(db.wireFailures, []); assert.deepEqual(calls, [PIM_ENDPOINTS.ACTIVE, continuation])
  assert.deepEqual(db.envelopes.filter(e => e.attempt_id === db.attempts[1].id).map(e => e.envelope), [prefix, JSON.parse(body)])
  if (r.persisted.status !== 'observed') return assert.fail()
  assert.deepEqual(r.persisted.view.rows.map(row => row.raw), [prefix.value[0], JSON.parse(body).value[0]])
  assert.equal(r.persisted.view.observedRowCount, 2); assert.notEqual(r.persisted.view.attemptId, prior.id)
  assert.equal(r.persisted.view.assurance, 'UNKNOWN'); assert.equal(r.persisted.view.coverage, 'NOT_ESTABLISHED')
})
