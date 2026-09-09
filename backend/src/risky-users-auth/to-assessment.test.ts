import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ASSESSMENT_COPY, assessmentReason, projectStoredRiskAssessment } from '../identity-risk/risk-assessment-projection.js';
import { RISK_ASSESSMENT_SCHEMA } from '../identity-risk/identity-risk-assessment.contract.js';
import { AUTH_RULE_A, AUTH_RULE_B } from './contract.js';
import type { AuthNormalizedEvent } from './contract.js';
import { evaluateAuthenticationRules } from './evaluate.js';
import { projectAuthenticationAssessment } from './to-assessment.js';
import { at, evaluation, event, failures, success } from './fixtures.js';

const opaque = (kind: string, value: string): string => `hvr1_${kind}_${createHash('sha256').update(value).digest('hex')}`;
const managed = async (kind: string, identifiers: readonly string[]): Promise<string> => opaque(kind, JSON.stringify(identifiers));
const scoped = (rows: readonly AuthNormalizedEvent[], subject = 'subject', app = 'app'): AuthNormalizedEvent[] => rows.map(row => ({ ...row, subjectRef: opaque('subject', subject), applicationRef: opaque('application', app) }));
const project = async (rows: readonly AuthNormalizedEvent[]) => { const input = evaluation(rows); return projectAuthenticationAssessment(input, evaluateAuthenticationRules(input), managed); };

test('projects fixed tuples and only opaque evidence/context; code-owned copy and no labels', async () => {
  const rows = scoped([...failures(10), success()]);
  const output = await project(rows);
  assert.equal(output.subjects.length, 1); assert.equal(output.subjects[0]!.findings.length, 2);
  for (const finding of output.subjects[0]!.findings) {
    assert.equal(finding.confidence, 'MEDIUM'); assert.equal(finding.application.label, null); assert.equal(finding.application.state, 'RESOLVED');
    assert.deepEqual(finding.device, { state: 'NOT_REPORTED', label: null });
    assert.equal(finding.explanation, ASSESSMENT_COPY[finding.ruleId].explanation);
    assert.match(finding.id, /^hvr1_contribution_[a-f0-9]{64}$/);
    assert.ok(finding.evidenceReferences.every(ref => /^hvr1_evidence_[a-f0-9]{64}$/.test(ref.id)));
    assert.equal(finding.priority, finding.ruleId === AUTH_RULE_A ? 'LOW' : 'MEDIUM');
  }
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes('192.0.2.10')); assert.ok(!serialized.includes('failure-0'));
  assert.ok(output.rules.every(rule => rule.status === 'READY' && rule.assessedIdentities === 1 && rule.matchedIdentities === 1));
});
test('B missing address remains independently insufficient while A is ready', async () => {
  const rows = scoped(failures(10).map(row => ({ ...row, clientSource: { qualification: 'MISSING', address: null } })));
  const output = await project(rows);
  assert.equal(output.rules[0]!.status, 'READY'); assert.equal(output.rules[0]!.assessedIdentities, 1);
  assert.equal(output.rules[1]!.status, 'INSUFFICIENT_FIELDS'); assert.equal(output.rules[1]!.reasonCode, 'CLIENT_SOURCE_UNQUALIFIED');
  assert.equal(output.rules[1]!.assessedIdentities, null); assert.equal(output.rules[1]!.matchedIdentities, null);
});
test('late findings retain historical event clocks, not fresh evaluation activity', async () => {
  const output = await project(scoped([...failures(10, -70), success(-60)]));
  assert.ok(output.subjects[0]!.findings.every(finding => finding.activityState === 'HISTORICAL' && finding.lastSeen <= at(-60)));
});
test('exact expiry uses original incident clock', async () => {
  const rows = scoped([...failures(5, -15), success(-10)]);
  const output = await project(rows);
  assert.equal(output.subjects[0]!.findings[0]!.activityState, 'CURRENT');
  const input = evaluation(rows, { asOf: new Date(Date.parse(at(0)) + 1).toISOString() });
  const later = await projectAuthenticationAssessment(input, evaluateAuthenticationRules(input), managed);
  assert.equal(later.subjects[0]!.findings[0]!.activityState, 'HISTORICAL');
});
test('witness references cap at fifty with honest counts and incomplete readiness', async () => {
  const rows = scoped(Array.from({ length: 60 }, (_, index) => event(`large-${index}`, -1)));
  const output = await project(rows); const finding = output.subjects[0]!.findings[0]!;
  assert.equal(finding.evidenceReferences.length, 50); assert.equal(finding.evidenceCount, 60); assert.equal(finding.evidenceCountCapped, true);
  assert.ok(output.rules.every(rule => rule.reasonCode === 'CAPACITY_LIMIT' && rule.countsCapped && rule.assessedIdentities === null));
});
test('subject output is capped at one hundred', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => scoped(failures(10).map(row => ({ ...row, eventId: `${i}-${row.eventId}` })), `subject-${i}`)).flat();
  const output = await project(rows);
  assert.equal(output.subjects.length, 100); assert.ok(output.rules.every(rule => rule.reasonCode === 'CAPACITY_LIMIT' && rule.matchedIdentities === null));
});
test('total finding output is capped at two hundred', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => scoped([...failures(10), success()].map(row => ({ ...row, eventId: `${i}-${row.eventId}` })), 'one-subject', `app-${i}`)).flat();
  const output = await project(rows);
  assert.equal(output.subjects[0]!.findings.length, 200); assert.ok(output.rules.every(rule => rule.reasonCode === 'CAPACITY_LIMIT'));
});
test('admitted evidence capture cannot be poisoned by future or unauthorized duplicate versions', async () => {
  const rows = scoped(failures(10));
  const future = { ...rows[0]!, ingestedAt: at(1), eventAt: at(-2) };
  const unauthorized = { ...rows[0]!, eventAt: at(-1500) };
  const output = await project([...rows, future, unauthorized]);
  const ref = output.subjects[0]!.findings[0]!.evidenceReferences.find(item => item.id === opaque('evidence', JSON.stringify([
    rows[0]!.organizationId, rows[0]!.customerTenantId, rows[0]!.microsoftTenantId, rows[0]!.source, rows[0]!.eventId,
  ])))!;
  assert.equal(ref.recordedAt, at(-10)); assert.equal(ref.ingestedAt, at(0));
});
test('forged result metadata and raw subject/application references fail closed', async () => {
  const input = evaluation(scoped(failures(10))); const result = evaluateAuthenticationRules(input);
  await assert.rejects(projectAuthenticationAssessment(input, { ...result, findings: result.findings.map(finding => ({ ...finding, firstSeen: at(-100) })) }, managed), /ASSESSMENT_RESULT_MISMATCH/);
  await assert.rejects(project(failures(10)), /MANAGED_SUBJECT_OR_APPLICATION_REQUIRED/);
});
test('managed reference callbacks must return correct kinds and cannot collide', async () => {
  const input = evaluation(scoped(failures(10))); const result = evaluateAuthenticationRules(input);
  await assert.rejects(projectAuthenticationAssessment(input, result, async () => 'raw-provider-id'), /INVALID_MANAGED_REFERENCE/);
  await assert.rejects(projectAuthenticationAssessment(input, result, async kind => opaque(kind, 'constant')), /MANAGED_REFERENCE_COLLISION/);
});
test('provider caveats do not become rendered copy', async () => {
  const input = evaluation(scoped(failures(10))); const result = evaluateAuthenticationRules(input);
  const changed = { ...result, findings: result.findings.map(finding => ({ ...finding, caveats: ['provider-secret@example.invalid'] })) };
  const output = await projectAuthenticationAssessment(input, changed, managed);
  assert.ok(!JSON.stringify(output).includes('provider-secret')); assert.deepEqual(output.subjects[0]!.findings[0]!.caveats, ASSESSMENT_COPY[AUTH_RULE_A].caveats);
});
test('MFA event fact is independent of current policy and failed MFA is not a policy-block claim', async () => {
  for (const fact of ['SATISFIED', 'NOT_SATISFIED'] as const) {
    const rows = scoped([...failures(5, -5), { ...success(), eventMfa: { fact, evidenceRef: 'private-event-detail' } }]);
    const output = await project(rows); const finding = output.subjects[0]!.findings.find(item => item.ruleId === AUTH_RULE_B)!;
    assert.equal(finding.eventProtection, fact === 'SATISFIED' ? 'MFA_SATISFIED' : 'NOT_REPORTED');
    assert.ok(!JSON.stringify(output).includes('private-event-detail'));
  }
});
test('helper output is accepted by the canonical stored-assessment validator', async () => {
  const output = await project(scoped([...failures(10), success()]));
  const sources = (['GRAPH_SIGN_INS', 'M365_AUDIT_STS', 'MAILBOX_RULES'] as const).map(source => ({
    source, status: source === 'GRAPH_SIGN_INS' ? 'READY' : 'WAITING', reasonCode: source === 'GRAPH_SIGN_INS' ? 'READY' : 'SOURCE_UNAVAILABLE',
    explanation: assessmentReason(source === 'GRAPH_SIGN_INS' ? 'READY' : 'SOURCE_UNAVAILABLE'),
    window: source === 'GRAPH_SIGN_INS' ? { start: at(-1440), end: at(0) } : { start: null, end: null },
    lastSuccessfulCollectionAt: source === 'GRAPH_SIGN_INS' ? at(0) : null, latestEventAt: source === 'GRAPH_SIGN_INS' ? at(0) : null,
    latestIngestionAt: source === 'GRAPH_SIGN_INS' ? at(0) : null, freshness: source === 'GRAPH_SIGN_INS' ? 'CURRENT' : 'UNKNOWN',
  }));
  const mailboxRule = { ruleId: 'HV-ID-MBX-001.v1', ruleVersion: 'v1', title: ASSESSMENT_COPY['HV-ID-MBX-001.v1'].title,
    status: 'WAITING', reasonCode: 'SOURCE_UNAVAILABLE', explanation: assessmentReason('SOURCE_UNAVAILABLE'), selectedSource: 'MAILBOX_RULES',
    window: { start: null, end: null }, evaluatedAt: null, assessedIdentities: null, matchedIdentities: null, countsCapped: false };
  assert.notEqual(projectStoredRiskAssessment({ schemaVersion: RISK_ASSESSMENT_SCHEMA, sources, rules: [...output.rules, mailboxRule], subjects: output.subjects }, new Date(at(0))), null);
});
