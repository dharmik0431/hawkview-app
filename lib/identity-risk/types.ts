export type IdentityRiskCapability = 'FULL' | 'PARTIAL' | 'UNAVAILABLE'

export type IdentityRiskChannelStatus =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'LEARNING'
  | 'NOT_EVALUATED'
  | 'ERROR'

export type IdentityRiskFreshness = 'CURRENT' | 'STALE' | 'UNKNOWN'

export type IdentityRiskChannelMeta = {
  capability: IdentityRiskCapability
  status: IdentityRiskChannelStatus
  freshness: IdentityRiskFreshness
  sourceLabel: string
  engineVersion: string | null
  catalogVersion: string | null
  evaluatedAt: string | null
  observedAt: string | null
  limitation: string | null
}

export type HawkViewIdentityFinding = {
  id: string
  state: 'OPEN' | 'UPDATED' | 'RESOLVED' | 'EXPIRED'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  coverage: IdentityRiskCapability
  title: string
  explanation: string
  affectedIdentity: {
    id: string
    label: string
    type: 'USER' | 'MAILBOX' | 'APPLICATION' | 'UNKNOWN'
  }
  observedAt: string
  ruleIds: string[]
  sourceLabels: string[]
  missingEvidenceLabels: string[]
  benignAlternativeCodes: string[]
  investigationGuidanceCode: string
  investigationGuidance: string
}

export type MicrosoftEntraRiskyUser = {
  id: string
  identityLabel: string
  riskLevel:
    | 'none'
    | 'low'
    | 'medium'
    | 'high'
    | 'hidden'
    | 'unknownFutureValue'
  riskState:
    | 'none'
    | 'atRisk'
    | 'remediated'
    | 'dismissed'
    | 'confirmedSafe'
    | 'confirmedCompromised'
    | 'unknownFutureValue'
  riskDetail: string | null
  observedAt: string
}

export type IdentityRiskPageInfo = {
  hasMore: boolean
  nextCursor: string | null
}

export type IdentityRiskBoundedCount = {
  value: number
  exact: boolean
  capped: boolean
}

export type HawkViewIdentityRiskCounts = {
  identitiesNeedingReview: IdentityRiskBoundedCount
  openFindings: IdentityRiskBoundedCount
  evaluatedRules: IdentityRiskBoundedCount
  matchedResults: IdentityRiskBoundedCount
  suppressedResults: IdentityRiskBoundedCount
  notMatchedResults: IdentityRiskBoundedCount
  notEvaluatedResults: IdentityRiskBoundedCount
}

export type HawkViewIdentitySignalsView = {
  channel: 'HAWKVIEW_IDENTITY_SIGNALS'
  meta: IdentityRiskChannelMeta
  counts: HawkViewIdentityRiskCounts | null
  findings: HawkViewIdentityFinding[] | null
  pageInfo: IdentityRiskPageInfo | null
}

export type MicrosoftEntraRiskyUsersView = {
  channel: 'MICROSOFT_ENTRA_RISKY_USERS'
  meta: IdentityRiskChannelMeta
  users: MicrosoftEntraRiskyUser[] | null
  pageInfo: IdentityRiskPageInfo | null
}

export type IdentityRiskViewModel = {
  hawkView: HawkViewIdentitySignalsView
  microsoft: MicrosoftEntraRiskyUsersView
}

export const RISK_ASSESSMENT_SCHEMA = 'hawkview-risk-assessment/v1' as const
export const RISK_ASSESSMENT_RULE_IDS = [
  'HV-ID-AUTH-010.v1',
  'HV-ID-AUTH-005.v2',
  'HV-ID-MBX-001.v1',
] as const

export const RISK_ASSESSMENT_RULE_TUPLES = {
  'HV-ID-AUTH-010.v1': {
    version: 'v1',
    priority: 'LOW',
    sources: ['M365_AUDIT_STS', 'GRAPH_SIGN_INS'],
  },
  'HV-ID-AUTH-005.v2': {
    version: 'v2',
    priority: 'MEDIUM',
    sources: ['M365_AUDIT_STS', 'GRAPH_SIGN_INS'],
  },
  'HV-ID-MBX-001.v1': {
    version: 'v1',
    priority: 'HIGH',
    sources: ['MAILBOX_RULES'],
  },
} as const

/** A rule the client carries published metadata for. */
export type RiskAssessmentRuleId = (typeof RISK_ASSESSMENT_RULE_IDS)[number]

/**
 * A rule identifier as reported by the server. Server rule catalogues change on
 * their own schedule, so this is any well-formed identifier, not only the ones
 * this client knows. Nothing treats an unrecognised rule as evaluated.
 */
export type ReportedRuleId = RiskAssessmentRuleId | (string & {})
export type RiskAssessmentSource =
  | 'M365_AUDIT_STS'
  | 'GRAPH_SIGN_INS'
  | 'MAILBOX_RULES'
export type RiskAssessmentReadiness =
  | 'READY'
  | 'PARTIAL'
  | 'WAITING'
  | 'MISSING_PERMISSION'
  | 'LICENSE_REQUIRED'
  | 'STALE'
  | 'FAILED'
  | 'INSUFFICIENT_FIELDS'
  | 'UNSUPPORTED'
  | 'DISABLED'
export type RiskAssessmentReason =
  | 'READY'
  | 'WAITING_FOR_COLLECTION'
  | 'MISSING_PERMISSION'
  | 'LICENSE_REQUIRED'
  | 'COLLECTION_FAILED'
  | 'COLLECTION_STALE'
  | 'INCOMPLETE_WINDOW'
  | 'SOURCE_UNAVAILABLE'
  | 'INSUFFICIENT_FIELDS'
  | 'USER_BINDING_UNRESOLVED'
  | 'APPLICATION_BINDING_UNRESOLVED'
  | 'CLIENT_SOURCE_UNQUALIFIED'
  | 'UNSUPPORTED_RECORD'
  | 'CONFLICTING_EVIDENCE'
  | 'CAPACITY_LIMIT'
  | 'EVALUATION_FAILED'
  | 'EVALUATION_DISABLED'
  | 'KEY_UNAVAILABLE'
  | 'DIRECTORY_SYNC_MISSING'
  | 'DIRECTORY_SYNC_NOT_SUCCEEDED'
  | 'DIRECTORY_SYNC_UNDATED'
  | 'DIRECTORY_SYNC_STALE'
  | 'DIRECTORY_SYNC_NEWER_ATTEMPT'
  | 'RULE_ENDPOINT_NOT_FOUND'
  | 'RULE_VALIDATION_UNATTESTABLE'
  | 'SOURCE_NOT_ATTESTED'
  | 'ATTESTED_COMPLETE'

export type RiskEvidenceWindow = {
  start: string | null
  end: string | null
}

export type RiskSourceReadiness = {
  source: RiskAssessmentSource
  status: RiskAssessmentReadiness
  reasonCode: RiskAssessmentReason
  explanation: string
  window: RiskEvidenceWindow
  lastSuccessfulCollectionAt: string | null
  latestEventAt: string | null
  latestIngestionAt: string | null
  freshness: IdentityRiskFreshness
}

export type RiskRuleReadiness = {
  ruleId: ReportedRuleId
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
}

export type RiskConditionalAccessPolicy = {
  id: string
  name: string
  state: 'ENABLED' | 'REPORT_ONLY' | 'DISABLED'
  outcome: 'UNIVERSAL' | 'CONDITIONAL' | 'NOT_ENFORCED'
  materialConditions: string[]
}

export type RiskProtection = {
  conditionalAccess: {
    contractVersion: 1
    status:
      | 'COVERED_BY_CONDITIONAL_ACCESS'
      | 'CONDITIONALLY_COVERED'
      | 'REPORT_ONLY'
      | 'NOT_COVERED'
      | 'UNKNOWN'
    policies: RiskConditionalAccessPolicy[]
    observedAt: string | null
    evaluatedAt: string | null
    source: 'EFFECTIVE_MFA_V1'
    freshness: IdentityRiskFreshness
    reasonCodes: string[]
  }
  securityDefaults: RiskProtectionEvidence<'ENABLED' | 'DISABLED'>
  legacyPerUserMfa: RiskProtectionEvidence<'ENFORCED' | 'ENABLED' | 'DISABLED'>
  registration: RiskProtectionEvidence<'REGISTERED' | 'NOT_REGISTERED'>
  explanation: string
}

export type RiskProtectionEvidence<State extends string> = {
  state: State | 'UNKNOWN'
  source: 'MICROSOFT_GRAPH' | 'EFFECTIVE_MFA_V1' | 'NOT_REPORTED'
  observedAt: string | null
  freshness: IdentityRiskFreshness
  reasonCode:
    | 'VERIFIED'
    | 'NOT_REPORTED'
    | 'STALE'
    | 'FAILED'
    | 'MISSING_PERMISSION'
    | 'INCOMPLETE'
}

export type RiskRecommendedAction = {
  code:
    | 'CONFIRM_EXPECTED_ACTIVITY'
    | 'REVIEW_SIGN_INS'
    | 'CHECK_SAVED_CREDENTIALS'
    | 'VERIFY_MFA_ENFORCEMENT'
    | 'REVIEW_MAILBOX_FORWARDING'
    | 'FOLLOW_INCIDENT_PROCEDURE'
  text: string
}

export type RiskAssessmentFinding = {
  id: string
  ruleId: ReportedRuleId
  ruleVersion: string
  priority: 'LOW' | 'MEDIUM' | 'HIGH'
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  activityState: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN'
  title: string
  explanation: string
  firstSeen: string
  lastSeen: string
  evaluatedAt: string
  activityWindowEndsAt: string
  window: RiskEvidenceWindow
  evidenceCount: number
  evidenceCountCapped: boolean
  selectedSource: RiskAssessmentSource
  application: {
    id: string | null
    state: 'RESOLVED' | 'NOT_REPORTED'
    label: string | null
  }
  device: { state: 'NOT_REPORTED' | 'INSUFFICIENT_FIELDS'; label: null }
  clientSource: {
    reference: string | null
    qualification: 'QUALIFIED' | 'NOT_REPORTED' | 'INSUFFICIENT_FIELDS'
  }
  evidenceReferences: Array<{
    id: string
    recordedAt: string
    ingestedAt: string | null
  }>
  eventProtection: 'MFA_SATISFIED' | 'BLOCKED_BY_POLICY' | 'NOT_REPORTED'
  caveats: string[]
  recommendedActions: RiskRecommendedAction[]
}

export type RiskAssessmentUser = {
  id: string
  label: string
  subjectType: 'USER' | 'MAILBOX'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | null
  protection: RiskProtection
  findings: RiskAssessmentFinding[]
}

export type RiskAssessmentCountAccuracy = 'EXACT' | 'AT_LEAST' | 'UNKNOWN'

export type RiskAssessmentSummary = {
  scope: 'TENANT'
  asOf: string | null
  currentUsers: {
    value: number | null
    accuracy: RiskAssessmentCountAccuracy
  }
}

export type RiskAssessment = {
  version: 1
  schemaVersion: typeof RISK_ASSESSMENT_SCHEMA
  meta: IdentityRiskChannelMeta
  sources: RiskSourceReadiness[]
  rules: RiskRuleReadiness[]
  users: RiskAssessmentUser[]
  page: IdentityRiskPageInfo
  /**
   * Present only when the caller opts into the additive count summary. Older
   * servers intentionally omit it; absence is unknown, never a list-derived
   * tenant total.
   */
  summary: RiskAssessmentSummary | null
}
