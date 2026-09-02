export const IDENTITY_RISK_ENGINE_VERSION = 'hawkview-identity-engine/1' as const
export const IDENTITY_SIGNAL_CATALOG_VERSION = 'hawkview-identity-signals/v1' as const
export const IDENTITY_SIGNAL_CHANNEL = 'HAWKVIEW_IDENTITY_SIGNALS' as const
export const IDENTITY_SIGNAL_MAX_SUBJECT_REFERENCE_LENGTH = 160 as const
export const IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCES = 32 as const
export const IDENTITY_SIGNAL_MAX_EVIDENCE_REFERENCE_LENGTH = 256 as const
export const IDENTITY_SIGNAL_MAX_EVIDENCE_ITEMS = 128 as const

export const IDENTITY_SIGNAL_RULE_IDS = [
  'HV-ID-EXP-001.v1',
  'HV-ID-EXP-002.v1',
  'HV-ID-EXP-003.v1',
  'HV-ID-CHG-001.v1',
  'HV-ID-CHG-002.v1',
  'HV-ID-CHG-003.v1',
  'HV-ID-CHG-004.v1',
  'HV-ID-CHG-005.v1',
  'HV-ID-APP-001.v1',
  'HV-ID-APP-002.v1',
  'HV-ID-MBX-001.v1',
  'HV-ID-MBX-002.v1',
  'HV-ID-MBX-003.v1',
  'HV-ID-AUTH-001.v1',
  'HV-ID-AUTH-002.v1',
  'HV-ID-AUTH-003.v1',
  'HV-ID-AUTH-004.v1',
  'HV-ID-AUTH-005.v1',
  'HV-ID-AUTH-006.v1',
  'HV-ID-AUTH-007.v1',
  'HV-ID-AUTH-008.v1',
  'HV-ID-AUTH-009.v1',
] as const

export type IdentitySignalRuleId = typeof IDENTITY_SIGNAL_RULE_IDS[number]
export type IdentitySignalStatus = 'MATCHED' | 'NOT_MATCHED' | 'NOT_EVALUATED' | 'SUPPRESSED'
export type IdentitySignalSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type IdentitySignalConfidence = 'LOW' | 'MEDIUM' | 'HIGH'
export type IdentitySignalCoverage = 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
export type AccountClass = 'HUMAN' | 'PRIVILEGED_HUMAN' | 'SERVICE' | 'SHARED' | 'BREAK_GLASS' | 'UNKNOWN'

export type IdentitySignalReasonCode =
  | 'RULE_FEATURE_DISABLED'
  | 'RULE_CONFIG_UNAPPROVED'
  | 'EVIDENCE_UNAVAILABLE'
  | 'EVIDENCE_PARTIAL'
  | 'EVIDENCE_STALE'
  | 'EVIDENCE_FUTURE_DATED'
  | 'EVIDENCE_MALFORMED'
  | 'EVIDENCE_CAPPED'
  | 'BASELINE_LEARNING'
  | 'ACCOUNT_CLASS_UNVERIFIED'
  | 'ACCOUNT_CLASS_UNSUPPORTED'
  | 'ACCOUNT_CLASS_COVERAGE_INCOMPLETE'
  | 'INSUFFICIENT_INDEPENDENT_CONTEXT'
  | 'APPROVED_SHARED_CONTEXT'
  | 'EXPECTED_AUTH_RETRY'
  | 'APPROVED_TRAVEL_EXCEPTION'
  | 'APPROVED_MAINTENANCE_WINDOW'
  | 'MAILBOX_RULE_PROJECTION_INCOMPLETE'
  | 'IDENTIFIER_DOMAIN_UNVERIFIED'
  | 'NO_MATCH'
  | 'RULE_MATCHED'

export type CatalogType =
  | 'PRIVILEGED_ROLE_GROUP'
  | 'HIGH_IMPACT_OPERATION'
  | 'HIGH_IMPACT_APPLICATION_PERMISSION'
  | 'LEGACY_CLIENT'
  | 'ACCOUNT_CLASS'
  | 'NETWORK_CONTEXT'

export type NetworkContextType =
  | 'SHARED_EGRESS'
  | 'SHARED_DEVICE'
  | 'EXPECTED_AUTH_RETRY'
  | 'TRAVEL_EXCEPTION'
  | 'MAINTENANCE'

export type NetworkContextEntry = Readonly<{
  id: string
  type: NetworkContextType
  startsAt: string
  expiresAt: string
  subjectId?: string
  appId?: string
  client?: string
  deviceFingerprint?: string
  sourceFingerprint?: string
}>

export type ApprovedCatalog = Readonly<{
  catalogType: CatalogType
  version: string
  digest: string
  status: 'DRAFT' | 'APPROVED'
  approverIds: readonly string[]
  effectiveAt: string
  expiresAt?: string
  values: readonly string[]
  accountClasses?: Readonly<Record<string, AccountClass>>
  contextEntries?: readonly NetworkContextEntry[]
}>

export type IdentitySignalEvaluationContext = Readonly<{
  organizationId: string
  customerTenantId: string
  evaluatedAt: string
  engineVersion: typeof IDENTITY_RISK_ENGINE_VERSION
  catalogVersion: typeof IDENTITY_SIGNAL_CATALOG_VERSION
  readiness: 'READY' | 'NOT_READY'
  capability: IdentitySignalCoverage
  futureClockSkewToleranceMs: number | null
  featureFlags?: Readonly<Partial<Record<IdentitySignalRuleId, boolean>>>
  catalogs?: readonly ApprovedCatalog[]
}>

export type EvidenceRequirement = Readonly<{
  observedAt: string
  maxAgeHours: number
}>

export type IdentitySignalSubject = Readonly<{
  type: 'USER' | 'APPLICATION' | 'MAILBOX' | 'TENANT' | 'SOURCE'
  opaqueId: string
}>

export type CandidateBase = Readonly<{
  subject: IdentitySignalSubject
  evidenceReferences: readonly string[]
  evidence: readonly EvidenceRequirement[]
  evidenceState: 'COMPLETE' | 'PARTIAL' | 'CAPPED' | 'MALFORMED' | 'UNAVAILABLE'
  requiresFullCapability?: boolean
}>

export type BehaviorBaseline = Readonly<{
  status: 'LEARNING' | 'MATURE' | 'UNAVAILABLE'
  activeDays: number
  successfulInteractiveSignIns: number
  propertyFrequency?: Readonly<Record<string, Readonly<{ events: number; days: number }>>>
}>

export type AuthEvent = Readonly<{
  id: string
  occurredAt: string
  outcome: 'SUCCESS' | 'FAILURE' | 'MFA_DENIED' | 'MFA_TIMEOUT'
  interactive: boolean
  subjectId: string
  sourceFingerprint?: string
  sourceAsn?: number
  appId?: string
  client?: string
  deviceFingerprint?: string
}>

export type IdentitySignalCandidate =
  | (CandidateBase & { ruleId: 'HV-ID-EXP-001.v1'; privileged: boolean; enabled: boolean; effectiveMfa: 'ENFORCED' | 'NOT_ENFORCED' | 'UNKNOWN' })
  | (CandidateBase & { ruleId: 'HV-ID-EXP-002.v1'; privileged: boolean; enabled: boolean; userType: 'MEMBER' | 'GUEST' | 'UNKNOWN' })
  | (CandidateBase & { ruleId: 'HV-ID-EXP-003.v1'; privileged: boolean; enabled: boolean; baseline: BehaviorBaseline; lastSuccessfulInteractiveSignInAt: string | null })
  | (CandidateBase & { ruleId: 'HV-ID-CHG-001.v1'; lifecycle: 'CREATED' | 'RE_ENABLED'; lifecycleAt: string; privilegeAt: string; privilegeOperation: string; privilegeSucceeded: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-CHG-002.v1'; userType: 'MEMBER' | 'GUEST' | 'UNKNOWN'; authoritativeCreatedAt: string | null; privilegeAt: string; privilegeOperation: string; privilegeSucceeded: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-CHG-003.v1'; anchorAt: string; actorId: string; events: readonly Readonly<{ id: string; occurredAt: string; actorId: string; operation: string; succeeded: boolean }>[] })
  | (CandidateBase & { ruleId: 'HV-ID-CHG-004.v1'; operation: string; actorBaselineEvents: number; tenantBaselineEvents: number; actorOperationCount: number; tenantOperationCount: number; baselineActiveDays: number; succeeded: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-CHG-005.v1'; change: 'SECURITY_DEFAULTS' | 'MFA_POLICY' | 'STRONG_GRANT'; before: string | boolean; after: string | boolean; succeeded: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-APP-001.v1'; declaredPermissions: readonly string[]; authoritativeCreatedAt: string | null; observedAt: string })
  | (CandidateBase & { ruleId: 'HV-ID-APP-002.v1'; applicationPermissionIds: readonly string[]; credentialMetadataChanged: boolean; authoritativeComparable: boolean; succeeded: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-MBX-001.v1'; enabled: boolean; recipientAddresses: readonly string[]; verifiedAcceptedDomains: readonly string[] })
  | (CandidateBase & { ruleId: 'HV-ID-MBX-002.v1'; enabled: boolean; conditionsCompleteness: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE'; actionsCompleteness: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE'; populatedConditionCount: number; populatedExceptionCount: number; actions: Readonly<{ delete: boolean; permanentDelete: boolean; moveTarget: boolean; markAsRead: boolean; stopProcessing: boolean }> })
  | (CandidateBase & { ruleId: 'HV-ID-MBX-003.v1'; projectionComplete: boolean; mailboxChangeAt: string; independentSignInAt: string; independentSignInRuleId: IdentitySignalRuleId; baseSeverity: Exclude<IdentitySignalSeverity, 'CRITICAL'> })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-001.v1'; disabledAt: string; activityAt: string; outcome: 'SUCCESS' | 'FAILURE' })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-002.v1'; baseline: BehaviorBaseline; eventAt: string; lastSuccessfulInteractiveSignInAt: string | null; successfulInteractive: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-003.v1'; baseline: BehaviorBaseline; properties: Readonly<{ country?: string; asn?: number; device?: string; client?: string; app?: string }>; sourceFingerprint?: string })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-004.v1'; baseline: BehaviorBaseline; previous: Readonly<{ occurredAt: string; latitude: number; longitude: number; sourceFingerprint?: string }>; current: Readonly<{ occurredAt: string; latitude: number; longitude: number; sourceFingerprint?: string }> })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-005.v1'; events: readonly AuthEvent[] })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-006.v1'; events: readonly AuthEvent[]; normalizedMfaDetailComplete: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-007.v1'; privileged: boolean; succeeded: boolean; client: string })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-008.v1'; events: readonly AuthEvent[]; tenantWideComplete: boolean })
  | (CandidateBase & { ruleId: 'HV-ID-AUTH-009.v1'; successfulInteractive: boolean; occurredAt: string })

export type IdentitySignalResult = Readonly<{
  engineVersion: typeof IDENTITY_RISK_ENGINE_VERSION
  catalogVersion: typeof IDENTITY_SIGNAL_CATALOG_VERSION
  channel: typeof IDENTITY_SIGNAL_CHANNEL
  ruleId: IdentitySignalRuleId
  subject: IdentitySignalSubject
  status: IdentitySignalStatus
  severity: IdentitySignalSeverity | null
  confidence: IdentitySignalConfidence | null
  coverage: IdentitySignalCoverage
  reasonCodes: readonly IdentitySignalReasonCode[]
  evidenceReferences: readonly string[]
  sourceLabels: readonly string[]
  titleCode: string
  explanationCode: string
  investigationGuidanceCode: 'REVIEW_IDENTITY_SIGNAL_EVIDENCE' | null
  benignAlternativeCodes: readonly string[]
}>
