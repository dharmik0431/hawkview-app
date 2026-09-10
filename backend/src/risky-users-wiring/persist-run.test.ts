import assert from 'node:assert/strict'
import test from 'node:test'
import { RUN_ENGINE_VERSION, RUN_STATUS, liveReaderWouldSelect, persistRun, runKeyFor } from './persist-run.js'
import { assessTenant } from './assess-tenant.js'
import { decodeRunCoverage } from './run-coverage.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'

/** A double rather than a database: the column this writes to does not exist in
 * production yet, so a test that needed one could not run at all. */
const writer = () => {
  const written: Record<string, unknown>[] = []
  return {
    written,
    client: {
      identityRiskEvaluationRun: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          written.push(data)
          return { id: 'run-1' }
        },
      },
    },
  }
}

const emptyBatch = () => normalizeSignInBatch({
  scope: { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' },
  source: 'GRAPH_SIGN_INS',
  rows: [], directory: [],
  reference: async () => 'subject-ref',
  collectionScope: 'GRAPH_INTERACTIVE_ONLY',
})

const input = {
  organizationId: 'org', customerTenantId: 'tenant',
  windowStart: new Date('2026-08-11T00:00:00.000Z'),
  windowEnd: new Date('2026-09-10T00:00:00.000Z'),
  rowsFetched: 2069,
  expiresAt: new Date('2026-12-10T00:00:00.000Z'),
  completedAt: new Date('2026-09-10T00:05:00.000Z'),
}

const assessment = async () => assessTenant({
  streams: [{
    stream: 'GRAPH_SIGN_INS', collection: 'READ' as const, batch: await emptyBatch(),
    scope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' }, detectors: [], rowsFetched: 0,
  }],
  budget: { maxEvents: 5000 },
})

test('a run this engine writes is INVISIBLE to the live reader', async () => {
  // THE POINT OF THE FILE. `identity-risk.service.ts` selects the newest run
  // with status COMPLETED and no engine discriminator, so a row written here
  // under that status would be served to a customer by the running product,
  // carrying an aggregate shaped for a different engine.
  const { written, client } = writer()
  await persistRun(client, await assessment(), input)

  const row = written[0]!
  assert.equal(row.status, RUN_STATUS)
  assert.notEqual(row.status, 'COMPLETED')

  // Asserted against the live reader's actual filter rather than against the
  // string, so this fails if either side moves — including if someone
  // "tidies" the status back to COMPLETED.
  assert.equal(
    liveReaderWouldSelect({ status: row.status as string, expiresAt: row.expiresAt as Date }, new Date('2026-09-10T01:00:00.000Z')),
    false)

  // POSITIVE CONTROL: the filter is capable of returning true, so the assertion
  // above is about this row rather than about a predicate that never matches.
  assert.equal(
    liveReaderWouldSelect({ status: 'COMPLETED', expiresAt: input.expiresAt }, new Date('2026-09-10T01:00:00.000Z')),
    true)
})

test('nothing is written that would need a severity or a confidence', async () => {
  // The two tables an MSP acts from require severity, confidence and coverage
  // as non-null strings, and this engine computes none of them. The guarantee
  // is structural: the writer has no access to those tables at all, so it
  // cannot fabricate a value under future pressure to "just fill it in".
  const { written, client } = writer()
  await persistRun(client, await assessment(), input)

  const row = written[0]!
  for (const fabricated of ['severity', 'confidence', 'coverage']) {
    assert.equal(fabricated in row, false, `${fabricated} must not be invented here`)
  }
  // And the old engine's own summary fields are left at their defaults rather
  // than filled with a coarser restatement of the claim.
  assert.equal('capability' in row, false)
  assert.equal('aggregate' in row, false)
})

test('the coverage vector survives the round trip, and absence stays distinguishable', async () => {
  const { written, client } = writer()
  await persistRun(client, await assessment(), input)

  const decoded = decodeRunCoverage(written[0]!.evaluationCoverage)
  assert.equal(decoded.present, true)
  assert.equal(decoded.present && decoded.streams[0]?.stream, 'GRAPH_SIGN_INS')

  // The reason the column is nullable and undefaulted: a run with no accounting
  // recorded is a different fact from one that accounted for nothing, and the
  // 1,818 rows written before this column existed are permanently in the first
  // case. Decoding absence as zero would convert every one of them into
  // "assessed nothing, found nothing" — a clean tenant, forever.
  assert.deepEqual(decodeRunCoverage(null), { present: false, because: 'NOT_RECORDED' })
})

test('the run key identifies the question, not the answer', () => {
  // Same tenant, same window, same engine -> same key, so two runs over
  // identical evidence are recognisable as the same question even if the
  // engine's verdict changed between them. That is exactly when you want to
  // see they were comparable.
  assert.equal(runKeyFor(input), runKeyFor({ ...input, rowsFetched: 4 }))
  assert.equal(runKeyFor(input), runKeyFor({ ...input, completedAt: new Date('2027-01-01T00:00:00.000Z') }))

  // A different window is a different question.
  assert.notEqual(runKeyFor(input), runKeyFor({ ...input, windowEnd: new Date('2026-09-09T00:00:00.000Z') }))
  assert.notEqual(runKeyFor(input), runKeyFor({ ...input, customerTenantId: 'other' }))
})

test('the two source hashes answer different questions', async () => {
  const { written, client } = writer()
  await persistRun(client, await assessment(), input)
  const base = written[0]!

  const moved = writer()
  await persistRun(moved.client, await assessment(), { ...input, rowsFetched: 2070 })

  // Same window, different row count: content moved, watermark did not. One
  // hash could not distinguish "collection advanced with no new rows" from
  // "the same window now holds different rows".
  assert.equal(moved.written[0]!.sourceWatermarkHash, base.sourceWatermarkHash)
  assert.notEqual(moved.written[0]!.sourceContentHash, base.sourceContentHash)
  assert.equal(base.engineVersion, RUN_ENGINE_VERSION)
})
