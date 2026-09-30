import assert from 'node:assert/strict'
import test from 'node:test'
import { getMicrosoftSecureScore } from './secure-score.util.js'

test('uses the newest valid Microsoft Secure Score snapshot', () => {
  assert.equal(
    getMicrosoftSecureScore([
      {
        currentScore: 30,
        maxScore: 100,
        createdDateTime: '2026-08-01T00:00:00Z',
      },
      {
        currentScore: 72,
        maxScore: 90,
        createdDateTime: '2026-08-02T00:00:00Z',
      },
    ]),
    80,
  )
})

test('does not turn unavailable or malformed scores into zero', () => {
  assert.equal(getMicrosoftSecureScore(null), null)
  assert.equal(getMicrosoftSecureScore([]), null)
  assert.equal(
    getMicrosoftSecureScore([{ currentScore: '70', maxScore: 100 }]),
    null,
  )
})

import { getMicrosoftSecureScoreDetails } from './secure-score.util.js'
const scoreDate = '2026-08-01T00:00:00.000Z'
const saved = '2026-08-10T00:00:00.000Z'
const success = '2026-08-10T00:00:01.000Z'
const row = (currentScore: unknown, createdDateTime: unknown = scoreDate) => ({ currentScore, maxScore: 100, createdDateTime })
const details = (payload: unknown) => getMicrosoftSecureScoreDetails({ payload, observedAt: new Date(saved) }, new Date(success))

test('new collection of old valid score preserves provider date and independent clocks', () => {
  assert.deepEqual(details([row(0)]), { version: 1, percentage: 0, scoreCreatedAt: scoreDate, snapshotObservedAt: saved, lastSuccessfulCollectionAt: success })
})
test('newer malformed numeric row cannot advance winning old score date', () => {
  assert.equal(details([row(62), row('invalid', '2026-08-09T00:00:00Z')]).scoreCreatedAt, scoreDate)
  assert.equal(details([row(62), row('invalid', '2026-08-09T00:00:00Z')]).percentage, 62)
})
test('no winning score never borrows a date from invalid rows', () => {
  for (const payload of [undefined, null, {}, [], [row('invalid')], [row(-1)]]) {
    assert.equal(details(payload).percentage, null)
    assert.equal(details(payload).scoreCreatedAt, null)
    assert.equal(details(payload).snapshotObservedAt, saved)
  }
})
test('legacy numeric values remain available without fabricated dates', () => {
  for (const date of [undefined, '', 'tomorrow', '2026-02-30T00:00:00Z', '2026-08-11T00:00:00Z']) {
    const result = details([{ currentScore: 42, maxScore: 100, createdDateTime: date }])
    assert.equal(result.percentage, 42)
    assert.equal(result.scoreCreatedAt, null)
  }
})
test('offset provider dates normalize and equal-date tie keeps legacy last row', () => {
  const result = details([row(30, '2026-08-01T02:00:00+02:00'), row(50, scoreDate)])
  assert.equal(result.percentage, 50)
  assert.equal(result.scoreCreatedAt, scoreDate)
  assert.equal(details([row(30, '2026-08-01T02:00:00+02:00')]).scoreCreatedAt, scoreDate)
})
test('missing or invalid independent clocks do not invent collection evidence', () => {
  assert.deepEqual(getMicrosoftSecureScoreDetails(undefined, null), { version: 1, percentage: null, scoreCreatedAt: null, snapshotObservedAt: null, lastSuccessfulCollectionAt: null })
  const result = getMicrosoftSecureScoreDetails({ payload: [row(62)], observedAt: new Date(NaN) }, new Date(NaN))
  assert.equal(result.scoreCreatedAt, scoreDate)
  assert.equal(result.snapshotObservedAt, null)
  assert.equal(result.lastSuccessfulCollectionAt, null)
})
test('legacy scalar parity across order, malformed rows, clamping and rounding', () => {
  for (const payload of [[row(0)], [row(300)], [row(1.5)], [row(1), row(2)], [row(1, null), row(2, null)], [row('bad')], null]) {
    assert.equal(details(payload).percentage, getMicrosoftSecureScore(payload))
  }
})
