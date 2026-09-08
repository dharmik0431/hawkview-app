import {
  RISK_ASSESSMENT_SCHEMA, RISK_ASSESSMENT_RULE_IDS, RISK_ASSESSMENT_RULE_TUPLES,
  type RiskAssessmentFindingDto, type RiskAssessmentRuleId, type RiskAssessmentSource,
  type RiskAssessmentReason, type RiskSourceReadinessDto, type RiskRuleReadinessDto,
  type RiskProtectionDto, type RiskRecommendedActionDto,
} from './identity-risk-assessment.contract.js'
import type { IdentityRiskEnvelope } from './identity-risk.contract.js'

export const ASSESSMENT_MAX_BYTES = 1_000_000
export const ASSESSMENT_MAX_SUBJECTS = 100
export const ASSESSMENT_MAX_FINDINGS = 200
export const ASSESSMENT_MAX_REFERENCES = 50
export const AUTH_COLLECTION_MAX_AGE_MS = 60 * 60_000
export const ASSESSMENT_COPY = Object.freeze({
  'HV-ID-AUTH-010.v1': {
    title: 'Repeated invalid-credential attempts',
    explanation: 'At least 10 distinct invalid-credential attempts were recorded for this account and application within 15 minutes. This may reflect mistyped or outdated credentials or attempted unauthorized access. No successful access is established by this finding.',
    caveats: ['This is an investigation lead, not a compromised-account verdict. A source address is not required; no same-origin or attacker attribution is made.'],
  },
  'HV-ID-AUTH-005.v2': {
    title: 'Invalid credentials followed by successful sign-in',
    explanation: 'At least 5 distinct invalid-credential failures occurred within 10 minutes before a verified success for the same account, application and qualified client address. The final failure was within 2 minutes of success.',
    caveats: ['A shared address does not prove that the same person performed every event. Current protection does not establish that this historical sign-in used MFA.'],
  },
  'HV-ID-MBX-001.v1': {
    title: 'External mailbox forwarding',
    explanation: 'An enabled mailbox rule forwards or redirects to a destination outside the verified tenant domains reported by Microsoft Graph. This does not establish email delivery or data theft.',
    caveats: ['Verified Graph domains are not the Exchange accepted-domain configuration. Human investigation is required.'],
  },
})
const ACTIONS: Readonly<Record<RiskRecommendedActionDto['code'], string>> = Object.freeze({
  CONFIRM_EXPECTED_ACTIVITY: 'Confirm with the account owner whether the activity was expected.',
  REVIEW_SIGN_INS: 'Review the relevant sign-in evidence in the authorized Microsoft tenant.',
  CHECK_SAVED_CREDENTIALS: 'Check for outdated credentials saved in an application or device.',
  VERIFY_MFA_ENFORCEMENT: 'Verify current MFA enforcement and review event-specific authentication evidence separately.',
  REVIEW_MAILBOX_FORWARDING: 'Review the mailbox rule and confirm that its destinations are authorized.',
  FOLLOW_INCIDENT_PROCEDURE: 'If activity is unauthorized, follow your incident response procedure. HawkView does not make Microsoft account changes.',
})
export function assessmentActions(id: RiskAssessmentRuleId): RiskRecommendedActionDto[] {
  const codes: RiskRecommendedActionDto['code'][] = id === 'HV-ID-MBX-001.v1'
    ? ['REVIEW_MAILBOX_FORWARDING', 'FOLLOW_INCIDENT_PROCEDURE']
    : ['CONFIRM_EXPECTED_ACTIVITY', 'REVIEW_SIGN_INS', ...(id === 'HV-ID-AUTH-010.v1' ? ['CHECK_SAVED_CREDENTIALS' as const] : []), 'VERIFY_MFA_ENFORCEMENT', 'FOLLOW_INCIDENT_PROCEDURE']
  return codes.map(code => ({ code, text: ACTIONS[code] }))
}
export function assessmentReason(reason: RiskAssessmentReason): string {
  switch (reason) {
    case 'READY': case 'ATTESTED_COMPLETE': return 'The selected source meets this check’s evidence requirements for the reported window.'
    case 'WAITING_FOR_COLLECTION': return 'Waiting for the first usable collection.'
    case 'MISSING_PERMISSION': return 'The selected source requires a Microsoft read permission that is not available.'
    case 'LICENSE_REQUIRED': return 'Microsoft reported a licensing restriction for this source.'
    case 'COLLECTION_FAILED': return 'The latest source collection failed. Earlier evidence does not establish current coverage.'
    case 'COLLECTION_STALE': case 'DIRECTORY_SYNC_STALE': return 'Source evidence is stale; current coverage is not verified.'
    case 'USER_BINDING_UNRESOLVED': return 'The records cannot be safely bound to a resolved human identity.'
    case 'APPLICATION_BINDING_UNRESOLVED': return 'A qualified application identity is not available.'
    case 'CLIENT_SOURCE_UNQUALIFIED': return 'A qualified client address is required for this check. Other checks may still be evaluated.'
    case 'CONFLICTING_EVIDENCE': return 'Conflicting records prevent a reliable conclusion for the affected evidence.'
    case 'CAPACITY_LIMIT': return 'A bounded processing limit was reached. Coverage is partial, not complete.'
    case 'KEY_UNAVAILABLE': return 'Approved pseudonymization is unavailable; evaluation is not performed.'
    case 'EVALUATION_DISABLED': return 'Evaluation is disabled by configuration or an operational safety control.'
    case 'INSUFFICIENT_FIELDS': case 'UNSUPPORTED_RECORD': return 'The source does not contain all fields required for this check.'
    case 'EVALUATION_FAILED': return 'The latest evaluation did not complete. Current coverage is unknown.'
    default: return 'Required source evidence is incomplete or not attested; this check is not fully evaluated.'
  }
}

/** Persist only scoped opaque references, typed outcomes and code-owned copy.
 * Directory labels/protection are separately authorized read-time projections. */
export type StoredRiskAssessment = Readonly<{
  schemaVersion: typeof RISK_ASSESSMENT_SCHEMA
  sources: readonly RiskSourceReadinessDto[]
  rules: readonly RiskRuleReadinessDto[]
  subjects: readonly Readonly<{ id: string; subjectType: 'USER' | 'MAILBOX'; findings: readonly RiskAssessmentFindingDto[] }>[]
}>
const STATES = new Set(['READY', 'PARTIAL', 'WAITING', 'MISSING_PERMISSION', 'LICENSE_REQUIRED', 'STALE', 'FAILED', 'INSUFFICIENT_FIELDS', 'UNSUPPORTED', 'DISABLED'])
const REASONS = new Set(['READY', 'WAITING_FOR_COLLECTION', 'MISSING_PERMISSION', 'LICENSE_REQUIRED', 'COLLECTION_FAILED', 'COLLECTION_STALE', 'INCOMPLETE_WINDOW', 'SOURCE_UNAVAILABLE', 'INSUFFICIENT_FIELDS', 'USER_BINDING_UNRESOLVED', 'APPLICATION_BINDING_UNRESOLVED', 'CLIENT_SOURCE_UNQUALIFIED', 'UNSUPPORTED_RECORD', 'CONFLICTING_EVIDENCE', 'CAPACITY_LIMIT', 'EVALUATION_FAILED', 'EVALUATION_DISABLED', 'KEY_UNAVAILABLE', 'DIRECTORY_SYNC_MISSING', 'DIRECTORY_SYNC_NOT_SUCCEEDED', 'DIRECTORY_SYNC_UNDATED', 'DIRECTORY_SYNC_STALE', 'DIRECTORY_SYNC_NEWER_ATTEMPT', 'RULE_ENDPOINT_NOT_FOUND', 'RULE_VALIDATION_UNATTESTABLE', 'SOURCE_NOT_ATTESTED', 'ATTESTED_COMPLETE'])
const SOURCES = new Set(['M365_AUDIT_STS', 'GRAPH_SIGN_INS', 'MAILBOX_RULES'])
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function safeTree(value: unknown, budget = { nodes: 0 }, depth = 0): boolean {
  if (++budget.nodes > 100_000 || depth > 12) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 2048 && !/[\p{Cc}\p{Cf}]/u.test(value)
  if (Array.isArray(value)) return value.length <= 2000 && value.every(v => safeTree(v, budget, depth + 1))
  if (!record(value)) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    'value' in Object.getOwnPropertyDescriptor(value, key)! && safeTree(value[key], budget, depth + 1))
}
function keys(row: Record<string, unknown>, allowed: string): boolean {
  const expected = allowed.split(',').sort()
  return Object.keys(row).sort().join(',') === expected.join(',')
}
function time(value: unknown, now: Date): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  const stamp = new Date(value)
  return Number.isFinite(stamp.getTime()) && stamp.toISOString() === value && stamp.getTime() <= now.getTime()
}
function window(value: unknown, now: Date): boolean {
  return record(value) && keys(value, 'start,end') &&
    ((value.start === null && value.end === null) || (time(value.start, now) && time(value.end, now) && value.start <= value.end))
}
function reference(value: unknown, kind: string): value is string {
  return typeof value === 'string' && new RegExp(`^hvr1_(?:${kind})_[a-f0-9]{64}$`).test(value)
}
const count = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000

export function projectStoredRiskAssessment(value: unknown, now: Date): StoredRiskAssessment | null {
  try {
    if (!safeTree(value) || Buffer.byteLength(JSON.stringify(value)) > ASSESSMENT_MAX_BYTES || !record(value) ||
      !keys(value, 'schemaVersion,sources,rules,subjects') || value.schemaVersion !== RISK_ASSESSMENT_SCHEMA ||
      !Array.isArray(value.sources) || value.sources.length !== 3 || !Array.isArray(value.rules) || value.rules.length !== 3 ||
      !Array.isArray(value.subjects) || value.subjects.length > ASSESSMENT_MAX_SUBJECTS) return null
    for (const source of value.sources) {
      if (!record(source) || !keys(source, 'source,status,reasonCode,explanation,window,lastSuccessfulCollectionAt,latestEventAt,latestIngestionAt,freshness') ||
        !SOURCES.has(source.source as string) || !STATES.has(source.status as string) || !REASONS.has(source.reasonCode as string) ||
        !['CURRENT', 'STALE', 'UNKNOWN'].includes(source.freshness as string) || !window(source.window, now) ||
        ['lastSuccessfulCollectionAt', 'latestEventAt', 'latestIngestionAt'].some(key => source[key] !== null && !time(source[key], now))) return null
      if (source.status === 'READY' && (source.freshness !== 'CURRENT' || source.lastSuccessfulCollectionAt === null ||
        !['READY', 'ATTESTED_COMPLETE'].includes(source.reasonCode as string))) return null
    }
    if (new Set(value.sources.map(source => source.source)).size !== 3) return null
    for (const rule of value.rules) {
      if (!record(rule) || !keys(rule, 'ruleId,ruleVersion,title,status,reasonCode,explanation,selectedSource,window,evaluatedAt,assessedIdentities,matchedIdentities,countsCapped') ||
        !RISK_ASSESSMENT_RULE_IDS.includes(rule.ruleId as RiskAssessmentRuleId)) return null
      const tuple = RISK_ASSESSMENT_RULE_TUPLES[rule.ruleId as RiskAssessmentRuleId]
      if (rule.ruleVersion !== tuple.version || !STATES.has(rule.status as string) || !REASONS.has(rule.reasonCode as string) ||
        (rule.selectedSource !== null && !(tuple.sources as readonly string[]).includes(rule.selectedSource as string)) ||
        !window(rule.window, now) || (rule.evaluatedAt !== null && !time(rule.evaluatedAt, now)) ||
        [rule.assessedIdentities, rule.matchedIdentities].some(n => n !== null && !count(n)) || typeof rule.countsCapped !== 'boolean') return null
      if (rule.status === 'READY' && (rule.selectedSource === null || rule.evaluatedAt === null || rule.countsCapped ||
        rule.assessedIdentities === null || rule.matchedIdentities === null || rule.reasonCode !== 'READY' ||
        !value.sources.some(source => source.source === rule.selectedSource && source.status === 'READY'))) return null
    }
    if (new Set(value.rules.map(rule => rule.ruleId)).size !== 3) return null
    let findings = 0
    const subjectIds = new Set<string>()
    const findingIds = new Set<string>()
    for (const subject of value.subjects) {
      if (!record(subject) || !keys(subject, 'id,subjectType,findings') || !['USER', 'MAILBOX'].includes(subject.subjectType as string) ||
        !reference(subject.id, subject.subjectType === 'USER' ? 'subject' : 'mailbox') || subjectIds.has(subject.id) ||
        !Array.isArray(subject.findings) || !subject.findings.length) return null
      subjectIds.add(subject.id)
      for (const finding of subject.findings) {
        if (++findings > ASSESSMENT_MAX_FINDINGS || !record(finding) || !keys(finding, 'id,ruleId,ruleVersion,priority,confidence,activityState,title,explanation,firstSeen,lastSeen,evaluatedAt,window,evidenceCount,evidenceCountCapped,selectedSource,application,device,clientSource,evidenceReferences,eventProtection,caveats,recommendedActions') ||
          !RISK_ASSESSMENT_RULE_IDS.includes(finding.ruleId as RiskAssessmentRuleId) || !reference(finding.id, 'contribution') || findingIds.has(finding.id)) return null
        findingIds.add(finding.id)
        if (!record(finding.application) || !keys(finding.application, 'id,state,label') ||
          (finding.application.id !== null && !reference(finding.application.id, 'application')) ||
          !['RESOLVED', 'NOT_REPORTED'].includes(finding.application.state as string) || finding.application.label !== null ||
          (finding.application.state === 'RESOLVED' ? finding.application.id === null : finding.application.id !== null) ||
          !record(finding.device) || !keys(finding.device, 'state,label') || finding.device.label !== null ||
          !['NOT_REPORTED', 'INSUFFICIENT_FIELDS'].includes(finding.device.state as string) ||
          !record(finding.clientSource) || !keys(finding.clientSource, 'reference,qualification') ||
          (finding.clientSource.reference !== null && !reference(finding.clientSource.reference, 'context')) ||
          !['QUALIFIED', 'NOT_REPORTED', 'INSUFFICIENT_FIELDS'].includes(finding.clientSource.qualification as string) ||
          (finding.clientSource.qualification === 'QUALIFIED' && finding.clientSource.reference === null)) return null
        const tuple = RISK_ASSESSMENT_RULE_TUPLES[finding.ruleId as RiskAssessmentRuleId]
        if (finding.ruleVersion !== tuple.version || finding.priority !== tuple.priority || !(tuple.sources as readonly string[]).includes(finding.selectedSource as string) ||
          (finding.ruleId === 'HV-ID-MBX-001.v1') !== (subject.subjectType === 'MAILBOX') ||
          !['LOW', 'MEDIUM', 'HIGH'].includes(finding.confidence as string) || !['CURRENT', 'HISTORICAL', 'UNKNOWN'].includes(finding.activityState as string) ||
          !time(finding.firstSeen, now) || !time(finding.lastSeen, now) || !time(finding.evaluatedAt, now) || finding.firstSeen > finding.lastSeen ||
          finding.lastSeen > finding.evaluatedAt || !window(finding.window, now) || !count(finding.evidenceCount) || finding.evidenceCount === 0 ||
          typeof finding.evidenceCountCapped !== 'boolean' || !Array.isArray(finding.evidenceReferences) || finding.evidenceReferences.length > ASSESSMENT_MAX_REFERENCES ||
          !['MFA_SATISFIED', 'BLOCKED_BY_POLICY', 'NOT_REPORTED'].includes(finding.eventProtection as string)) return null
        const refs = new Set<string>()
        for (const ref of finding.evidenceReferences) {
          if (!record(ref) || !keys(ref, 'id,recordedAt,ingestedAt') || !reference(ref.id, 'evidence') || refs.has(ref.id) ||
            !time(ref.recordedAt, now) || (ref.ingestedAt !== null && !time(ref.ingestedAt, now))) return null
          refs.add(ref.id)
        }
      }
    }
    // Discard all stored free-form copy even if bounded. Never carry provider prose.
    const source = value as unknown as StoredRiskAssessment
    return {
      schemaVersion: RISK_ASSESSMENT_SCHEMA,
      sources: source.sources.map(row => ({ ...row, explanation: assessmentReason(row.reasonCode) })),
      rules: source.rules.map(row => ({ ...row, title: ASSESSMENT_COPY[row.ruleId].title, explanation: assessmentReason(row.reasonCode) })),
      subjects: source.subjects.map(row => ({ ...row, findings: row.findings.map(finding => ({ ...finding,
        ...ASSESSMENT_COPY[finding.ruleId], recommendedActions: assessmentActions(finding.ruleId),
      })) })),
    }
  } catch { return null }
}

export function unknownRiskProtection(): RiskProtectionDto {
  const evidence = { state: 'UNKNOWN', source: 'NOT_REPORTED', observedAt: null, freshness: 'UNKNOWN', reasonCode: 'NOT_REPORTED' } as const
  return {
    conditionalAccess: { contractVersion: 1, status: 'UNKNOWN', policies: [], source: 'EFFECTIVE_MFA_V1', freshness: 'UNKNOWN', observedAt: null, evaluatedAt: null, reasonCodes: ['EVIDENCE_UNAVAILABLE'] },
    securityDefaults: evidence, legacyPerUserMfa: evidence, registration: evidence,
    explanation: 'Protection is not verified. Registration, legacy per-user MFA, current Conditional Access and event MFA are independent facts.',
  }
}
export function assessmentMeta(data: StoredRiskAssessment, evaluatedAt: string | null, now: Date): IdentityRiskEnvelope {
  const usable = data.rules.filter(rule => rule.status === 'READY' || rule.status === 'PARTIAL')
  const full = data.rules.every(rule => rule.status === 'READY' && !rule.countsCapped && data.sources.some(source =>
    source.source === rule.selectedSource && source.status === 'READY' && source.freshness === 'CURRENT'))
  const current = evaluatedAt !== null && time(evaluatedAt, now) && now.getTime() - new Date(evaluatedAt).getTime() <= AUTH_COLLECTION_MAX_AGE_MS
  return { version: 1, channel: 'HAWKVIEW_IDENTITY_SIGNALS', engineVersion: 'hawkview-identity-engine/1', catalogVersion: 'hawkview-identity-signals/v1',
    evaluatedAt, capability: !current || !usable.length ? 'UNAVAILABLE' : full ? 'FULL' : 'PARTIAL',
    status: !current ? 'STALE' : !usable.length ? 'NOT_EVALUATED' : 'AVAILABLE',
    sourceLabel: 'HawkView independent identity evidence', observedAt: null,
    freshness: current && full ? 'CURRENT' : current && usable.length ? 'UNKNOWN' : evaluatedAt ? 'STALE' : 'UNKNOWN',
    limitation: current && full ? null : 'Coverage is limited to the individually reported source and rule evidence; missing results do not establish safety.',
  }
}
