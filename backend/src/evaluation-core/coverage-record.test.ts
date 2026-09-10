import assert from 'node:assert/strict'
import test from 'node:test'
import { COVERAGE_RECORD_VERSION, decodeCoverage, encodeCoverage } from './coverage-record.js'
import type { Coverage } from './contract.js'

const coverage = (parts: Partial<Coverage> = {}): Coverage => ({
  collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
  applies: 4,
  doesNotApply: { NOT_A_CREDENTIAL_EVENT: 8 },
  unknown: {},
  unprocessable: {},
  ...parts,
})

test('a coverage vector survives a round trip with its partition intact', () => {
  const original = coverage({ unknown: { UNRECOGNIZED_OUTCOME: 3 }, unprocessable: { MALFORMED_ROW: 1 } })
  const decoded = decodeCoverage(encodeCoverage(original))
  assert.equal(decoded.present, true)
  assert.deepEqual(decoded.present === true && decoded.coverage, original)

  // Named buckets rather than a row of integers, so the partition is visible in
  // storage. Adjacent integer columns invite a SUM that adds could-not-process
  // to does-not-apply, which is the collapse this design exists to prevent.
  const stored = encodeCoverage(original) as Record<string, unknown>
  assert.deepEqual(Object.keys(stored).sort(),
    ['applies', 'collectionScope', 'doesNotApply', 'unknown', 'unprocessable', 'version'])
})

test('no accounting recorded is never the same answer as accounting recorded as zero', () => {
  // The decisive case. Every run written before accounting existed has a null
  // column, and integer columns defaulting to 0 would render all of them as
  // "we assessed nothing and found nothing" — the bare-zero defect written into
  // the database, where it is permanent and indistinguishable after the fact.
  const nothingRecorded = decodeCoverage(null)
  assert.deepEqual(nothingRecorded, { present: false, because: 'NOT_RECORDED' })
  assert.deepEqual(decodeCoverage(undefined), { present: false, because: 'NOT_RECORDED' })

  const recordedAsZero = decodeCoverage(encodeCoverage(coverage({
    applies: 0, doesNotApply: {}, unknown: {}, unprocessable: {},
  })))
  assert.equal(recordedAsZero.present, true)
  assert.equal(recordedAsZero.present === true && recordedAsZero.coverage.applies, 0)

  // Both are "no events", and they are different facts. Nothing in the decoded
  // shape lets a caller treat them alike: one has no coverage at all.
  assert.notEqual(nothingRecorded.present, recordedAsZero.present)
})

test('a version this build does not know is refused, not read optimistically', () => {
  const future = { ...encodeCoverage(coverage()), version: 'hawkview-coverage/v2' }
  assert.deepEqual(decodeCoverage(future), { present: false, because: 'UNRECOGNIZED_VERSION' })
  // Refused even though every other field is readable — a reader that assumes
  // it understands an unknown shape is how a field silently changes meaning.
  assert.equal(typeof (future as Record<string, unknown>).applies, 'number')

  assert.deepEqual(decodeCoverage({ ...encodeCoverage(coverage()), version: undefined }),
    { present: false, because: 'UNRECOGNIZED_VERSION' })
})

test('a malformed row is its own answer rather than a partially trusted one', () => {
  const base = encodeCoverage(coverage())
  const rejected = [
    { ...base, applies: -1 },
    { ...base, applies: 1.5 },
    { ...base, applies: '4' },
    { ...base, doesNotApply: { REASON: -2 } },
    { ...base, doesNotApply: { REASON: 1.5 } },
    // A blank reason name is a count nobody can act on: the same silent opt-out
    // the detector accounting rejects, arriving from storage instead.
    { ...base, unknown: { '   ': 3 } },
    { ...base, unprocessable: [] },
    { ...base, collectionScope: { declared: true } },
    { ...base, collectionScope: { declared: true, asked: '' } },
    'not an object',
  ]
  for (const row of rejected) {
    assert.deepEqual(decodeCoverage(row), { present: false, because: 'MALFORMED' },
      `expected refusal for ${JSON.stringify(row)}`)
  }
})

test('an undeclared collection scope round-trips as undeclared rather than vanishing', () => {
  // If this decoded to "declared" the claim would silently stop being withheld,
  // and a count over a view nobody recorded requesting would read as exact.
  const decoded = decodeCoverage(encodeCoverage(coverage({ collectionScope: { declared: false } })))
  assert.equal(decoded.present === true && decoded.coverage.collectionScope.declared, false)
})

test('the version tag is inside the record, so a row carries its own meaning', () => {
  assert.equal((encodeCoverage(coverage()) as Record<string, unknown>).version, COVERAGE_RECORD_VERSION)
})
