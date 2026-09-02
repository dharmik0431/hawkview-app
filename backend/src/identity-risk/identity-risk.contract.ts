export type IdentitySignalOutcome = 'MATCHED' | 'NOT_MATCHED' | 'NOT_EVALUATED' | 'SUPPRESSED'
export type IdentitySignalCoverage = 'FULL' | 'PARTIAL' | 'UNAVAILABLE'
export type IdentitySignalContext = Readonly<{ organizationId: string; customerTenantId: string; evaluationAt: Date; engineVersion: string; sources: Readonly<Record<string, readonly Record<string, unknown>[]>> }>
export type IdentitySignalResult = Readonly<{ ruleId: string; ruleVersion: string; outcome: IdentitySignalOutcome; coverage: IdentitySignalCoverage; reasonCode?: string; subjectType?: string; subjectId?: string; severity?: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'; confidence?: 'LOW'|'MEDIUM'|'HIGH'; explanation?: Readonly<Record<string,string>>; observedAt?: Date }>
/** Formulas are supplied by the detector owner; platform owns source gating and persistence. */
export interface IdentitySignalDetector { readonly ruleId: string; evaluate(context: IdentitySignalContext): readonly IdentitySignalResult[] }

/** Public read contract. Frontend must reject any payload without version 1 + exact channel. */
export type IdentityRiskReadiness = 'AVAILABLE' | 'STALE' | 'LEARNING' | 'NOT_EVALUATED' | 'UNAVAILABLE' | 'ERROR'
export type IdentityRiskChannel = 'HAWKVIEW_IDENTITY_SIGNALS' | 'MICROSOFT_ENTRA_RISKY_USERS'
export type IdentityRiskReadDto = Readonly<{ version: 1; channel: IdentityRiskChannel; capability: IdentitySignalCoverage; status: IdentityRiskReadiness; sourceLabel: string; observedAt: string | null; freshness: 'CURRENT'|'STALE'|'UNKNOWN'; limitation: string | null }>
export type IdentityRiskFindingDto = Readonly<{
  id: string; state: 'OPEN'|'UPDATED'|'RESOLVED'|'EXPIRED'; severity: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'; confidence: 'LOW'|'MEDIUM'|'HIGH'; coverage: IdentitySignalCoverage
  title: string; affectedIdentity: Readonly<{ id: string; label: string; type: 'USER'|'MAILBOX'|'APPLICATION'|'UNKNOWN' }>
  investigationGuidanceCode: 'REVIEW_ACTIVITY'|'REVIEW_ACCESS'|'REVIEW_MAILBOX_RULE'|'REVIEW_CONFIGURATION'
  investigationGuidance: string; benignAlternativeCodes: readonly string[]; sourceLabels: readonly string[]; missingEvidenceLabels: readonly string[]; observedAt: string; ruleIds: readonly string[]
}>
