import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeMicrosoftRisk, MICROSOFT_RISK_MAX_ROWS } from './microsoft-risk-summary.js'

const now = new Date('2026-09-15T12:00:00.000Z')
const row = (id: string, riskState = 'atRisk', riskDetail = 'none') => ({ id, riskState, riskDetail, riskLevel: 'high' })
const input = (payload: unknown) => ({ payload, snapshotObservedAt: now, collectionSucceededAt: now, collectionStatus: 'SUCCEEDED', now })

test('raw rows are not active identities: cleared/closed/safe overrides and duplicate IDs', () => {
  const cleared = Array.from({ length: 10 }, (_, i) => row(`closed-${i}`, i % 2 ? 'dismissed' : 'confirmedSafe'))
  assert.equal(summarizeMicrosoftRisk(input(cleared)).activeDistinctUserCount, 0)
  const result = summarizeMicrosoftRisk(input([...cleared, row('active'), row('active'), row('compromised', 'confirmedCompromised'), row('safe', 'atRisk', 'adminConfirmedAccountSafe')]))
  assert.equal(result.rawRecordCount, 14)
  assert.equal(result.activeDistinctUserCount, 2)
  assert.equal(result.observedActiveDistinctUserCount, 2)
  assert.equal(result.completeness, 'COMPLETE')
  assert.ok(Object.isFrozen(result))
  assert.doesNotMatch(JSON.stringify(result), /closed-|compromised|adminConfirmedAccountSafe/)
})

test('all three canonical safe-detail overrides precede active state', () => {
  for (const detail of ['adminConfirmedSigninSafe', 'aiConfirmedSigninSafe', 'adminConfirmedAccountSafe']) {
    assert.equal(summarizeMicrosoftRisk(input([row('safe', 'confirmedCompromised', detail)])).activeDistinctUserCount, 0)
  }
})

test('unknown and malformed records never establish exact zero or erase other active observations', () => {
  for (const bad of [null, [], {}, { id: '../bad', riskState: 'atRisk', riskLevel: 'high' }, row('unknown', 'futureState'), { ...row('bad'), riskDetail: {} }, { ...row('bad'), riskLastUpdatedDateTime: 'not-a-date' }, Object.create({ id: 'inherited' })]) {
    const result = summarizeMicrosoftRisk(input([row('one'), row('two'), bad]))
    assert.equal(result.availability, 'PARTIAL')
    assert.equal(result.activeDistinctUserCount, null)
    assert.equal(result.observedActiveDistinctUserCount, 2)
    const unknownOnly = summarizeMicrosoftRisk(input([bad]))
    assert.equal(unknownOnly.activeDistinctUserCount, null)
    assert.equal(unknownOnly.observedActiveDistinctUserCount, 0)
  }
})

test('active plus conflicting duplicates retain observed evidence without claiming current active risk', () => {
  for (const conflictingState of ['confirmedSafe', 'dismissed', 'futureState']) {
    const rows = [row('same'), row('same', conflictingState), row('unrelated')]
    const result = summarizeMicrosoftRisk(input(rows))
    assert.equal(result.completeness, 'CONFLICTING')
    assert.equal(result.reasonCode, 'CONFLICTING_RECORDS')
    assert.equal(result.observedActiveDistinctUserCount, 2)
    assert.equal(result.activeDistinctUserCount, null)
    assert.deepEqual(result, summarizeMicrosoftRisk(input(rows.reverse())))
  }
})

test('missing source gates, failed/running collections and stale/future clocks are unavailable, not zero', () => {
  for (const overrides of [
    { sourceAllowed: false }, { collectionStatus: 'FAILED' }, { collectionStatus: 'RUNNING' },
    { collectionSucceededAt: null }, { snapshotObservedAt: null },
    { snapshotObservedAt: new Date(now.getTime() - 37 * 3600000) },
    { collectionSucceededAt: new Date(now.getTime() - 37 * 3600000) },
    { snapshotObservedAt: new Date(now.getTime() + 301000) },
    { collectionSucceededAt: new Date(now.getTime() + 301000) },
    { snapshotObservedAt: '09/15/2026' },
    { snapshotObservedAt: '2026-02-30T12:00:00.000Z' },
    { snapshotObservedAt: '2026-09-15T24:00:00.000Z' },
  ]) {
    const result = summarizeMicrosoftRisk({ ...input([row('active')]), ...overrides })
    assert.equal(result.availability, 'UNAVAILABLE')
    assert.equal(result.completeness, 'UNKNOWN')
    assert.equal(result.activeDistinctUserCount, null)
    assert.equal(result.observedActiveDistinctUserCount, null)
  }
})

test('bounded whole-snapshot validation and canonical timestamps', () => {
  for (const payload of [{}, null, Array(MICROSOFT_RISK_MAX_ROWS + 1).fill(row('x'))]) {
    assert.equal(summarizeMicrosoftRisk(input(payload)).reasonCode, 'INVALID_SNAPSHOT')
  }
  const result = summarizeMicrosoftRisk(input(Array.from({ length: 120 }, (_, i) => row(`user-${i}`))))
  assert.equal(result.activeDistinctUserCount, 120)
  assert.equal(result.snapshotObservedAt, now.toISOString())
  assert.equal(result.collectionSucceededAt, now.toISOString())
  assert.equal(summarizeMicrosoftRisk(input([])).activeDistinctUserCount, 0)
})
