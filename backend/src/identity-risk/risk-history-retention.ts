import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { withRiskKeyTransaction } from './mailbox-read-transaction.js'
import { RISK_UUID } from './pilot-risk-config.js'

// Fixed limits, not operator-tunable. Only IDs/counts cross the SQL boundary.
export const HISTORY_BATCH_ROWS = 256
export const HISTORY_BATCH_RUNS = 16
export const HISTORY_CYCLE_BATCHES = 128
export const HISTORY_CYCLE_MS = 10_000
export const HISTORY_TRANSACTION_MS = 1_000
type Scope = { organizationId: string; customerTenantId: string }
type Config = { mode: 'observe' | 'delete'; scopes: Scope[] | 'all'; key: string }
type Lease = { key: string; id: string }
const zero = () => ({ findings: 0, matchedResults: 0, coverage: 0, runs: 0 })

/** An explicit staged flag, unrelated to evaluation/UI flags. Unknown input is OFF. */
export function riskHistoryRetentionConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const mode = env.HAWKVIEW_RISK_HISTORY_RETENTION_MODE
  const text = env.HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES
  if ((mode !== 'observe' && mode !== 'delete') || !text || text.length > 12_000) return null
  let scopes: Scope[] | 'all'
  if (text === 'all') scopes = 'all'
  else {
    // Exact ASCII UUID pairs, no escaped/duplicate object keys or prototypes.
    if (!/^\s*\[\s*\{[\s\S]*\}\s*\]\s*$/.test(text) || text.includes('\\')) return null
    try {
      scopes = JSON.parse(text)
      if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 100 || scopes.some(s =>
        !s || Object.keys(s).sort().join(',') !== 'customerTenantId,organizationId' ||
        typeof s.organizationId !== 'string' || !RISK_UUID.test(s.organizationId) ||
        typeof s.customerTenantId !== 'string' || !RISK_UUID.test(s.customerTenantId))) return null
      if ((text.match(/"organizationId"\s*:/g) ?? []).length !== scopes.length ||
        (text.match(/"customerTenantId"\s*:/g) ?? []).length !== scopes.length) return null
      scopes.sort((a, b) => a.customerTenantId.localeCompare(b.customerTenantId))
      if (new Set(scopes.map(s => s.customerTenantId)).size !== scopes.length) return null
    } catch { return null }
  }
  return { mode, scopes, key: createHash('sha256').update(JSON.stringify(scopes)).digest('hex') }
}

// UTC session (enforced by the owned transaction helper): exact 90*24 hours.
// expires_at is the INDEPENDENT validity cap, never extended by this worker.
const eligible = `r.status IN ('COMPLETED','FAILED')
  AND isfinite(r.created_at) AND r.created_at <= CURRENT_TIMESTAMP - INTERVAL '2160 hours'
  AND isfinite(r.expires_at) AND r.expires_at <= CURRENT_TIMESTAMP
  AND ((r.status='FAILED' AND r.completed_at IS NULL) OR (isfinite(r.completed_at) AND r.completed_at >= r.created_at AND r.completed_at <= CURRENT_TIMESTAMP))
  AND (r.lease_expires_at IS NULL OR (isfinite(r.lease_expires_at) AND r.lease_expires_at <= CURRENT_TIMESTAMP))`

export class RiskHistoryRetention {
  private tx<T>(deadline: number, work: (client: pg.Client) => Promise<T>) {
    return withRiskKeyTransaction(Math.min(deadline, Date.now() + HISTORY_TRANSACTION_MS), work)
  }

  async claim(config: Config, deadline: number): Promise<Lease | null> {
    return this.tx(deadline, async c => {
      await c.query(`INSERT INTO identity_risk_history_cursors (scope_key) VALUES ($1) ON CONFLICT DO NOTHING`, [config.key])
      const id = randomUUID()
      const row = await c.query(`UPDATE identity_risk_history_cursors SET lease_id=$2::uuid,
        lease_expires_at=statement_timestamp()+INTERVAL '30 seconds'
        WHERE scope_key=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=statement_timestamp()) RETURNING scope_key`, [config.key, id])
      return row.rowCount === 1 ? { key: config.key, id } : null
    })
  }

  async next(config: Config, lease: Lease, deadline: number): Promise<Scope | null> {
    if (config.key !== lease.key) throw new Error('RISK_HISTORY_UNAVAILABLE')
    return this.tx(deadline, async c => {
      const cursor = await c.query(`SELECT after_tenant_id FROM identity_risk_history_cursors
        WHERE scope_key=$1 AND lease_id=$2::uuid AND lease_expires_at>statement_timestamp() FOR UPDATE`, [lease.key, lease.id])
      if (cursor.rowCount !== 1) throw new Error('RISK_HISTORY_UNAVAILABLE')
      const row = await c.query<Scope>(`SELECT t.organization_id AS "organizationId",t.id AS "customerTenantId"
        FROM customer_tenants t WHERE ($1::uuid IS NULL OR t.id>$1::uuid)
        AND ($2::jsonb IS NULL OR EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb)
          AS s("organizationId" uuid,"customerTenantId" uuid) WHERE s."organizationId"=t.organization_id AND s."customerTenantId"=t.id))
        AND EXISTS (SELECT 1 FROM identity_risk_evaluation_runs r
          WHERE r.organization_id=t.organization_id AND r.customer_tenant_id=t.id AND ${eligible})
        ORDER BY t.id LIMIT 1`, [cursor.rows[0].after_tenant_id, config.scopes === 'all' ? null : JSON.stringify(config.scopes)])
      // Advance before work: crashes/blocked tenants cannot pin progress. Revisit
      // on wrap; cursor is separate from evaluation/attempt metadata.
      const updated = await c.query(`UPDATE identity_risk_history_cursors SET after_tenant_id=$3::uuid,updated_at=CURRENT_TIMESTAMP
        WHERE scope_key=$1 AND lease_id=$2::uuid AND lease_expires_at>statement_timestamp()`,
      [lease.key, lease.id, row.rows[0]?.customerTenantId ?? null])
      if (updated.rowCount !== 1) throw new Error('RISK_HISTORY_UNAVAILABLE')
      return row.rows[0] ?? null
    })
  }

  /** No caller-supplied cleanup time. Whole batch is a single cancellable transaction. */
  async prune(scope: Scope, config: Config, lease: Lease, deadline: number) {
    if (config.mode !== 'delete' || !RISK_UUID.test(scope.organizationId) || !RISK_UUID.test(scope.customerTenantId) ||
      (config.scopes !== 'all' && !config.scopes.some(s => s.organizationId === scope.organizationId && s.customerTenantId === scope.customerTenantId)))
      throw new Error('RISK_HISTORY_UNAVAILABLE')
    return this.tx(deadline, async c => {
      const owned = await c.query(`SELECT scope_key FROM identity_risk_history_cursors
        WHERE scope_key=$1 AND lease_id=$2::uuid AND lease_expires_at>statement_timestamp() FOR UPDATE`, [lease.key, lease.id])
      if (lease.key !== config.key || owned.rowCount !== 1) throw new Error('RISK_HISTORY_UNAVAILABLE')
      // Evaluator takes attempt head before run. NOWAIT avoids waiting behind
      // live evaluation; no keys/controls/tenant state are modified by cleanup.
      const heads = await c.query(`SELECT environment,attempt_id,completed_run_id FROM identity_risk_attempt_heads
        WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid ORDER BY environment LIMIT 65 FOR UPDATE NOWAIT`,
      [scope.organizationId, scope.customerTenantId])
      if (heads.rows.length > 64) throw new Error('RISK_HISTORY_UNAVAILABLE')
      await c.query(`INSERT INTO identity_risk_history_tenant_cursors (organization_id,customer_tenant_id)
        VALUES ($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`, [scope.organizationId, scope.customerTenantId])
      const cursor = await c.query(`SELECT after_created_at::text,after_run_id FROM identity_risk_history_tenant_cursors
        WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid FOR UPDATE NOWAIT`, [scope.organizationId, scope.customerTenantId])
      const selectPage = (afterCreatedAt: string | null, afterId: string | null) => c.query<{ id: string; created_at: string }>(`SELECT r.id,r.created_at::text FROM identity_risk_evaluation_runs r
        WHERE r.organization_id=$1::uuid AND r.customer_tenant_id=$2::uuid AND ${eligible}
        AND ($3::timestamptz IS NULL OR (r.created_at,r.id)>($3::timestamptz,$4::uuid))
        ORDER BY r.created_at,r.id LIMIT ${HISTORY_BATCH_RUNS} FOR UPDATE SKIP LOCKED`,
      [scope.organizationId, scope.customerTenantId, afterCreatedAt, afterId])
      let selected = await selectPage(cursor.rows[0].after_created_at, cursor.rows[0].after_run_id)
      // A partial graph must be revisited after reaching this tenant's end.
      // One bounded wrap avoids mistaking cursor reset for a no-progress scan.
      if (!selected.rows.length && cursor.rows[0].after_created_at !== null) selected = await selectPage(null, null)
      const last = selected.rows.at(-1)
      await c.query(`UPDATE identity_risk_history_tenant_cursors SET after_created_at=$3::timestamptz,after_run_id=$4::uuid
        WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid`,
      [scope.organizationId, scope.customerTenantId, last?.created_at ?? null, last?.id ?? null])
      const ids = selected.rows.map(r => r.id)
      if (!ids.length) return zero()
      const args = [scope.organizationId, scope.customerTenantId, ids]
      const counts = zero()
      // FK NO ACTION additionally prevents any implicit cascade on concurrent
      // attachment. Only a bounded explicit leaf set is ever deleted.
      // OFFSET 0 keeps the unique parent-ID lookup ahead of scoped predicates.
      // With stale tenant cardinality estimates a flattened join can otherwise
      // rescan every scoped matched row for each finding (quadratic work).
      // The outer exact scope plus composite FK still enforce tenant ownership.
      const findings = await c.query(`WITH candidate_matches AS MATERIALIZED (
        SELECT m.id FROM identity_risk_matched_results m
        WHERE m.organization_id=$1::uuid AND m.customer_tenant_id=$2::uuid AND m.evaluation_run_id=ANY($3::uuid[])
        AND isfinite(m.expires_at) AND m.expires_at<=CURRENT_TIMESTAMP AND isfinite(m.created_at) AND m.created_at<=CURRENT_TIMESTAMP
        AND EXISTS (SELECT 1 FROM (
          SELECT f.organization_id,f.customer_tenant_id,f.expires_at,f.created_at,f.updated_at
          FROM identity_risk_findings f WHERE f.matched_result_id=m.id OFFSET 0
        ) f WHERE f.organization_id=$1::uuid AND f.customer_tenant_id=$2::uuid
          AND isfinite(f.expires_at) AND f.expires_at<=CURRENT_TIMESTAMP AND isfinite(f.created_at) AND f.created_at<=CURRENT_TIMESTAMP
          AND isfinite(f.updated_at) AND f.updated_at<=CURRENT_TIMESTAMP)
        ORDER BY m.id LIMIT ${HISTORY_BATCH_ROWS}
      ), candidate_findings AS MATERIALIZED (
        SELECT f.id,f.matched_result_id FROM candidate_matches x CROSS JOIN LATERAL (
          SELECT f.id,f.matched_result_id FROM (
            SELECT f.id,f.matched_result_id,f.organization_id,f.customer_tenant_id,f.expires_at,f.created_at,f.updated_at
            FROM identity_risk_findings f WHERE f.matched_result_id=x.id ORDER BY f.id OFFSET 0
          ) f WHERE f.organization_id=$1::uuid AND f.customer_tenant_id=$2::uuid
          AND isfinite(f.expires_at) AND f.expires_at<=CURRENT_TIMESTAMP AND isfinite(f.created_at) AND f.created_at<=CURRENT_TIMESTAMP
          AND isfinite(f.updated_at) AND f.updated_at<=CURRENT_TIMESTAMP
          ORDER BY f.id LIMIT ${HISTORY_BATCH_ROWS}
        ) f LIMIT ${HISTORY_BATCH_ROWS}
      ), chosen AS (SELECT f.id FROM candidate_findings x JOIN identity_risk_findings f ON f.id=x.id AND f.matched_result_id=x.matched_result_id
        JOIN LATERAL (
          SELECT p.organization_id,p.customer_tenant_id,p.evaluation_run_id,p.expires_at,p.created_at
          FROM identity_risk_matched_results p WHERE p.id=x.matched_result_id OFFSET 0
        ) m ON m.organization_id=f.organization_id AND m.customer_tenant_id=f.customer_tenant_id
        WHERE f.organization_id=$1::uuid AND f.customer_tenant_id=$2::uuid AND m.evaluation_run_id=ANY($3::uuid[])
        AND isfinite(m.expires_at) AND m.expires_at<=CURRENT_TIMESTAMP AND isfinite(m.created_at) AND m.created_at<=CURRENT_TIMESTAMP
        AND isfinite(f.expires_at) AND f.expires_at<=CURRENT_TIMESTAMP AND isfinite(f.created_at) AND f.created_at<=CURRENT_TIMESTAMP
        AND isfinite(f.updated_at) AND f.updated_at<=CURRENT_TIMESTAMP
        ORDER BY f.id LIMIT ${HISTORY_BATCH_ROWS} FOR UPDATE OF f SKIP LOCKED)
        DELETE FROM identity_risk_findings f USING chosen x WHERE f.id=x.id
        AND f.organization_id=$1::uuid AND f.customer_tenant_id=$2::uuid RETURNING f.id`, args)
      counts.findings = findings.rowCount ?? 0
      let remaining = HISTORY_BATCH_ROWS - counts.findings
      const matches = await c.query(`WITH chosen AS (SELECT m.id FROM identity_risk_matched_results m
        WHERE m.organization_id=$1::uuid AND m.customer_tenant_id=$2::uuid AND m.evaluation_run_id=ANY($3::uuid[])
        AND isfinite(m.expires_at) AND m.expires_at<=CURRENT_TIMESTAMP AND isfinite(m.created_at) AND m.created_at<=CURRENT_TIMESTAMP
        AND NOT EXISTS (SELECT 1 FROM identity_risk_findings f WHERE f.matched_result_id=m.id)
        ORDER BY m.id LIMIT $4 FOR UPDATE SKIP LOCKED)
        DELETE FROM identity_risk_matched_results m USING chosen x WHERE m.id=x.id
        AND m.organization_id=$1::uuid AND m.customer_tenant_id=$2::uuid RETURNING m.id`, [...args, remaining])
      counts.matchedResults = matches.rowCount ?? 0
      remaining -= counts.matchedResults
      const coverage = await c.query(`WITH chosen AS (SELECT v.id FROM identity_risk_rule_coverage v
        WHERE v.organization_id=$1::uuid AND v.customer_tenant_id=$2::uuid AND v.evaluation_run_id=ANY($3::uuid[])
        AND isfinite(v.expires_at) AND v.expires_at<=CURRENT_TIMESTAMP AND isfinite(v.created_at) AND v.created_at<=CURRENT_TIMESTAMP
        ORDER BY v.id LIMIT $4 FOR UPDATE SKIP LOCKED)
        DELETE FROM identity_risk_rule_coverage v USING chosen x WHERE v.id=x.id
        AND v.organization_id=$1::uuid AND v.customer_tenant_id=$2::uuid RETURNING v.id`, [...args, remaining])
      counts.coverage = coverage.rowCount ?? 0
      const removable = await c.query<{ id: string }>(`SELECT r.id FROM identity_risk_evaluation_runs r
        WHERE r.organization_id=$1::uuid AND r.customer_tenant_id=$2::uuid AND r.id=ANY($3::uuid[]) AND ${eligible}
        AND NOT EXISTS (SELECT 1 FROM identity_risk_matched_results m WHERE m.evaluation_run_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM identity_risk_rule_coverage v WHERE v.evaluation_run_id=r.id)`, args)
      const removableIds = removable.rows.map(r => r.id)
      for (const h of heads.rows) if (removableIds.includes(h.completed_run_id)) {
        await c.query(`UPDATE identity_risk_attempt_heads SET completed_run_id=NULL
          WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND environment=$3
          AND attempt_id=$4::uuid AND completed_run_id=$5::uuid`,
        [scope.organizationId, scope.customerTenantId, h.environment, h.attempt_id, h.completed_run_id])
      }
      const removed = await c.query(`DELETE FROM identity_risk_evaluation_runs r WHERE r.organization_id=$1::uuid
        AND r.customer_tenant_id=$2::uuid AND r.id=ANY($3::uuid[]) AND ${eligible} RETURNING r.id`,
      [scope.organizationId, scope.customerTenantId, removableIds])
      counts.runs = removed.rowCount ?? 0
      const stillOwned = await c.query(`SELECT 1 FROM identity_risk_history_cursors WHERE scope_key=$1
        AND lease_id=$2::uuid AND lease_expires_at>statement_timestamp()`, [lease.key, lease.id])
      if (stillOwned.rowCount !== 1) throw new Error('RISK_HISTORY_UNAVAILABLE')
      return counts
    })
  }

  async release(lease: Lease, deadline: number) {
    await this.tx(deadline, c => c.query(`UPDATE identity_risk_history_cursors SET lease_id=NULL,lease_expires_at=NULL
      WHERE scope_key=$1 AND lease_id=$2::uuid`, [lease.key, lease.id]))
  }

  /** Bounded READ ONLY preflight, not a full global backlog count/forecast. */
  async preflight(config: Config, deadline: number) {
    return this.tx(deadline, async c => {
      await c.query('SET TRANSACTION READ ONLY')
      const rows = await c.query(`SELECT r.id FROM identity_risk_evaluation_runs r WHERE ${eligible}
        AND ($1::jsonb IS NULL OR EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb)
          AS s("organizationId" uuid,"customerTenantId" uuid) WHERE s."organizationId"=r.organization_id AND s."customerTenantId"=r.customer_tenant_id))
        ORDER BY r.created_at,r.id LIMIT 257`, [config.scopes === 'all' ? null : JSON.stringify(config.scopes)])
      return { candidateRunsObserved: Math.min(rows.rows.length, 256), capped: rows.rows.length > 256 }
    })
  }

  async run(deadlineAt = Date.now() + HISTORY_CYCLE_MS) {
    const config = riskHistoryRetentionConfig()
    const summary = { status: 'OFF', batches: 0, failedBatches: 0, ...zero(), backlog: 'UNKNOWN' }
    if (!config) return summary
    const deadline = Math.min(deadlineAt, Date.now() + HISTORY_CYCLE_MS)
    if (config.mode === 'observe') return { ...summary, status: 'OBSERVED', ...await this.preflight(config, deadline) }
    const lease = await this.claim(config, deadline)
    if (!lease) return { ...summary, status: 'BUSY' }
    try {
      let wrapped = false
      let progressed = false
      while (summary.batches < HISTORY_CYCLE_BATCHES && deadline - Date.now() >= HISTORY_TRANSACTION_MS + 100) {
        if (JSON.stringify(riskHistoryRetentionConfig()) !== JSON.stringify(config)) break
        const scope = await this.next(config, lease, deadline)
        if (deadline - Date.now() < HISTORY_TRANSACTION_MS + 100) break
        if (!scope) {
          if (wrapped && !progressed) break
          wrapped = true
          progressed = false
          continue
        }
        summary.batches++
        try {
          const result = await this.prune(scope, config, lease, deadline)
          for (const k of ['findings', 'matchedResults', 'coverage', 'runs'] as const) summary[k] += result[k]
          if (Object.values(result).some(n => n > 0)) progressed = true
        } catch { summary.failedBatches++ }
      }
      return { ...summary, status: 'COMPLETED' }
    } finally {
      if (deadline - Date.now() >= 100) {
        try { await this.release(lease, deadline) } catch { /* lease expires; no diagnostics payload */ }
      }
    }
  }
}
