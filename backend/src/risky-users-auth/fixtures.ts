/** Invented authentication fixtures only; never customer records. */
import type { AuthEvaluationInput, AuthNormalizationContext, AuthNormalizedEvent } from './contract.js';
export const SYNTHETIC_SCOPE = { organizationId: 'synthetic-org', customerTenantId: 'synthetic-tenant', microsoftTenantId: 'synthetic-microsoft-tenant' };
export const SYNTHETIC_NOW = '2026-09-08T16:00:00.000Z';
const DIRECTORY_ID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';
export const at = (minutes: number): string => new Date(Date.parse(SYNTHETIC_NOW) + minutes * 60000).toISOString();
export function event(id: string, minutes: number, overrides: Partial<AuthNormalizedEvent> = {}): AuthNormalizedEvent {
  return { ...SYNTHETIC_SCOPE, source: 'GRAPH_SIGN_INS', eventId: id, eventAt: at(minutes), ingestedAt: SYNTHETIC_NOW,
    subjectRef: 'synthetic-human', applicationRef: 'synthetic-app', outcome: 'INVALID_CREDENTIAL', errorCode: 50126,
    clientSource: { qualification: 'QUALIFIED', address: '192.0.2.10' }, eventMfa: { fact: 'NOT_EVIDENCED', evidenceRef: null }, ...overrides };
}
export const failures = (count: number, start = -10): AuthNormalizedEvent[] => Array.from({ length: count }, (_, index) => event(`failure-${index}`, start + index));
export const success = (minutes = 0): AuthNormalizedEvent => event('success', minutes, { outcome: 'SUCCESS', errorCode: 0 });
export function evaluation(events: readonly AuthNormalizedEvent[], overrides: Partial<AuthEvaluationInput> = {}): AuthEvaluationInput {
  return { ...SYNTHETIC_SCOPE, source: 'GRAPH_SIGN_INS', asOf: SYNTHETIC_NOW, authorizedFrom: at(-1440), events,
    readiness: { state: 'READY', paginationComplete: true, gapCount: 0, capped: false }, ...overrides };
}
export function normalization(source: 'GRAPH_SIGN_INS' | 'M365_AUDIT_STS' = 'GRAPH_SIGN_INS'): AuthNormalizationContext {
  return { ...SYNTHETIC_SCOPE, source, ingestedAt: SYNTHETIC_NOW,
    subject: { resolvedSubjectRef: 'synthetic-human', sourceUserId: source === 'GRAPH_SIGN_INS' ? DIRECTORY_ID : 'synthetic.human@example.invalid', principalClass: 'HUMAN',
      sourceField: source === 'GRAPH_SIGN_INS' ? 'userId' : 'UserId', matchedBy: source === 'GRAPH_SIGN_INS' ? 'DIRECTORY_OBJECT_ID' : 'EXACT_NORMALIZED_UPN', uniqueMatch: true },
    application: { applicationRef: 'synthetic-app', sourceValue: APPLICATION_ID, field: source === 'GRAPH_SIGN_INS' ? 'appId' : 'ApplicationId', qualified: true },
    clientSource: { qualification: 'QUALIFIED' } };
}
export function graphRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'synthetic-event', createdDateTime: at(-1), userId: DIRECTORY_ID, appId: APPLICATION_ID,
    ipAddress: '192.0.2.10', isInteractive: true, status: { errorCode: 50126 }, ...overrides };
}
export function auditRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { Id: 'synthetic-event', CreationTime: at(-1), OrganizationId: SYNTHETIC_SCOPE.microsoftTenantId, RecordType: 15, UserType: 0,
    UserId: 'synthetic.human@example.invalid', UserKey: 'synthetic-alternative-key', ApplicationId: APPLICATION_ID, ClientIP: '192.0.2.10', Operation: 'UserLoginFailed',
    ErrorCode: '50126', ResultStatus: 'Succeeded', ...overrides };
}
