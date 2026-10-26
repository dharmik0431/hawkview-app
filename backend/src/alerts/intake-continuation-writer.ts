import {
  classifyLockedIntakeMode, intakeReviewReason, sameIntakeSourceSnapshot,
  type IntakeDecisionReceipt, type IntakeSourceSnapshot,
} from './intake-continuation-policy.js'
import type { SqlRunner } from './pipeline-store.js'

/** A future adapter must enforce both limits on the actual database transaction.
 * Prisma maps these to interactive transaction maxWait/timeout; the physical
 * test adapter must bound its BEGIN-to-COMMIT interval too. Plain SqlRunner
 * is insufficient. Unit mocks only verify the requested limits. */
export type IntakeReceiptTransactionLimits = Readonly<{ maxWaitMs: number; timeoutMs: number }>
export interface IntakeReceiptRunner extends SqlRunner {
  transactionWithLimits<T>(
    limits: IntakeReceiptTransactionLimits,
    run: (tx: SqlRunner) => Promise<T>,
  ): Promise<T>
}

// Provisional one-finding bounds. Physical database and intake-budget tests
// must establish throughput before this inactive seam can be wired in.
export const INTAKE_RECEIPT_TRANSACTION_LIMITS = { maxWaitMs: 250, timeoutMs: 3_500 } as const
const INTAKE_RECEIPT_LOCK_WAIT_MS = 500
const INTAKE_RECEIPT_STATEMENT_MS = 2_500

/**
 * Inactive HAW-19 writer seam. No production service imports this module.
 * It is deliberately one finding per transaction until the registered physical
 * database test establishes safe chunk locking, timing and throughput.
 *
 * The callback may make database writes through the supplied transaction only.
 * It must never send email, call Microsoft or perform other external I/O while
 * holding a finding lock. The receipt is claimed first in the same transaction;
 * any callback failure rolls both the claim and its effects back.
 */
export type IntakeReceiptWriteResult =
  | Readonly<{ kind: 'COMMITTED' }>
  | Readonly<{ kind: 'REFUSED'; reason: 'SOURCE_MISSING_OR_MOVED' | 'SOURCE_CHANGED'
      | 'ALREADY_DECIDED' | 'INACTIVE' | 'SCOPE_MISMATCH'
      | 'HISTORICAL_ONLY' | 'UNTRUSTED_TIME' | 'INELIGIBLE' }>

type SourceRow = Readonly<{
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

type ReceiptRow = Readonly<{
  finding_id: string
  organization_id: string
  customer_tenant_id: string
  source_rule_id: string
  source_rule_version: string
  outcome: IntakeDecisionReceipt['outcome']
  mapping_revision: string
}>

type DecisionClockRow = Readonly<{ decided_at_exact: string }>

async function lockedDecisionClock(tx: SqlRunner): Promise<string> {
  const rows = await tx.query<DecisionClockRow>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at_exact`,
    [],
  )
  return rows.length === 1 ? rows[0]?.decided_at_exact ?? '' : ''
}

function sourceFromRow(row: SourceRow): IntakeSourceSnapshot {
  return {
    id: row.id, organizationId: row.organization_id,
    customerTenantId: row.customer_tenant_id, matchedResultId: row.matched_result_id,
    dedupeKey: row.dedupe_key, ruleId: row.rule_id, ruleVersion: row.rule_version,
    subjectType: row.subject_type, subjectId: row.subject_id, state: row.state,
    severity: row.severity, confidence: row.confidence, coverage: row.coverage,
    observedAt: row.observed_at_exact, expiresAt: row.expires_at_exact,
    updatedAt: row.updated_at_exact,
  }
}

function receiptFromRow(row: ReceiptRow): IntakeDecisionReceipt {
  return {
    findingId: row.finding_id, organizationId: row.organization_id,
    customerTenantId: row.customer_tenant_id, ruleId: row.source_rule_id,
    ruleVersion: row.source_rule_version, outcome: row.outcome,
    mappingRevision: row.mapping_revision,
  }
}

export async function commitActiveIntakeReceipt(
  runner: IntakeReceiptRunner,
  selected: IntakeSourceSnapshot,
  mappingRevision: string,
  outcome: 'COMPLETED' | 'BLOCKED_UNMAPPED',
  writeEffects: (tx: SqlRunner) => Promise<void>,
): Promise<IntakeReceiptWriteResult> {
  if (!mappingRevision || mappingRevision.length > 64 ||
      (outcome !== 'COMPLETED' && outcome !== 'BLOCKED_UNMAPPED')) {
    throw new Error('INVALID_INTAKE_RECEIPT_INPUT')
  }
  return runner.transactionWithLimits(INTAKE_RECEIPT_TRANSACTION_LIMITS, async tx => {
    // NOWAIT below covers the finding row only. Bound receipt/foreign-key and
    // table-lock waits, and every SQL statement, without changing pool defaults.
    await tx.execute(`SET LOCAL lock_timeout = '${INTAKE_RECEIPT_LOCK_WAIT_MS}ms'`, [])
    await tx.execute(`SET LOCAL statement_timeout = '${INTAKE_RECEIPT_STATEMENT_MS}ms'`, [])
    // Lock the exact source scope. NOWAIT returns a retryable transaction error
    // rather than spending collection's time waiting behind evaluation or
    // retention. The latter also locks finding rows before deletion.
    const locked = await tx.query<SourceRow>(
      `SELECT f.id, f.organization_id, f.customer_tenant_id, f.matched_result_id,
              f.dedupe_key, f.rule_id, f.rule_version, f.subject_type, f.subject_id,
              f.state, f.severity, f.confidence, f.coverage,
              to_char(f.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_exact,
              to_char(f.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at_exact,
              to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact
         FROM identity_risk_findings f
        WHERE f.id = $1::uuid AND f.organization_id = $2::uuid
          AND f.customer_tenant_id = $3::uuid
        FOR UPDATE OF f NOWAIT`,
      [selected.id, selected.organizationId, selected.customerTenantId],
    )
    const current = locked[0]
    if (!current) return { kind: 'REFUSED', reason: 'SOURCE_MISSING_OR_MOVED' }
    const lockedSource = sourceFromRow(current)
    if (!sameIntakeSourceSnapshot(selected, lockedSource)) {
      return { kind: 'REFUSED', reason: 'SOURCE_CHANGED' }
    }

    const priorRows = await tx.query<ReceiptRow>(
      `SELECT finding_id, organization_id, customer_tenant_id,
              source_rule_id, source_rule_version, outcome, mapping_revision
         FROM alert_finding_intake_status
        WHERE finding_id = $1::uuid FOR UPDATE`,
      [selected.id],
    )
    const review = intakeReviewReason(selected,
      priorRows[0] ? receiptFromRow(priorRows[0]) : null, mappingRevision)
    if (review === 'SCOPE_MISMATCH' || review === 'IDENTITY_CHANGED') {
      return { kind: 'REFUSED', reason: 'SCOPE_MISMATCH' }
    }
    if (review !== 'UNSEEN' && review !== 'MAPPING_CHANGED' && review !== 'INACTIVE') {
      return { kind: 'REFUSED', reason: 'ALREADY_DECIDED' }
    }

    // PostgreSQL now()/CURRENT_TIMESTAMP are transaction-start clocks. Read
    // clock_timestamp() once, after both row locks, so a finding that aged out
    // while waiting cannot enter the active-effects path. This inactive seam
    // refuses historical/untrusted findings until a separate history writer
    // can durably record them without notifications or email.
    const mode = classifyLockedIntakeMode(lockedSource, await lockedDecisionClock(tx))
    if (mode.kind !== 'ACTIVE_ELIGIBLE') return { kind: 'REFUSED', reason: mode.kind }
    if (review === 'INACTIVE') return { kind: 'REFUSED', reason: 'INACTIVE' }

    // This conditional write is the claim. A second writer that did not take
    // the source lock cannot overwrite a terminal receipt. Both the claim and
    // database-only effects become visible on commit, or neither does.
    const claimed = await tx.execute(
      `INSERT INTO alert_finding_intake_status
         (finding_id, organization_id, customer_tenant_id, source_rule_id,
          source_rule_version, outcome, mapping_revision, decided_at,
          next_cleanup_check_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
               $8::timestamptz, $8::timestamptz + INTERVAL '2160 hours', now(), now())
       ON CONFLICT (finding_id) DO UPDATE SET
         source_rule_id = EXCLUDED.source_rule_id,
         source_rule_version = EXCLUDED.source_rule_version,
         outcome = EXCLUDED.outcome,
         mapping_revision = EXCLUDED.mapping_revision,
         decided_at = EXCLUDED.decided_at,
         next_cleanup_check_at = EXCLUDED.next_cleanup_check_at,
         updated_at = now()
       WHERE alert_finding_intake_status.organization_id = EXCLUDED.organization_id
         AND alert_finding_intake_status.customer_tenant_id = EXCLUDED.customer_tenant_id
         AND alert_finding_intake_status.outcome = 'BLOCKED_UNMAPPED'
         AND (alert_finding_intake_status.source_rule_id IS DISTINCT FROM EXCLUDED.source_rule_id
           OR alert_finding_intake_status.source_rule_version IS DISTINCT FROM EXCLUDED.source_rule_version
           OR alert_finding_intake_status.mapping_revision IS DISTINCT FROM EXCLUDED.mapping_revision)`,
      [selected.id, selected.organizationId, selected.customerTenantId,
        selected.ruleId, selected.ruleVersion, outcome, mappingRevision, mode.processedAtExact],
    )
    if (claimed !== 1) throw new Error('INTAKE_RECEIPT_CLAIM_LOST')
    await writeEffects(tx)
    // A database-only callback can cross the observation-age or expiry edge.
    // Throw rather than returning REFUSED: the transaction must roll back both
    // its receipt and effects. This is a pre-commit check, not proof of the
    // exact commit instant or of any external send path.
    const finalMode = classifyLockedIntakeMode(lockedSource, await lockedDecisionClock(tx))
    if (finalMode.kind !== 'ACTIVE_ELIGIBLE') {
      throw new Error('INTAKE_ACTIVE_EFFECT_BOUNDARY_CROSSED')
    }
    return { kind: 'COMMITTED' }
  })
}
