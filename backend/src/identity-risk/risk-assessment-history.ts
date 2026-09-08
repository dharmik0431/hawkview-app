import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { ASSESSMENT_MAX_BYTES, ASSESSMENT_MAX_FINDINGS, ASSESSMENT_MAX_REFERENCES,
  ASSESSMENT_MAX_SUBJECTS, AUTH_COLLECTION_MAX_AGE_MS, projectStoredRiskAssessment, type StoredRiskAssessment } from './risk-assessment-projection.js'
import type { RiskAssessmentFindingDto } from './identity-risk-assessment.contract.js'

export const findingActivityMs = (ruleId: string) => ruleId === 'HV-ID-AUTH-010.v1' ? 15 * 60_000
  : ruleId === 'HV-ID-AUTH-005.v2' ? 10 * 60_000 : 36 * 60 * 60_000
export function findingRetentionExpiry(finding: Pick<RiskAssessmentFindingDto, 'lastSeen'>): Date {
  // Replay does not move lastSeen. Only a new validated event/observation can do so.
  return new Date(Date.parse(finding.lastSeen) + 90 * 24 * 60 * 60_000)
}
type Scope = { organizationId: string; customerTenantId: string }

export async function readAssessmentHistory(scope: Scope, keyVersionId: string, metadata: StoredRiskAssessment, now: Date, deadlineAt: number): Promise<{ subjects: StoredRiskAssessment['subjects']; capped: boolean }> {
  const rows = await withMailboxReadTransaction(deadlineAt, 4000, async client => (await client.query<{ evidence: unknown; capped: boolean }>(`
    WITH candidates AS MATERIALIZED (
      SELECT f.id, m.evidence, octet_length(m.evidence::text) AS bytes
      FROM identity_risk_findings f
      JOIN identity_risk_matched_results m ON m.id=f.matched_result_id
        AND m.organization_id=f.organization_id AND m.customer_tenant_id=f.customer_tenant_id
      JOIN identity_risk_evaluation_runs r ON r.id=m.evaluation_run_id
        AND r.organization_id=f.organization_id AND r.customer_tenant_id=f.customer_tenant_id
      WHERE f.organization_id=$1::uuid AND f.customer_tenant_id=$2::uuid
        AND f.expires_at>$3 AND m.expires_at>$3 AND r.pseudonym_key_version_id=$4::uuid
        AND m.evidence->>'schemaVersion'='hawkview-risk-assessment/v1'
      ORDER BY f.observed_at DESC,f.id DESC LIMIT 201
    ), limits AS (SELECT count(*)>200 OR COALESCE(sum(bytes),0)>$5 OR COALESCE(max(bytes),0)>65536 AS capped FROM candidates)
    SELECT CASE WHEN NOT limits.capped THEN candidates.evidence ELSE NULL END AS evidence,limits.capped
    FROM limits LEFT JOIN candidates ON NOT limits.capped`,
  [scope.organizationId, scope.customerTenantId, now, keyVersionId, ASSESSMENT_MAX_BYTES])).rows)
  if (rows.some(row => row.capped)) return { subjects: [], capped: true }
  const subjects = new Map<string, StoredRiskAssessment['subjects'][number]>()
  for (const row of rows) {
    if (row.evidence === null) continue
    const envelope = row.evidence as { schemaVersion?: unknown; subject?: unknown }
    const validated = projectStoredRiskAssessment({ ...metadata, subjects: [envelope?.subject] }, now, 'PERSISTED_HISTORY')
    if (!validated) return { subjects: [], capped: true }
    const subject = validated.subjects[0]!
    const previous = subjects.get(subject.id)
    if (previous && previous.subjectType !== subject.subjectType) return { subjects: [], capped: true }
    subjects.set(subject.id, { ...subject, findings: [...previous?.findings ?? [], ...subject.findings] })
  }
  if (subjects.size > ASSESSMENT_MAX_SUBJECTS) return { subjects: [], capped: true }
  return { subjects: [...subjects.values()], capped: false }
}

/** Distinguish retained history from current evidence without resetting incident
 * clocks. Merge only exact opaque subject/application/client/source domains. */
export function reconcileAssessmentHistory(current: StoredRiskAssessment, previous: StoredRiskAssessment['subjects'], now: Date,
  invalidEvidenceReferences: ReadonlySet<string> = new Set()): StoredRiskAssessment {
  const subjects = new Map<string, { id: string; subjectType: 'USER' | 'MAILBOX'; findings: RiskAssessmentFindingDto[] }>()
  const add = (id: string, subjectType: 'USER' | 'MAILBOX', finding: RiskAssessmentFindingDto) => {
    const subject = subjects.get(id) ?? { id, subjectType, findings: [] }
    if (subject.subjectType !== subjectType) throw new Error('IDENTITY_RISK_SUBJECT_CONFLICT')
    subject.findings.push(finding); subjects.set(id, subject)
  }
  for (const subject of previous) for (const finding of subject.findings) {
    if (findingRetentionExpiry(finding) <= now) continue
    const source = current.sources.find(source => source.source === finding.selectedSource)
    const rule = current.rules.find(rule => rule.ruleId === finding.ruleId)
    const sourceCurrent = rule?.selectedSource === finding.selectedSource && ['READY','PARTIAL'].includes(rule.status) && source &&
      (source.status === 'READY' || (source.status === 'PARTIAL' && finding.evaluatedAt === rule.evaluatedAt && ['READY','PARTIAL'].includes(rule.status))) && source.freshness === 'CURRENT' &&
      source.lastSuccessfulCollectionAt !== null && now.getTime() - Date.parse(source.lastSuccessfulCollectionAt) <=
        (finding.selectedSource === 'MAILBOX_RULES' ? 36 * 60 * 60_000 : AUTH_COLLECTION_MAX_AGE_MS)
    const disputed = finding.evidenceReferences.some(ref => invalidEvidenceReferences.has(ref.id)) ||
      (finding.evidenceCountCapped && invalidEvidenceReferences.size > 0)
    const historical = now.getTime() > Date.parse(finding.activityWindowEndsAt)
    add(subject.id, subject.subjectType, { ...finding, activityState: historical ? 'HISTORICAL'
      : disputed || !sourceCurrent || finding.activityState === 'UNKNOWN' ? 'UNKNOWN' : finding.activityState })
  }
  for (const subject of current.subjects) for (const projected of subject.findings) {
    const invalid = projected.evidenceReferences.some(ref => invalidEvidenceReferences.has(ref.id)) ||
      (projected.evidenceCountCapped && invalidEvidenceReferences.size > 0)
    const finding: RiskAssessmentFindingDto = invalid ? {...projected,activityState:'UNKNOWN'} : projected
    const retained = subjects.get(subject.id)?.findings.find(prior => prior.ruleId === finding.ruleId &&
      prior.selectedSource === finding.selectedSource && prior.application.id === finding.application.id &&
      prior.clientSource.reference === finding.clientSource.reference &&
      Date.parse(finding.firstSeen) <= Date.parse(prior.activityWindowEndsAt) &&
      Date.parse(prior.firstSeen) <= Date.parse(finding.activityWindowEndsAt))
    if (!retained) { add(subject.id, subject.subjectType, finding); continue }
    const validPrior = retained.activityState !== 'UNKNOWN'
    const refs = [...new Map([...(validPrior ? retained.evidenceReferences : []), ...finding.evidenceReferences].map(ref => [ref.id, ref])).values()]
      .filter(ref => !invalidEvidenceReferences.has(ref.id)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
    const countUncertain = refs.length > ASSESSMENT_MAX_REFERENCES || retained.evidenceCountCapped || finding.evidenceCountCapped
    const combined: RiskAssessmentFindingDto = { ...finding, id: retained.id,
      firstSeen: validPrior && retained.firstSeen < finding.firstSeen ? retained.firstSeen : finding.firstSeen,
      lastSeen: validPrior && retained.lastSeen > finding.lastSeen ? retained.lastSeen : finding.lastSeen,
      activityWindowEndsAt: validPrior && retained.activityWindowEndsAt > finding.activityWindowEndsAt ? retained.activityWindowEndsAt : finding.activityWindowEndsAt,
      evidenceReferences: refs.slice(-ASSESSMENT_MAX_REFERENCES), evidenceCount: countUncertain ? Math.max(finding.evidenceCount, validPrior ? retained.evidenceCount : 0, refs.length) : refs.length,
      evidenceCountCapped: countUncertain,
    }
    const collection = subjects.get(subject.id)!.findings
    collection[collection.indexOf(retained)] = combined
  }
  const all = [...subjects.values()]
  if (all.length > ASSESSMENT_MAX_SUBJECTS || all.reduce((count, subject) => count + subject.findings.length, 0) > ASSESSMENT_MAX_FINDINGS)
    throw new Error('IDENTITY_RISK_ASSESSMENT_CAPACITY')
  return { ...current, subjects: all }
}
