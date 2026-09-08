import { AUTH_RULE_A, AUTH_RULE_B, MAX_AUTH_EVENTS, MAX_AUTH_INCIDENTS, MAX_INCIDENT_INPUT_EVIDENCE } from './contract.js';
import type { AuthFinding, AuthIncident, AuthIncidentContext } from './contract.js';
import { digest, findingKey, ordinal, sameScope } from './evaluate.js';
import { objectValue, textValue, utcTime } from './normalize.js';

/** Derived-risk retention remains the caller's existing 90-day policy. This function deletes nothing. */
export function mergeAuthenticationIncidents(prior: readonly AuthIncident[], current: readonly AuthFinding[], context: AuthIncidentContext): readonly AuthIncident[] {
  const now = utcTime(context.asOf);
  if (now === null || ![context.organizationId, context.customerTenantId, context.microsoftTenantId].every(textValue)
    || !['GRAPH_SIGN_INS', 'M365_AUDIT_STS'].includes(context.source)) throw new TypeError('INVALID_INCIDENT_CONTEXT');
  if (!Array.isArray(prior) || !Array.isArray(current) || prior.length + current.length > MAX_AUTH_INCIDENTS) throw new RangeError('INCIDENT_INPUT_CAP_EXCEEDED');
  if (context.conflictingEventIds !== undefined && (!Array.isArray(context.conflictingEventIds) || context.conflictingEventIds.length > MAX_AUTH_EVENTS || !context.conflictingEventIds.every(textValue))) throw new TypeError('INVALID_CONFLICT_CONTEXT');
  const conflicts = new Set(context.conflictingEventIds ?? []);
  const inScope = (finding: AuthFinding): boolean => sameScope(finding, context) && finding.source === context.source;
  // Check every bound before allocating copies, evidence unions, or candidate arrays.
  let inputEvidence = 0;
  for (const collection of [prior, current]) for (const finding of collection) {
    if (!objectValue(finding) || !Array.isArray(finding.evidenceEventIds) || finding.evidenceEventIds.length > MAX_AUTH_EVENTS) throw new TypeError('INVALID_INCIDENT_EVIDENCE');
    inputEvidence += finding.evidenceEventIds.length;
    if ('quarantinedEventIds' in finding && finding.quarantinedEventIds !== undefined) {
      if (!Array.isArray(finding.quarantinedEventIds) || finding.quarantinedEventIds.length > MAX_AUTH_EVENTS) throw new TypeError('INVALID_INCIDENT_EVIDENCE');
      inputEvidence += finding.quarantinedEventIds.length;
    }
    if (inputEvidence > MAX_INCIDENT_INPUT_EVIDENCE) throw new RangeError('INCIDENT_EVIDENCE_INPUT_CAP_EXCEEDED');
  }
  for (const collection of [prior, current]) for (const finding of collection) {
    if (!inScope(finding)) throw new TypeError('INCIDENT_SCOPE_MISMATCH');
    if (![finding.findingId, finding.subjectRef, finding.applicationRef].every(textValue)
      || !finding.evidenceEventIds.every(textValue) || new Set(finding.evidenceEventIds).size !== finding.evidenceEventIds.length
      || finding.evidenceCount !== finding.evidenceEventIds.length || finding.confidence !== 'SUPPORTED_PATTERN'
      || !(finding.ruleId === AUTH_RULE_A && finding.priority === 'LOW' || finding.ruleId === AUTH_RULE_B && finding.priority === 'MEDIUM')
      || !Array.isArray(finding.caveats) || finding.caveats.length > 32 || !finding.caveats.every(textValue)) throw new TypeError('INVALID_INCIDENT_FACTS');
    const first = utcTime(finding.firstSeen), last = utcTime(finding.lastSeen), expiry = utcTime(finding.expiresAt), evaluated = utcTime(finding.evaluatedAt);
    if (first === null || last === null || expiry === null || evaluated === null || first > last || last > now || evaluated > now || expiry < last) throw new TypeError('INCIDENT_REPLAY_BOUNDARY');
  }
  for (const incident of prior) {
    if (!textValue(incident.incidentId) || utcTime(incident.lastEvaluatedAt) === null || Date.parse(incident.lastEvaluatedAt) > now) throw new TypeError('INCIDENT_REPLAY_BOUNDARY');
    if (!['ACTIVE', 'HISTORICAL', 'UNKNOWN'].includes(incident.activity) || !(incident.quarantinedEventIds ?? []).every(textValue)) throw new TypeError('INVALID_INCIDENT_FACTS');
  }
  const incidents: AuthIncident[] = prior.map(incident => {
    const quarantined = new Set([...(incident.quarantinedEventIds ?? []), ...incident.evidenceEventIds.filter((id: string) => conflicts.has(id))]);
    const newlyAffected = incident.evidenceEventIds.some((id: string) => quarantined.has(id));
    const evidence = incident.evidenceEventIds.filter((id: string) => !quarantined.has(id));
    return { ...incident,
      activity: Date.parse(incident.expiresAt) < now ? 'HISTORICAL' : incident.activity === 'UNKNOWN' || newlyAffected ? 'UNKNOWN' : 'ACTIVE',
      quarantinedEventIds: [...quarantined].sort(ordinal).slice(0, MAX_AUTH_EVENTS), evidenceEventIds: evidence, evidenceCount: evidence.length,
      caveats: [...new Set([...incident.caveats, ...(quarantined.size ? ['CONFLICTING_DUPLICATES'] : []), ...(quarantined.size > MAX_AUTH_EVENTS ? ['EVIDENCE_CAP_REACHED'] : [])])].sort(ordinal),
      lastEvaluatedAt: context.asOf,
    };
  });
  for (const finding of [...current].sort((a, b) => ordinal(a.firstSeen, b.firstSeen) || ordinal(a.findingId, b.findingId))) {
    const key = findingKey(finding);
    const candidates = incidents.filter(incident => findingKey(incident) === key
      && Date.parse(finding.firstSeen) <= Date.parse(incident.expiresAt)
      && Date.parse(incident.firstSeen) <= Date.parse(finding.expiresAt));
    const retained = candidates.sort((a, b) => ordinal(a.firstSeen, b.firstSeen) || ordinal(a.incidentId, b.incidentId))[0];
    const supportedCandidates = candidates.filter(incident => incident.activity === 'ACTIVE');
    const quarantined = new Set([...candidates.flatMap(incident => incident.quarantinedEventIds ?? []), ...finding.evidenceEventIds.filter((id: string) => conflicts.has(id))]);
    const witnessInvalid = finding.evidenceEventIds.some((id: string) => quarantined.has(id));
    const evidence = [...new Set([...supportedCandidates.flatMap(incident => incident.evidenceEventIds), ...finding.evidenceEventIds])].filter(id => !quarantined.has(id)).sort(ordinal);
    const firstSeen = [finding.firstSeen, ...supportedCandidates.map(incident => incident.firstSeen)].sort(ordinal)[0]!;
    const lastSeen = [finding.lastSeen, ...supportedCandidates.map(incident => incident.lastSeen)].sort(ordinal).at(-1)!;
    const expiresAt = [finding.expiresAt, ...supportedCandidates.map(incident => incident.expiresAt)].sort(ordinal).at(-1)!;
    const caveats = [...new Set([...finding.caveats, ...candidates.flatMap(incident => incident.caveats), ...(quarantined.size ? ['CONFLICTING_DUPLICATES'] : []), ...(evidence.length > MAX_AUTH_EVENTS || quarantined.size > MAX_AUTH_EVENTS ? ['EVIDENCE_CAP_REACHED'] : [])])].sort(ordinal);
    const newest = [...supportedCandidates, finding].sort((a, b) => ordinal(a.lastSeen, b.lastSeen) || ordinal(a.evaluatedAt, b.evaluatedAt)).at(-1)!;
    const combined: AuthIncident = {
      ...finding, findingId: retained?.findingId ?? finding.findingId,
      incidentId: retained?.incidentId ?? `incident-${digest([key, finding.findingId])}`,
      firstSeen, lastSeen, expiresAt, evaluatedAt: context.asOf, lastEvaluatedAt: context.asOf,
      activity: Date.parse(expiresAt) < now ? 'HISTORICAL' : witnessInvalid ? 'UNKNOWN' : 'ACTIVE',
      quarantinedEventIds: [...quarantined].sort(ordinal).slice(0, MAX_AUTH_EVENTS),
      evidenceEventIds: evidence.slice(0, MAX_AUTH_EVENTS), evidenceCount: Math.min(evidence.length, MAX_AUTH_EVENTS),
      eventMfa: newest.eventMfa, caveats,
    };
    for (const candidate of candidates) incidents.splice(incidents.indexOf(candidate), 1);
    incidents.push(combined);
  }
  return incidents.sort((a, b) => ordinal(a.incidentId, b.incidentId));
}

/** Per-user priorities are a maximum, never a sum. A+B cannot produce HIGH. */
export function highestAuthenticationPriority(findings: readonly AuthFinding[], context: AuthIncidentContext & { subjectRef: string }): 'LOW' | 'MEDIUM' | null {
  const now = utcTime(context.asOf);
  if (now === null) return null;
  const active = findings.filter(finding => sameScope(finding, context) && finding.source === context.source && finding.subjectRef === context.subjectRef
    && (!('activity' in finding) || finding.activity === 'ACTIVE')
    && utcTime(finding.lastSeen) !== null && Date.parse(finding.lastSeen) <= now && utcTime(finding.expiresAt) !== null && Date.parse(finding.expiresAt) >= now);
  return active.some(finding => finding.ruleId === AUTH_RULE_B && finding.priority === 'MEDIUM') ? 'MEDIUM'
    : active.some(finding => finding.ruleId === AUTH_RULE_A && finding.priority === 'LOW') ? 'LOW' : null;
}
