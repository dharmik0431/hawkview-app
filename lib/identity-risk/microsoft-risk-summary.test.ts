import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeMicrosoftRiskSummary,
  presentMicrosoftRiskSummary,
} from './microsoft-risk-summary.ts'

const now = Date.parse('2026-09-15T12:00:00.000Z')
const clocks = {
  snapshotObservedAt: '2026-09-15T11:00:00.000Z',
  collectionSucceededAt: '2026-09-15T11:05:00.000Z',
}

test('presents a complete exact Microsoft active-identity count without implying safety', () => {
  const summary = normalizeMicrosoftRiskSummary({
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'AVAILABLE',
    completeness: 'COMPLETE',
    rawRecordCount: 10,
    observedActiveDistinctUserCount: 0,
    activeDistinctUserCount: 0,
    ...clocks,
    reasonCode: null,
  }, now)

  assert.ok(summary)
  const presentation = presentMicrosoftRiskSummary(summary)
  assert.equal(presentation.headline, '0 active Microsoft risk identities in current evidence')
  assert.match(presentation.detail, /not a statement that the tenant is safe/i)
})

test('preserves observed active evidence without calling a partial count current or exact', () => {
  const summary = normalizeMicrosoftRiskSummary({
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'PARTIAL',
    completeness: 'CONFLICTING',
    rawRecordCount: 10,
    observedActiveDistinctUserCount: 2,
    activeDistinctUserCount: null,
    ...clocks,
    reasonCode: 'CONFLICTING_RECORDS',
  }, now)

  const presentation = presentMicrosoftRiskSummary(summary)
  assert.equal(presentation.count, 2)
  assert.equal(presentation.exact, false)
  assert.match(presentation.headline, /active Microsoft-risk evidence requiring review/)
  assert.doesNotMatch(presentation.headline, /currently active|at least/i)
})

test('does not turn an incomplete observed zero into a zero-risk claim', () => {
  const summary = normalizeMicrosoftRiskSummary({
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'PARTIAL',
    completeness: 'PARTIAL',
    rawRecordCount: 3,
    observedActiveDistinctUserCount: 0,
    activeDistinctUserCount: null,
    ...clocks,
    reasonCode: 'PARTIAL_RECORDS',
  }, now)

  const presentation = presentMicrosoftRiskSummary(summary)
  assert.equal(presentation.count, null)
  assert.equal(presentation.headline, 'Microsoft risk status incomplete')
  assert.doesNotMatch(presentation.headline, /\b0\b|safe|none/i)
})

test('fails impossible combinations and future clocks closed', () => {
  const completeWithoutCount = {
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'AVAILABLE',
    completeness: 'COMPLETE',
    rawRecordCount: 1,
    observedActiveDistinctUserCount: 1,
    activeDistinctUserCount: null,
    ...clocks,
    reasonCode: null,
  }
  assert.equal(normalizeMicrosoftRiskSummary(completeWithoutCount, now), null)
  assert.equal(normalizeMicrosoftRiskSummary({
    ...completeWithoutCount,
    activeDistinctUserCount: 1,
    snapshotObservedAt: '2026-09-15T12:06:00.000Z',
  }, now), null)

  assert.equal(normalizeMicrosoftRiskSummary({
    ...completeWithoutCount,
    activeDistinctUserCount: 1,
    snapshotObservedAt: '2026-09-15T11:00:00.000Z',
    collectionSucceededAt: '2026-09-15T10:59:59.999Z',
  }, now), null)
})

test('mirrors the backend discriminated count and reason combinations', () => {
  const complete = {
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'AVAILABLE',
    completeness: 'COMPLETE',
    rawRecordCount: 1,
    observedActiveDistinctUserCount: 1,
    activeDistinctUserCount: 1,
    ...clocks,
    reasonCode: null,
  }

  assert.ok(normalizeMicrosoftRiskSummary(complete, now))
  assert.equal(normalizeMicrosoftRiskSummary({
    ...complete,
    observedActiveDistinctUserCount: 9,
    activeDistinctUserCount: 9,
  }, now), null)

  const partial = {
    ...complete,
    availability: 'PARTIAL',
    completeness: 'PARTIAL',
    rawRecordCount: 2,
    observedActiveDistinctUserCount: 1,
    activeDistinctUserCount: null,
    reasonCode: 'PARTIAL_RECORDS',
  }
  assert.ok(normalizeMicrosoftRiskSummary(partial, now))
  assert.ok(normalizeMicrosoftRiskSummary({ ...partial, completeness: 'UNKNOWN' }, now))
  assert.ok(normalizeMicrosoftRiskSummary({
    ...partial,
    completeness: 'CONFLICTING',
    reasonCode: 'CONFLICTING_RECORDS',
  }, now))
  for (const invalid of [
    { ...partial, rawRecordCount: null },
    { ...partial, observedActiveDistinctUserCount: 3 },
    { ...partial, reasonCode: 'SOURCE_UNAVAILABLE' },
    { ...partial, completeness: 'CONFLICTING' },
    { ...partial, completeness: 'UNKNOWN', reasonCode: 'CONFLICTING_RECORDS' },
  ]) assert.equal(normalizeMicrosoftRiskSummary(invalid, now), null)

  const unavailable = {
    ...complete,
    availability: 'UNAVAILABLE',
    completeness: 'UNKNOWN',
    rawRecordCount: null,
    observedActiveDistinctUserCount: null,
    activeDistinctUserCount: null,
    snapshotObservedAt: null,
    collectionSucceededAt: null,
    reasonCode: 'SOURCE_UNAVAILABLE',
  }
  assert.ok(normalizeMicrosoftRiskSummary(unavailable, now))
  assert.equal(normalizeMicrosoftRiskSummary({ ...unavailable, rawRecordCount: 0 }, now), null)
  assert.equal(normalizeMicrosoftRiskSummary({ ...unavailable, reasonCode: 'PARTIAL_RECORDS' }, now), null)
})

test('rejects invalid numeric domains, inherited objects, and extra fields', () => {
  const complete = {
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'AVAILABLE',
    completeness: 'COMPLETE',
    rawRecordCount: 1,
    observedActiveDistinctUserCount: 1,
    activeDistinctUserCount: 1,
    ...clocks,
    reasonCode: null,
  }
  for (const rawRecordCount of [-1, 0.5, Number.NaN, 50_001]) {
    assert.equal(normalizeMicrosoftRiskSummary({ ...complete, rawRecordCount }, now), null)
  }
  assert.equal(normalizeMicrosoftRiskSummary({ ...complete, extra: true }, now), null)
  assert.equal(normalizeMicrosoftRiskSummary(Object.assign(Object.create({ inherited: true }), complete), now), null)
})

test('accepts inverted diagnostic clocks only for unavailable invalid-clock evidence', () => {
  const unavailable = {
    source: 'MICROSOFT_IDENTITY_PROTECTION',
    availability: 'UNAVAILABLE',
    completeness: 'UNKNOWN',
    rawRecordCount: null,
    observedActiveDistinctUserCount: null,
    activeDistinctUserCount: null,
    snapshotObservedAt: '2026-09-15T11:05:00.000Z',
    collectionSucceededAt: '2026-09-15T11:00:00.000Z',
    reasonCode: 'INVALID_CLOCK',
  }
  assert.ok(normalizeMicrosoftRiskSummary(unavailable, now))
  assert.equal(
    presentMicrosoftRiskSummary(normalizeMicrosoftRiskSummary(unavailable, now)).observedAt,
    null,
  )
  assert.equal(normalizeMicrosoftRiskSummary({
    ...unavailable,
    reasonCode: 'STALE_EVIDENCE',
  }, now), null)
  assert.equal(normalizeMicrosoftRiskSummary({
    ...unavailable,
    snapshotObservedAt: '2026-09-15T12:06:00.000Z',
  }, now), null)
  assert.equal(normalizeMicrosoftRiskSummary({
    ...unavailable,
    snapshotObservedAt: '2026-09-15T11:05:00Z',
  }, now), null)
})
