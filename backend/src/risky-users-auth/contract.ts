/** Internal, pure authentication contract. Not a public API or persistence DTO. */
export const AUTH_RULE_A = 'HV-ID-AUTH-010.v1' as const;
export const AUTH_RULE_B = 'HV-ID-AUTH-005.v2' as const;
export const MAX_AUTH_EVENTS = 10000;
export const MAX_AUTH_INCIDENTS = 2000;
export const MAX_INCIDENT_INPUT_EVIDENCE = 100000;
export type AuthRuleId = typeof AUTH_RULE_A | typeof AUTH_RULE_B;
export type AuthSource = 'GRAPH_SIGN_INS' | 'M365_AUDIT_STS';
export type AuthPrincipalClass = 'HUMAN' | 'PRIVILEGED_HUMAN' | 'NON_HUMAN' | 'UNKNOWN';
export type AuthClientQualification = 'QUALIFIED' | 'MISSING' | 'AMBIGUOUS' | 'PROXY_ONLY';
export type AuthOutcome = 'INVALID_CREDENTIAL' | 'SUCCESS' | 'NON_QUALIFYING' | 'UNKNOWN';
export interface AuthScope {
  organizationId: string;
  customerTenantId: string;
  microsoftTenantId: string;
}
export interface AuthNormalizationContext extends AuthScope {
  source: AuthSource;
  ingestedAt: string;
  /** Resolver-owned immutable directory binding. Never inferred from a UPN. */
  subject: {
    resolvedSubjectRef: string; sourceUserId: string; principalClass: AuthPrincipalClass;
    sourceField?: 'userId' | 'UserId'; conflictingIdentifiers?: boolean;
    matchedBy?: 'DIRECTORY_OBJECT_ID' | 'EXACT_NORMALIZED_UPN'; uniqueMatch?: boolean;
  };
  /** Source-specific, independently qualified app binding. Labels must be unambiguous. */
  application: { applicationRef: string; sourceValue: string; field: 'appId' | 'ApplicationId' | 'Application'; qualified: boolean };
  clientSource: { qualification: AuthClientQualification; field?: 'ipAddress' | 'ClientIP' | 'ActorIpAddress' };
  /** Optional authoritative event-bound fact, never a current MFA/CA policy inference. */
  eventMfa?: AuthScope & { source: AuthSource; eventId: string; fact: 'SATISFIED' | 'NOT_SATISFIED'; evidenceRef: string };
}
export interface AuthNormalizedEvent extends AuthScope {
  source: AuthSource;
  eventId: string;
  eventAt: string;
  ingestedAt: string;
  subjectRef: string;
  applicationRef: string;
  outcome: AuthOutcome;
  errorCode: number | null;
  clientSource: { qualification: AuthClientQualification; address: string | null };
  eventMfa: { fact: 'SATISFIED' | 'NOT_SATISFIED' | 'NOT_EVIDENCED'; evidenceRef: string | null };
}
export type AuthNormalizationResult =
  | { status: 'ACCEPTED'; event: AuthNormalizedEvent }
  | { status: 'REJECTED'; reason: string };
export interface AuthEvaluationInput extends AuthScope {
  /** Exactly one selected source. Never pool Graph and audit records. */
  source: AuthSource;
  asOf: string;
  authorizedFrom: string;
  events: readonly AuthNormalizedEvent[];
  readiness: {
    state: 'READY' | 'PARTIAL' | 'UNAVAILABLE' | 'STALE';
    paginationComplete: boolean;
    gapCount: number;
    capped: boolean;
    reasonCodes?: readonly string[];
  };
}
export interface AuthFinding extends AuthScope {
  findingId: string;
  ruleId: AuthRuleId;
  source: AuthSource;
  subjectRef: string;
  applicationRef: string;
  clientAddress: string | null;
  priority: 'LOW' | 'MEDIUM';
  confidence: 'SUPPORTED_PATTERN';
  firstSeen: string;
  lastSeen: string;
  evaluatedAt: string;
  expiresAt: string;
  evidenceEventIds: readonly string[];
  evidenceCount: number;
  /** Explicit event MFA facts only. No compromise probability is implied. */
  eventMfa: AuthNormalizedEvent['eventMfa'];
  caveats: readonly string[];
}
export interface AuthRuleEvaluation {
  /** Aggregate selected-source coverage, not a per-subject assertion of completeness. */
  ruleId: AuthRuleId;
  status: 'MATCHED' | 'NOT_MATCHED' | 'NOT_EVALUATED';
  reasonCodes: readonly string[];
}
export interface AuthEvaluationResult {
  evaluatedAt: string;
  rules: readonly AuthRuleEvaluation[];
  findings: readonly AuthFinding[];
  admittedEventCount: number;
  duplicateCount: number;
  conflictingEventIds: readonly string[];
}
export interface AuthIncident extends AuthFinding {
  incidentId: string;
  activity: 'ACTIVE' | 'HISTORICAL' | 'UNKNOWN';
  /** Preserved disputed references, excluded from the valid evidence count. */
  quarantinedEventIds?: readonly string[];
  lastEvaluatedAt: string;
}
export interface AuthIncidentContext extends AuthScope {
  asOf: string;
  source: AuthSource;
  /** Only conflict IDs admitted by this same scoped evaluation/replay boundary. */
  conflictingEventIds?: readonly string[];
}
