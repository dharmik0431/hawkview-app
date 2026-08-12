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
