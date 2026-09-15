import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '../generated/prisma/client.js'
import type { TenantAssessment } from '../evaluation-core/compose.js'
import { IDENTITY_RISK_RUN_RETENTION_MS } from '../identity-risk/identity-risk.contract.js'
import { intakeRowsFor, NATIVE_RULE_ID } from './publish-to-intake.js'
import { persistRun, runKeyFor, RUN_STATUS, type PersistRunInput } from './persist-run.js'
import { encodeRunFindings } from './run-findings.js'

const MARKER = 'nativeAlertPublication'
const PUBLICATION_VERSION = 1
export type NativePublication = 'PUBLISHED' | 'ALREADY_PUBLISHED' | 'HISTORICAL_NOT_REPLAYED' | 'OLDER_WINDOW_NOT_PUBLISHED'

/** Source occurrence, not evaluation time: reevaluating old evidence cannot
 * move it across the operator's no-replay watermark. Only the one approved
 * native detector is admitted; new detectors need their own reviewed mapping. */
export function nativePublicationRows(assessment: TenantAssessment, input: PersistRunInput, runId: string) {
  const pairs = intakeRowsFor({
    ...input, evaluationRunId: runId, findings: assessment.findings.items,
    observedAt: input.completedAt,
  })
  return pairs.map((pair, index) => {
    const finding = assessment.findings.items[index]!
    if (finding.detectorId !== 'repeated-credential-failure' ||
        pair.finding.subjectType !== 'USER' || !pair.finding.subjectId ||
        pair.finding.subjectId.length > 128) throw new Error('NATIVE_PUBLICATION_INVALID_FINDING')
    const times = finding.signals.filter(signal => signal.count > 0).map(signal => {
      if (signal.latest?.kind !== 'EVENT_OCCURRED') throw new Error('NATIVE_PUBLICATION_INVALID_OBSERVATION')
      const time = Date.parse(signal.latest.at)
      if (!Number.isFinite(time) || time < input.windowStart.getTime() ||
          time > input.windowEnd.getTime()) throw new Error('NATIVE_PUBLICATION_INVALID_OBSERVATION')
      return time
    })
    if (times.length === 0) throw new Error('NATIVE_PUBLICATION_INVALID_OBSERVATION')
    const observedAt = new Date(Math.max(...times))
    const expiresAt = new Date(Math.min(input.expiresAt.getTime(), observedAt.getTime() + IDENTITY_RISK_RUN_RETENTION_MS))
    return { pair, observedAt, expiresAt }
  }).filter(row => row.expiresAt.getTime() > input.completedAt.getTime())
}

/** A finding list can be exhaustive without the evidence supporting an exact
 * no-match claim. Reuse BOTH authoritative core facts; unknown/stale input must
 * not close a previously observed finding. */
export const mayResolveNativeAbsence = (assessment: TenantAssessment): boolean =>
  assessment.findings.complete && assessment.claim.permitted

function priorPublication(value: unknown): NativePublication {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(MARKER in value)) {
    // Existing pre-bridge native runs are not automatically backfilled. A run
    // key alone is not proof that the alert publisher ever committed.
    return 'HISTORICAL_NOT_REPLAYED'
  }
  const marker = (value as Record<string, unknown>)[MARKER]
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error('NATIVE_PUBLICATION_INVALID_MARKER')
  const record = marker as Record<string, unknown>
  if (record.version !== PUBLICATION_VERSION) throw new Error('NATIVE_PUBLICATION_INVALID_MARKER')
  if (record.status === 'PUBLISHED') return 'ALREADY_PUBLISHED'
  if (record.status === 'OLDER_WINDOW_NOT_PUBLISHED') return 'OLDER_WINDOW_NOT_PUBLISHED'
  throw new Error('NATIVE_PUBLICATION_INVALID_MARKER')
}

// Fixed SQL, values supplied separately. Batches bound bind count/materialization;
// no concurrent per-finding queries are started inside the transaction.
const UPSERT_STANDING = `
 INSERT INTO identity_risk_findings AS existing
 (id, organization_id, customer_tenant_id, matched_result_id, dedupe_key,
  rule_id, rule_version, subject_type, subject_id, state, severity, confidence,
  coverage, observed_at, expires_at, created_at, updated_at)
 SELECT r.id, $1::uuid, $2::uuid, r.matched_id, r.dedupe_key,
  r.rule_id, r.rule_version, r.subject_type, r.subject_id, 'OPEN',
  'NOT_ASSESSED', 'NOT_ASSESSED', 'NOT_ASSESSED', r.observed_at, r.expires_at,
  $4::timestamptz, $4::timestamptz
 FROM jsonb_to_recordset($3::jsonb) AS r(
  id uuid, matched_id uuid, dedupe_key text, rule_id text, rule_version text,
  subject_type text, subject_id text, observed_at timestamptz, expires_at timestamptz)
 ON CONFLICT (organization_id, customer_tenant_id, dedupe_key) DO UPDATE SET
  matched_result_id = EXCLUDED.matched_result_id,
  severity = 'NOT_ASSESSED', confidence = 'NOT_ASSESSED', coverage = 'NOT_ASSESSED',
  observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at,
  updated_at = EXCLUDED.updated_at,
  state = CASE WHEN EXCLUDED.observed_at > existing.observed_at THEN 'OPEN' ELSE existing.state END
 WHERE existing.rule_id = EXCLUDED.rule_id
   AND existing.subject_type = EXCLUDED.subject_type AND existing.subject_id = EXCLUDED.subject_id
   AND EXCLUDED.observed_at >= existing.observed_at`

/** The real production seam. A marker, run and every parent/finding commit in
 * ONE transaction. Tenant row locking serializes publishers (including replay)
 * without holding a lock while source evaluation runs. No email is sent here. */
export async function publishNativeAssessment(
  prisma: PrismaClient, assessment: TenantAssessment, input: PersistRunInput,
): Promise<{ id: string; publication: NativePublication }> {
  return prisma.$transaction(async tx => {
    const scope = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM customer_tenants
       WHERE id = $1::uuid AND organization_id = $2::uuid AND status = 'ACTIVE' FOR UPDATE`,
      input.customerTenantId, input.organizationId,
    )
    if (scope.length !== 1) throw new Error('NATIVE_PUBLICATION_SCOPE_UNAVAILABLE')
    const existing = await tx.identityRiskEvaluationRun.findUnique({
      where: { organizationId_customerTenantId_runKey: {
        organizationId: input.organizationId, customerTenantId: input.customerTenantId, runKey: runKeyFor(input),
      } }, select: { id: true, evaluationFindings: true },
    })
    if (existing) return { id: existing.id, publication: priorPublication(existing.evaluationFindings) }

    const latest = await tx.identityRiskEvaluationRun.findFirst({
      where: { organizationId: input.organizationId, customerTenantId: input.customerTenantId, status: RUN_STATUS },
      orderBy: [{ windowEnd: 'desc' }, { id: 'desc' }], select: { windowEnd: true },
    })
    const { id } = await persistRun(tx as unknown as Parameters<typeof persistRun>[0], assessment, input)
    const publication = latest && latest.windowEnd.getTime() > input.windowEnd.getTime()
      ? 'OLDER_WINDOW_NOT_PUBLISHED' as const : 'PUBLISHED' as const
    if (publication === 'PUBLISHED') {
      const rows = nativePublicationRows(assessment, input, id)
      for (let offset = 0; offset < rows.length; offset += 128) {
        const batch = rows.slice(offset, offset + 128).map(row => ({ ...row, matchedId: randomUUID() }))
        await tx.identityRiskMatchedResult.createMany({ data: batch.map(row => ({
          id: row.matchedId, organizationId: input.organizationId, customerTenantId: input.customerTenantId,
          evaluationRunId: id, ...row.pair.matched,
          evidence: row.pair.matched.evidence as Prisma.InputJsonValue,
          observedAt: row.observedAt, expiresAt: input.expiresAt,
        })) })
        const payload = JSON.stringify(batch.map(row => ({
          id: randomUUID(), matched_id: row.matchedId, dedupe_key: row.pair.finding.dedupeKey,
          rule_id: row.pair.finding.ruleId, rule_version: row.pair.finding.ruleVersion,
          subject_type: row.pair.finding.subjectType, subject_id: row.pair.finding.subjectId,
          observed_at: row.observedAt.toISOString(), expires_at: row.expiresAt.toISOString(),
        })))
        await tx.$executeRawUnsafe(UPSERT_STANDING, input.organizationId, input.customerTenantId, payload, input.completedAt)
      }
      await tx.identityRiskFinding.updateMany({
        where: { organizationId: input.organizationId, customerTenantId: input.customerTenantId,
          ruleId: NATIVE_RULE_ID, state: 'OPEN', expiresAt: { lte: input.completedAt } },
        data: { state: 'EXPIRED', updatedAt: input.completedAt },
      })
      if (mayResolveNativeAbsence(assessment)) {
        await tx.identityRiskFinding.updateMany({
          where: { organizationId: input.organizationId, customerTenantId: input.customerTenantId,
            ruleId: NATIVE_RULE_ID, state: 'OPEN', observedAt: { lte: input.windowEnd },
            dedupeKey: { notIn: rows.map(row => row.pair.finding.dedupeKey) } },
          data: { state: 'RESOLVED', updatedAt: input.completedAt },
        })
      }
    }
    await tx.identityRiskEvaluationRun.update({ where: { id }, data: {
      evaluationFindings: { ...encodeRunFindings(assessment, input.sources),
        [MARKER]: { version: PUBLICATION_VERSION, status: publication } } as Prisma.InputJsonValue,
    } })
    return { id, publication }
  }, { maxWait: 5_000, timeout: 30_000 })
}
