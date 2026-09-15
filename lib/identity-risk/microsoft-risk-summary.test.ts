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
