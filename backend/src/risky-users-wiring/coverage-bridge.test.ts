import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAccountsForEveryRow, collectionScopeOf, toEvaluationCoverage, watchedResolver,
} from './coverage-bridge.js'
import { coverageForEvaluation, normalizeSignInBatch } from '../risky-users-normalization/index.js'
import type { NormalizedEvent } from '../risky-users-normalization/contract.js'
import { evaluate, uninterpreted } from '../evaluation-core/evaluate.js'

/** The seam, exercised against the classifier's real output rather than a
 * hand-written stand-in. A fixture shaped like what I expect would only prove
 * the two modules agree with my belief about them. */
const graphScope = { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' }

const emptyGraphBatch = () => normalizeSignInBatch({
  scope: { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' },
  source: 'GRAPH_SIGN_INS',
  rows: [],
  directory: [],
  reference: async () => 'subject-ref',
  collectionScope: 'GRAPH_INTERACTIVE_ONLY',
})

test('the collection scope crosses the seam without the core learning the vocabulary', async () => {
  assert.deepEqual(collectionScopeOf(graphScope), { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' })
  // An unrecorded request becomes the core's own "undeclared" case rather than
  // an empty string that would read as a request nobody made.
  assert.deepEqual(collectionScopeOf({ declared: false, asked: 'UNDECLARED' }), { declared: false })
  assert.deepEqual(collectionScopeOf({ declared: true, asked: '   ' }), { declared: false })
})

test('every bucket the classifier reports lands somewhere in the core contract', async () => {
  // This is what the integration branch existed to check. Both modules compiled
  // together before this file was written, because their files are disjoint —
  // nothing forced them to agree until the conversion was written down.
  const reported = coverageForEvaluation(await emptyGraphBatch())
  const bucketNames = Object.keys(reported).filter(name => typeof reported[name as keyof typeof reported] === 'object')
  // If the classifier grows a bucket, this fails rather than silently dropping
  // it — the mapping cannot stay complete by accident.
  assert.deepEqual(bucketNames.sort(), ['doesNotApply', 'notYetCited', 'unknown', 'unprocessable'])
})

test('the mapping accounts for every classified row, and the two gating totals agree', async () => {
  const batch = await emptyGraphBatch()
  const coverage = toEvaluationCoverage(batch, graphScope)
  assert.doesNotThrow(() => assertAccountsForEveryRow(batch, coverage))

  // The core derives its own gating number from the buckets it gates on rather
  // than trusting the classifier's total — so the two being equal is a real
  // check, not a tautology.
  assert.equal(uninterpreted(coverage), coverageForEvaluation(batch).uninterpretedEvents)
})

test('the core consumes the bridged coverage and reaches a claim', async () => {
  const batch = await emptyGraphBatch()
  const assessment = evaluate({
    evidence: {
      availability: 'READ',
      applies: batch.applies,
      coverage: toEvaluationCoverage(batch, graphScope),
      timeOf: (event: NormalizedEvent) => event.eventAt,
    },
    detectors: [],
    budget: { maxEvents: 5000 },
  })
  // An empty window with no detectors cannot report a clean zero, and says so
  // in more than one way — which is the whole point of the vocabulary.
  assert.equal(assessment.claim.permitted, false)
  assert.deepEqual(assessment.count.accuracy, 'NOT_AVAILABLE')
})


test('a resolver that ignores its identifier is caught; the batch alone cannot see it', async () => {
  // The guard that works, and the reason the obvious one does not. A batch's
  // `resolvedSubjects` is keyed BY reference, so sixteen people collapsing to
  // one reference leaves ONE entry — the collapse erases its own evidence, and
  // no check inside the batch can fail. My first version compared people
  // against references within that list and stayed silent against the real bug
  // reproduced on real data.
  const broken = watchedResolver((async (kind: string) => 'subject:' + kind) as never)
  await broken.resolve('subject', 'user-a')
  await broken.resolve('subject', 'user-b')
  await broken.resolve('subject', 'user-c')
  assert.throws(() => broken.assertNoCollapse(), /16|3 distinct identifiers produced 1 distinct references/)

  const honest = watchedResolver(async (kind, identifier) => kind + ':' + identifier)
  await honest.resolve('subject', 'user-a')
  await honest.resolve('subject', 'user-b')
  assert.doesNotThrow(() => honest.assertNoCollapse())

  // Kinds are counted apart: applications collapsing must not be masked by
  // subjects resolving correctly, and vice versa.
  const mixed = watchedResolver(async (kind, identifier) =>
    kind === 'application' ? 'app:same' : kind + ':' + identifier)
  await mixed.resolve('subject', 'user-a')
  await mixed.resolve('subject', 'user-b')
  await mixed.resolve('application', 'app-a')
  await mixed.resolve('application', 'app-b')
  assert.throws(() => mixed.assertNoCollapse(), /application/)

  // Nothing asked, nothing to collapse — a guard that fires on emptiness is noise.
  assert.doesNotThrow(() => watchedResolver(async (k, i) => k + ':' + i).assertNoCollapse())
})
