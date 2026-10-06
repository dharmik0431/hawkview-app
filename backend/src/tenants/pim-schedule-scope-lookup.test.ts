import assert from 'node:assert/strict'
import test from 'node:test'
import { readCurrentPimScope } from './pim-schedule-scope-lookup.js'
import { capturePimAttempt, rotatePimScope, attemptFromRecord } from './pim-schedule-store.js'
import { collectAndReadPimSchedule, type PimCollectionRequest } from './pim-schedule-orchestration.js'
import { readPimSchedulePlane, type PimReadAuthorization } from './pim-schedule-reader.js'
import { PIM_ENDPOINTS, PIM_PROJECTION, type PimLimits, type PimPlane } from './pim-schedule-contract.js'
import { PimDatabaseDouble, testTenant, alternateId } from './pim-schedule-test-double.js'

// Synthetic caller policy, never a product default.
const limits: PimLimits = { pages: 5, rows: 20, pageBytes: 5000, materializedBytes: 50000,
  requestTimeoutMs: 1000, collectorDeadlineMs: 4000, wireBytes: 20000, requests: 8,
  retryAttempts: 1, retryDelayMs: 1, maxConflictVersions: 4, maxConflictEvidenceBytes: 5000 }
const auth = (): PimReadAuthorization => ({ subjectId: 'injected-user', organizationId: testTenant.organizationId,
  tenantMemberships: new Set([testTenant.customerTenantId]) })
const lookup = (db: PimDatabaseDouble, plane: PimPlane = 'ACTIVE', a: PimReadAuthorization = auth()) =>
  readCurrentPimScope(db, a, { customerTenantId: testTenant.customerTenantId, plane })

/** Seeds a committed ACTIVE collection so a current scope exists and no attempt is in flight. */
async function seeded(db: PimDatabaseDouble) {
  const req: PimCollectionRequest = { ...testTenant, plane: 'ACTIVE', scopeVersion: 'injected-pim-v1',
    attemptLifetimeMs: 10000, limits: { ...limits } }
  const transport = {
    token: async () => 'injected-token',
    fetchPage: async () => new Response(JSON.stringify({ value: [{ id: 'prior' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }),
  }
  const r = await collectAndReadPimSchedule(req, { db, authorization: auth(), transport })
  assert.equal(r.collection.status, 'committed')
  return r
}

test('a caller that did not rotate discovers the new current version and captures with it', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const rotation = await rotatePimScope(db, attemptFromRecord(db.attempts[0]), 'injected-pim-v2')
  assert.equal(rotation.status, 'rotated')

  const found = await lookup(db)
  assert.ok(db.operations.includes('scope-lookup'), 'new lookup path was actually invoked')
  assert.equal(found.status, 'current')
  if (found.status !== 'current') return assert.fail()
  // Discovery reports the live version without the caller having known it.
  assert.equal(found.scope.scopeVersion, 'injected-pim-v2')
  assert.equal(found.scope.scopeId, db.scopes.find(s => s.is_current)!.id)
  assert.equal(found.scope.microsoftTenantId, testTenant.microsoftTenantId)
  assert.equal(found.scope.connectionIncarnation, db.incarnation)
  assert.equal(found.scope.endpointDescriptor, PIM_ENDPOINTS.ACTIVE)
  assert.equal(found.scope.projectionIdentity, PIM_PROJECTION)
  // No managed credential is exposed by the discovery contract.
  assert.deepEqual(Object.keys(found.scope).filter(k => /credential|secret|client|token/i.test(k)), [])

  const captured = await capturePimAttempt(db, { ...testTenant, plane: 'ACTIVE',
    scopeVersion: found.scope.scopeVersion, attemptLifetimeMs: 10000 })
  assert.equal(captured.status, 'captured')

  // Narrow failing control: the version the caller held BEFORE discovery is now refused, so the
  // capture above succeeded because of the discovered value and not for an incidental reason.
  const db2 = new PimDatabaseDouble()
  await seeded(db2)
  assert.equal((await rotatePimScope(db2, attemptFromRecord(db2.attempts[0]), 'injected-pim-v2')).status, 'rotated')
  assert.deepEqual(await capturePimAttempt(db2, { ...testTenant, plane: 'ACTIVE',
    scopeVersion: 'injected-pim-v1', attemptLifetimeMs: 10000 }), { status: 'rejected', reason: 'SCOPE_REPLACED' })
})

test('rotation between discovery and capture still rejects SCOPE_REPLACED and starts no provider work', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const found = await lookup(db)
  if (found.status !== 'current') return assert.fail()
  assert.equal(found.scope.scopeVersion, 'injected-pim-v1')

  // A rotation lands after the snapshot was taken.
  assert.equal((await rotatePimScope(db, attemptFromRecord(db.attempts[0]), 'injected-pim-v2')).status, 'rotated')
  const attemptsBefore = db.attempts.length
  const refused = await capturePimAttempt(db, { ...testTenant, plane: 'ACTIVE',
    scopeVersion: found.scope.scopeVersion, attemptLifetimeMs: 10000 })
  assert.deepEqual(refused, { status: 'rejected', reason: 'SCOPE_REPLACED' })
  // No attempt allocated, so no provider work could begin from this path.
  assert.equal(db.attempts.length, attemptsBefore)

  // A caller may deliberately take a fresh snapshot; there is no automatic retry loop.
  const again = await lookup(db)
  if (again.status !== 'current') return assert.fail()
  assert.equal(again.scope.scopeVersion, 'injected-pim-v2')
})

test('authorization is refused before any SQL, and organization/tenant binding is preserved', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const operationsBefore = db.operations.length

  await assert.rejects(lookup(db, 'ACTIVE', { subjectId: 'injected-user',
    organizationId: testTenant.organizationId, tenantMemberships: new Set([alternateId]) }), /PIM_FORBIDDEN/)
  await assert.rejects(lookup(db, 'ACTIVE', { subjectId: '',
    organizationId: testTenant.organizationId, tenantMemberships: new Set([testTenant.customerTenantId]) }), /PIM_FORBIDDEN/)
  // Nothing reached the database: the refusal happened before the statement ran.
  assert.equal(db.operations.length, operationsBefore)

  // A membership the caller really holds, but for a tenant that is not this one.
  const other = await readCurrentPimScope(db, { subjectId: 'injected-user',
    organizationId: testTenant.organizationId, tenantMemberships: new Set([alternateId]) },
  { customerTenantId: alternateId, plane: 'ACTIVE' })
  assert.deepEqual(other, { status: 'rejected', reason: 'TENANT_MISMATCH' })

  // Correct tenant, wrong organization.
  assert.deepEqual(await lookup(db, 'ACTIVE', { subjectId: 'injected-user', organizationId: alternateId,
    tenantMemberships: new Set([testTenant.customerTenantId]) }), { status: 'rejected', reason: 'TENANT_MISMATCH' })

  // An inactive tenant or a missing managed connection is refused rather than answered.
  db.active = false
  assert.deepEqual(await lookup(db), { status: 'rejected', reason: 'TENANT_MISMATCH' })
  db.active = true; db.connected = false
  assert.deepEqual(await lookup(db), { status: 'rejected', reason: 'INCARNATION_CHANGED' })
})

test('ACTIVE and ELIGIBLE never return each other\'s current scope', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  // Only ACTIVE has been collected, so ELIGIBLE is explicitly absent rather than borrowed.
  assert.deepEqual(await lookup(db, 'ELIGIBLE'), { status: 'no-current-scope', plane: 'ELIGIBLE' })

  const eligible = await capturePimAttempt(db, { ...testTenant, plane: 'ELIGIBLE',
    scopeVersion: 'injected-eligible-v1', attemptLifetimeMs: 10000 })
  assert.equal(eligible.status, 'captured')

  const a = await lookup(db, 'ACTIVE'), e = await lookup(db, 'ELIGIBLE')
  if (a.status !== 'current' || e.status !== 'current') return assert.fail()
  assert.equal(a.scope.scopeVersion, 'injected-pim-v1')
  assert.equal(e.scope.scopeVersion, 'injected-eligible-v1')
  assert.notEqual(a.scope.scopeId, e.scope.scopeId)
  assert.equal(a.scope.plane, 'ACTIVE'); assert.equal(e.scope.plane, 'ELIGIBLE')
  assert.equal(a.scope.endpointDescriptor, PIM_ENDPOINTS.ACTIVE)
  assert.equal(e.scope.endpointDescriptor, PIM_ENDPOINTS.ELIGIBLE)
})

test('absence inserts nothing and a successful lookup mutates nothing', async () => {
  const empty = new PimDatabaseDouble()
  const mutationsBefore = empty.mutations
  assert.deepEqual(await lookup(empty), { status: 'no-current-scope', plane: 'ACTIVE' })
  // An absent scope is reported, never invented.
  assert.equal(empty.scopes.length, 0)
  assert.equal(empty.attempts.length, 0)
  assert.equal(empty.mutations, mutationsBefore)

  const db = new PimDatabaseDouble()
  await seeded(db)
  const snapshot = structuredClone({ scopes: db.scopes, attempts: db.attempts, rows: db.rows })
  const mutations = db.mutations
  const found = await lookup(db)
  assert.equal(found.status, 'current')
  assert.equal(db.mutations, mutations)
  assert.deepEqual({ scopes: db.scopes, attempts: db.attempts, rows: db.rows }, snapshot)
})

test('committed receipts still return contentDigest with unchanged reader behaviour', async () => {
  const db = new PimDatabaseDouble()
  await seeded(db)
  const before = await readPimSchedulePlane(db, auth(), { customerTenantId: testTenant.customerTenantId, plane: 'ACTIVE' })
  await lookup(db)
  const after = await readPimSchedulePlane(db, auth(), { customerTenantId: testTenant.customerTenantId, plane: 'ACTIVE' })
  assert.equal(before.status, 'observed'); assert.equal(after.status, 'observed')
  if (before.status !== 'observed' || after.status !== 'observed') return assert.fail()
  assert.equal(typeof after.view.contentDigest, 'string')
  assert.ok(after.view.contentDigest)
  assert.equal(after.view.contentDigest, before.view.contentDigest)
  assert.equal(after.view.attemptId, before.view.attemptId)
  assert.equal(after.view.observedRowCount, before.view.observedRowCount)
})
