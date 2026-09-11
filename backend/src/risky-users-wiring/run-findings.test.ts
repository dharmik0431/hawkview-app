import assert from 'node:assert/strict'
import test from 'node:test'
import { RUN_FINDINGS_VERSION, decodeRunFindings, encodeRunFindings } from './run-findings.js'
import type { TenantAssessment } from '../evaluation-core/compose.js'
import type { Finding } from '../evaluation-core/contract.js'

const raymonds: Finding = {
  detectorId: 'repeated-credential-failure',
  subject: {
    kind: 'DIRECTORY_USER',
    userRef: 'subject:c54eb6ce',
    correlation: { available: true, matchedBy: 'DIRECTORY_OBJECT_ID', ref: 'guid-c54eb6ce' },
  },
  signals: [
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 462, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
    { signal: 'PASSWORD_REJECTED', count: 12, latest: { at: '2026-09-09T03:58:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
  ],
}

/** Carries the verdict as well as the findings, because the record does: a
 * count stored apart from its basis is the separation this design removes. */
const assessment = (items: readonly Finding[]): TenantAssessment => ({
  findings: { items, complete: true },
  count: { accuracy: 'AT_LEAST', value: items.length, scope: { evidenceRequested: ['GRAPH_INTERACTIVE_ONLY'], setAside: [], covered: ['repeated-credential-failure'], notCovered: [] } },
  claim: items.length === 0 ? { permitted: true } : { permitted: false, withheld: [{ stream: 'GRAPH_SIGN_INS', because: 'UNINTERPRETED_EVENTS' }] },
} as unknown as TenantAssessment)

test('a real finding survives storage with each signal still carrying its own date', () => {
  const decoded = decodeRunFindings(encodeRunFindings(assessment([raymonds]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]))
  assert.equal(decoded.present, true)
  assert.ok(decoded.present)

  const [finding] = decoded.findings
  // The Raymonds account. 462 lockouts last seen 3 September, 12 rejections
  // last seen the 9th — the pairing that was wrong before per-signal recency,
  // and the thing a round trip could quietly re-collapse.
  assert.equal(finding?.signals[0]?.count, 462)
  assert.equal(finding?.signals[0]?.latest?.at, '2026-09-03T10:40:00.000Z')
  assert.equal(finding?.signals[1]?.latest?.at, '2026-09-09T03:58:00.000Z')
  assert.equal(finding?.signals[0]?.latest?.kind, 'EVENT_OCCURRED')
})

test('a record that was never written is not a run that found nothing', () => {
  // The distinction the column is nullable and undefaulted to protect. A
  // DEFAULT '[]' would convert every run written before the column existed into
  // "this run found nothing" — a clean tenant, permanently, with nothing later
  // able to tell a backfilled default from a measurement.
  assert.deepEqual(decodeRunFindings(null), { present: false, because: 'NOT_RECORDED' })
  assert.deepEqual(decodeRunFindings(undefined), { present: false, because: 'NOT_RECORDED' })

  // And a run that genuinely produced none is PRESENT with an empty list.
  const none = decodeRunFindings(encodeRunFindings(assessment([]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]))
  assert.equal(none.present, true)
  assert.deepEqual(none.present && none.findings, [])
})

test('a version this build does not know is refused, not read optimistically', () => {
  const future = { ...encodeRunFindings(assessment([raymonds]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]), version: 'hawkview-run-findings/v2' }
  assert.deepEqual(decodeRunFindings(future), { present: false, because: 'UNRECOGNIZED_VERSION' })

  // POSITIVE CONTROL: the same payload at the version this build writes does
  // decode, so the assertion above is about the version and not about a
  // decoder that refuses everything.
  assert.equal(decodeRunFindings({ ...future, version: RUN_FINDINGS_VERSION }).present, true)
})

test('one unreadable signal makes the whole record unreadable', () => {
  const good = encodeRunFindings(assessment([raymonds]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]) as { items: { signals: Record<string, unknown>[] }[] }

  // A finding shown with part of its basis silently dropped is worse than one
  // not shown: the count stays, the evidence under it shrinks, and nothing on
  // the screen says a signal went missing.
  for (const corruption of [
    { signal: '' },
    { count: -1 },
    { count: 1.5 },
    { capped: 'yes' },
    { latest: { at: '2026-09-03T10:40:00.000Z' } },
    { latest: { at: '2026-09-03T10:40:00.000Z', kind: 'GUESSED' } },
  ]) {
    const broken = structuredClone(good)
    Object.assign(broken.items[0]!.signals[1]!, corruption)
    assert.deepEqual(
      decodeRunFindings(broken), { present: false, because: 'MALFORMED' },
      `accepted ${JSON.stringify(corruption)}`)
  }

  // POSITIVE CONTROL: the uncorrupted clone still decodes, so the loop above is
  // rejecting the corruptions rather than the cloning.
  assert.equal(decodeRunFindings(structuredClone(good)).present, true)
})

test('an unknown recency kind is refused rather than guessed', () => {
  // A read time and an event time are not interchangeable, and a read time is
  // always recent — so guessing the kind makes six-month-old evidence look
  // like it happened this morning. Refusing costs a record; guessing costs a
  // technician's judgement about whether to act tonight.
  const good = encodeRunFindings(assessment([raymonds]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]) as { items: { signals: Record<string, unknown>[] }[] }
  const broken = structuredClone(good)
  broken.items[0]!.signals[0]!.latest = { at: '2026-09-03T10:40:00.000Z', kind: 'STATE_OBSERVED' }
  // A DIFFERENT known kind is not corruption — it decodes, and means something
  // else. The refusal is for kinds outside the closed set.
  const decoded = decodeRunFindings(broken)
  assert.equal(decoded.present, true)
  assert.equal(decoded.present && decoded.findings[0]?.signals[0]?.latest?.kind, 'STATE_OBSERVED')
})

test('a finding recorded with no signals is a malformed record, not a basisless finding', () => {
  const good = encodeRunFindings(assessment([raymonds]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]) as { items: { signals: unknown[] }[] }
  const broken = structuredClone(good)
  broken.items[0]!.signals = []
  assert.deepEqual(decodeRunFindings(broken), { present: false, because: 'MALFORMED' })
})

test('a verdict with no basis, and a basis with no verdict, are both refused', () => {
  // The two halves of the same defect. A count whose findings did not decode is
  // a number with nothing under it; findings with no count is a basis nobody
  // drew a conclusion from. Rendering either produces the pair Engineer 2 found:
  // a tile saying four above a list saying none.
  //
  // They are in ONE record so the refusal is possible at all — two columns
  // would be two reads and two chances to drift.
  const whole = encodeRunFindings(assessment([raymonds]), [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }]) as Record<string, unknown>

  for (const missing of ['count', 'claim', 'complete']) {
    const partial = { ...whole }
    delete partial[missing]
    assert.deepEqual(
      decodeRunFindings(partial), { present: false, because: 'MALFORMED' },
      `accepted a record with no ${missing}`)
  }

  // And the verdict really does come back when it is there, so the refusals
  // above are about absence rather than a decoder that rejects everything.
  const decoded = decodeRunFindings(whole)
  assert.equal(decoded.present, true)
  assert.equal(decoded.present && decoded.count.accuracy, 'AT_LEAST')
  assert.equal(decoded.present && decoded.claim.permitted, false)
  assert.equal(decoded.present && decoded.complete, true)
})
