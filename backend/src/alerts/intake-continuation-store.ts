import { FINDINGS_PER_CHUNK, MAX_FINDINGS_PER_TICK } from './finding-pipeline.js'
import type { SqlRunner } from './pipeline-store.js'
import type { IntakeSourceSnapshot } from './intake-continuation-policy.js'

/**
 * Inactive candidate reader for the proposed receipt-backed intake. No production
 * service calls this module. The existing global finding index cannot serve this
 * order; an online index and disposable-DB plan proof are activation requirements.
 */
export type IntakeLaneBudgets = Readonly<{ recent: number; old: number }>
export type IntakeLanePage = Readonly<{
  findings: readonly IntakeSourceSnapshot[]
  truncated: boolean
}>
export type IntakeCandidatePages = Readonly<{ recent: IntakeLanePage; old: IntakeLanePage }>

type CandidateRow = Readonly<{
  id: string
  organization_id: string
  customer_tenant_id: string
  matched_result_id: string
  dedupe_key: string
  rule_id: string
  rule_version: string
  subject_type: string
  subject_id: string
  state: string
  severity: string
  confidence: string
  coverage: string
  observed_at_exact: string
  expires_at_exact: string
  updated_at_exact: string
}>

function validateBudgets(budgets: IntakeLaneBudgets): void {
  if (!Number.isSafeInteger(budgets.recent) || !Number.isSafeInteger(budgets.old) ||
      budgets.recent < FINDINGS_PER_CHUNK || budgets.old < FINDINGS_PER_CHUNK ||
      budgets.recent + budgets.old > MAX_FINDINGS_PER_TICK) {
    throw new Error('INVALID_INTAKE_LANE_BUDGETS')
  }
}

function mapRow(row: CandidateRow): IntakeSourceSnapshot {
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerTenantId: row.customer_tenant_id,
    matchedResultId: row.matched_result_id,
    dedupeKey: row.dedupe_key,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    state: row.state,
    severity: row.severity,
    confidence: row.confidence,
    coverage: row.coverage,
    observedAt: row.observed_at_exact,
    expiresAt: row.expires_at_exact,
    updatedAt: row.updated_at_exact,
  }
}

async function readLane(
  runner: SqlRunner,
  lane: 'recent' | 'old',
  tickAtIso: string,
  mappingRevision: string,
  cap: number,
): Promise<IntakeLanePage> {
  // The two lane predicates are complements at the same sampled tick. Keep
  // receipt eligibility IN the database WHERE clause, ahead of ORDER/LIMIT:
  // filtering the first 5,001 rows in JS recreates the starvation bug.
  const lanePredicate = lane === 'recent'
    ? "f.observed_at >= $1::timestamptz - INTERVAL '24 hours'"
    : "f.observed_at < $1::timestamptz - INTERVAL '24 hours'"
  const rows = await runner.query<CandidateRow>(
    `SELECT f.id, f.organization_id, f.customer_tenant_id, f.matched_result_id,
            f.dedupe_key, f.rule_id, f.rule_version, f.subject_type, f.subject_id,
            f.state, f.severity, f.confidence, f.coverage,
            to_char(f.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_exact,
            to_char(f.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at_exact,
            to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact
       FROM identity_risk_findings f
       LEFT JOIN alert_finding_intake_status s ON s.finding_id = f.id
      WHERE f.state IN ('OPEN', 'UPDATED')
        AND isfinite(f.observed_at) AND isfinite(f.expires_at) AND isfinite(f.updated_at)
        AND f.observed_at <= $1::timestamptz AND ${lanePredicate}
        AND (
          s.finding_id IS NULL
          OR (
            s.organization_id = f.organization_id
            AND s.customer_tenant_id = f.customer_tenant_id
            AND s.outcome = 'BLOCKED_UNMAPPED'
            AND (
                s.source_rule_id IS DISTINCT FROM f.rule_id
                OR s.source_rule_version IS DISTINCT FROM f.rule_version
                OR s.mapping_revision IS DISTINCT FROM $2::varchar
            )
          )
        )
      ORDER BY f.observed_at, f.id
      LIMIT $3::int`,
    [tickAtIso, mappingRevision, cap + 1],
  )
  return { findings: rows.slice(0, cap).map(mapRow), truncated: rows.length > cap }
}

/** Budgets remain explicit until disposable-DB load measurements set a quota. */
export async function readIntakeCandidatePages(
  runner: SqlRunner,
  tickAtIso: string,
  mappingRevision: string,
  budgets: IntakeLaneBudgets,
): Promise<IntakeCandidatePages> {
  validateBudgets(budgets)
  if (!Number.isFinite(Date.parse(tickAtIso)) || !mappingRevision || mappingRevision.length > 64) {
    throw new Error('INVALID_INTAKE_SELECTION')
  }
  // Separate queries avoid an unbounded union/sort. Both use the same tickAt.
  let recent = await readLane(runner, 'recent', tickAtIso, mappingRevision, budgets.recent)
  let old = await readLane(runner, 'old', tickAtIso, mappingRevision, budgets.old)
  // An idle lane lends only its unused portion of the same bounded total. A
  // reread starts at the same stable order rather than using OFFSET, so a
  // concurrent source update is caught later by the strict write-time CAS.
  if (recent.findings.length < budgets.recent && old.truncated) {
    old = await readLane(runner, 'old', tickAtIso, mappingRevision,
      budgets.old + budgets.recent - recent.findings.length)
  } else if (old.findings.length < budgets.old && recent.truncated) {
    recent = await readLane(runner, 'recent', tickAtIso, mappingRevision,
      budgets.recent + budgets.old - old.findings.length)
  }
  return { recent, old }
}
