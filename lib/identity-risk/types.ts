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
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'hidden' | 'unknownFutureValue'
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

export type HawkViewIdentitySignalsView = {
  channel: 'HAWKVIEW_IDENTITY_SIGNALS'
  meta: IdentityRiskChannelMeta
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
