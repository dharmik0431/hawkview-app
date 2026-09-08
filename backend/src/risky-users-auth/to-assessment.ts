import {
  ASSESSMENT_COPY, ASSESSMENT_MAX_FINDINGS, ASSESSMENT_MAX_REFERENCES, ASSESSMENT_MAX_SUBJECTS,
  assessmentActions, assessmentReason, type StoredRiskAssessment,
} from '../identity-risk/risk-assessment-projection.js';
import { RISK_ASSESSMENT_RULE_TUPLES, type RiskAssessmentFindingDto, type RiskAssessmentReadiness, type RiskAssessmentReason, type RiskRuleReadinessDto } from '../identity-risk/identity-risk-assessment.contract.js';
import { AUTH_RULE_A, AUTH_RULE_B, MAX_AUTH_EVENTS, MAX_AUTH_INCIDENTS, MAX_INCIDENT_INPUT_EVIDENCE } from './contract.js';
import type { AuthEvaluationInput, AuthEvaluationResult, AuthFinding, AuthNormalizedEvent, AuthRuleId } from './contract.js';
import { digest, evaluateAuthenticationRules, ordinal } from './evaluate.js';
import { mergeAuthenticationIncidents } from './incidents.js';
import { utcTime } from './normalize.js';

type ReferenceKind = 'contribution' | 'evidence' | 'context';
type AssessmentPart = { subjects: StoredRiskAssessment['subjects']; rules: readonly RiskRuleReadinessDto[] };
const opaque = (value: unknown, kind: string): value is string => typeof value === 'string' && new RegExp(`^hvr1_${kind}_[a-f0-9]{64}$`).test(value);
const fingerprint = (finding: AuthFinding): string => digest([
  finding.organizationId, finding.customerTenantId, finding.microsoftTenantId, finding.source, finding.findingId,
  finding.ruleId, finding.subjectRef, finding.applicationRef, finding.clientAddress, finding.priority, finding.confidence,
  finding.firstSeen, finding.lastSeen, finding.evaluatedAt, finding.expiresAt, finding.evidenceEventIds,
  finding.evidenceCount, finding.eventMfa.fact, finding.eventMfa.evidenceRef,
]);

function readiness(reasons: readonly string[], ruleId: AuthRuleId, capacity: boolean): { status: RiskAssessmentReadiness; reasonCode: RiskAssessmentReason } {
  const has = (...codes: string[]): boolean => codes.some(code => reasons.includes(code));
  if (capacity || has('INPUT_CAP_EXCEEDED', 'SOURCE_CAPPED', 'LOOKBACK_CAPPED')) return { status: 'PARTIAL', reasonCode: 'CAPACITY_LIMIT' };
  if (ruleId === AUTH_RULE_B && has('INSUFFICIENT_FIELDS')) return { status: 'INSUFFICIENT_FIELDS', reasonCode: 'CLIENT_SOURCE_UNQUALIFIED' };
  if (has('CONFLICTING_DUPLICATES')) return { status: 'PARTIAL', reasonCode: 'CONFLICTING_EVIDENCE' };
  if (has('SOURCE_STALE')) return { status: 'STALE', reasonCode: 'COLLECTION_STALE' };
  if (has('SOURCE_UNAVAILABLE')) return { status: 'WAITING', reasonCode: 'SOURCE_UNAVAILABLE' };
  if (has('INVALID_EVALUATION_CONTEXT', 'INVALID_READINESS')) return { status: 'FAILED', reasonCode: 'EVALUATION_FAILED' };
  return reasons.length ? { status: 'PARTIAL', reasonCode: 'INCOMPLETE_WINDOW' } : { status: 'READY', reasonCode: 'READY' };
}

/** Pure projection only. The caller supplies managed references and performs persistence separately. */
export async function projectAuthenticationAssessment(
  input: AuthEvaluationInput,
  result: AuthEvaluationResult,
  reference: (kind: ReferenceKind, identifiers: readonly string[]) => Promise<string>,
): Promise<AssessmentPart> {
  const now = utcTime(input.asOf);
  const authorized = utcTime(input.authorizedFrom);
  if (now === null || authorized === null || authorized > now || result.evaluatedAt !== input.asOf) throw new TypeError('INVALID_ASSESSMENT_CONTEXT');
  if (!Array.isArray(result.findings) || result.findings.length > MAX_AUTH_INCIDENTS) throw new RangeError('ASSESSMENT_INPUT_CAP_EXCEEDED');
  let evidenceBudget = 0;
  for (const finding of result.findings) {
    if (!finding || !Array.isArray(finding.evidenceEventIds) || finding.evidenceEventIds.length > MAX_AUTH_EVENTS) throw new TypeError('INVALID_ASSESSMENT_EVIDENCE');
    evidenceBudget += finding.evidenceEventIds.length;
    if (evidenceBudget > MAX_INCIDENT_INPUT_EVIDENCE) throw new RangeError('ASSESSMENT_INPUT_CAP_EXCEEDED');
  }
  // Establish result provenance before projecting any supplied fields or generating references.
  const canonical = evaluateAuthenticationRules(input);
  const canonicalById = new Map(canonical.findings.map(finding => [finding.findingId, finding]));
  if (canonical.findings.length !== result.findings.length || new Set(result.findings.map((finding: AuthFinding) => finding.findingId)).size !== result.findings.length) throw new TypeError('ASSESSMENT_RESULT_MISMATCH');
  for (const finding of result.findings) {
    const expected = canonicalById.get(finding.findingId);
    if (!expected || fingerprint(expected) !== fingerprint(finding)) throw new TypeError('ASSESSMENT_RESULT_MISMATCH');
  }
  const incidents = [...mergeAuthenticationIncidents([], canonical.findings, {
    organizationId: input.organizationId, customerTenantId: input.customerTenantId, microsoftTenantId: input.microsoftTenantId,
    source: input.source, asOf: input.asOf, conflictingEventIds: canonical.conflictingEventIds,
  })].sort((a, b) => Number(b.activity === 'ACTIVE') - Number(a.activity === 'ACTIVE')
    || Number(b.priority === 'MEDIUM') - Number(a.priority === 'MEDIUM')
    || ordinal(b.lastSeen, a.lastSeen) || ordinal(a.incidentId, b.incidentId));

  const selected = [] as typeof incidents[number][];
  const selectedSubjects = new Set<string>();
  let capacity = false;
  for (const incident of incidents) {
    if (!opaque(incident.subjectRef, 'subject') || !opaque(incident.applicationRef, 'application')) throw new TypeError('MANAGED_SUBJECT_OR_APPLICATION_REQUIRED');
    if (selected.length >= ASSESSMENT_MAX_FINDINGS || (!selectedSubjects.has(incident.subjectRef) && selectedSubjects.size >= ASSESSMENT_MAX_SUBJECTS)) { capacity = true; continue; }
    selected.push(incident); selectedSubjects.add(incident.subjectRef);
    if (incident.evidenceEventIds.length > ASSESSMENT_MAX_REFERENCES || incident.caveats.includes('EVIDENCE_CAP_REACHED')) capacity = true;
  }
  const needed = new Set(selected.flatMap(incident => incident.evidenceEventIds.slice(0, ASSESSMENT_MAX_REFERENCES)));
  const captured = new Map<string, AuthNormalizedEvent>();
  const assessed = { [AUTH_RULE_A]: new Set<string>(), [AUTH_RULE_B]: new Set<string>() };
  const disputed = new Set(canonical.conflictingEventIds);
  if (input.events.length <= MAX_AUTH_EVENTS) for (const event of input.events) {
    // Use the engine's exact admission gate, not an unfiltered ID-to-last-record map.
    // This is bounded by MAX_AUTH_EVENTS and does not query or retain additional history.
    if (!event || disputed.has(event.eventId) || evaluateAuthenticationRules({ ...input, events: [event] }).admittedEventCount !== 1) continue;
    if (!opaque(event.subjectRef, 'subject') || !opaque(event.applicationRef, 'application')) throw new TypeError('MANAGED_SUBJECT_OR_APPLICATION_REQUIRED');
    assessed[AUTH_RULE_A].add(event.subjectRef);
    if (event.clientSource.qualification === 'QUALIFIED') assessed[AUTH_RULE_B].add(event.subjectRef);
    if (!needed.has(event.eventId)) continue;
    const prior = captured.get(event.eventId);
    if (!prior || Date.parse(event.ingestedAt) < Date.parse(prior.ingestedAt)) captured.set(event.eventId, event);
  }
  if ([...needed].some(id => !captured.has(id))) throw new TypeError('ASSESSMENT_EVIDENCE_NOT_ADMITTED');

  const referenceCache = new Map<string, string>();
  const referenceOwners = new Map<string, string>();
  const managed = async (kind: ReferenceKind, identifiers: readonly string[]): Promise<string> => {
    const scoped = [input.organizationId, input.customerTenantId, input.microsoftTenantId, input.source, ...identifiers];
    const key = JSON.stringify([kind, scoped]);
    const cached = referenceCache.get(key);
    if (cached) return cached;
    const value = await reference(kind, scoped);
    if (!opaque(value, kind)) throw new TypeError('INVALID_MANAGED_REFERENCE');
    if (referenceOwners.has(value) && referenceOwners.get(value) !== key) throw new TypeError('MANAGED_REFERENCE_COLLISION');
    referenceOwners.set(value, key); referenceCache.set(key, value);
    return value;
  };
  const subjects = new Map<string, { id: string; subjectType: 'USER'; findings: RiskAssessmentFindingDto[] }>();
  for (const incident of selected) {
    const tuple = RISK_ASSESSMENT_RULE_TUPLES[incident.ruleId];
    const refs: RiskAssessmentFindingDto['evidenceReferences'][number][] = [];
    for (const id of incident.evidenceEventIds.slice(0, ASSESSMENT_MAX_REFERENCES)) {
      const event = captured.get(id)!;
      refs.push({ id: await managed('evidence', [event.eventId]), recordedAt: new Date(Date.parse(event.eventAt)).toISOString(), ingestedAt: new Date(Date.parse(event.ingestedAt)).toISOString() });
    }
    const clientReference = incident.clientAddress === null ? null : await managed('context', ['client-address', incident.clientAddress]);
    const finding: RiskAssessmentFindingDto = {
      id: await managed('contribution', [incident.ruleId, incident.subjectRef, incident.applicationRef, incident.incidentId]),
      ruleId: incident.ruleId, ruleVersion: tuple.version, priority: tuple.priority, confidence: 'MEDIUM',
      activityState: incident.activity === 'UNKNOWN' ? 'UNKNOWN' : Date.parse(incident.expiresAt) < now ? 'HISTORICAL' : 'CURRENT',
      title: ASSESSMENT_COPY[incident.ruleId].title, explanation: ASSESSMENT_COPY[incident.ruleId].explanation,
      firstSeen: incident.firstSeen, lastSeen: incident.lastSeen, evaluatedAt: new Date(now).toISOString(),
      window: { start: incident.firstSeen, end: incident.lastSeen }, evidenceCount: incident.evidenceCount,
      evidenceCountCapped: incident.evidenceCount > refs.length || incident.caveats.includes('EVIDENCE_CAP_REACHED'), selectedSource: input.source,
      application: { id: incident.applicationRef, state: 'RESOLVED', label: null }, device: { state: 'NOT_REPORTED', label: null },
      clientSource: { reference: clientReference, qualification: clientReference ? 'QUALIFIED' : 'NOT_REPORTED' }, evidenceReferences: refs,
      eventProtection: incident.activity !== 'UNKNOWN' && incident.ruleId === AUTH_RULE_B && incident.eventMfa.fact === 'SATISFIED' ? 'MFA_SATISFIED' : 'NOT_REPORTED',
      caveats: [...ASSESSMENT_COPY[incident.ruleId].caveats], recommendedActions: assessmentActions(incident.ruleId),
    };
    const subject = subjects.get(incident.subjectRef) ?? { id: incident.subjectRef, subjectType: 'USER' as const, findings: [] as RiskAssessmentFindingDto[] };
    subject.findings.push(finding); subjects.set(incident.subjectRef, subject);
  }
  const window = { start: new Date(Math.max(authorized, now - 24 * 60 * 60000)).toISOString(), end: new Date(now).toISOString() };
  const rules = ([AUTH_RULE_A, AUTH_RULE_B] as const).map(ruleId => {
    const evaluation = canonical.rules.find(rule => rule.ruleId === ruleId)!;
    const state = readiness(evaluation.reasonCodes, ruleId, capacity);
    const complete = state.status === 'READY' && evaluation.status !== 'NOT_EVALUATED';
    const matched = new Set(incidents.filter(incident => incident.ruleId === ruleId).map(incident => incident.subjectRef));
    return {
      ruleId, ruleVersion: RISK_ASSESSMENT_RULE_TUPLES[ruleId].version, title: ASSESSMENT_COPY[ruleId].title,
      ...state, explanation: assessmentReason(state.reasonCode), selectedSource: input.source, window, evaluatedAt: new Date(now).toISOString(),
      assessedIdentities: complete ? assessed[ruleId].size : null, matchedIdentities: complete ? matched.size : null,
      countsCapped: capacity || state.reasonCode === 'CAPACITY_LIMIT',
    } satisfies RiskRuleReadinessDto;
  });
  return { subjects: [...subjects.values()].sort((a, b) => ordinal(a.id, b.id)), rules };
}
