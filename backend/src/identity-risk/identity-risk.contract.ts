export const IDENTITY_RISK_API_VERSION = 1 as const
export const IDENTITY_RISK_ENGINE_VERSION = 'hawkview-identity-engine/1' as const
export const IDENTITY_RISK_CATALOG_VERSION = 'hawkview-identity-signals/v1' as const
export const MICROSOFT_RISK_CATALOG_VERSION = 'microsoft-entra-risky-users/v1' as const
export const IDENTITY_RISK_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000
export const IDENTITY_RISK_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000
export const IDENTITY_RISK_DEFAULT_PAGE_SIZE = 50
export const IDENTITY_RISK_MAX_PAGE_SIZE = 100
export const IDENTITY_RISK_MAX_RULE_IDS = 10
export const IDENTITY_RISK_MAX_LIST_ITEMS = 10
export const IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION =
  'hawkview-identity-source/v1' as const

export type IdentitySignalOutcome =
  | 'MATCHED'
  | 'NOT_MATCHED'
  | 'NOT_EVALUATED'
  | 'SUPPRESSED'
export type IdentitySignalCoverage = 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
export type IdentitySignalSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type IdentitySignalConfidence = 'LOW' | 'MEDIUM' | 'HIGH'
export type IdentitySubjectType = 'USER' | 'MAILBOX' | 'APPLICATION' | 'UNKNOWN'

export type IdentityRiskSourceScalar = string | number | boolean | null
export type IdentityRiskSourceAttribute = Readonly<{
  name: string
  value: IdentityRiskSourceScalar | readonly IdentityRiskSourceScalar[]
}>

/**
 * Versioned, data-only projection boundary for evaluator source records.
 * Provider payloads, principals, credentials, tokens, and arbitrary objects are
 * not valid source payloads. Projectors must emit only approved attributes and
 * HawkView opaque references before the platform receives a batch.
 */
export type IdentityRiskSourcePayload = Readonly<{
  schemaVersion: typeof IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION
  recordReference: string
  subjectReference?: string
  attributes: readonly IdentityRiskSourceAttribute[]
}>

export type IdentitySignalEvaluationContext = Readonly<{
  organizationId: string
  customerTenantId: string
  evaluationAt: Date
  engineVersion: string
  catalogVersion: string
  sources: Readonly<Record<string, readonly IdentityRiskSourcePayload[]>>
}>

export type IdentitySignalResult = Readonly<{
  ruleId: string
  outcome: IdentitySignalOutcome
  coverage: IdentitySignalCoverage
  reasonCodes: readonly string[]
  subjectType: IdentitySubjectType
  subjectId: string
  evidenceReferences?: readonly string[]
  sourceLabels?: readonly string[]
  severity?: IdentitySignalSeverity
  confidence?: IdentitySignalConfidence
  observedAt?: Date
}>

/** Formulas are supplied by the detector owner; platform owns source gating and persistence. */
export interface IdentitySignalDetector {
  readonly ruleId: string
  evaluate(
    context: IdentitySignalEvaluationContext,
  ): readonly IdentitySignalResult[] | Promise<readonly IdentitySignalResult[]>
}

export type IdentityRiskSourceEnvelope =
  | Readonly<{
      kind: 'IMMUTABLE_EVENT'
      sourceType: string
      canonicalEventId: string
      authoritativeEventTime: Date
      sourceEventVersion: string
      payload: IdentityRiskSourcePayload
    }>
  | Readonly<{
      kind: 'AUTHORITATIVE_SNAPSHOT'
      resourceType: string
      objectId: string
      authoritativeObservationId: string
      observedAt: Date
      projectorSchemaVersion: string
      sourceWatermark: string
      payload: IdentityRiskSourcePayload
    }>

export type IdentityRiskSourceBatch = Readonly<{
  context: Omit<IdentitySignalEvaluationContext, 'sources'>
  sourceEnvelopes: readonly IdentityRiskSourceEnvelope[]
  orderedSourceWatermarks: readonly string[]
  earliestSourceExpiry: Date | null
  capability: IdentitySignalCoverage
}>

export type IdentityRiskReadiness =
  | 'AVAILABLE'
  | 'STALE'
  | 'LEARNING'
  | 'NOT_EVALUATED'
  | 'UNAVAILABLE'
  | 'ERROR'
export type IdentityRiskChannel =
  | 'HAWKVIEW_IDENTITY_SIGNALS'
  | 'MICROSOFT_ENTRA_RISKY_USERS'
export type IdentityRiskFreshness = 'CURRENT' | 'STALE' | 'UNKNOWN'

export type IdentityRiskEnvelope = Readonly<{
  version: 1
  channel: IdentityRiskChannel
  engineVersion: string | null
  catalogVersion: string
  evaluatedAt: string | null
  capability: IdentitySignalCoverage
  status: IdentityRiskReadiness
  sourceLabel: string
  observedAt: string | null
  freshness: IdentityRiskFreshness
  limitation: string | null
}>

export type IdentityRiskBoundedCount = Readonly<{
  value: number
  exact: boolean
  capped: boolean
}>

export type IdentityRiskPageInfo = Readonly<{
  hasMore: boolean
  nextCursor: string | null
}>

export type IdentityRiskFindingDto = Readonly<{
  id: string
  state: 'OPEN' | 'UPDATED' | 'RESOLVED' | 'EXPIRED'
  severity: IdentitySignalSeverity
  confidence: IdentitySignalConfidence
  coverage: IdentitySignalCoverage
  title: string
  explanation: string
  affectedIdentity: Readonly<{
    id: string
    label: string
    type: IdentitySubjectType
  }>
  investigationGuidanceCode:
    | 'REVIEW_ACTIVITY'
    | 'REVIEW_ACCESS'
    | 'REVIEW_MAILBOX_RULE'
    | 'REVIEW_CONFIGURATION'
  investigationGuidance: string
  benignAlternativeCodes: readonly string[]
  sourceLabels: readonly string[]
  missingEvidenceLabels: readonly string[]
  observedAt: string
  ruleIds: readonly string[]
}>

export type MicrosoftRiskLevel =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'hidden'
  | 'unknownFutureValue'
export type MicrosoftRiskState =
  | 'none'
  | 'atRisk'
  | 'remediated'
  | 'dismissed'
  | 'confirmedSafe'
  | 'confirmedCompromised'
  | 'unknownFutureValue'

export type MicrosoftRiskDetail =
  | 'none'
  | 'adminGeneratedTemporaryPassword'
  | 'userPerformedSecuredPasswordChange'
  | 'userPerformedSecuredPasswordReset'
  | 'adminConfirmedSigninSafe'
  | 'aiConfirmedSigninSafe'
  | 'userPassedMFADrivenByRiskBasedPolicy'
  | 'adminDismissedAllRiskForUser'
  | 'adminConfirmedSigninCompromised'
  | 'hidden'
  | 'adminConfirmedUserCompromised'
  | 'm365DAdminDismissedDetection'
  | 'userChangedPasswordOnPremises'
  | 'adminDismissedRiskForSignIn'
  | 'adminConfirmedAccountSafe'
  | 'unknownFutureValue'

export type MicrosoftRiskyUserDto = Readonly<{
  id: string
  identityLabel: string
  riskLevel: MicrosoftRiskLevel
  riskState: MicrosoftRiskState
  riskDetail: MicrosoftRiskDetail | null
  observedAt: string
}>

export type IdentityRiskControlType =
  | 'ALERT_DELIVERY_DISABLED'
  | 'EVALUATION_HARD_DISABLED'
export type IdentityRiskControlScope =
  | Readonly<{ type: 'GLOBAL' }>
  | Readonly<{
      type: 'TENANT'
      organizationId: string
      customerTenantId: string
    }>

export type IdentityRiskEvaluationRequest = Readonly<{
  organizationId: string
  customerTenantId: string
  engineVersion: typeof IDENTITY_RISK_ENGINE_VERSION
  catalogVersion: typeof IDENTITY_RISK_CATALOG_VERSION
  windowStart: Date
  windowEnd: Date
  evaluationAt: Date
  loadSources: () => Promise<IdentityRiskSourceBatch>
  detectors: readonly IdentitySignalDetector[]
}>
