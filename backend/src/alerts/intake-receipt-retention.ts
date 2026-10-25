import type { SqlRunner } from './pipeline-store.js'

/**
 * Inactive bounded cleanup for the proposed minimal intake receipt. No
 * scheduler calls this yet. The receipt stores no subject or dedupe value;
 * while a finding exists, its small decision tombstone must remain so the
 * selector cannot resurrect a notice after its next evaluation refresh.
 * Once the source finding is gone, this due queue deletes the tombstone.
 */
export const INTAKE_RECEIPT_CLEANUP_BATCH = 256

type DueReceipt = Readonly<{
  finding_id: string
  exact_parent_exists: boolean
  any_parent_exists: boolean
}>

export type IntakeReceiptCleanupResult = Readonly<{
  inspected: number
  removed: number
  rescheduled: number
  scopeMismatches: number
  fullPage: boolean
}>

export async function pruneDueIntakeReceipts(
  runner: SqlRunner,
  tickAtIso: string,
): Promise<IntakeReceiptCleanupResult> {
  if (!Number.isFinite(Date.parse(tickAtIso))) throw new Error('INVALID_INTAKE_CLEANUP_TIME')
  return runner.transaction(async tx => {
    // SKIP LOCKED happens inside the bounded due-page query. A skipped row
    // remains due and will be retried; there is no cursor to leap over it.
    const due = await tx.query<DueReceipt>(
      `WITH due AS MATERIALIZED (
         SELECT s.finding_id, s.organization_id, s.customer_tenant_id
           FROM alert_finding_intake_status s
          WHERE s.next_cleanup_check_at <= $1::timestamptz
          ORDER BY s.next_cleanup_check_at, s.finding_id
          LIMIT ${INTAKE_RECEIPT_CLEANUP_BATCH}
          FOR UPDATE OF s SKIP LOCKED
       )
       SELECT d.finding_id,
              EXISTS (SELECT 1 FROM identity_risk_findings f
                       WHERE f.id = d.finding_id
                         AND f.organization_id = d.organization_id
                         AND f.customer_tenant_id = d.customer_tenant_id) AS exact_parent_exists,
              EXISTS (SELECT 1 FROM identity_risk_findings f
                       WHERE f.id = d.finding_id) AS any_parent_exists
         FROM due d`,
      [tickAtIso],
    )
    // A corrupt scope must remain intact for diagnosis, but cannot pin the
    // earliest due page forever. Reschedule it alongside live receipts and
    // return a bounded anomaly count for the future operator metric/log.
    const scopeMismatches = due.filter(row => row.any_parent_exists && !row.exact_parent_exists).length
    const orphans = due.filter(row => !row.any_parent_exists).map(row => row.finding_id)
    const retained = due.filter(row => row.any_parent_exists).map(row => row.finding_id)
    const removed = orphans.length === 0 ? 0 : await tx.execute(
      `DELETE FROM alert_finding_intake_status s
        WHERE s.finding_id = ANY($2::uuid[])
          AND s.next_cleanup_check_at <= $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM identity_risk_findings f WHERE f.id = s.finding_id)`,
      [tickAtIso, orphans],
    )
    const rescheduled = retained.length === 0 ? 0 : await tx.execute(
      `UPDATE alert_finding_intake_status s
          SET next_cleanup_check_at = $1::timestamptz + INTERVAL '24 hours',
              updated_at = $1::timestamptz
        WHERE s.finding_id = ANY($2::uuid[])
          AND s.next_cleanup_check_at <= $1::timestamptz`,
      [tickAtIso, retained],
    )
    if (removed !== orphans.length || rescheduled !== retained.length) {
      throw new Error('INTAKE_RECEIPT_CLEANUP_RACE')
    }
    return {
      inspected: due.length,
      removed,
      rescheduled,
      scopeMismatches,
      fullPage: due.length === INTAKE_RECEIPT_CLEANUP_BATCH,
    }
  })
}
