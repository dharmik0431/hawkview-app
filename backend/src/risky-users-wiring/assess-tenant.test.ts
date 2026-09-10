import assert from 'node:assert/strict'
import test from 'node:test'
import { assessTenant, unreadStream } from './assess-tenant.js'
import { assertAccountsForEveryRow, toEvaluationCoverage } from './coverage-bridge.js'
import { composeTenantAssessment } from '../evaluation-core/compose.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import type { NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Detector } from '../evaluation-core/contract.js'

const scope = { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' }
const graphScope = { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' }

const emptyGraphBatch = () => normalizeSignInBatch({
  scope,
  source: 'GRAPH_SIGN_INS',
  rows: [],
  directory: [],
  reference: async () => 'subject-ref',
  collectionScope: 'GRAPH_INTERACTIVE_ONLY',
})

/** Assesses whatever it is handed and finds nothing, accounting for all of it. */
const silent: Detector<NormalizedEvent> = {
  id: 'silent',
  monotonic: true,
  run: applicable => ({ status: 'RAN', considered: applicable.length, declined: {}, findings: [] }),
}

test('a classified batch reaches a tenant assessment without the core learning Microsoft', async () => {
  const assessment = assessTenant({
    streams: [{ stream: 'sign-ins', batch: await emptyGraphBatch(), scope: graphScope, detectors: [silent] }],
    budget: { maxEvents: 5000 },
  })
  // An empty window: nothing applied and no check examined anything, so no
  // clean claim is available and the count says so rather than reading zero.
  assert.equal(assessment.claim.permitted, false)
  assert.equal(assessment.count.accuracy, 'NOT_AVAILABLE')
  assert.deepEqual(assessment.findings.items, [])
})

test('the request that produced the evidence travels through to the tenant count', async () => {
  const assessment = assessTenant({
    streams: [{ stream: 'sign-ins', batch: await emptyGraphBatch(), scope: graphScope, detectors: [silent] }],
    budget: { maxEvents: 5000 },
  })
  // The narrow request is named beside the figure, so a zero cannot be read as
  // covering traffic nobody asked for.
  assert.deepEqual(assessment.count.scope.evidenceRequested, ['GRAPH_INTERACTIVE_ONLY'])
})

test('an unread stream needs no batch, because unread evidence has no events', async () => {
  // The shape matters more than the result: building this as an option on the
  // main path would leave a batch-shaped hole for a caller to fill with
  // something empty, which is how "never collected" and "collected and empty"
  // become the same value.
  const tenant = composeTenantAssessment([unreadStream('sign-ins', 'NEVER_COLLECTED')])
  assert.deepEqual(tenant.claim.permitted === false && tenant.claim.withheld,
    [{ stream: 'sign-ins', because: 'NEVER_COLLECTED' }])
  assert.equal(tenant.count.accuracy, 'NOT_AVAILABLE')
})


test('a coverage that has lost a bucket is refused rather than under-reporting', async () => {
  // My first version of this test asserted doesNotThrow on a bucket that IS
  // mapped — the name claimed one thing and the assertion tested its opposite,
  // which is the vacuity trap this project has hit four times. It now drops a
  // bucket and requires the failure.
  const batch = await emptyGraphBatch()
  const withUncited = {
    ...batch,
    counts: { ...batch.counts, notYetCitedByReason: { ...batch.counts.notYetCitedByReason, EXCLUSION_NOT_YET_CITED: 9 } },
  }

  const complete = toEvaluationCoverage(withUncited, graphScope)
  assert.doesNotThrow(() => assertAccountsForEveryRow(withUncited, complete))

  // The same coverage with the fourth bucket dropped — exactly what mapping
  // without `notYetCited` would have produced before the integration branch
  // surfaced it. Nine events vanish and the coverage still looks well-formed.
  const lostBucket = { ...complete, notYetCited: {} }
  assert.throws(() => assertAccountsForEveryRow(withUncited, lostBucket), /lost rows/)
})

test('the gating totals must be the same events, not merely the same number', async () => {
  const batch = await emptyGraphBatch()
  const withUnknown = {
    ...batch,
    counts: { ...batch.counts, unknownByObservation: { ...batch.counts.unknownByObservation, UNRECOGNIZED_ERROR_CODE: 4 } },
  }
  const coverage = toEvaluationCoverage(withUnknown, graphScope)
  assert.doesNotThrow(() => assertAccountsForEveryRow(withUnknown, coverage))

  // Moving events from a gating bucket to a non-gating one keeps the row total
  // identical, so the first check still passes — and the claim silently stops
  // being withheld. The second check is what catches that.
  const misfiled = { ...coverage, unknown: {}, doesNotApply: { ...coverage.doesNotApply, UNRECOGNIZED_ERROR_CODE: 4 } }
  assert.throws(() => assertAccountsForEveryRow(withUnknown, misfiled), /Gating total disagrees/)
})
