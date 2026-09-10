import assert from 'node:assert/strict'
import test from 'node:test'
import { COVERAGE_VERSIONS, decodeRunCoverage, encodeRunCoverage } from './run-coverage.js'
import { composeTenantAssessment } from '../evaluation-core/compose.js'
import { evaluate } from '../evaluation-core/evaluate.js'
import type { Coverage, Detector } from '../evaluation-core/contract.js'

type Event = Readonly<{ id: string }>

const coverage = (parts: Partial<Coverage> = {}): Coverage => ({
  collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
  applies: 4,
  doesNotApply: { NOT_A_CREDENTIAL_EVENT: 8 },
  notYetCited: {},
  unknown: {},
  unprocessable: {},
  ...parts,
})

const silent: Detector<Event> = {
  id: 'silent', monotonic: true,
  run: applicable => ({ status: 'RAN', considered: applicable.length, declined: {}, findings: [] }),
}

const stream = (name: string, parts: Partial<Coverage> = {}) => ({
  stream: name,
  assessment: evaluate<Event>({
    evidence: {
      availability: 'READ',
      applies: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
      coverage: coverage(parts),
      timeOf: () => 0,
    },
    detectors: [silent],
    budget: { maxEvents: 100 },
  }),
})

test('the denominator a claim rested on survives the run that produced it', () => {
  // "4 assessed, 8 out of scope" exists while evaluate runs and nowhere
  // afterwards. Without this, a run reports a zero and cannot later be asked
  // what the zero was an answer about — which is where all 1,054 historical
  // runs are, permanently.
  const assessment = composeTenantAssessment([stream('sign-ins')])
  const decoded = decodeRunCoverage(encodeRunCoverage(assessment))

  assert.equal(decoded.present, true)
  const recovered = decoded.present === true ? decoded.streams : []
  assert.deepEqual(recovered.map(entry => entry.stream), ['sign-ins'])
  assert.equal(recovered[0]?.coverage.applies, 4)
  assert.deepEqual(recovered[0]?.coverage.doesNotApply, { NOT_A_CREDENTIAL_EVENT: 8 })
})

test('streams are stored apart, because one number for a tenant is a lie by averaging', () => {
  const assessment = composeTenantAssessment([
    stream('sign-ins', { applies: 4, doesNotApply: { NOT_A_CREDENTIAL_EVENT: 8 } }),
    stream('mailbox-forwarding', { applies: 4, doesNotApply: {}, unknown: { MALFORMED: 2 } }),
  ])
  const decoded = decodeRunCoverage(encodeRunCoverage(assessment))
  const recovered = decoded.present === true ? decoded.streams : []

  assert.equal(recovered.length, 2)
  // Averaging is not recoverable afterwards either, so the separation has to
  // survive storage rather than being reconstructed on read.
  assert.deepEqual(recovered[0]?.coverage.doesNotApply, { NOT_A_CREDENTIAL_EVENT: 8 })
  assert.deepEqual(recovered[1]?.coverage.unknown, { MALFORMED: 2 })
})

test('no accounting recorded is not a run that assessed nothing', () => {
  assert.deepEqual(decodeRunCoverage(null), { present: false, because: 'NOT_RECORDED' })
  assert.deepEqual(decodeRunCoverage(undefined), { present: false, because: 'NOT_RECORDED' })

  // An empty stream list is a genuine, different answer: a run that recorded
  // its accounting and had no streams to account for.
  const empty = decodeRunCoverage(encodeRunCoverage(composeTenantAssessment([])))
  assert.equal(empty.present, true)
  assert.deepEqual(empty.present === true ? empty.streams : null, [])
})

test('a stream written by a version this build does not know makes the whole record unreadable', () => {
  // The dangerous case: the envelope decodes, so a reader that checked only the
  // outer version would proceed with a partial answer about which streams a
  // claim covered — which looks complete and is not.
  const record = encodeRunCoverage(composeTenantAssessment([stream('sign-ins'), stream('mailbox-forwarding')]))
  const streams = record.streams as Record<string, unknown>[]
  streams[1] = { ...streams[1], coverage: { ...(streams[1]!.coverage as object), version: 'hawkview-coverage/v9' } }

  // And the inner reason travels rather than flattening: "written by a version
  // we do not know" and "written wrongly" send a maintainer to different places.
  assert.deepEqual(decodeRunCoverage(record), { present: false, because: 'UNRECOGNIZED_VERSION' })
})

test('a malformed envelope is refused rather than partially trusted', () => {
  const good = encodeRunCoverage(composeTenantAssessment([stream('sign-ins')]))
  for (const bad of [
    { ...good, version: 'hawkview-run-coverage/v2' },
    { ...good, streams: 'not an array' },
    { ...good, streams: [{ stream: '', coverage: (good.streams as unknown[])[0] }] },
    { ...good, streams: [{ coverage: (good.streams as unknown[])[0] }] },
    'not an object',
  ]) {
    assert.equal(decodeRunCoverage(bad).present, false, `expected refusal for ${JSON.stringify(bad).slice(0, 60)}`)
  }
})

test('both versions are readable without grepping, because they move separately', () => {
  assert.equal(COVERAGE_VERSIONS.run, 'hawkview-run-coverage/v1')
  assert.equal(COVERAGE_VERSIONS.stream, 'hawkview-coverage/v1')
  assert.notEqual(COVERAGE_VERSIONS.run, COVERAGE_VERSIONS.stream)
})
