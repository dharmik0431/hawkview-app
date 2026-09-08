import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { findingActivityMs, findingRetentionExpiry, reconcileAssessmentHistory } from './risk-assessment-history.js';
import { ASSESSMENT_COPY, ASSESSMENT_MAX_FINDINGS, ASSESSMENT_MAX_REFERENCES, ASSESSMENT_MAX_SUBJECTS, assessmentActions, assessmentReason, projectStoredRiskAssessment, type StoredRiskAssessment } from './risk-assessment-projection.js';
import { RISK_ASSESSMENT_RULE_IDS, RISK_ASSESSMENT_RULE_TUPLES, RISK_ASSESSMENT_SCHEMA, type RiskAssessmentFindingDto, type RiskAssessmentRuleId, type RiskAssessmentSource, type RiskRuleReadinessDto, type RiskSourceReadinessDto } from './identity-risk-assessment.contract.js';

const BASE = Date.parse('2026-09-08T21:00:00.000Z');
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const at = (offset = 0): string => new Date(BASE + offset).toISOString();
const clock = (offset = 0): Date => new Date(BASE + offset);
const A = 'HV-ID-AUTH-010.v1', B = 'HV-ID-AUTH-005.v2', C = 'HV-ID-MBX-001.v1';
const opaque = (kind: string, value: string): string => `hvr1_${kind}_${createHash('sha256').update(value).digest('hex')}`;
const evidence = (key: string, recordedAt = at()) => ({ id: opaque('evidence', key), recordedAt, ingestedAt: recordedAt });

function finding(ruleId: RiskAssessmentRuleId = B, overrides: Partial<RiskAssessmentFindingDto> = {}): RiskAssessmentFindingDto {
  const tuple = RISK_ASSESSMENT_RULE_TUPLES[ruleId];
  const firstSeen = overrides.firstSeen ?? at(-5 * MINUTE), lastSeen = overrides.lastSeen ?? at();
  const evidenceReferences = overrides.evidenceReferences ?? Array.from({ length: ruleId === A ? 10 : ruleId === B ? 6 : 1 }, (_, index) => evidence(`${ruleId}-${index}`, lastSeen));
  return {
    id: opaque('contribution', `${ruleId}-original`), ruleId, ruleVersion: tuple.version, priority: tuple.priority, confidence: 'MEDIUM',
    activityState: 'CURRENT', title: ASSESSMENT_COPY[ruleId].title, explanation: ASSESSMENT_COPY[ruleId].explanation,
    firstSeen, lastSeen, evaluatedAt: at(), activityWindowEndsAt: new Date(Date.parse(lastSeen) + findingActivityMs(ruleId)).toISOString(),
    window: { start: firstSeen, end: lastSeen }, evidenceCount: evidenceReferences.length, evidenceCountCapped: false,
    selectedSource: ruleId === C ? 'MAILBOX_RULES' : 'GRAPH_SIGN_INS',
    application: { id: ruleId === C ? null : opaque('application', 'synthetic-app'), state: ruleId === C ? 'NOT_REPORTED' : 'RESOLVED', label: null },
    device: { state: 'NOT_REPORTED', label: null },
    clientSource: { reference: ruleId === B ? opaque('context', 'synthetic-client') : null, qualification: ruleId === B ? 'QUALIFIED' : 'NOT_REPORTED' },
    eventProtection: 'NOT_REPORTED', caveats: [...ASSESSMENT_COPY[ruleId].caveats], recommendedActions: assessmentActions(ruleId), ...overrides,
    evidenceReferences: [...evidenceReferences].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id)),
  };
}
function subject(findings: readonly RiskAssessmentFindingDto[], key = 'synthetic-user'): StoredRiskAssessment['subjects'][number] {
  const mailbox = findings[0]?.ruleId === C;
  return { id: opaque(mailbox ? 'mailbox' : 'subject', key), subjectType: mailbox ? 'MAILBOX' : 'USER', findings };
}
function assessment(subjects: StoredRiskAssessment['subjects'] = [], now = clock()): StoredRiskAssessment {
  const end = now.toISOString(), start = new Date(now.getTime() - DAY).toISOString();
  const sources: RiskSourceReadinessDto[] = (['GRAPH_SIGN_INS', 'M365_AUDIT_STS', 'MAILBOX_RULES'] as const).map(source => ({
    source, status: 'READY', reasonCode: 'READY', explanation: assessmentReason('READY'), window: { start, end },
    lastSuccessfulCollectionAt: end, latestEventAt: end, latestIngestionAt: end, freshness: 'CURRENT',
  }));
  const rules: RiskRuleReadinessDto[] = RISK_ASSESSMENT_RULE_IDS.map(ruleId => ({
    ruleId, ruleVersion: RISK_ASSESSMENT_RULE_TUPLES[ruleId].version, title: ASSESSMENT_COPY[ruleId].title, status: 'READY', reasonCode: 'READY',
    explanation: assessmentReason('READY'), selectedSource: ruleId === C ? 'MAILBOX_RULES' : 'GRAPH_SIGN_INS', window: { start, end },
    evaluatedAt: end, assessedIdentities: 1, matchedIdentities: subjects.some(row => row.findings.some(item => item.ruleId === ruleId)) ? 1 : 0, countsCapped: false,
  }));
  return { schemaVersion: RISK_ASSESSMENT_SCHEMA, sources, rules, subjects };
}
function sourceState(input: StoredRiskAssessment, source: RiskAssessmentSource, overrides: Partial<RiskSourceReadinessDto>): StoredRiskAssessment {
  return { ...input, sources: input.sources.map(row => row.source === source ? { ...row, ...overrides } : row) };
}
function ruleState(input: StoredRiskAssessment, ruleId: RiskAssessmentRuleId, overrides: Partial<RiskRuleReadinessDto>): StoredRiskAssessment {
  return { ...input, rules: input.rules.map(row => row.ruleId === ruleId ? { ...row, ...overrides } : row) };
}
const only = (input: StoredRiskAssessment): RiskAssessmentFindingDto => { assert.equal(input.subjects.length, 1); assert.equal(input.subjects[0]!.findings.length, 1); return input.subjects[0]!.findings[0]!; };

test('history fixtures satisfy the shared current/persisted contract', () => {
  const data = assessment([subject([finding(A), finding(B)]), subject([finding(C)])]);
  assert.notEqual(projectStoredRiskAssessment(data, clock()), null);
  assert.notEqual(projectStoredRiskAssessment(data, clock(), 'PERSISTED_HISTORY'), null);
});
test('activity periods are fixed by rule and remain independent of retention', () => {
  assert.equal(findingActivityMs(A), 15 * MINUTE); assert.equal(findingActivityMs(B), 10 * MINUTE); assert.equal(findingActivityMs(C), 36 * 60 * MINUTE);
  assert.equal(findingRetentionExpiry(finding()).getTime(), BASE + 90 * DAY);
});
test('replay is idempotent and does not refresh event, activity or retention clocks', () => {
  const original = finding(); const current = assessment([subject([original])]);
  const first = reconcileAssessmentHistory(current, [], clock());
  assert.deepEqual(reconcileAssessmentHistory(current, first.subjects, clock()), first);
  const replay = { ...original, evaluatedAt: at(MINUTE) };
  const later = only(reconcileAssessmentHistory(assessment([subject([replay])], clock(MINUTE)), first.subjects, clock(MINUTE)));
  assert.equal(later.id, original.id); assert.equal(later.firstSeen, original.firstSeen); assert.equal(later.lastSeen, original.lastSeen);
  assert.equal(later.activityWindowEndsAt, original.activityWindowEndsAt); assert.equal(later.evidenceCount, original.evidenceCount);
  assert.equal(findingRetentionExpiry(later).getTime(), findingRetentionExpiry(original).getTime());
});
for (const ruleId of [A, B, C] as const) test(`${ruleId} exact detector expiry is current, plus one millisecond historical`, () => {
  const original = finding(ruleId, { activityWindowEndsAt: at(2 * MINUTE) });
  const previous = [subject([original])];
  assert.equal(only(reconcileAssessmentHistory(assessment([], clock(2 * MINUTE)), previous, clock(2 * MINUTE))).activityState, 'CURRENT');
  assert.equal(only(reconcileAssessmentHistory(assessment([], clock(2 * MINUTE + 1)), previous, clock(2 * MINUTE + 1))).activityState, 'HISTORICAL');
});
test('retained evidence survives leaving the 24-hour source window as history', () => {
  const original = finding(); const previous = [subject([original])];
  const result = only(reconcileAssessmentHistory(assessment([], clock(2 * DAY)), previous, clock(2 * DAY)));
  assert.equal(result.activityState, 'HISTORICAL'); assert.equal(result.lastSeen, original.lastSeen); assert.equal(result.id, original.id);
});
test('retention keeps the final millisecond before 90 days, drops at equality, and never extends on replay', () => {
  const original = finding(); const previous = [subject([original])];
  assert.equal(reconcileAssessmentHistory(assessment([], clock(90 * DAY - 1)), previous, clock(90 * DAY - 1)).subjects.length, 1);
  assert.equal(reconcileAssessmentHistory(assessment([], clock(90 * DAY)), previous, clock(90 * DAY)).subjects.length, 0);
  assert.equal(reconcileAssessmentHistory(assessment([], clock(90 * DAY + 1)), previous, clock(90 * DAY + 1)).subjects.length, 0);
  const replayed = { ...original, evaluatedAt: at(89 * DAY) };
  assert.equal(findingRetentionExpiry(replayed).getTime(), BASE + 90 * DAY);
});
for (const status of ['FAILED', 'STALE', 'WAITING'] as const) test(`${status} source does not turn retained current evidence into a clean/current assertion`, () => {
  const reasonCode = status === 'FAILED' ? 'COLLECTION_FAILED' : status === 'STALE' ? 'COLLECTION_STALE' : 'SOURCE_UNAVAILABLE';
  const current = sourceState(assessment(), 'GRAPH_SIGN_INS', { status, reasonCode, freshness: status === 'STALE' ? 'STALE' : 'UNKNOWN' });
  const retained = only(reconcileAssessmentHistory(current, [subject([finding()])], clock()));
  assert.equal(retained.activityState, 'UNKNOWN'); assert.equal(retained.priority, 'MEDIUM');
});
for (const status of ['FAILED', 'STALE', 'WAITING'] as const) test(`${status} rule cannot retain CURRENT merely because its source is READY`, () => {
  const reasonCode = status === 'FAILED' ? 'EVALUATION_FAILED' : status === 'STALE' ? 'COLLECTION_STALE' : 'SOURCE_UNAVAILABLE';
  const current = ruleState(assessment(), B, { status, reasonCode, assessedIdentities: null, matchedIdentities: null });
  assert.equal(only(reconcileAssessmentHistory(current, [subject([finding()])], clock())).activityState, 'UNKNOWN');
});
test('same-generation partial coverage preserves an intact witness, later partial coverage does not renew it', () => {
  let current = sourceState(assessment(), 'GRAPH_SIGN_INS', { status: 'PARTIAL', reasonCode: 'INCOMPLETE_WINDOW' });
  current = ruleState(current, B, { status: 'PARTIAL', reasonCode: 'INCOMPLETE_WINDOW', evaluatedAt: at() });
  assert.equal(only(reconcileAssessmentHistory(current, [subject([finding()])], clock())).activityState, 'CURRENT');
  current = ruleState(current, B, { evaluatedAt: at(MINUTE) });
  assert.equal(only(reconcileAssessmentHistory(current, [subject([finding()])], clock(MINUTE))).activityState, 'UNKNOWN');
});
test('stale collection age cannot be refreshed by a READY label', () => {
  const current = sourceState(assessment(), 'GRAPH_SIGN_INS', { lastSuccessfulCollectionAt: at(-61 * MINUTE) });
  assert.equal(only(reconcileAssessmentHistory(current, [subject([finding()])], clock())).activityState, 'UNKNOWN');
});
test('unknown prior stays unknown without independent replacement evidence', () => {
  assert.equal(only(reconcileAssessmentHistory(assessment(), [subject([finding(B, { activityState: 'UNKNOWN' })])], clock())).activityState, 'UNKNOWN');
});
test('disputed persisted evidence is retained as unknown, then historical after exact activity expiry', () => {
  const original = finding(); const invalid = new Set([original.evidenceReferences[0]!.id]);
  const disputed = reconcileAssessmentHistory(assessment(), [subject([original])], clock(), invalid);
  assert.equal(only(disputed).activityState, 'UNKNOWN'); assert.equal(only(disputed).id, original.id);
  assert.equal(only(reconcileAssessmentHistory(assessment([], clock(11 * MINUTE)), disputed.subjects, clock(11 * MINUTE), invalid)).activityState, 'HISTORICAL');
});
test('capped prior evidence cannot claim an unrelated dispute is absent from unseen witnesses', () => {
  const prior = finding(B, { evidenceCountCapped: true, evidenceCount: 100 });
  assert.equal(only(reconcileAssessmentHistory(assessment(), [subject([prior])], clock(), new Set([opaque('evidence', 'unseen')]))).activityState, 'UNKNOWN');
});
test('an invalidated current witness cannot be added as CURRENT', () => {
  const current = finding(); const data = assessment([subject([current])]);
  const output = only(reconcileAssessmentHistory(data, [], clock(), new Set([current.evidenceReferences[0]!.id])));
  assert.notEqual(output.activityState, 'CURRENT');
});
test('fresh replacement preserves incident ID but not disputed prior clocks, MFA or references', () => {
  const prior = finding(B, { firstSeen: at(-10 * MINUTE), lastSeen: at(), eventProtection: 'MFA_SATISFIED' });
  const fresh = finding(B, { id: opaque('contribution', 'replacement'), firstSeen: at(-4 * MINUTE), lastSeen: at(-MINUTE), activityWindowEndsAt: at(9 * MINUTE),
    evidenceReferences: Array.from({ length: 6 }, (_, i) => evidence(`replacement-${i}`, at(-MINUTE))), eventProtection: 'NOT_REPORTED' });
  const output = only(reconcileAssessmentHistory(assessment([subject([fresh])]), [subject([prior])], clock(), new Set([prior.evidenceReferences[0]!.id])));
  assert.equal(output.id, prior.id); assert.equal(output.firstSeen, fresh.firstSeen); assert.equal(output.lastSeen, fresh.lastSeen);
  assert.equal(output.activityWindowEndsAt, fresh.activityWindowEndsAt); assert.equal(output.eventProtection, 'NOT_REPORTED');
  assert.deepEqual(output.evidenceReferences, fresh.evidenceReferences); assert.equal(output.activityState, 'CURRENT');
});
test('rolling extensions merge evidence once without moving the established incident ID', () => {
  const prior = finding(); const added = evidence('new-rolling-event', at(MINUTE));
  const current = finding(B, { id: opaque('contribution', 'rolling'), lastSeen: at(MINUTE), evaluatedAt: at(MINUTE), activityWindowEndsAt: at(11 * MINUTE), evidenceReferences: [...prior.evidenceReferences, added] });
  const data = assessment([subject([current])], clock(MINUTE));
  const output = reconcileAssessmentHistory(data, [subject([prior])], clock(MINUTE));
  assert.equal(only(output).id, prior.id); assert.equal(only(output).evidenceCount, 7); assert.equal(only(output).activityWindowEndsAt, at(11 * MINUTE));
  assert.deepEqual(reconcileAssessmentHistory(data, output.subjects, clock(MINUTE)), output);
});
for (const dimension of ['application', 'client', 'source', 'subject', 'rule'] as const) test(`merge never pools a different ${dimension} domain`, () => {
  const prior = finding(); let fresh = finding(B, { id: opaque('contribution', dimension) });
  if (dimension === 'application') fresh = { ...fresh, application: { ...fresh.application, id: opaque('application', 'other') } };
  if (dimension === 'client') fresh = { ...fresh, clientSource: { ...fresh.clientSource, reference: opaque('context', 'other') } };
  if (dimension === 'source') fresh = { ...fresh, selectedSource: 'M365_AUDIT_STS' };
  if (dimension === 'rule') fresh = finding(A);
  let data = assessment([subject([fresh], dimension === 'subject' ? 'other-subject' : 'synthetic-user')]);
  if (dimension === 'source') data = ruleState(data, B, { selectedSource: 'M365_AUDIT_STS' });
  const output = reconcileAssessmentHistory(data, [subject([prior])], clock());
  assert.equal(output.subjects.reduce((count, row) => count + row.findings.length, 0), 2);
});
test('touching episode windows merge at equality but not one millisecond beyond', () => {
  const prior = finding(B, { lastSeen: at(-5 * MINUTE), activityWindowEndsAt: at(5 * MINUTE) });
  for (const extra of [0, 1]) {
    const current = finding(B, { id: opaque('contribution', `adjacent-${extra}`), firstSeen: at(5 * MINUTE + extra), lastSeen: at(6 * MINUTE), evaluatedAt: at(6 * MINUTE), activityWindowEndsAt: at(16 * MINUTE) });
    const result = reconcileAssessmentHistory(assessment([subject([current])], clock(6 * MINUTE)), [subject([prior])], clock(6 * MINUTE));
    assert.equal(result.subjects[0]!.findings.length, extra === 0 ? 1 : 2);
  }
});
test('C remains HIGH and uses its own source freshness even when A/B are unavailable', () => {
  let data = assessment();
  data = sourceState(data, 'GRAPH_SIGN_INS', { status: 'FAILED', reasonCode: 'COLLECTION_FAILED', freshness: 'UNKNOWN' });
  data = sourceState(data, 'MAILBOX_RULES', { lastSuccessfulCollectionAt: at(-2 * 60 * MINUTE) });
  const output = reconcileAssessmentHistory(data, [subject([finding(A), finding(B)]), subject([finding(C)])], clock());
  const mailbox = output.subjects.find(row => row.subjectType === 'MAILBOX')!.findings[0]!;
  assert.equal(mailbox.priority, 'HIGH'); assert.equal(mailbox.activityState, 'CURRENT');
  assert.ok(output.subjects.find(row => row.subjectType === 'USER')!.findings.every(row => row.activityState === 'UNKNOWN' && row.priority !== 'HIGH'));
});
test('reference cap is honest and preserves bounded latest references', () => {
  const oldRefs = Array.from({ length: 30 }, (_, i) => evidence(`cap-${i}`, at(-MINUTE)));
  const newRefs = Array.from({ length: 30 }, (_, i) => evidence(`cap-${i + 25}`, i < 5 ? at(-MINUTE) : at()));
  const prior = finding(B, { evidenceReferences: oldRefs }); const fresh = finding(B, { evidenceReferences: newRefs });
  const result = only(reconcileAssessmentHistory(assessment([subject([fresh])]), [subject([prior])], clock()));
  assert.equal(result.evidenceReferences.length, ASSESSMENT_MAX_REFERENCES); assert.equal(result.evidenceCount, 55); assert.equal(result.evidenceCountCapped, true);
});
test('subject and finding caps fail explicitly without silent truncation', () => {
  const manySubjects = Array.from({ length: ASSESSMENT_MAX_SUBJECTS + 1 }, (_, i) => subject([finding(B, { id: opaque('contribution', `subject-${i}`) })], `subject-${i}`));
  assert.equal(reconcileAssessmentHistory(assessment(), manySubjects.slice(0, ASSESSMENT_MAX_SUBJECTS), clock()).subjects.length, ASSESSMENT_MAX_SUBJECTS);
  assert.throws(() => reconcileAssessmentHistory(assessment(), manySubjects, clock()), /IDENTITY_RISK_ASSESSMENT_CAPACITY/);
  const manyFindings = Array.from({ length: ASSESSMENT_MAX_FINDINGS + 1 }, (_, i) => finding(B, { id: opaque('contribution', `finding-${i}`), application: { id: opaque('application', `app-${i}`), state: 'RESOLVED', label: null } }));
  assert.equal(reconcileAssessmentHistory(assessment(), [subject(manyFindings.slice(0, ASSESSMENT_MAX_FINDINGS))], clock()).subjects[0]!.findings.length, ASSESSMENT_MAX_FINDINGS);
  assert.throws(() => reconcileAssessmentHistory(assessment(), [subject(manyFindings)], clock()), /IDENTITY_RISK_ASSESSMENT_CAPACITY/);
});
test('future evaluation clocks are rejected by the persisted-history boundary before reconciliation', () => {
  const data = assessment([subject([finding(B, { evaluatedAt: at(MINUTE) })])]);
  assert.equal(projectStoredRiskAssessment(data, clock(), 'PERSISTED_HISTORY'), null);
});
test('expired CURRENT rows require history-mode validation followed by explicit aging', () => {
  const now = clock(11 * MINUTE); const old = finding(); const data = assessment([subject([old])], now);
  assert.equal(projectStoredRiskAssessment(data, now), null);
  const shape = projectStoredRiskAssessment(data, now, 'PERSISTED_HISTORY'); assert.notEqual(shape, null);
  const aged = reconcileAssessmentHistory(assessment([], now), shape!.subjects, now);
  assert.equal(only(aged).activityState, 'HISTORICAL'); assert.notEqual(projectStoredRiskAssessment(aged, now), null);
});
