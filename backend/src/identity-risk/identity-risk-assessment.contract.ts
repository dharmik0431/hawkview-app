import type { IdentityRiskEnvelope, IdentityRiskPageInfo } from './identity-risk.contract.js'

/** Frozen recovery-release public contract. Existing v1 routes remain compatible. */
export const RISK_ASSESSMENT_SCHEMA = 'hawkview-risk-assessment/v1' as const
export const RISK_ASSESSMENT_RULE_IDS = [
  'HV-ID-AUTH-010.v1', // Repeated invalid credentials: 10 distinct / 15 minutes.
  'HV-ID-AUTH-005.v2', // Qualified failures then success: 5 / 10 minutes, final <=2m.
  'HV-ID-MBX-001.v1', // Existing published HIGH priority retained, no new escalation.
] as const
export type RiskAssessmentRuleId = typeof RISK_ASSESSMENT_RULE_IDS[number]
/** Closed release tuples. Neither aggregation nor protection changes priority. */
export const RISK_ASSESSMENT_RULE_TUPLES = Object.freeze({
  'HV-ID-AUTH-010.v1': { version: 'v1', priority: 'LOW', sources: ['M365_AUDIT_STS', 'GRAPH_SIGN_INS'] },
  'HV-ID-AUTH-005.v2': { version: 'v2', priority: 'MEDIUM', sources: ['M365_AUDIT_STS', 'GRAPH_SIGN_INS'] },
  'HV-ID-MBX-001.v1': { version: 'v1', priority: 'HIGH', sources: ['MAILBOX_RULES'] },
} as const)
export type RiskAssessmentSource = 'M365_AUDIT_STS' | 'GRAPH_SIGN_INS' | 'MAILBOX_RULES'
export type RiskAssessmentReadiness =
  | 'READY' | 'PARTIAL' | 'WAITING' | 'MISSING_PERMISSION' | 'LICENSE_REQUIRED'
  | 'STALE' | 'FAILED' | 'INSUFFICIENT_FIELDS' | 'UNSUPPORTED' | 'DISABLED'
export type RiskAssessmentReason =
  | 'READY' | 'WAITING_FOR_COLLECTION' | 'MISSING_PERMISSION' | 'LICENSE_REQUIRED'
  | 'COLLECTION_FAILED' | 'COLLECTION_STALE' | 'INCOMPLETE_WINDOW' | 'SOURCE_UNAVAILABLE'
  | 'INSUFFICIENT_FIELDS' | 'USER_BINDING_UNRESOLVED' | 'APPLICATION_BINDING_UNRESOLVED'
  | 'CLIENT_SOURCE_UNQUALIFIED' | 'UNSUPPORTED_RECORD' | 'CONFLICTING_EVIDENCE'
  | 'CAPACITY_LIMIT' | 'EVALUATION_FAILED' | 'EVALUATION_DISABLED' | 'KEY_UNAVAILABLE'
  | 'DIRECTORY_SYNC_MISSING' | 'DIRECTORY_SYNC_NOT_SUCCEEDED' | 'DIRECTORY_SYNC_UNDATED'
  | 'DIRECTORY_SYNC_STALE' | 'DIRECTORY_SYNC_NEWER_ATTEMPT' | 'RULE_ENDPOINT_NOT_FOUND'
  | 'RULE_VALIDATION_UNATTESTABLE' | 'SOURCE_NOT_ATTESTED' | 'ATTESTED_COMPLETE'
export type RiskEvidenceWindow = Readonly<{ start: string | null; end: string | null }>
export type RiskProtectionEvidence<State extends string> = Readonly<{
  state: State | 'UNKNOWN'
  source: 'MICROSOFT_GRAPH' | 'EFFECTIVE_MFA_V1' | 'NOT_REPORTED'
  observedAt: string | null
  freshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
  reasonCode: 'VERIFIED' | 'NOT_REPORTED' | 'STALE' | 'FAILED' | 'MISSING_PERMISSION' | 'INCOMPLETE'
}>

export type RiskSourceReadinessDto = Readonly<{
  source: RiskAssessmentSource
  status: RiskAssessmentReadiness
  reasonCode: RiskAssessmentReason
  explanation: string
  window: RiskEvidenceWindow
  lastSuccessfulCollectionAt: string | null
  latestEventAt: string | null
  latestIngestionAt: string | null
  freshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
}>
export type RiskRuleReadinessDto = Readonly<{
  ruleId: RiskAssessmentRuleId
  ruleVersion: string
  title: string
  status: RiskAssessmentReadiness
  reasonCode: RiskAssessmentReason
  explanation: string
  selectedSource: RiskAssessmentSource | null
  window: RiskEvidenceWindow
  evaluatedAt: string | null
  assessedIdentities: number | null
  matchedIdentities: number | null
  countsCapped: boolean
}>
export type RiskProtectionDto = Readonly<{
  conditionalAccess: Readonly<{
    contractVersion: 1
    status: 'COVERED_BY_CONDITIONAL_ACCESS' | 'CONDITIONALLY_COVERED' | 'REPORT_ONLY' | 'NOT_COVERED' | 'UNKNOWN'
    policies: readonly Readonly<{
      id: string; name: string; state: 'ENABLED' | 'REPORT_ONLY' | 'DISABLED'
      outcome: 'UNIVERSAL' | 'CONDITIONAL' | 'NOT_ENFORCED'; materialConditions: readonly string[]
    }>[]
    observedAt: string | null
    evaluatedAt: string | null
    source: 'EFFECTIVE_MFA_V1'
    freshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
    reasonCodes: readonly string[]
  }>
  securityDefaults: RiskProtectionEvidence<'ENABLED' | 'DISABLED'>
  legacyPerUserMfa: RiskProtectionEvidence<'ENFORCED' | 'ENABLED' | 'DISABLED'>
  registration: RiskProtectionEvidence<'REGISTERED' | 'NOT_REGISTERED'>
  explanation: string
}>
export type RiskRecommendedActionDto = Readonly<{
  code: 'CONFIRM_EXPECTED_ACTIVITY' | 'REVIEW_SIGN_INS' | 'CHECK_SAVED_CREDENTIALS'
    | 'VERIFY_MFA_ENFORCEMENT' | 'REVIEW_MAILBOX_FORWARDING' | 'FOLLOW_INCIDENT_PROCEDURE'
  text: string
}>
export type RiskAssessmentFindingDto = Readonly<{
  id: string
  ruleId: RiskAssessmentRuleId
  ruleVersion: string
  priority: 'LOW' | 'MEDIUM' | 'HIGH'
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  activityState: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN'
  title: string
  explanation: string
  firstSeen: string
  lastSeen: string
  evaluatedAt: string
  /** Exact detector activity-window boundary, distinct from data retention. */
  activityWindowEndsAt: string
  window: RiskEvidenceWindow
  evidenceCount: number
  evidenceCountCapped: boolean
  selectedSource: RiskAssessmentSource
  application: Readonly<{ id: string | null; state: 'RESOLVED' | 'NOT_REPORTED'; label: string | null }>
  device: Readonly<{ state: 'NOT_REPORTED' | 'INSUFFICIENT_FIELDS'; label: null }>
  clientSource: Readonly<{ reference: string | null; qualification: 'QUALIFIED' | 'NOT_REPORTED' | 'INSUFFICIENT_FIELDS' }>
  evidenceReferences: readonly Readonly<{
    id: string // Tenant-scoped opaque reference, never raw provider payload.
    recordedAt: string
    ingestedAt: string | null
  }>[]
  eventProtection: 'MFA_SATISFIED' | 'BLOCKED_BY_POLICY' | 'NOT_REPORTED'
  caveats: readonly string[]
  recommendedActions: readonly RiskRecommendedActionDto[]
}>
export type RiskAssessmentUserDto = Readonly<{
  id: string // Existing managed tenant-scoped opaque subject reference.
  label: string // Authorized, resolved directory subject only; no guessed human rows.
  subjectType: 'USER' | 'MAILBOX'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | null // Highest CURRENT finding only.
  protection: RiskProtectionDto
  findings: readonly RiskAssessmentFindingDto[]
}>

/** Opt-in public summary of the authorized, bounded assessment, not all possible risk. */
export type RiskAssessmentSummaryDto = Readonly<{
  scope: 'TENANT'
  asOf: string | null // Completed assessment timestamp, never request time.
  currentUsers:
    | Readonly<{ value: number; accuracy: 'EXACT' | 'AT_LEAST' }>
    | Readonly<{ value: null; accuracy: 'UNKNOWN' }>
}>

export type RiskAssessmentWithSummaryDto = RiskAssessmentDto & Readonly<{
  summary: RiskAssessmentSummaryDto
}>

/** GET /api/tenants/:tenantId/identity-signals/assessment; bounded persisted read.
 * Never evaluate source rules in GET. Microsoft remains its independent existing
 * /microsoft-entra-risky-users endpoint/DTO and cannot influence this response.
 */
export type RiskAssessmentDto = Readonly<{
  version: 1
  schemaVersion: typeof RISK_ASSESSMENT_SCHEMA
  // Conservative aggregate: FULL/CURRENT requires every rule's selected source
  // and rule evidence READY/current. Unselected alternative feeds do not add
  // coverage. Any required missing/stale source prohibits complete/current claims.
  meta: IdentityRiskEnvelope
  sources: readonly RiskSourceReadinessDto[]
  rules: readonly RiskRuleReadinessDto[]
  users: readonly RiskAssessmentUserDto[]
  page: IdentityRiskPageInfo
}>
