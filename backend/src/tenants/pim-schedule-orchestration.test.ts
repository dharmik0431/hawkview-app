import assert from 'node:assert/strict'
import test from 'node:test'
import { collectAndReadPimSchedule, type PimCollectionRequest } from './pim-schedule-orchestration.js'
import { capturePimAttempt, beginPimAttempt, publishPimObservations, recordPimTerminalFailure, rotatePimScope, attemptFromRecord } from './pim-schedule-store.js'
import { acquirePimSchedule, type PimTransport } from './pim-schedule-acquisition.js'
import { preparePimCollection } from './pim-schedule-preparation.js'
import { readPimSchedulePlane, type PimReadAuthorization } from './pim-schedule-reader.js'
import { PIM_ENDPOINTS, PIM_PRODUCTION_ACTIVATION, type PimLimits, type PimPlane, type PimFailure, type ParsedEnvelope } from './pim-schedule-contract.js'
import { PIM_SCHEDULE_ACCESS_CAPABILITIES, DEFAULT_REQUIRED_PERMISSIONS, MICROSOFT_ACCESS_CAPABILITIES } from '../microsoft/microsoft-access-contract.js'
import { PimDatabaseDouble, testTenant, alternateId } from './pim-schedule-test-double.js'

// Synthetic caller policy, never a product default.
const limits: PimLimits = { pages: 5, rows: 20, pageBytes: 5000, materializedBytes: 50000,
  requestTimeoutMs: 1000, collectorDeadlineMs: 4000, wireBytes: 20000, requests: 8,
  retryAttempts: 1, retryDelayMs: 1, maxConflictVersions: 4, maxConflictEvidenceBytes: 5000 }
const request = (plane: PimPlane = 'ACTIVE'): PimCollectionRequest => ({ ...testTenant, plane,
  scopeVersion: 'injected-pim-v1', attemptLifetimeMs: 10000, limits: { ...limits } })
const auth = (): PimReadAuthorization => ({ subjectId: 'injected-user', organizationId: testTenant.organizationId,
  tenantMemberships: new Set([testTenant.customerTenantId]) })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const envelope = (body: any, plane: PimPlane = 'ACTIVE'): ParsedEnvelope => ({ pageIndex: 0,
  requestedToken: PIM_ENDPOINTS[plane], envelope: body, byteLength: Buffer.byteLength(JSON.stringify(body)) })
function transport(db: PimDatabaseDouble, pages: Array<unknown | Response | (() => Promise<Response>)>) {
  const calls: Parameters<PimTransport['fetchPage']>[0][] = []
  let tokens = 0
  const effects: PimTransport = {
    token: async (a, tenant, _deadline, signal) => {
      assert.equal(db.inTransaction, false); assert.equal(tenant, testTenant.microsoftTenantId)
      assert.equal(a.configurationRevision, db.authority?.configurationRevision); assert.equal(signal.aborted, false)
      tokens++; return 'injected-token'
    },
    fetchPage: async r => {
      assert.equal(db.inTransaction, false); assert.equal(r.redirect, 'error'); assert.equal(r.method, 'GET')
      assert.equal(r.microsoftTenantId, testTenant.microsoftTenantId); calls.push(r)
      assert.ok(pages.length, 'unexpected transport call')
      const p = pages.shift()!
      return typeof p === 'function' ? p() : p instanceof Response ? p : json(p)
    },
  }
  return { effects, calls, tokens: () => tokens }
}
const collect = (db: PimDatabaseDouble, pages: Parameters<typeof transport>[1], req = request()) => {
  const t = transport(db, pages)
  return { t, result: collectAndReadPimSchedule(req, { db, authorization: auth(), transport: t.effects }) }
}
async function captured(db: PimDatabaseDouble, req = request()) {
  const c = await capturePimAttempt(db, req)
  assert.equal(c.status, 'captured'); if (c.status !== 'captured') throw new Error('capture rejected')
  return c
}
const failed: PimFailure = { failureKind: 'PROVIDER_FAILED', traversalOutcome: 'ERRORED', envelopes: [], wireFailures: [] }

for (const plane of ['ACTIVE', 'ELIGIBLE'] as const) test('integrated empty ' + plane + ' is an observed qualified empty', async () => {
  const db = new PimDatabaseDouble(), { result, t } = collect(db, [{ value: [] }], request(plane))
  const r = await result
  assert.equal(r.collection.status, 'committed'); assert.equal(r.persisted.status, 'observed')
  if (r.persisted.status !== 'observed') return assert.fail()
  assert.equal(r.persisted.view.observedRowCount, 0); assert.deepEqual(r.persisted.view.rows, [])
  assert.equal(r.persisted.view.assurance, 'UNKNOWN'); assert.equal(r.persisted.view.coverage, 'NOT_ESTABLISHED')
  assert.equal(r.persisted.view.traversalOutcome, 'EXHAUSTED'); assert.equal(r.persisted.view.plane, plane)
  assert.equal(t.calls[0].url, PIM_ENDPOINTS[plane]); assert.equal(db.envelopes.length, 1)
  assert.ok(r.persisted.view.committedAt instanceof Date); assert.equal(r.persisted.view.scopeId, db.scopes[0].id)
})
test('nonempty caller retains all occurrences, invalid IDs, exact case and unknown/null/absent parsed values', async () => {
  const raw = [{ id: null, unknown: [1, null, 'A'] }, { id: 'x', startDateTime: null, endDateTime: 'not-a-date' },
    { id: 'x', extension: true, startDateTime: '2026-10-01T12:00:00Z' }, { id: 'x', extension: true, startDateTime: '2026-10-01T12:00:00Z' }, 7]
  const db = new PimDatabaseDouble(), r = await collect(db, [{ value: raw, extension: { hidden: null } }]).result
  assert.equal(r.persisted.status, 'observed'); if (r.persisted.status !== 'observed') return assert.fail()
  const rows = r.persisted.view.rows
  assert.deepEqual(rows.map(r => r.raw), raw); assert.deepEqual(rows.map(r => r.instanceId), [null, 'x', 'x', 'x', null])
  assert.deepEqual(rows.map(r => r.occurrenceOrdinal), [0, 1, 2, 3, 4])
  assert.ok((rows[1].diagnostics as string[]).includes('DUPLICATE_INSTANCE_ID'))
  assert.equal(rows[1].providerStartDateTime, null); assert.equal(rows[1].providerEndDateTime, null)
  assert.equal(rows[2].providerStartDateTime?.toISOString(), '2026-10-01T12:00:00.000Z')
  assert.notEqual(rows[2].providerStartDateTime?.getTime(), r.persisted.view.committedAt.getTime())
  assert.deepEqual(db.envelopes[0].envelope, { value: raw, extension: { hidden: null } })
})
test('empty intermediate page follows original opaque continuation verbatim', async () => {
  const next = PIM_ENDPOINTS.ACTIVE + '?$skiptoken=Ab%2Bc%2F%3D'
  const db = new PimDatabaseDouble(), { t, result } = collect(db, [{ value: [], '@odata.nextLink': next }, { value: [{ id: 'last' }] }])
  const r = await result
  assert.equal(r.collection.status, 'committed'); assert.deepEqual(t.calls.map(c => c.url), [PIM_ENDPOINTS.ACTIVE, next])
  assert.equal(db.rows[0].instance_id, 'last'); assert.equal(db.envelopes.length, 2)
})
for (const next of ['https://evil.example/data', PIM_ENDPOINTS.ELIGIBLE, PIM_ENDPOINTS.ACTIVE.replace('/v1.0/', '/beta/'),
  PIM_ENDPOINTS.ACTIVE + '?$select=id', PIM_ENDPOINTS.ACTIVE + '?$expand=principal', PIM_ENDPOINTS.ACTIVE + '?tenantId=other',
  'https://user:pass@graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleInstances',
  PIM_ENDPOINTS.ACTIVE + '#fragment']) test('refuses continuation before second credential-bearing call: ' + next, async () => {
  const db = new PimDatabaseDouble(), { t, result } = collect(db, [{ value: [], '@odata.nextLink': next }])
  const r = await result
  assert.equal(t.calls.length, 1); assert.equal(r.collection.status, 'recorded')
  assert.equal(db.attempts[0].failure_kind, 'INVALID_CONTINUATION'); assert.equal(db.attempts[0].is_current, false)
})
test('scope initialization separates both planes, and capture never rotates an existing generation', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'active' }] }]).result
  await collect(db, [{ value: [{ id: 'eligible' }] }], request('ELIGIBLE')).result
  assert.equal(db.scopes.length, 2); assert.notEqual(db.scopes[0].id, db.scopes[1].id)
  const denied = await capturePimAttempt(db, { ...request(), scopeVersion: 'changed' })
  assert.deepEqual(denied, { status: 'rejected', reason: 'SCOPE_REPLACED' }); assert.equal(db.scopes.length, 2)
  const active = await readPimSchedulePlane(db, auth(), request())
  assert.equal(active.status, 'observed'); if (active.status === 'observed') assert.equal(active.view.rows[0].instanceId, 'active')
})
test('partial page cap keeps prior current view and atomically records captured envelopes', async () => {
  const db = new PimDatabaseDouble()
  const first = await collect(db, [{ value: [{ id: 'prior' }] }]).result
  const prior = db.attempts[0].id
  const req = request(); req.limits.pages = 1
  const { t, result } = collect(db, [{ value: [{ id: 'partial' }], '@odata.nextLink': PIM_ENDPOINTS.ACTIVE + '?$skiptoken=next' }], req)
  const r = await result
  assert.equal(t.calls.length, 1); assert.equal(r.persisted.status, 'last-attempt-failed')
  if (r.persisted.status !== 'last-attempt-failed') return assert.fail()
  assert.equal(r.persisted.view?.attemptId, prior); assert.equal(r.persisted.view?.rows[0].instanceId, 'prior')
  assert.equal(db.attempts[1].traversal_outcome, 'TRUNCATED_BUDGET'); assert.equal(db.rows.length, 1)
  assert.equal(db.envelopes.filter(e => e.attempt_id === db.attempts[1].id).length, 1)
  assert.equal(first.collection.status, 'committed')
})
test('wire parsing failure retains metadata only and leaves prior current unchanged', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'prior' }] }]).result
  const r = await collect(db, [new Response('{', { status: 200 })]).result
  assert.equal(r.persisted.status, 'last-attempt-failed'); assert.equal(db.wireFailures.length, 1)
  assert.deepEqual(Object.keys(db.wireFailures[0]).sort(), ['attempt_id', 'byte_length', 'failure_kind', 'page_index'])
  assert.equal(db.wireFailures[0].byte_length, 1); assert.equal(db.wireFailures[0].failure_kind, 'INVALID_JSON')
  assert.equal(db.envelopes.length, 1); assert.equal(db.attempts[0].is_current, true)
})
test('provider error does not persist provider text or replace current observations', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [] }]).result
  await collect(db, [new Response('sensitive provider body', { status: 403 })]).result
  assert.equal(db.attempts[1].failure_kind, 'PROVIDER_FAILED'); assert.equal(db.attempts[0].is_current, true)
  assert.equal(JSON.stringify(db.envelopes).includes('sensitive'), false)
})
test('429 without Retry-After uses caller fallback and finite retry/request limits', async () => {
  const db = new PimDatabaseDouble(), { t, result } = collect(db, [new Response('', { status: 429 }), { value: [] }])
  assert.equal((await result).collection.status, 'committed'); assert.equal(t.calls.length, 2)
  assert.equal(t.calls[0].url, t.calls[1].url)
  const req = request(); req.limits.requests = 1
  const next = collect(db, [new Response('', { status: 429 })], req)
  await next.result; assert.equal(next.t.calls.length, 1); assert.equal(db.attempts[1].failure_kind, 'CAPACITY')
})
test('repeated URL and aggregate wire cap refuse extra transport', async () => {
  for (const mode of ['repeat', 'wire'] as const) {
    const db = new PimDatabaseDouble(), req = request()
    const body = { value: [], '@odata.nextLink': PIM_ENDPOINTS.ACTIVE + (mode === 'wire' ? '?$skiptoken=next' : '') }
    if (mode === 'wire') req.limits.wireBytes = Buffer.byteLength(JSON.stringify(body))
    const { t, result } = collect(db, [body], req)
    await result; assert.equal(t.calls.length, 1); assert.equal(db.attempts[0].failure_kind, 'CAPACITY')
  }
})
test('request timeout bounds a noncooperative injected fetch and aborts its signal', async () => {
  const db = new PimDatabaseDouble(), req = request(); req.limits.requestTimeoutMs = 10
  let signal: AbortSignal | undefined
  const r = await collectAndReadPimSchedule(req, { db, authorization: auth(), transport: {
    token: async () => 'token', fetchPage: async r => { signal = r.signal; return new Promise<Response>(() => {}) },
  } })
  assert.equal(r.collection.status, 'recorded'); assert.equal(signal?.aborted, true)
  assert.equal(db.attempts[0].traversal_outcome, 'TRUNCATED_DEADLINE')
})
test('stream deadline is bounded and cancellation requested', async () => {
  const db = new PimDatabaseDouble(), req = request(); req.limits.requestTimeoutMs = 15
  let cancelled = false
  const response = new Response(new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }))
  await collect(db, [response], req).result
  assert.equal(cancelled, true); assert.equal(db.attempts[0].traversal_outcome, 'TRUNCATED_DEADLINE')
})
test('caller mutation across transport await aborts acquisition and is not committed', async () => {
  const db = new PimDatabaseDouble(), req = request()
  const { result, t } = collect(db, [async () => { req.microsoftTenantId = alternateId; return json({ value: [{ id: 'wrong' }] }) }], req)
  await result; assert.equal(t.calls.length, 1); assert.equal(db.attempts[0].failure_kind, 'CONTEXT_CHANGED')
  assert.equal(db.rows.length, 0); assert.equal(db.attempts[0].is_current, false)
})
test('capture copies tenant identity before its first await', async () => {
  const db = new PimDatabaseDouble(), req = request()
  db.hook = op => { if (op === 'G-advisory') { req.microsoftTenantId = alternateId; db.hook = null } }
  const c = await captured(db, req)
  assert.equal(c.attempt.microsoftTenantId, testTenant.microsoftTenantId)
  assert.equal(c.authority.configurationRevision, db.authority?.configurationRevision)
  assert.deepEqual(db.operations.slice(2, 7), ['G-advisory', 'G-row', 'tenant', 'connection', 'scope'])
})
test('live scope rotation rejects delayed success and preserves historical current view', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'prior' }] }]).result
  const c = await captured(db), p = preparePimCollection(c.attempt, [envelope({ value: [{ id: 'late' }] })], limits)
  const oldScope = structuredClone(db.scopes[0])
  const rotation = await rotatePimScope(db, c.attempt, 'injected-pim-v2')
  assert.equal(rotation.status, 'rotated'); assert.equal(db.scopes.length, 2)
  assert.equal(db.scopes[0].scope_incarnation, oldScope.scope_incarnation); assert.equal(db.scopes[0].scope_version, oldScope.scope_version)
  assert.deepEqual(await publishPimObservations(db, c.attempt, p, limits), { status: 'rejected', reason: 'SCOPE_REPLACED' })
  assert.equal(db.attempts[0].is_current, true); assert.equal(db.rows.length, 1)
})
test('expiry retirement allows a successor; delayed error cannot rewrite ABANDONED', async () => {
  const db = new PimDatabaseDouble(), a = await captured(db)
  assert.deepEqual(await beginPimAttempt(db, a.attempt, 100), { status: 'rejected', reason: 'BUSY' })
  db.now = a.attempt.expiresAt.getTime()
  const b = await beginPimAttempt(db, a.attempt, 1000)
  assert.ok('attemptId' in b); assert.equal(db.attempts[0].outcome, 'ABANDONED')
  assert.deepEqual(await recordPimTerminalFailure(db, a.attempt, failed, limits), { status: 'rejected', reason: 'SUPERSEDED' })
  assert.equal(db.attempts[1].outcome, null); assert.equal(db.attempts[0].outcome, 'ABANDONED')
})
test('still-owned expired attempt may fail; expired publication cannot commit', async () => {
  const db = new PimDatabaseDouble(), a = await captured(db)
  const p = preparePimCollection(a.attempt, [envelope({ value: [] })], limits)
  db.now = a.attempt.expiresAt.getTime()
  assert.deepEqual(await publishPimObservations(db, a.attempt, p, limits), { status: 'rejected', reason: 'EXPIRED' })
  assert.equal((await recordPimTerminalFailure(db, a.attempt, failed, limits)).status, 'recorded')
  assert.equal(db.attempts[0].outcome, 'FAILED')
})
test('replay precedes expiry/ownership, binds all authority, and writes nothing', async () => {
  const db = new PimDatabaseDouble(), a = await captured(db)
  const p = preparePimCollection(a.attempt, [envelope({ value: [] })], limits)
  assert.equal((await publishPimObservations(db, a.attempt, p, limits)).status, 'committed')
  const newer = await beginPimAttempt(db, a.attempt, 1000); assert.ok('attemptId' in newer)
  db.now = a.attempt.expiresAt.getTime() + 1
  const writes = db.mutations
  assert.equal((await publishPimObservations(db, a.attempt, p, limits)).status, 'replayed'); assert.equal(db.mutations, writes)
  const different = preparePimCollection(a.attempt, [envelope({ value: [{ id: 'different' }] })], limits)
  assert.deepEqual(await publishPimObservations(db, a.attempt, different, limits), { status: 'rejected', reason: 'CONFLICT' })
  db.incarnation = alternateId
  assert.deepEqual(await publishPimObservations(db, a.attempt, p, limits), { status: 'rejected', reason: 'INCARNATION_CHANGED' })
  assert.deepEqual(await publishPimObservations(db, { ...a.attempt, connectionIncarnation: alternateId }, p, limits), { status: 'rejected', reason: 'INCARNATION_CHANGED' })
  db.incarnation = a.attempt.connectionIncarnation; db.authority!.configurationRevision = alternateId
  assert.deepEqual(await publishPimObservations(db, a.attempt, p, limits), { status: 'rejected', reason: 'SUPERSEDED' })
  assert.deepEqual(await publishPimObservations(db, { ...a.attempt, configurationRevision: alternateId }, p, limits), { status: 'rejected', reason: 'INCARNATION_CHANGED' })
})
test('cross-tenant, cross-plane and forged occurrence/digest publication write nothing', async () => {
  const db = new PimDatabaseDouble(), a = await captured(db)
  const p = preparePimCollection(a.attempt, [envelope({ value: [{ id: null }] })], limits)
  const writes = db.mutations
  assert.deepEqual(await publishPimObservations(db, { ...a.attempt, microsoftTenantId: alternateId }, p, limits), { status: 'rejected', reason: 'TENANT_MISMATCH' })
  assert.deepEqual(await publishPimObservations(db, a.attempt, { ...p, rows: [{ ...p.rows[0], plane: 'ELIGIBLE' }] }, limits), { status: 'rejected', reason: 'PLANE_MISMATCH' })
  for (const forged of [{ ...p, rows: [{ ...p.rows[0], occurrenceOrdinal: 9 }] }, { ...p, contentDigest: '0'.repeat(64) },
    { ...p, traversalOutcome: 'TRUNCATED_BUDGET' as 'EXHAUSTED' }]) {
    assert.deepEqual(await publishPimObservations(db, a.attempt, forged, limits), { status: 'rejected', reason: 'CONFLICT' })
  }
  assert.equal(db.mutations, writes)
})
test('mid-publication exception rolls back payload/current swap and propagates without failure mutation', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'prior' }] }]).result
  db.hook = op => { if (op === 'observation') throw new Error('injected insert failure') }
  await assert.rejects(collect(db, [{ value: [{ id: 'new' }] }]).result, /injected insert failure/)
  assert.equal(db.attempts[0].is_current, true); assert.equal(db.attempts[1].outcome, null)
  assert.equal(db.envelopes.length, 1); assert.equal(db.rows.length, 1); assert.equal(db.operations.includes('fail'), false)
})
test('expiry during terminal transaction rolls back the cleared current and all new evidence', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'prior' }] }]).result
  const a = await captured(db), p = preparePimCollection(a.attempt, [envelope({ value: [{ id: 'late' }] })], limits)
  db.hook = op => { if (op === 'commit') db.now = a.attempt.expiresAt.getTime() }
  assert.deepEqual(await publishPimObservations(db, a.attempt, p, limits), { status: 'rejected', reason: 'EXPIRED' })
  assert.equal(db.attempts[0].is_current, true); assert.equal(db.attempts[1].outcome, null); assert.equal(db.rows.length, 1)
})
test('failure evidence and FAILED transition roll back together', async () => {
  const db = new PimDatabaseDouble(), a = await captured(db)
  db.hook = op => { if (op === 'fail') throw new Error('injected terminal failure') }
  await assert.rejects(recordPimTerminalFailure(db, a.attempt, { ...failed, envelopes: [envelope({ value: [] })] }, limits), /injected terminal failure/)
  assert.equal(db.envelopes.length, 0); assert.equal(db.attempts[0].outcome, null)
})
test('equal content carries its content-change clock while a new observation gets a new commit clock', async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'stable' }] }]).result
  const first = structuredClone(db.attempts[0]); db.now += 100
  await collect(db, [{ value: [{ id: 'stable' }] }]).result
  assert.equal(db.attempts[1].content_changed_at?.getTime(), first.content_changed_at?.getTime())
  assert.ok(db.attempts[1].committed_at! > first.committed_at!)
})
test('authorization precedes any query and keeps organization filter; never-collected differs from empty', async () => {
  const db = new PimDatabaseDouble()
  assert.deepEqual(await readPimSchedulePlane(db, auth(), request()), { status: 'never-collected', plane: 'ACTIVE' })
  const before = db.operations.length
  await assert.rejects(readPimSchedulePlane(db, { ...auth(), tenantMemberships: new Set() }, request()), /PIM_FORBIDDEN/)
  await assert.rejects(collectAndReadPimSchedule(request(), { db, authorization: { ...auth(), organizationId: alternateId }, transport: transport(db, []).effects }), /PIM_FORBIDDEN/)
  assert.equal(db.operations.length, before)
  await collect(db, [{ value: [] }]).result
  assert.deepEqual(await readPimSchedulePlane(db, { ...auth(), organizationId: alternateId }, request()), { status: 'never-collected', plane: 'ACTIVE' })
})
test('missing/nonfinite policy and lifetime reject before database or transport', async () => {
  for (const patch of [{ limits: undefined }, { limits: { ...limits, pageBytes: Infinity } }, { limits: { ...limits, rows: NaN } },
    { limits: { ...limits, requestTimeoutMs: 0 } }, { attemptLifetimeMs: undefined }, { attemptLifetimeMs: -1 }]) {
    const db = new PimDatabaseDouble(), req = { ...request(), ...patch } as PimCollectionRequest
    await assert.rejects(collect(db, [], req).result, /INVALID_PIM/); assert.equal(db.operations.length, 0)
  }
})
test('explicit dormant capabilities preserve consent and do not alias DIRECTORY_ROLES or activate dispatch', () => {
  assert.equal(PIM_PRODUCTION_ACTIVATION, false)
  assert.equal(DEFAULT_REQUIRED_PERMISSIONS.length, 20)
  for (const plane of ['ACTIVE', 'ELIGIBLE'] as const) {
    const c = PIM_SCHEDULE_ACCESS_CAPABILITIES[plane]
    assert.equal(c.endpoint, PIM_ENDPOINTS[plane]); assert.equal(c.activation, 'DISABLED')
    assert.equal(c.applicationPermission.name, 'RoleManagement.Read.Directory'); assert.equal(c.assurance, 'UNKNOWN')
    assert.equal(MICROSOFT_ACCESS_CAPABILITIES.some(active => String(active.key) === c.key), false)
  }
})

for (const change of ['configuration', 'connection', 'tenant', 'scope'] as const) test('integrated late result rejects changed live ' + change, async () => {
  const db = new PimDatabaseDouble()
  await collect(db, [{ value: [{ id: 'prior' }] }]).result
  const { result } = collect(db, [async () => {
    if (change === 'configuration') db.authority!.configurationRevision = alternateId
    if (change === 'connection') db.incarnation = alternateId
    if (change === 'tenant') db.tenant.microsoftTenantId = alternateId
    if (change === 'scope') await rotatePimScope(db, attemptFromRecord(db.attempts[1]), 'rotated')
    return json({ value: [{ id: 'stale' }] })
  }])
  const r = await result
  assert.equal(r.collection.status, 'rejected'); assert.equal(db.attempts[0].is_current, true)
  assert.equal(db.rows.length, 1); assert.equal(db.envelopes.length, 1); assert.equal(db.attempts[1].outcome, null)
})
test('publish copies payload before lock await; caller mutation cannot replace prepared observations', async () => {
  const db = new PimDatabaseDouble(), a = await captured(db)
  const p = preparePimCollection(a.attempt, [envelope({ value: [{ id: 'original' }] })], limits)
  db.hook = op => {
    if (op === 'G-advisory') { (p.rows[0].raw as { id: string }).id = 'changed'; db.hook = null }
  }
  assert.equal((await publishPimObservations(db, a.attempt, p, limits)).status, 'committed')
  assert.equal(db.rows[0].raw.id, 'original')
})
test('captured authority and attempt mutation across an await are detected', async () => {
  const db = new PimDatabaseDouble(), c = await captured(db), authority = { ...c.authority }
  const t = transport(db, [{ value: [] }])
  t.effects.token = async copied => {
    authority.credentialReference = 'changed'; c.attempt.expiresAt.setTime(0)
    assert.equal(copied.credentialReference, 'injected-only'); return 'token'
  }
  const r = await acquirePimSchedule(c.attempt, authority, limits, t.effects)
  assert.equal(r.status, 'failed'); if (r.status === 'failed') assert.equal(r.failure.failureKind, 'CONTEXT_CHANGED')
  assert.equal(t.calls.length, 0)
})
test('row, page-byte and retained-envelope limits preserve previous current observation', async () => {
  for (const cap of ['rows', 'pageBytes', 'materializedBytes'] as const) {
    const db = new PimDatabaseDouble(); await collect(db, [{ value: [{ id: 'prior' }] }]).result
    const req = request(); req.limits[cap] = cap === 'rows' ? 0 : 20
    await collect(db, [{ value: [{ id: 'new', extension: 'x'.repeat(30) }] }], req).result
    assert.equal(db.attempts[0].is_current, true); assert.equal(db.attempts[1].outcome, 'FAILED')
    assert.equal(db.attempts[1].traversal_outcome, 'TRUNCATED_BUDGET'); assert.equal(db.rows.length, 1)
  }
})
test('whole collector deadline refuses another request even after a successful response', async () => {
  const db = new PimDatabaseDouble(), req = request(); req.limits.collectorDeadlineMs = 10
  const { result, t } = collect(db, [async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return json({ value: [], '@odata.nextLink': PIM_ENDPOINTS.ACTIVE + '?$skiptoken=next' })
  }], req)
  await result; assert.equal(t.calls.length, 1); assert.equal(db.attempts[0].failure_kind, 'DEADLINE')
})
test('wrong tenant or disconnected capture stops before token acquisition', async () => {
  for (const state of ['inactive', 'disconnected', 'tenant'] as const) {
    const db = new PimDatabaseDouble()
    if (state === 'inactive') db.active = false
    if (state === 'disconnected') db.connected = false
    if (state === 'tenant') db.tenant.microsoftTenantId = alternateId
    const { result, t } = collect(db, [])
    assert.equal((await result).collection.status, 'rejected'); assert.equal(t.tokens(), 0); assert.equal(db.attempts.length, 0)
  }
})
test('malformed parsed envelope survives as parsed evidence, without fabricated rows', async () => {
  const db = new PimDatabaseDouble(), raw = { value: null, unknown: { keep: 'Case' } }
  const r = await collect(db, [raw]).result
  assert.equal(r.collection.status, 'recorded'); assert.equal(db.attempts[0].failure_kind, 'INVALID_ENVELOPE')
  assert.deepEqual(db.envelopes[0].envelope, raw); assert.equal(db.rows.length, 0)
})
