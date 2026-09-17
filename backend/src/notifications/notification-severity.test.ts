import assert from 'node:assert/strict'
import test from 'node:test'
import { NOTIFICATION_SEVERITIES, notificationSeverityRank, notificationSeveritiesAtOrAbove, notificationSeveritySql } from './notification-severity.js'

test('five persisted severities use one ordering across all 25 pairs', () => {
  const expected = ['info', 'low', 'medium', 'high', 'critical']
  assert.deepEqual(NOTIFICATION_SEVERITIES, expected)
  for (const [rank, minimum] of expected.entries()) {
    assert.equal(notificationSeverityRank(minimum), rank)
    assert.deepEqual(notificationSeveritiesAtOrAbove(minimum), expected.slice(rank))
    for (const [valueRank, value] of expected.entries()) {
      assert.equal(notificationSeveritiesAtOrAbove(minimum).some(item => item === value), valueRank >= rank)
    }
  }
})

test('unknown, null, category and urgency values fail closed instead of becoming info', () => {
  for (const value of [null, undefined, '', 'warning', 'error', 'ACT_NOW', 'ACT_TODAY', 'HIGH', 3]) {
    assert.equal(notificationSeverityRank(value), null)
    assert.deepEqual(notificationSeveritiesAtOrAbove(value), [])
  }
  assert.match(notificationSeveritySql('n.severity'), /ELSE NULL END/)
  assert.throws(() => notificationSeveritySql('n.severity; SELECT 1' as never), /Invalid severity column/)
})
