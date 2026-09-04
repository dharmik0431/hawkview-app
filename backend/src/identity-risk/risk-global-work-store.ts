import { withRiskKeyTransaction } from './mailbox-read-transaction.js'
import { isGlobalRiskConfig, riskRuntimeConfig } from './risk-runtime-config.js'
import type { PseudonymScope } from './identity-risk-pseudonym.js'
import { createHash, randomUUID } from 'node:crypto'

export type RiskCycleLease = Readonly<{ environment: string; id: string }>
export function riskTenantScopeOpaqueId(scope: Pick<PseudonymScope, 'organizationId' | 'customerTenantId'>) {
  return createHash('sha256').update(`identity-risk-control/v1\u0000${scope.organizationId}:${scope.customerTenantId}`).digest('hex').slice(0, 32)
}

/** Internal authenticated scheduler only; no HTTP/read-path enrollment. The
 * cursor is committed BEFORE attempted work. Failure/crash moves forward, and
 * wraparound retries later; no tenant can pin the scan to the first 1,000 IDs. */
export class RiskGlobalWorkStore {
  /** Durable attempt BEFORE key/source work. A failed attempt cannot leave an
   * earlier successful empty evaluation looking like the latest check. Existing
   * operational-event expiry/maintenance applies; no identities or errors. */
  async recordAttempt(scope: PseudonymScope, lease: RiskCycleLease, deadlineAt: number) {
    const config = riskRuntimeConfig()
    if (!isGlobalRiskConfig(config) || scope.environment !== config.environment || lease.environment !== config.environment)
      throw new Error('IDENTITY_RISK_CYCLE_UNAVAILABLE')
    const opaque = riskTenantScopeOpaqueId(scope)
    const eventKey = createHash('sha256').update(`GLOBAL_RISK_ATTEMPT\u0000${lease.id}\u0000${opaque}`).digest('hex')
    await withRiskKeyTransaction(deadlineAt, async client => {
      const result = await client.query(`INSERT INTO identity_risk_operational_events
        (id,event_key,event_type,scope_type,scope_opaque_id,reason_code,correlation_id,actor_service_id,expires_at,created_at)
        SELECT $1::uuid,$2,'GLOBAL_RISK_ATTEMPT','TENANT',$3,'EVALUATION_REQUESTED',$4::uuid,
          'identity-risk-scheduler',CURRENT_TIMESTAMP+INTERVAL '90 days',CURRENT_TIMESTAMP
        FROM identity_risk_scheduler_cursors WHERE environment=$5 AND lease_id=$4::uuid AND lease_expires_at>CURRENT_TIMESTAMP
        ON CONFLICT(event_key) DO UPDATE SET event_key=EXCLUDED.event_key RETURNING id`,
      [randomUUID(), eventKey, opaque, lease.id, lease.environment])
      if (result.rowCount !== 1) throw new Error('IDENTITY_RISK_CYCLE_UNAVAILABLE')
    })
  }

  async claimCycle(deadlineAt: number): Promise<RiskCycleLease | null> {
    const config = riskRuntimeConfig()
    if (!isGlobalRiskConfig(config)) return null
    return withRiskKeyTransaction(deadlineAt, async client => {
      await client.query(`INSERT INTO identity_risk_scheduler_cursors (environment)
        VALUES ($1) ON CONFLICT DO NOTHING`, [config.environment])
      const id = randomUUID()
      const claimed = await client.query(`UPDATE identity_risk_scheduler_cursors
        SET lease_id=$2::uuid, lease_expires_at=CURRENT_TIMESTAMP+INTERVAL '2 minutes'
        WHERE environment=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP)
        RETURNING environment`, [config.environment, id])
      return claimed.rowCount === 1 ? { environment: config.environment, id } : null
    })
  }

  async releaseCycle(lease: RiskCycleLease, deadlineAt: number) {
    await withRiskKeyTransaction(deadlineAt, async client => {
      await client.query(`UPDATE identity_risk_scheduler_cursors SET lease_id=NULL,lease_expires_at=NULL
        WHERE environment=$1 AND lease_id=$2::uuid`, [lease.environment, lease.id])
    })
  }

  async nextScope(lease: RiskCycleLease, deadlineAt: number): Promise<PseudonymScope | null> {
    const config = riskRuntimeConfig()
    if (!isGlobalRiskConfig(config) || config.environment !== lease.environment) return null
    return withRiskKeyTransaction(deadlineAt, async client => {
      const cursor = await client.query<{ after_tenant_id: string | null }>(`SELECT after_tenant_id
        FROM identity_risk_scheduler_cursors WHERE environment=$1 AND lease_id=$2::uuid
        AND lease_expires_at>CURRENT_TIMESTAMP FOR UPDATE`, [config.environment, lease.id])
      if (cursor.rowCount !== 1) throw new Error('IDENTITY_RISK_CYCLE_UNAVAILABLE')
      const rows = await client.query<{ organizationId: string; customerTenantId: string }>(`
        SELECT organization_id AS "organizationId", id AS "customerTenantId" FROM customer_tenants
        WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 1`, [cursor.rows[0]!.after_tenant_id])
      const candidate = rows.rows[0]
      await client.query(`UPDATE identity_risk_scheduler_cursors SET after_tenant_id=$2::uuid,
        updated_at=CURRENT_TIMESTAMP WHERE environment=$1`, [config.environment, candidate?.customerTenantId ?? null])
      // Inactive/unconnected candidates are intentionally advanced too. ensure
      // rechecks state with locks; no trust in scan-time eligibility or plan.
      return candidate ? { ...candidate, environment: config.environment } : null
    })
  }
}
