import { createHash } from 'node:crypto';
import { AUTH_RULE_A, AUTH_RULE_B, MAX_AUTH_EVENTS } from './contract.js';
import type { AuthEvaluationInput, AuthEvaluationResult, AuthFinding, AuthNormalizedEvent, AuthRuleId, AuthScope } from './contract.js';
import { canonicalAddress, objectValue, textValue, utcTime } from './normalize.js';

const MINUTE = 60000;
export const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sameScope = (a: AuthScope, b: AuthScope): boolean => a.organizationId === b.organizationId && a.customerTenantId === b.customerTenantId && a.microsoftTenantId === b.microsoftTenantId;
export const findingKey = (finding: AuthFinding): string => JSON.stringify([finding.organizationId, finding.customerTenantId, finding.microsoftTenantId, finding.source, finding.ruleId, finding.subjectRef, finding.applicationRef, finding.clientAddress]);
const eventOrder = (a: AuthNormalizedEvent, b: AuthNormalizedEvent): number => Date.parse(a.eventAt) - Date.parse(b.eventAt) || ordinal(a.eventId, b.eventId);
function validEvent(event: unknown): event is AuthNormalizedEvent {
  if (!objectValue(event) || ![event.eventId, event.subjectRef, event.applicationRef, event.organizationId, event.customerTenantId, event.microsoftTenantId].every(textValue)
    || utcTime(event.eventAt) === null || utcTime(event.ingestedAt) === null
    || !['GRAPH_SIGN_INS', 'M365_AUDIT_STS'].includes(event.source as string)
    || !(event.errorCode === null || (typeof event.errorCode === 'number' && Number.isSafeInteger(event.errorCode) && event.errorCode >= 0 && event.errorCode <= 999999999))
    || !['INVALID_CREDENTIAL', 'SUCCESS', 'NON_QUALIFYING', 'UNKNOWN'].includes(event.outcome as string)
    || !objectValue(event.clientSource) || !objectValue(event.eventMfa)) return false;
  if (!['QUALIFIED', 'MISSING', 'AMBIGUOUS', 'PROXY_ONLY'].includes(event.clientSource.qualification as string)) return false;
  if (event.clientSource.qualification === 'QUALIFIED' ? canonicalAddress(event.clientSource.address) !== event.clientSource.address || event.clientSource.address === null : event.clientSource.address !== null) return false;
  if (!['SATISFIED', 'NOT_SATISFIED', 'NOT_EVIDENCED'].includes(event.eventMfa.fact as string)) return false;
  if (event.eventMfa.fact === 'NOT_EVIDENCED' ? event.eventMfa.evidenceRef !== null : !textValue(event.eventMfa.evidenceRef)) return false;
  return (event.outcome !== 'INVALID_CREDENTIAL' || event.errorCode === 50126) && (event.outcome !== 'SUCCESS' || event.errorCode === 0);
}
function immutableFingerprint(event: AuthNormalizedEvent): string {
  // Ingestion time is not an immutable event fact; a legitimate replay can be ingested later.
  return digest([event.organizationId, event.customerTenantId, event.microsoftTenantId, event.source, event.eventId,
    Date.parse(event.eventAt), event.subjectRef, event.applicationRef, event.outcome, event.errorCode,
    event.clientSource.qualification, event.clientSource.address, event.eventMfa.fact, event.eventMfa.evidenceRef]);
}
function makeFinding(input: AuthEvaluationInput, ruleId: AuthRuleId, evidence: readonly AuthNormalizedEvent[], expiresAt: number, caveats: readonly string[]): AuthFinding {
  const sorted = [...evidence].sort(eventOrder);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const finding: AuthFinding = {
    organizationId: input.organizationId, customerTenantId: input.customerTenantId, microsoftTenantId: input.microsoftTenantId,
    findingId: '', ruleId, source: input.source, subjectRef: first.subjectRef, applicationRef: first.applicationRef,
    clientAddress: ruleId === AUTH_RULE_B ? last.clientSource.address : null,
    priority: ruleId === AUTH_RULE_A ? 'LOW' : 'MEDIUM', confidence: 'SUPPORTED_PATTERN',
    firstSeen: first.eventAt, lastSeen: last.eventAt, evaluatedAt: input.asOf, expiresAt: new Date(expiresAt).toISOString(),
    evidenceEventIds: sorted.map(event => event.eventId), evidenceCount: sorted.length,
    eventMfa: ruleId === AUTH_RULE_B ? last.eventMfa : { fact: 'NOT_EVIDENCED', evidenceRef: null },
    caveats: [...new Set(['PATTERN_NOT_COMPROMISE_PROOF', ...caveats])].sort(ordinal),
  };
  finding.findingId = `auth-${digest([findingKey(finding), first.eventId])}`;
  return finding;
}

export function evaluateAuthenticationRules(input: AuthEvaluationInput): AuthEvaluationResult {
  const result: AuthEvaluationResult = { evaluatedAt: input.asOf, rules: [], findings: [], admittedEventCount: 0, duplicateCount: 0, conflictingEventIds: [] };
  const blocked = (reason: string): AuthEvaluationResult => ({ ...result, rules: [AUTH_RULE_A, AUTH_RULE_B].map(ruleId => ({ ruleId, status: 'NOT_EVALUATED', reasonCodes: [reason] })) });
  const now = utcTime(input.asOf);
  const authorized = utcTime(input.authorizedFrom);
  if (now === null || authorized === null || authorized > now || ![input.organizationId, input.customerTenantId, input.microsoftTenantId].every(textValue)
    || !['GRAPH_SIGN_INS', 'M365_AUDIT_STS'].includes(input.source)) return blocked('INVALID_EVALUATION_CONTEXT');
  if (!Array.isArray(input.events) || input.events.length > MAX_AUTH_EVENTS) return blocked('INPUT_CAP_EXCEEDED');
  const reasons = new Set<string>();
  const lowerBound = Math.max(authorized, now - 24 * 60 * MINUTE);
  if (authorized < lowerBound) reasons.add('LOOKBACK_CAPPED');
  if (!input.readiness || !['READY', 'PARTIAL', 'UNAVAILABLE', 'STALE'].includes(input.readiness.state)) return blocked('INVALID_READINESS');
  if (input.readiness.state !== 'READY') reasons.add(`SOURCE_${input.readiness.state}`);
  if (input.readiness.paginationComplete !== true) reasons.add('PAGINATION_INCOMPLETE');
  if (!Number.isSafeInteger(input.readiness.gapCount) || input.readiness.gapCount < 0 || input.readiness.gapCount > 0) reasons.add('SOURCE_GAPS');
  if (input.readiness.capped !== false) reasons.add('SOURCE_CAPPED');
  // External reason strings are never copied into findings or rendered as code-owned reasons.
  if (input.readiness.reasonCodes !== undefined && (!Array.isArray(input.readiness.reasonCodes) || input.readiness.reasonCodes.length > 0)) reasons.add('SOURCE_REPORTED_GAP');
  const groups = new Map<string, { fingerprint: string; event: AuthNormalizedEvent; conflict: boolean }>();
  for (const event of input.events) {
    // Authorization and replay clocks are gated BEFORE duplicate/fingerprint admission.
    if (objectValue(event)) {
      const eventTime = utcTime(event.eventAt);
      const ingestionTime = utcTime(event.ingestedAt);
      if (eventTime !== null && eventTime < lowerBound) continue;
      if ((eventTime !== null && eventTime > now) || (ingestionTime !== null && ingestionTime > now)) { reasons.add('FUTURE_RECORD_EXCLUDED'); continue; }
      if (eventTime !== null && ingestionTime !== null && ingestionTime < eventTime) { reasons.add('INGESTION_PRECEDES_EVENT'); continue; }
    }
    if (!validEvent(event)) { reasons.add('MALFORMED_NORMALIZED_EVENT'); continue; }
    if (!sameScope(input, event) || event.source !== input.source) { reasons.add('SOURCE_SCOPE_MISMATCH'); continue; }
    const fingerprint = immutableFingerprint(event);
    const existing = groups.get(event.eventId);
    if (!existing) groups.set(event.eventId, { fingerprint, event, conflict: false });
    else {
      result.duplicateCount += 1;
      if (existing.fingerprint !== fingerprint) existing.conflict = true;
      else if (Date.parse(event.ingestedAt) < Date.parse(existing.event.ingestedAt)) existing.event = event;
    }
  }
  const conflicts = [...groups].filter(([, value]) => value.conflict).map(([id]) => id).sort(ordinal);
  if (conflicts.length) reasons.add('CONFLICTING_DUPLICATES');
  const events = [...groups.values()].filter(value => !value.conflict).map(value => value.event).sort(eventOrder);
  result.conflictingEventIds = conflicts;
  result.admittedEventCount = events.length;
  if (events.some(event => event.outcome === 'UNKNOWN')) reasons.add('UNKNOWN_OUTCOMES');
  const aReasons = new Set(reasons);
  const bReasons = new Set(reasons);
  if (authorized > now - 15 * MINUTE) aReasons.add('AUTHORIZED_WINDOW_INCOMPLETE');
  if (authorized > now - 20 * MINUTE) bReasons.add('AUTHORIZED_WINDOW_INCOMPLETE');
  if (events.some(event => (event.outcome === 'INVALID_CREDENTIAL' || event.outcome === 'SUCCESS') && event.clientSource.qualification !== 'QUALIFIED')) bReasons.add('INSUFFICIENT_FIELDS');
  const byUserApp = new Map<string, AuthNormalizedEvent[]>();
  const byUserAppClient = new Map<string, AuthNormalizedEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.subjectRef, event.applicationRef]);
    if (event.outcome === 'INVALID_CREDENTIAL') {
      const values = byUserApp.get(key) ?? []; values.push(event); byUserApp.set(key, values);
    }
    if (event.clientSource.qualification === 'QUALIFIED' && (event.outcome === 'INVALID_CREDENTIAL' || event.outcome === 'SUCCESS')) {
      const clientKey = JSON.stringify([event.subjectRef, event.applicationRef, event.clientSource.address]);
      const values = byUserAppClient.get(clientKey) ?? []; values.push(event); byUserAppClient.set(clientKey, values);
    }
  }
  const findings: AuthFinding[] = [];
  for (const failures of byUserApp.values()) {
    let start = 0;
    let episode: { first: number; last: number; expiry: number } | null = null;
    const flush = (): void => {
      if (episode) findings.push(makeFinding(input, AUTH_RULE_A, failures.slice(episode.first, episode.last + 1), episode.expiry, [...aReasons]));
    };
    for (let end = 0; end < failures.length; end += 1) {
      const time = Date.parse(failures[end]!.eventAt);
      while (start <= end && Date.parse(failures[start]!.eventAt) < time - 15 * MINUTE) start += 1;
      if (end - start + 1 < 10) continue;
      const expiry = Date.parse(failures[end - 9]!.eventAt) + 15 * MINUTE;
      if (episode && Date.parse(failures[start]!.eventAt) <= episode.expiry) {
        episode.last = end; episode.expiry = expiry;
      } else { flush(); episode = { first: start, last: end, expiry }; }
    }
    flush();
  }
  for (const values of byUserAppClient.values()) {
    const failures: AuthNormalizedEvent[] = [];
    let start = 0;
    let episode: { evidence: Map<string, AuthNormalizedEvent>; expiry: number; admittedFailureEnd: number } | null = null;
    const flush = (): void => {
      if (episode) findings.push(makeFinding(input, AUTH_RULE_B, [...episode.evidence.values()], episode.expiry, [...bReasons]));
    };
    for (const event of values) {
      const time = Date.parse(event.eventAt);
      if (event.outcome === 'INVALID_CREDENTIAL') { failures.push(event); continue; }
      while (start < failures.length && Date.parse(failures[start]!.eventAt) < time - 10 * MINUTE) start += 1;
      let end = failures.length;
      while (end > start && Date.parse(failures[end - 1]!.eventAt) >= time) end -= 1;
      if (end - start >= 5 && Date.parse(failures[end - 1]!.eventAt) >= time - 2 * MINUTE) {
        if (!episode || Date.parse(failures[start]!.eventAt) > episode.expiry) {
          flush(); episode = { evidence: new Map(), expiry: time + 10 * MINUTE, admittedFailureEnd: start };
        }
        for (let index = Math.max(start, episode.admittedFailureEnd); index < end; index += 1) episode.evidence.set(failures[index]!.eventId, failures[index]!);
        episode.admittedFailureEnd = end;
        episode.evidence.set(event.eventId, event);
        episode.expiry = time + 10 * MINUTE;
      }
    }
    flush();
  }
  result.findings = findings.sort((a, b) => ordinal(a.findingId, b.findingId));
  result.rules = ([AUTH_RULE_A, AUTH_RULE_B] as const).map(ruleId => {
    const reasonCodes = [...(ruleId === AUTH_RULE_A ? aReasons : bReasons)].sort(ordinal);
    return { ruleId, status: findings.some(finding => finding.ruleId === ruleId) ? 'MATCHED' : reasonCodes.length ? 'NOT_EVALUATED' : 'NOT_MATCHED', reasonCodes };
  });
  return result;
}
