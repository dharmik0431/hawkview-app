import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { withRiskKeyTransaction } from './mailbox-read-transaction.js'
import type { PseudonymKeyVersion, PseudonymScope } from './identity-risk-pseudonym.js'
import { RISK_UUID } from './pilot-risk-config.js'
import { riskRuntimeConfig, riskScopeAllowed, isWrappedRiskConfig, isGlobalRiskConfig } from './risk-runtime-config.js'
import { keyUnavailable, readRiskWrappingRoot, wrapRiskKey, wrappedRiskName, WRAPPED_RISK_PROVIDER, type WrappedRiskCiphertext } from './wrapped-risk-crypto.js'

const columns = `id, organization_id AS "organizationId", customer_tenant_id AS "customerTenantId", environment, provider, immutable_key_id AS "immutableKeyId"`
type EventKind = 'CREATED' | 'SESSION_OPENED' | 'SESSION_FAILED' | 'RETIRED' | 'DESTROYED'

export class WrappedRiskKeyStore {
  private allowed(scope: PseudonymScope) {
    const config = riskRuntimeConfig()
    if (!isWrappedRiskConfig(config) || !riskScopeAllowed(scope, config)) throw keyUnavailable()
  }
  private async event(client: pg.Client, id: string, kind: EventKind) {
    await client.query(`INSERT INTO identity_risk_key_events (key_version_id,kind,bucket,correlation_id,expires_at)
      VALUES ($1::uuid,$2,date_trunc('minute',CURRENT_TIMESTAMP),$3::uuid,date_trunc('minute',CURRENT_TIMESTAMP)+INTERVAL '90 days')
      ON CONFLICT DO NOTHING`, [id, kind, randomUUID()])
    // Scoped retention, never NULL/indefinite events, no identities or raw provider errors.
    await client.query(`WITH expired AS (
      SELECT key_version_id,kind,bucket FROM identity_risk_key_events
      WHERE key_version_id=$1::uuid AND expires_at<=CURRENT_TIMESTAMP
      ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
    ) DELETE FROM identity_risk_key_events e USING expired x
      WHERE e.key_version_id=x.key_version_id AND e.kind=x.kind AND e.bucket=x.bucket`, [id])
  }
  private async lockKey(client: pg.Client, key: PseudonymKeyVersion, active = true) {
    this.allowed(key)
    if (key.immutableKeyId !== wrappedRiskName(key)) throw keyUnavailable()
    const rows = await client.query(`SELECT id FROM identity_risk_pseudonym_key_versions
      WHERE id=$1::uuid AND organization_id=$2::uuid AND customer_tenant_id=$3::uuid AND environment=$4
      AND provider=$5 AND immutable_key_id=$6 AND destroyed_at IS NULL
      AND (${active ? "status='ACTIVE' AND retired_at IS NULL AND activated_at<=CURRENT_TIMESTAMP" : "status IN ('ACTIVE','RETIRED','DISABLED')"}) FOR SHARE`,
    [key.id, key.organizationId, key.customerTenantId, key.environment, key.provider, key.immutableKeyId])
    if (rows.rowCount !== 1) throw keyUnavailable()
  }

  /** Explicit local/control-plane primitive, NOT called by load, pin, Nest startup or an HTTP route. */
  async createVersion(scope: PseudonymScope, versionId: string, deadlineAt: number): Promise<PseudonymKeyVersion> {
    return this.createOrLoad(scope, versionId, deadlineAt, false)
  }

  /** Scheduler only. A missing ACTIVE row is not permission to recreate a key.
   * Existing history, including damaged ciphertext and revocation tombstones,
   * requires controlled operator reconciliation, never automatic rotation. */
  async ensureVersion(scope: PseudonymScope, deadlineAt: number): Promise<PseudonymKeyVersion> {
    if (!isGlobalRiskConfig(riskRuntimeConfig())) throw keyUnavailable()
    return this.createOrLoad(scope, randomUUID(), deadlineAt, true)
  }

  private async assertAutomaticScope(client: pg.Client, scope: PseudonymScope) {
    // Same exclusive advisory namespace AND ordering as evaluator/stop controls.
    const keys = ['GLOBAL', `${scope.organizationId}:${scope.customerTenantId}`]
      .map(key => `hawkview:identity-risk-control:EVALUATION_HARD_DISABLED:${key}`).sort()
    for (const key of keys) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
    this.allowed(scope)
    if (!isGlobalRiskConfig(riskRuntimeConfig())) throw keyUnavailable()
    const stop = await client.query(`SELECT id FROM identity_risk_operational_controls
      WHERE state='ACTIVE' AND control_type='EVALUATION_HARD_DISABLED' AND
      ((scope_type='GLOBAL' AND scope_key='GLOBAL') OR
       (scope_type='TENANT' AND scope_key=$3 AND organization_id=$1::uuid AND customer_tenant_id=$2::uuid)) LIMIT 1`,
    [scope.organizationId, scope.customerTenantId, `${scope.organizationId}:${scope.customerTenantId}`])
    if (stop.rowCount) throw keyUnavailable()
    // Row locks linearize suspension/disconnect/deletion with enrollment. All
    // ownership predicates remain inside this transaction, not a stale page DTO.
    const owner = await client.query("SELECT id FROM organizations WHERE id=$1::uuid AND status='ACTIVE' FOR SHARE", [scope.organizationId])
    if (owner.rowCount !== 1) throw keyUnavailable()
    const tenant = await client.query(`SELECT id FROM customer_tenants
      WHERE id=$1::uuid AND organization_id=$2::uuid AND status='ACTIVE' FOR SHARE`, [scope.customerTenantId, scope.organizationId])
    if (tenant.rowCount !== 1) throw keyUnavailable()
    const connection = await client.query(`SELECT id FROM tenant_connections
      WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND status='CONNECTED' FOR SHARE`, [scope.customerTenantId, scope.organizationId])
    if (connection.rowCount !== 1) throw keyUnavailable()
  }

  private async createOrLoad(scope: PseudonymScope, versionId: string, deadlineAt: number, automatic: boolean): Promise<PseudonymKeyVersion> {
    this.allowed(scope)
    if (!RISK_UUID.test(versionId)) throw keyUnavailable()
    const root = readRiskWrappingRoot()
    let material: Buffer | undefined
    try {
      return await withRiskKeyTransaction(deadlineAt, async (client) => {
        if (automatic) await this.assertAutomaticScope(client, scope)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`risk-key:${scope.environment}:${scope.organizationId}:${scope.customerTenantId}`])
        const existing = await client.query<PseudonymKeyVersion>(`SELECT ${columns} FROM identity_risk_pseudonym_key_versions
          WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND environment=$3 AND status='ACTIVE'`,
        [scope.organizationId, scope.customerTenantId, scope.environment])
        if (existing.rows.length) {
          const winner = existing.rows[0]!
          await this.lockKey(client, winner)
          const cipher = await client.query('SELECT name FROM identity_risk_wrapped_keys WHERE key_version_id=$1::uuid AND name=$2', [winner.id, winner.immutableKeyId])
          if (cipher.rowCount !== 1) throw keyUnavailable()
          return winner
        }
        if (automatic) {
          const history = await client.query(`SELECT id FROM identity_risk_pseudonym_key_versions
            WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND environment=$3 LIMIT 1`,
          [scope.organizationId, scope.customerTenantId, scope.environment])
          if (history.rowCount) throw keyUnavailable()
        }
        const key: PseudonymKeyVersion = { ...scope, id: versionId, provider: WRAPPED_RISK_PROVIDER, immutableKeyId: '' }
        // Construct a new immutable value, never mutate a registered version.
        const registered = { ...key, immutableKeyId: wrappedRiskName(key) }
        material = randomBytes(32)
        const cipher = wrapRiskKey(registered, material, root)
        await client.query(`INSERT INTO identity_risk_pseudonym_key_versions
          (id,organization_id,customer_tenant_id,environment,provider,immutable_key_id,status,activated_at)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'ACTIVE',CURRENT_TIMESTAMP)`,
        [registered.id, scope.organizationId, scope.customerTenantId, scope.environment, registered.provider, registered.immutableKeyId])
        await client.query('INSERT INTO identity_risk_wrapped_keys (key_version_id,name,ciphertext,iv,tag) VALUES ($1::uuid,$2,$3,$4,$5)',
          [registered.id, cipher.name, cipher.ciphertext, cipher.iv, cipher.tag])
        await this.event(client, registered.id, 'CREATED')
        return registered
      })
    } catch { throw keyUnavailable() }
    finally { material?.fill(0); root.fill(0) }
  }

  async ciphertext(key: PseudonymKeyVersion, deadlineAt: number): Promise<WrappedRiskCiphertext> {
    this.allowed(key)
    try {
      return await withRiskKeyTransaction(deadlineAt, async (client) => {
        await this.lockKey(client, key)
        const rows = await client.query<WrappedRiskCiphertext>('SELECT name,ciphertext,iv,tag FROM identity_risk_wrapped_keys WHERE key_version_id=$1::uuid AND name=$2', [key.id, wrappedRiskName(key)])
        if (rows.rows.length !== 1) throw keyUnavailable()
        await this.event(client, key.id, 'SESSION_OPENED')
        return rows.rows[0]!
      })
    } catch { throw keyUnavailable() }
  }

  async assertActive(key: PseudonymKeyVersion, deadlineAt: number) {
    try { await withRiskKeyTransaction(deadlineAt, (client) => this.lockKey(client, key)) }
    catch { throw keyUnavailable() }
  }
  async recordFailure(key: PseudonymKeyVersion, deadlineAt: number) {
    try { await withRiskKeyTransaction(deadlineAt, async (client) => { await this.lockKey(client, key); await this.event(client, key.id, 'SESSION_FAILED') }) }
    catch { /* Evidence unavailable. Never log raw errors or bypass failure. */ }
  }
  /** Existing authorized maintenance invokes this with the explicit pilot scope.
   * Includes retired versions, but cannot cross org/tenant/environment boundaries. */
  async pruneExpired(scope: PseudonymScope, deadlineAt: number) {
    this.allowed(scope)
    return withRiskKeyTransaction(deadlineAt, async (client) => {
      const result = await client.query(`WITH expired AS (
        SELECT e.key_version_id,e.kind,e.bucket FROM identity_risk_key_events e
        JOIN identity_risk_pseudonym_key_versions k ON k.id=e.key_version_id
        WHERE k.organization_id=$1::uuid AND k.customer_tenant_id=$2::uuid AND k.environment=$3 AND e.expires_at<=CURRENT_TIMESTAMP
        ORDER BY e.expires_at LIMIT 500 FOR UPDATE OF e SKIP LOCKED
      ) DELETE FROM identity_risk_key_events e USING expired x
        WHERE e.key_version_id=x.key_version_id AND e.kind=x.kind AND e.bucket=x.bucket`,
      [scope.organizationId,scope.customerTenantId,scope.environment])
      return result.rowCount ?? 0
    })
  }
  async retireOrDestroy(key: PseudonymKeyVersion, destroy: boolean, deadlineAt: number) {
    try {
      await withRiskKeyTransaction(deadlineAt, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`risk-key:${key.environment}:${key.organizationId}:${key.customerTenantId}`])
        await this.lockKey(client, key, false)
        await client.query("UPDATE identity_risk_pseudonym_key_versions SET status=$2, retired_at=COALESCE(retired_at,CURRENT_TIMESTAMP) WHERE id=$1::uuid", [key.id, destroy ? 'DISABLED' : 'RETIRED'])
        if (destroy) await client.query('DELETE FROM identity_risk_wrapped_keys WHERE key_version_id=$1::uuid', [key.id])
        await this.event(client, key.id, destroy ? 'DESTROYED' : 'RETIRED')
      })
    } catch { throw keyUnavailable() }
  }
}
