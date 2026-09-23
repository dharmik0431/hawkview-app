import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFleetRisk, FLEET_EVIDENCE_MAX_AGE_MS as age } from './fleet-risk-projection.ts'
import { syntheticRiskResponses } from './test-fixtures.ts'

const now = Date.parse('2026-09-23T12:00:00Z')
const stamp = new Date(now).toISOString()
const ref = '00000000-0000-4000-8000-000000000011'
function native(positive = false): any {
  return { version: 'hawkview-risky-users/v1', available: true,
    run: { windowStart: stamp, windowEnd: stamp, completedAt: stamp },
    collectors: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: stamp }],
    coverage: [{ stream: 'GRAPH_SIGN_INS', coverage: { applies: 5, uninterpretedEvents: 0, notYetCitedEvents: 0 } }],
    subjectsNamed: true, count: { accuracy: 'EXACT', value: positive ? 1 : 0,
      scope: { evidenceRequested: ['GRAPH_SIGN_INS'], covered: ['repeated-credential-failure'], notCovered: [] } },
    claim: { permitted: true }, findings: { complete: true, items: positive ? [{ detectorId: 'repeated-credential-failure',
      subject: { kind: 'DIRECTORY_USER', userRef: ref, correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref } },
      displayName: 'Synthetic native user', userPrincipalName: 'test@synthetic.invalid',
      signals: [{ signal: 'PASSWORD_REJECTED', count: 10, capped: false, latest: { at: stamp, kind: 'EVENT_OCCURRED' } }] }] : [] } }
}
function record(id = 'record-1', riskState = 'atRisk', correlationRef = ref): any {
  return { id, identityLabel: 'Synthetic Microsoft user', riskLevel: 'high', riskState, riskDetail: null, observedAt: stamp,
    correlation: { available: true, shape: 'DIRECTORY_OBJECT_ID', ref: correlationRef } }
}
function microsoft(users: any[] = []): any {
  return { ...syntheticRiskResponses().microsoftRiskyUsers, evaluatedAt: stamp, observedAt: stamp, users,
    microsoftRiskSummary: { source: 'MICROSOFT_IDENTITY_PROTECTION', availability: 'AVAILABLE', completeness: 'COMPLETE',
      rawRecordCount: users.length, observedActiveDistinctUserCount: users.length, activeDistinctUserCount: users.length,
      snapshotObservedAt: stamp, collectionSucceededAt: stamp, reasonCode: null } }
}
function project(n = native(), m = microsoft(), time = now) {
  return projectFleetRisk([{ id: 'tenant-a' }], [{ data: n }], [{ data: m }], time)
}

test('complete fresh zero is assessed; unavailable, withheld, truncated and count mismatch never clean', () => {
  assert.equal(project().tenantStatuses[0].status, 'SUCCESS')
  for (const change of [
    (n: any) => n.available = false,
    (n: any) => n.claim = { permitted: false, reasons: ['MISSING_EVIDENCE'] },
    (n: any) => n.findings.complete = false,
    (n: any) => n.count.value = 2,
    (n: any) => n.count.scope.notCovered = [{ detectorId: 'external-mailbox-forwarding', because: 'MISSING_EVIDENCE' }],
  ]) { const n = native(); change(n); assert.notEqual(project(n).tenantStatuses[0].status, 'SUCCESS') }
  const m = microsoft(); m.microsoftRiskSummary.activeDistinctUserCount = 2
  assert.notEqual(project(native(), m).tenantStatuses[0].status, 'SUCCESS')
})
test('persisted clocks expire at two hours; invalid, missing, future, duplicate and reversed clocks fail closed', () => {
  assert.equal(project(native(), microsoft(), now + age).tenantStatuses[0].status, 'SUCCESS')
  assert.notEqual(project(native(), microsoft(), now + age + 1).tenantStatuses[0].status, 'SUCCESS')
  for (const value of [null, 'invalid', new Date(now + 1).toISOString()]) {
    const n = native(); n.run.completedAt = value
    assert.notEqual(project(n).tenantStatuses[0].status, 'SUCCESS')
  }
  for (const mutate of [
    (n: any) => n.collectors.push({ ...n.collectors[0] }),
    (n: any) => n.collectors[0].status = 'FAILED',
    (n: any) => n.run.completedAt = new Date(now - 1).toISOString(),
  ]) { const n = native(); mutate(n); assert.notEqual(project(n).tenantStatuses[0].status, 'SUCCESS') }
  const n = native(); n.collectors.push({ source: 'IRRELEVANT', status: 'FAILED', lastSuccessfulCollectionAt: null })
  assert.equal(project(n).tenantStatuses[0].status, 'SUCCESS')
})
test('Microsoft-only positives survive absent native assessments; cleared entries do not corroborate', () => {
  assert.equal(project(null, microsoft([record()])).fleetRows.length, 1)
  for (const records of [[record('clear', 'dismissed'), record()], [record(), record('clear', 'dismissed')]]) {
    const p = project(native(true), microsoft(records))
    assert.equal(p.fleetRows.length, 1)
    assert.equal(p.fleetRows[0].detection.microsoftRecord?.riskState, 'atRisk')
  }
  assert.equal(project(native(true), microsoft([record('clear', 'dismissed')])).fleetRows[0].detection.microsoft, 'NOT_COMPARABLE')
})
test('duplicate Microsoft identities deduplicate, conflicting IDs cannot bridge, tenant identities stay separate', () => {
  assert.equal(project(null, microsoft([record('a'), record('b')])).fleetRows.length, 1)
  const p = project(native(true), microsoft([record(), record('record-1', 'atRisk', '00000000-0000-4000-8000-000000000012')]))
  assert.equal(p.fleetRows.length, 1)
  assert.equal(p.fleetRows[0].detection.microsoft, 'NOT_COMPARABLE')
  const fleet = projectFleetRisk([{ id: 'a' }, { id: 'b' }], [], [{ data: microsoft([record()]) }, { data: microsoft([record()]) }], now)
  assert.equal(new Set(fleet.fleetRows.map(r => r.id)).size, 2)
})
test('historical and failed/loading/refetch cached positives stay visible without current certification', () => {
  assert.equal(project(native(true), microsoft(), now + age + 1).fleetRows[0].evidenceState, 'HISTORICAL')
  for (const flag of ['isError', 'isLoading', 'isFetching']) {
    const p = projectFleetRisk([{ id: 'a' }], [{ data: native(true), [flag]: true }], [{ data: microsoft([record()]), [flag]: true }], now)
    assert.equal(p.fleetRows.length, 1)
    assert.equal(p.fleetRows[0].evidenceState, 'UNKNOWN')
    assert.notEqual(p.tenantStatuses[0].status, 'SUCCESS')
  }
})
test('Microsoft snapshots use 36 hours independently of native two-hour evidence', () => {
  for (const hours of [3, 36]) {
    const p = project(null, microsoft([record()]), now + hours * 60 * 60 * 1000)
    assert.equal(p.fleetRows[0].evidenceState, 'CURRENT')
  }
  assert.equal(project(null, microsoft([record()]), now + 36 * 60 * 60 * 1000 + 1).fleetRows[0].evidenceState, 'HISTORICAL')
  const m = microsoft([record()]); m.microsoftRiskSummary.collectionSucceededAt = new Date(now - 1).toISOString()
  assert.notEqual(project(null, m).fleetRows[0]?.evidenceState, 'CURRENT')
})
test('native stream, run ordering and persisted RUNNING cannot certify current coverage', () => {
  for (const mutate of [
    (n: any) => n.run.windowStart = null,
    (n: any) => n.run.windowStart = new Date(now + 1).toISOString(),
    (n: any) => n.run.windowEnd = new Date(now + 1).toISOString(),
    (n: any) => n.collectors[0].status = 'RUNNING',
    (n: any) => { n.coverage[0].stream = 'UNKNOWN'; n.collectors[0].source = 'UNKNOWN' },
    (n: any) => n.collectors.push({ source: 'GRAPH_SIGN_INS', status: null }),
  ]) {
    const n = native(true); mutate(n); const p = project(n)
    assert.notEqual(p.tenantStatuses[0].status, 'SUCCESS')
    assert.notEqual(p.fleetRows[0]?.evidenceState, 'CURRENT')
  }
  const n = native(); n.run.windowStart = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  assert.equal(project(n).tenantStatuses[0].status, 'SUCCESS', 'window start is ordering-only, not a freshness clock')
})
test('mailbox findings cannot collapse into user rows sharing a reference', () => {
  const n = native(true)
  const mailbox = structuredClone(n.findings.items[0]); mailbox.subject = { kind: 'MAILBOX', mailboxRef: ref }; mailbox.detectorId = 'external-mailbox-forwarding'
  n.findings.items.push(mailbox)
  const p = project(n)
  assert.equal(p.fleetRows.length, 1)
  assert.equal(p.fleetRows[0].reasons.length, 1)
})
test('conflicting native correlations never bridge a grouped user to Microsoft', () => {
  const n = native(true); const other = structuredClone(n.findings.items[0]); other.subject.correlation.ref = 'different-ref'; n.findings.items.push(other)
  const p = project(n, microsoft([record()]))
  assert.equal(p.fleetRows.length, 2)
  assert.equal(p.fleetRows[0].detection.microsoft, 'NOT_COMPARABLE')
})
test('undelivered source totals remain separate, qualified, and timestamped', () => {
  const n = native(); n.count.value = 7; n.count.accuracy = 'AT_LEAST'
  const m = microsoft(); Object.assign(m.microsoftRiskSummary, { rawRecordCount: 3, activeDistinctUserCount: 3, observedActiveDistinctUserCount: 3 })
  const p = project(n, m, now + 37 * 60 * 60 * 1000)
  assert.equal(p.metrics.totalRiskyUsers, 0)
  assert.deepEqual(p.deliveryGaps.map(g => [g.source, g.reported, g.shown, g.lowerBound, g.evidenceState, g.asOf]), [
    ['HawkView', 7, 0, true, 'HISTORICAL', stamp], ['Microsoft', 3, 0, false, 'HISTORICAL', stamp],
  ])
})
