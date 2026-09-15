export type IdentityRiskCapability = 'FULL' | 'PARTIAL' | 'UNAVAILABLE'

export type IdentityRiskChannelStatus =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'LEARNING'
  | 'NOT_EVALUATED'
  | 'ERROR'

export type IdentityRiskFreshness = 'CURRENT' | 'STALE' | 'UNKNOWN'

/**
 * Why a channel is not reporting. `limitation` carries the server's prose; this
 * is the machine-readable cause the UI needs in order to say something specific
 * and actionable instead of "unavailable".
 *
 * Optional on the wire. A server that does not send it yields null, and the UI
 * says it does not know the reason rather than guessing one.
 */
export type IdentityRiskChannelReason =
  | 'LICENSE_REQUIRED'
  | 'MISSING_PERMISSION'
  | 'WAITING_FOR_COLLECTION'
  | 'COLLECTION_FAILED'
  | 'COLLECTION_STALE'
  | 'SOURCE_UNAVAILABLE'
  | 'EVALUATION_DISABLED'

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
  reasonCode: IdentityRiskChannelReason | null
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

/**
 * The key that makes it possible to say whether HawkView and Microsoft reported
 * the same person. Both channels supply one; a match requires the same shape on
 * both sides and identical refs, because the ref may be wrapped and a wrapped
 * value only matches another wrapped identically.
 *
 * The shape varies by tenant: Graph tenants carry a directory object GUID,
 * audit-fallback tenants have no GUID at all and resolve by user principal
 * name. A join that assumed GUIDs would silently return nothing on most of the
 * estate, so nothing here compares refs across shapes.
 *
 * `available: false` is a statement about capability, not a failure — it
 * carries the reason, so the row can say "Microsoft's channel requires Entra ID
 * P2" rather than shrugging.
 */
export type CorrelationRef =
  | {
      available: true
      shape: 'DIRECTORY_OBJECT_ID' | 'USER_PRINCIPAL_NAME'
      ref: string
    }
  | { available: false; because: string }

export type MicrosoftEntraRiskyUser = {
  id: string
  identityLabel: string
  /** Optional on the wire; null from a server that does not send one. */
  correlation: CorrelationRef | null
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
  /**
   * The check cannot run on this tenant's evidence at all — the audit-log
   * fallback carries no conditional-access status, device detail or risk
   * fields, so some checks have nothing to execute against.
   *
   * This is not incomplete evidence and not a failure. It bounds what any
   * result from this tenant can claim, so it travels with the count as scope
   * rather than being reported as a gap in collection.
   */
  | 'INAPPLICABLE'
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
  /** Collection succeeded and the window held nothing to evaluate.
   *
   * Distinct from WAITING_FOR_COLLECTION, which means we have not looked yet,
   * and from INCOMPLETE_WINDOW, which means we looked at part of it. Here we
   * looked at all of it and it was empty -- so the rule did not run, and any
   * screen reporting it as assessed is stating a result nobody measured. */
  | 'NO_EVIDENCE_IN_WINDOW'
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
  /** The tenant's evidence does not carry the fields this check needs. */
  | 'CHECK_NOT_APPLICABLE'
  /** Findings exist but cannot be attributed to a person. */
  | 'UNRESOLVED_SUBJECT_IDENTITY'
  /** Evidence carries codes or events outside HawkView's vocabulary. */
  | 'UNINTERPRETABLE_EVIDENCE'

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

/**
 * When a finding's timestamp marks something happening, and when it marks
 * HawkView looking.
 *
 * The kind travels with the value rather than being looked up from the signal's
 * name or the rule's id. A name is a proxy for the kind in the same way an id
 * is, so keying on one would move the convention rather than remove it -- and a
 * convention held somewhere else is what produced "3 records, last 3:04 p.m."
 * for a mailbox that had simply been read.
 */
export type SignalInstant = {
  at: string
  kind: 'EVENT_OCCURRED' | 'STATE_OBSERVED'
}

/**
 * One reason inside a finding, with its own volume and its own recency.
 *
 * A finding is per subject per detector and can rest on several signals at
 * once: on the fleet today one account carries 462 lockouts that stopped on 3
 * September beside 12 password rejections from the 9th. Those are one finding
 * and two facts, and a surface that shows one count and one date for it states
 * the quieter signal's recency over the louder signal's volume.
 *
 * A null instant means the signal was evaluated and nothing occurred. A signal
 * missing from the array was never evaluated. The two must not be collapsed,
 * and neither may be read as a floor when the count is capped -- a capped zero
 * is the absence of a reading, not a finding of none.
 */
export type FindingSignal = {
  signal: string
  count: number
  latest: SignalInstant | null
  capped: boolean
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
  /**
   * Present only on servers that speak it. Absent -- the key missing, never an
   * empty array -- means this response predates the field, and the
   * finding-level count and dates above are read instead.
   *
   * Non-empty when present. An empty array would say every signal was never
   * evaluated, which is a finding resting on nothing rather than an ambiguous
   * one, so it is rejected rather than tolerated.
   */
  signals: FindingSignal[] | null
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
  /**
   * Resolved at read time for authorised callers and never persisted in the
   * finding row. Null when the server does not supply it, in which case the
   * list shows the opaque reference rather than inventing an identity.
   */
  displayName: string | null
  userPrincipalName: string | null
  correlation: CorrelationRef | null
  subjectType: 'USER' | 'MAILBOX'
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | null
  protection: RiskProtection
  findings: RiskAssessmentFinding[]
}

export type RiskAssessmentCountAccuracy = 'EXACT' | 'AT_LEAST' | 'UNKNOWN'

/**
 * Why an exact tenant total was not claimed. Optional on the wire; a server
 * that omits it yields null, and the UI says the cause was not reported rather
 * than inventing one. These must never be collapsed into a single generic
 * string: "we could not confirm whether these mailboxes belong to people" and
 * "we could not interpret some sign-in events" send a technician to different
 * places.
 */
/**
 * The rebuilt engine's own withholding vocabulary, carried rather than mapped.
 *
 * These are not translated into the older reasons above. Several are close
 * enough that a mapping would look reasonable and lose the distinction that
 * makes them worth having: NEVER_COLLECTED and a stale collection both leave a
 * tenant without current evidence, and "we have not collected since August" and
 * "we have never successfully collected" are different sentences to put in
 * front of an MSP. One is a gap; the other is a tenant that was never wired up.
 *
 * NOTHING_APPLICABLE is the one most easily misread as a result. It means no
 * evidence was in scope for any detector, which is a statement about scope and
 * not about the tenant -- the checks had nothing to examine rather than
 * examining and finding nobody.
 */
export type NativeWithheldReason =
  | 'NEVER_COLLECTED'
  | 'UNREADABLE_NOW'
  | 'UNINTERPRETED_EVENTS'
  | 'NOTHING_APPLICABLE'
  | 'CAPACITY_EXCEEDED'
  | 'DETECTOR_FAILED'
  | 'UNRESOLVED_SUBJECT_IDENTITY'

export type RiskAssessmentCountReason =
  /** The count is withheld because the window held nothing to count, not
   *  because counting was interrupted. See [RiskAssessmentReason]. */
  | 'NO_EVIDENCE_IN_WINDOW'
  | 'UNRESOLVED_SUBJECT_IDENTITY'
  | 'UNINTERPRETABLE_EVIDENCE'
  | 'CAPACITY_LIMIT'
  | 'INCOMPLETE_WINDOW'
  | 'COLLECTION_STALE'
  | 'SOURCE_UNAVAILABLE'

export type RiskAssessmentSummary = {
  scope: 'TENANT'
  asOf: string | null
  currentUsers: {
    value: number | null
    accuracy: RiskAssessmentCountAccuracy
    /**
     * Every reason the exact claim was withheld, not the first one. Several can
     * hold at once — unresolved mailbox bindings and uninterpretable sign-in
     * codes are independent problems and a tenant can have both. Rendering one
     * of four reads as "this is the reason", which is the same defect as
     * rendering one true sentence where another belongs.
     *
     * Empty means no reason was reported, which the UI admits rather than
     * filling in.
     */
    reasons: RiskAssessmentCountReason[]
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
