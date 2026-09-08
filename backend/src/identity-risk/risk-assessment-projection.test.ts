import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RISK_ASSESSMENT_SCHEMA, RISK_ASSESSMENT_RULE_IDS, RISK_ASSESSMENT_RULE_TUPLES } from './identity-risk-assessment.contract.js'
import { assessmentMeta, projectStoredRiskAssessment, unknownRiskProtection, type StoredRiskAssessment } from './risk-assessment-projection.js'
import { identityRiskRulePresentation } from './identity-risk.catalog.js'
const now = new Date('2026-09-08T20:00:00.000Z')
const ref = (kind: string) => `hvr1_${kind}_${'a'.repeat(64)}`
function fixture(): StoredRiskAssessment {
  const window = { start: '2026-09-08T19:45:00.000Z', end: now.toISOString() }
  return {
    schemaVersion: RISK_ASSESSMENT_SCHEMA,
    sources: (['M365_AUDIT_STS', 'GRAPH_SIGN_INS', 'MAILBOX_RULES'] as const).map(source => ({ source, status: 'READY', reasonCode: 'READY', explanation: 'PRIVATE', window,
      lastSuccessfulCollectionAt: now.toISOString(), latestEventAt: now.toISOString(), latestIngestionAt: now.toISOString(), freshness: 'CURRENT' })),
    rules: RISK_ASSESSMENT_RULE_IDS.map(ruleId => ({ ruleId, ruleVersion: RISK_ASSESSMENT_RULE_TUPLES[ruleId].version,
      title: 'PRIVATE', status: 'READY', reasonCode: 'READY', explanation: 'PRIVATE', selectedSource: ruleId === 'HV-ID-MBX-001.v1' ? 'MAILBOX_RULES' : 'M365_AUDIT_STS',
      window, evaluatedAt: now.toISOString(), assessedIdentities: 1, matchedIdentities: 1, countsCapped: false })),
    subjects: [{ id: ref('subject'), subjectType: 'USER', findings: [{
      id: ref('contribution'), ruleId: 'HV-ID-AUTH-010.v1', ruleVersion: 'v1', priority: 'LOW', confidence: 'MEDIUM', activityState: 'CURRENT',
      title: 'PRIVATE', explanation: 'password=PRIVATE', firstSeen: window.start, lastSeen: now.toISOString(), evaluatedAt: now.toISOString(), window,
      evidenceCount: 10, evidenceCountCapped: true, selectedSource: 'M365_AUDIT_STS',
      application: { id: ref('application'), state: 'RESOLVED', label: null }, device: { state: 'NOT_REPORTED', label: null }, clientSource: { reference: null, qualification: 'NOT_REPORTED' },
      evidenceReferences: [{ id: ref('evidence'), recordedAt: now.toISOString(), ingestedAt: now.toISOString() }], eventProtection: 'NOT_REPORTED',
      caveats: ['PRIVATE'], recommendedActions: [{ code: 'REVIEW_SIGN_INS', text: 'PRIVATE' }],
    }] }],
  }
}
test('all diagnostic copy is code-owned; opaque evidence survives, arbitrary provider text does not', () => {
  const result = projectStoredRiskAssessment(fixture(), now)
  assert.ok(result)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  assert.equal(result.subjects[0]?.findings[0]?.evidenceReferences[0]?.id, ref('evidence'))
  assert.ok(result.subjects[0]?.findings[0]?.recommendedActions.some(action => action.code === 'CHECK_SAVED_CREDENTIALS'))
})
test('exact release tuple and source are enforced without altering old break-glass meaning', () => {
  assert.match(identityRiskRulePresentation('HV-ID-AUTH-009.v1')!.title, /Break-glass/)
  assert.match(identityRiskRulePresentation('HV-ID-AUTH-010.v1')!.title, /invalid-credential/)
  for (const change of [{ ruleId: 'HV-ID-AUTH-009.v1' }, { ruleId: ' HV-ID-AUTH-010.v1' },
    { priority: 'HIGH' }, { priority: 'CRITICAL' }, { ruleVersion: 'v2' }, { selectedSource: 'MAILBOX_RULES' }]) {
    const input = structuredClone(fixture())
    Object.assign(input.subjects[0]!.findings[0]!, change)
    assert.equal(projectStoredRiskAssessment(input, now), null)
  }
})
test('raw IDs, names, unknown fields, prototype/getter payloads and size overruns fail closed', () => {
  for (const change of [{ id: 'raw-microsoft-id' }, { raw: { access_token: 'PRIVATE' } }, { title: 'X'.repeat(2049) },
    { title: 'bad\ntext' }, { evidenceReferences: [{ id: 'raw-id', recordedAt: now.toISOString(), ingestedAt: null }] },
    { application: { id: ref('application'), state: 'RESOLVED', label: 'Provider text' } }]) {
    const input = structuredClone(fixture()); Object.assign(input.subjects[0]!.findings[0]!, change)
    assert.equal(projectStoredRiskAssessment(input, now), null)
  }
  assert.equal(projectStoredRiskAssessment(Object.create(fixture()), now), null)
  const withGetter = { ...fixture(), get raw() { throw new Error('must not run') } }
  assert.equal(projectStoredRiskAssessment(withGetter, now), null)
})
test('unknown protection carries uncertainty; partial or stale source cannot produce full/current metadata', () => {
  const protection = unknownRiskProtection()
  assert.equal(protection.registration.state, 'UNKNOWN')
  assert.equal(protection.registration.observedAt, null)
  assert.equal(protection.legacyPerUserMfa.freshness, 'UNKNOWN')
  const input = fixture()
  const partial = { ...input, rules: input.rules.map(rule => rule.ruleId === 'HV-ID-MBX-001.v1' ? { ...rule, status: 'WAITING' as const, reasonCode: 'SOURCE_NOT_ATTESTED' as const } : rule) }
  assert.equal(assessmentMeta(partial, now.toISOString(), now).capability, 'PARTIAL')
  assert.notEqual(assessmentMeta(partial, now.toISOString(), now).freshness, 'CURRENT')
  assert.equal(assessmentMeta(input, now.toISOString(), new Date(now.getTime() + 3_600_001)).capability, 'UNAVAILABLE')
})
