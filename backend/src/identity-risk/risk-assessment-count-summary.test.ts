import assert from 'node:assert/strict'
import test from 'node:test'
import { RISK_ASSESSMENT_RULE_IDS, RISK_ASSESSMENT_RULE_TUPLES, RISK_ASSESSMENT_SCHEMA, type RiskAssessmentDto, type RiskAssessmentFindingDto, type RiskAssessmentUserDto } from './identity-risk-assessment.contract.js'
import { unknownRiskProtection } from './risk-assessment-projection.js'
import { riskAssessmentSummary } from './risk-assessment-count-summary.js'

const now = new Date('2026-09-09T12:00:00.000Z')
const stamp = now.toISOString()
const ref = (n: number, kind = 'subject') => `hvr1_${kind}_${n.toString(16).padStart(64, '0')}`
function finding(ruleId: RiskAssessmentFindingDto['ruleId'] = RISK_ASSESSMENT_RULE_IDS[0], activityState: RiskAssessmentFindingDto['activityState'] = 'CURRENT'): RiskAssessmentFindingDto {
  return { id: ref(RISK_ASSESSMENT_RULE_IDS.indexOf(ruleId) + 1, 'contribution'), ruleId,
    ruleVersion: RISK_ASSESSMENT_RULE_TUPLES[ruleId].version, priority: RISK_ASSESSMENT_RULE_TUPLES[ruleId].priority,
    confidence: 'HIGH', activityState, title: 'Synthetic', explanation: 'Synthetic', firstSeen: stamp, lastSeen: stamp,
    evaluatedAt: stamp, activityWindowEndsAt: new Date(now.getTime() + 60_000).toISOString(), window: { start: stamp, end: stamp },
    evidenceCount: 1, evidenceCountCapped: false, selectedSource: ruleId === 'HV-ID-MBX-001.v1' ? 'MAILBOX_RULES' : 'GRAPH_SIGN_INS',
    application: { id: null, state: 'NOT_REPORTED', label: null }, device: { state: 'NOT_REPORTED', label: null },
    clientSource: { reference: null, qualification: 'NOT_REPORTED' }, evidenceReferences: [], eventProtection: 'NOT_REPORTED', caveats: [], recommendedActions: [] }
}
function user(n: number, findings = [finding()], subjectType: 'USER' | 'MAILBOX' = 'USER'): RiskAssessmentUserDto {
  return { id: ref(n, subjectType === 'USER' ? 'subject' : 'mailbox'), label: 'Synthetic identity', subjectType,
    priority: 'LOW', protection: unknownRiskProtection(), findings }
}
function fixture(users: RiskAssessmentUserDto[] = []): RiskAssessmentDto {
  return { version: 1, schemaVersion: RISK_ASSESSMENT_SCHEMA,
    meta: { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', engineVersion: 'hawkview-identity-engine/1', catalogVersion: 'hawkview-identity-signals/v1',
      evaluatedAt: stamp, capability: 'FULL', status: 'AVAILABLE', sourceLabel: 'Synthetic', observedAt: null, freshness: 'CURRENT', limitation: null },
    sources: (['M365_AUDIT_STS', 'GRAPH_SIGN_INS', 'MAILBOX_RULES'] as const).map(source => ({ source, status: 'READY', reasonCode: 'READY', explanation: 'Synthetic',
      window: { start: stamp, end: stamp }, lastSuccessfulCollectionAt: stamp, latestEventAt: stamp, latestIngestionAt: stamp, freshness: 'CURRENT' })),
    rules: RISK_ASSESSMENT_RULE_IDS.map(ruleId => ({ ruleId, ruleVersion: RISK_ASSESSMENT_RULE_TUPLES[ruleId].version, title: 'Synthetic', status: 'READY',
      reasonCode: 'READY', explanation: 'Synthetic', selectedSource: ruleId === 'HV-ID-MBX-001.v1' ? 'MAILBOX_RULES' : 'GRAPH_SIGN_INS',
      window: { start: stamp, end: stamp }, evaluatedAt: stamp, assessedIdentities: 5, matchedIdentities: 0, countsCapped: false })),
    users, page: { hasMore: false, nextCursor: null } }
}
const count = (data: RiskAssessmentDto, at = now) => riskAssessmentSummary(data, at).currentUsers
const unknown = { value: null, accuracy: 'UNKNOWN' }
function partial(data: RiskAssessmentDto, capped = false): RiskAssessmentDto {
  return { ...data, meta: { ...data.meta, capability: 'PARTIAL', freshness: 'UNKNOWN' },
    rules: data.rules.map(rule => rule.ruleId === 'HV-ID-MBX-001.v1' ? { ...rule, status: 'PARTIAL', reasonCode: capped ? 'CAPACITY_LIMIT' : 'INCOMPLETE_WINDOW',
      countsCapped: capped, assessedIdentities: null, matchedIdentities: null } : rule) }
}

test('counts one canonical user across multiple rules, duplicate findings and duplicate rows', () => {
  const one = user(1, [...RISK_ASSESSMENT_RULE_IDS.map(id => finding(id)), finding()])
  assert.deepEqual(count(fixture([one, one, user(2)])), { value: 2, accuracy: 'EXACT' })
})
test('mailbox-only identities never count; already-qualified canonical human mailbox rollup counts once', () => {
  const mailboxFinding = finding('HV-ID-MBX-001.v1')
  assert.deepEqual(count(fixture([user(1, [mailboxFinding], 'MAILBOX'), user(2, [mailboxFinding], 'MAILBOX')])), { value: 0, accuracy: 'EXACT' })
  assert.deepEqual(count(fixture([user(3, [finding(), mailboxFinding])])), { value: 1, accuracy: 'EXACT' })
})
test('historical and unknown activity are excluded without changing lifecycle or protection', () => {
  const data = fixture([user(1, [finding(undefined, 'HISTORICAL')]), user(2, [finding(undefined, 'UNKNOWN')]),
    user(4, [finding(), finding(undefined, 'HISTORICAL')])])
  assert.deepEqual(count(data), { value: 1, accuracy: 'EXACT' })
  assert.equal(data.users[0]!.findings[0]!.activityState, 'HISTORICAL')
})
test('complete current evidence supports exact zero and preserves authoritative assessment time', () => {
  assert.deepEqual(riskAssessmentSummary(fixture(), new Date(now.getTime() + 1000)), { scope: 'TENANT', asOf: stamp, currentUsers: { value: 0, accuracy: 'EXACT' } })
})
test('partial/capped positive is a lower bound; partial/capped empty is unknown even with hasMore=false', () => {
  for (const capped of [false, true]) {
    assert.deepEqual(count(partial(fixture([user(1)]), capped)), { value: 1, accuracy: 'AT_LEAST' })
    assert.deepEqual(count(partial(fixture(), capped)), unknown)
  }
})
test('capped rules prevent exactness even if aggregate metadata incorrectly claims full', () => {
  const data = partial(fixture([user(1)]), true)
  assert.deepEqual(count({ ...data, meta: fixture().meta }), { value: 1, accuracy: 'AT_LEAST' })
})
test('stale, failed and not-evaluated assessments never report current positive or zero', () => {
  for (const users of [[], [user(1)]]) for (const status of ['STALE', 'ERROR', 'NOT_EVALUATED', 'UNAVAILABLE'] as const) {
    const data = fixture(users)
    assert.deepEqual(count({ ...data, meta: { ...data.meta, status } }), unknown)
  }
  assert.deepEqual(count(fixture([user(1)]), new Date(now.getTime() + 3_600_001)), unknown)
})
test('missing/future/invalid completion timestamp cannot invent an asOf or zero', () => {
  for (const evaluatedAt of [null, 'invalid', new Date(now.getTime() + 1000).toISOString()]) {
    const data = fixture()
    assert.deepEqual(riskAssessmentSummary({ ...data, meta: { ...data.meta, evaluatedAt } }, now), { scope: 'TENANT', asOf: null, currentUsers: unknown })
  }
})
test('stale selected source prevents counting its users even when another source remains usable', () => {
  const data = partial(fixture([user(1)]))
  assert.deepEqual(count({ ...data, sources: data.sources.map(source => source.source === 'GRAPH_SIGN_INS' ? { ...source, freshness: 'STALE', status: 'STALE' } : source) }), unknown)
})
test('summary is computed before UI slicing and remains stable across presentation pages', () => {
  const data = fixture(Array.from({ length: 80 }, (_, n) => user(n + 1)))
  const summary = riskAssessmentSummary(data, now)
  for (let start = 0; start < 80; start += 20) {
    const page = { ...data, summary, users: data.users.slice(start, start + 20) }
    assert.equal(page.users.length, 20)
    assert.deepEqual(page.summary.currentUsers, { value: 80, accuracy: 'EXACT' })
  }
})
test('future server-paged input is never mistaken for a generation total', () => {
  const data = fixture([user(1)])
  assert.deepEqual(count({ ...data, page: { hasMore: true, nextCursor: 'synthetic' } }), unknown)
  assert.deepEqual(count({ ...data, page: { hasMore: false, nextCursor: 'synthetic' } }), unknown)
})
test('existing 100-subject/200-finding caps fail closed without raising limits or hydrating more rows', () => {
  assert.deepEqual(count(fixture(Array.from({ length: 100 }, (_, n) => user(n + 1, [{ ...finding(), id: ref(n + 1, 'contribution') }])))), { value: 100, accuracy: 'EXACT' })
  assert.deepEqual(count(fixture([user(1, Array.from({ length: 200 }, (_, n) => ({ ...finding(), id: ref(n + 1, 'contribution') })))])), { value: 1, accuracy: 'EXACT' })
  assert.deepEqual(count(fixture(Array.from({ length: 101 }, (_, n) => user(n + 1, [{ ...finding(), id: ref(n + 1, 'contribution') }])))), unknown)
  assert.deepEqual(count(fixture([user(1, Array.from({ length: 201 }, (_, n) => ({ ...finding(), id: ref(n + 1, 'contribution') })))])), unknown)
})

test('any unqualified returned CURRENT user finding makes the whole count unknown rather than subtracting it', () => {
  for (const change of [
    { activityWindowEndsAt: new Date(now.getTime() - 1).toISOString() },
    { activityWindowEndsAt: 'invalid' },
    { firstSeen: 'invalid' },
    { lastSeen: 'invalid' },
    { evaluatedAt: new Date(now.getTime() + 1).toISOString() },
  ]) {
    const inconsistent = user(1, [{ ...finding(), ...change }])
    for (const users of [[inconsistent], [inconsistent, user(2)]])
      assert.deepEqual(count(fixture(users)), unknown)
  }
  const data = fixture([user(1), user(2)])
  for (const change of [{ selectedSource: null }, { status: 'WAITING' as const }, { evaluatedAt: null }])
    assert.deepEqual(count({ ...data, rules: data.rules.map(rule => rule.ruleId === 'HV-ID-AUTH-010.v1' ? { ...rule, ...change } : rule) }), unknown)
})
test('contradictory user/mailbox identities and noncanonical user references fail closed', () => {
  assert.deepEqual(count(fixture([user(1), { ...user(2, [], 'MAILBOX'), id: user(1).id }])), unknown)
  assert.deepEqual(count(fixture([{ ...user(1), id: 'synthetic-address@example.invalid' }])), unknown)
})
test('protection context cannot subtract an otherwise qualifying current user', () => {
  const protectedUser = user(1)
  const protection = { ...protectedUser.protection, securityDefaults: { ...protectedUser.protection.securityDefaults, state: 'ENABLED' as const } }
  assert.deepEqual(count(fixture([{ ...protectedUser, protection }])), { value: 1, accuracy: 'EXACT' })
})
