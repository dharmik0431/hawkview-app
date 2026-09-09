import { RISK_ASSESSMENT_RULE_IDS, type RiskAssessmentDto, type RiskAssessmentSummaryDto } from './identity-risk-assessment.contract.js'
import { ASSESSMENT_MAX_FINDINGS, ASSESSMENT_MAX_SUBJECTS, AUTH_COLLECTION_MAX_AGE_MS } from './risk-assessment-projection.js'

const mailboxMaxAge = 36 * 60 * 60_000
const timestamp = (value: string | null, now: number): number | null => {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed <= now ? parsed : null
}

/** Call only after the authorized reader returns its complete bounded projection.
 * No database/source access, labels, mailbox inference, or pagination traversal.
 * This is a count of supported current evidence, not a universal safety verdict.
 */
export function riskAssessmentSummary(assessment: RiskAssessmentDto, now = new Date()): RiskAssessmentSummaryDto {
  const clock = now.getTime()
  const completed = timestamp(assessment.meta.evaluatedAt, clock)
  const asOf = completed === null ? null : assessment.meta.evaluatedAt
  const unknown: RiskAssessmentSummaryDto = { scope: 'TENANT', asOf, currentUsers: { value: null, accuracy: 'UNKNOWN' } }
  if (completed === null || clock - completed > AUTH_COLLECTION_MAX_AGE_MS ||
    assessment.meta.status !== 'AVAILABLE' || assessment.meta.freshness === 'STALE' ||
    !['FULL', 'PARTIAL'].includes(assessment.meta.capability) ||
    assessment.page.hasMore || assessment.page.nextCursor !== null ||
    assessment.users.length > ASSESSMENT_MAX_SUBJECTS ||
    assessment.rules.length !== RISK_ASSESSMENT_RULE_IDS.length || assessment.sources.length !== 3 ||
    new Set(assessment.rules.map(rule => rule.ruleId)).size !== RISK_ASSESSMENT_RULE_IDS.length ||
    !assessment.rules.every(rule => RISK_ASSESSMENT_RULE_IDS.includes(rule.ruleId))) return unknown

  const sourceReady = (sourceId: string | null, complete: boolean) => {
    const source = assessment.sources.find(candidate => candidate.source === sourceId)
    if (!source || source.freshness !== 'CURRENT' ||
      !(complete ? source.status === 'READY' : ['READY', 'PARTIAL'].includes(source.status))) return false
    const collected = timestamp(source.lastSuccessfulCollectionAt, clock)
    return collected !== null && clock - collected <= (source.source === 'MAILBOX_RULES' ? mailboxMaxAge : AUTH_COLLECTION_MAX_AGE_MS)
  }
  const identities = new Set<string>()
  const subjectTypes = new Map<string, string>()
  let findingCount = 0
  for (const user of assessment.users) {
    findingCount += user.findings.length
    if (findingCount > ASSESSMENT_MAX_FINDINGS) return unknown
    const priorType = subjectTypes.get(user.id)
    if (priorType && priorType !== user.subjectType) return unknown
    subjectTypes.set(user.id, user.subjectType)
    if (user.subjectType !== 'USER') continue
    if (!/^hvr1_subject_[a-f0-9]{64}$/.test(user.id)) return unknown
    for (const finding of user.findings) {
      if (finding.activityState !== 'CURRENT') continue
      const endsAt = Date.parse(finding.activityWindowEndsAt)
      const rule = assessment.rules.find(candidate => candidate.ruleId === finding.ruleId)
      const firstSeen = timestamp(finding.firstSeen, clock)
      const lastSeen = timestamp(finding.lastSeen, clock)
      const evaluated = timestamp(finding.evaluatedAt, clock)
      // A CURRENT row can age while the authorized read is in flight. Do not
      // silently subtract it and contradict the returned list with an exact zero.
      if (!Number.isFinite(endsAt) || endsAt < clock || firstSeen === null || lastSeen === null || evaluated === null ||
        firstSeen > lastSeen || lastSeen > evaluated || !rule || timestamp(rule.evaluatedAt, clock) === null ||
        rule.selectedSource !== finding.selectedSource || !['READY', 'PARTIAL'].includes(rule.status) ||
        !sourceReady(finding.selectedSource, false)) return unknown
      identities.add(user.id)
    }
  }
  // Omitted bindings/history overflow already mark rules capped/partial in the reader.
  // hasMore=false is NOT an attestation of completeness.
  const complete = assessment.meta.capability === 'FULL' && assessment.meta.freshness === 'CURRENT' &&
    assessment.rules.every(rule => rule.status === 'READY' && !rule.countsCapped &&
      rule.assessedIdentities !== null && rule.matchedIdentities !== null &&
      timestamp(rule.evaluatedAt, clock) !== null && sourceReady(rule.selectedSource, true))
  if (complete) return { scope: 'TENANT', asOf, currentUsers: { value: identities.size, accuracy: 'EXACT' } }
  return identities.size > 0
    ? { scope: 'TENANT', asOf, currentUsers: { value: identities.size, accuracy: 'AT_LEAST' } }
    : unknown
}
