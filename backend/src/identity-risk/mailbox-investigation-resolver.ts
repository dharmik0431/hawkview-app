import { Inject, Injectable } from '@nestjs/common'
import { IdentityRiskPseudonymProvider, type PseudonymKeyVersion } from './identity-risk-pseudonym.js'
import { withMailboxReadTransaction, withRiskKeyTransaction } from './mailbox-read-transaction.js'
import { MAILBOX_SOURCE_MAX_AGE_MS } from './mailbox-source-attestation.js'
import { isIdentityRiskOpaqueReferenceKind } from './identity-risk.validation.js'
import { RISK_UUID } from './pilot-risk-config.js'

type Scope = { organizationId: string; customerTenantId: string }
type Finding = { subjectId: string; pseudonymKeyVersionId: string; sourceObservedAt: Date }
export type ResolvedMailbox = { status: 'AVAILABLE' | 'UNAVAILABLE'; mailboxId: string | null; label: string | null; observedAt: string | null }
const unavailable = (): ResolvedMailbox => ({ status: 'UNAVAILABLE', mailboxId: null, label: null, observedAt: null })
function current(date: Date, now: Date) { return date instanceof Date && Number.isFinite(date.getTime()) && now.getTime() - date.getTime() <= MAILBOX_SOURCE_MAX_AGE_MS && date.getTime() - now.getTime() <= 300000 }

/** Authz lives in IdentityRiskService before and after this private bounded join.
 * No persisted identity map or public pseudonym reversal. Existing tenant inventory only.
 */
@Injectable()
export class MailboxInvestigationResolver {
  constructor(@Inject(IdentityRiskPseudonymProvider) private readonly provider: IdentityRiskPseudonymProvider) {}
  async resolve(scope: Scope, finding: Finding, now: Date): Promise<ResolvedMailbox> {
    const environment = process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    if (!environment || !this.provider.configured || !this.provider.allowsScope({ ...scope, environment }) ||
      !RISK_UUID.test(scope.organizationId) || !RISK_UUID.test(scope.customerTenantId) || !RISK_UUID.test(finding.pseudonymKeyVersionId) ||
      !isIdentityRiskOpaqueReferenceKind(finding.subjectId, 'mailbox') || !current(finding.sourceObservedAt, now)) return unavailable()
    try {
      // Busy means temporarily unavailable; never queue user lookups behind long collectors.
      const { tryInSyncMemoryLane } = await import('../tenants/tenant-sync.service.js')
      return await tryInSyncMemoryLane(async () => {
        const deadline = Date.now() + 15000
        const key = await withMailboxReadTransaction(deadline, 3000, async (client) => {
          const rows = await client.query<PseudonymKeyVersion>(`SELECT id,organization_id AS "organizationId",customer_tenant_id AS "customerTenantId",environment,provider,immutable_key_id AS "immutableKeyId"
            FROM identity_risk_pseudonym_key_versions WHERE id=$1::uuid AND organization_id=$2::uuid AND customer_tenant_id=$3::uuid
            AND environment=$4 AND status='ACTIVE' AND retired_at IS NULL AND activated_at<=CURRENT_TIMESTAMP`,
          [finding.pseudonymKeyVersionId, scope.organizationId, scope.customerTenantId, environment])
          return rows.rows.length === 1 ? rows.rows[0] : undefined
        })
        if (!key) return unavailable()
        const session = await this.provider.pin(key, deadline)
        try {
          // PostgreSQL disallows FOR SHARE in a READ ONLY transaction. This
          // bounded transaction only selects/locks; it does not change inventory.
          return await withRiskKeyTransaction(deadline, async (client) => {
            const active = await client.query(`SELECT id FROM identity_risk_pseudonym_key_versions WHERE id=$1::uuid AND organization_id=$2::uuid
              AND customer_tenant_id=$3::uuid AND environment=$4 AND status='ACTIVE' AND retired_at IS NULL FOR SHARE`,
            [key.id, scope.organizationId, scope.customerTenantId, environment])
            if (active.rowCount !== 1) return unavailable()
            const snapshots = await client.query<{ observedAt: Date; payload: unknown }>(`SELECT s.observed_at AS "observedAt",
              CASE WHEN jsonb_typeof(s.payload)='array' THEN CASE WHEN jsonb_array_length(s.payload)<=1000 AND octet_length(s.payload::text)<=2097152 THEN
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x->'id','mail',x->'mail','userPrincipalName',x->'userPrincipalName')), '[]'::jsonb) FROM jsonb_array_elements(s.payload) x)
              ELSE NULL END ELSE NULL END AS payload
              FROM tenant_entra_snapshots s JOIN sync_states y ON y.organization_id=s.organization_id AND y.customer_tenant_id=s.customer_tenant_id AND y.resource_type=s.resource_type
              WHERE s.organization_id=$1::uuid AND s.customer_tenant_id=$2::uuid AND s.resource_type='EXCHANGE_MAILBOXES'
              AND y.status='SUCCEEDED' AND y.last_successful_at>=s.observed_at AND (y.last_attempt_at IS NULL OR y.last_attempt_at<=y.last_successful_at) LIMIT 2`,
            [scope.organizationId, scope.customerTenantId])
            const snapshot = snapshots.rows[0]
            if (snapshots.rows.length !== 1 || !snapshot || !current(snapshot.observedAt, now) || !Array.isArray(snapshot.payload) || snapshot.payload.length > 1000) return unavailable()
            let match: { id: string; label: string } | undefined
            const seen = new Set<string>()
            for (const row of snapshot.payload) {
              if (!row || typeof row.id !== 'string' || !RISK_UUID.test(row.id) || seen.has(row.id)) return unavailable()
              seen.add(row.id)
              if (await session.reference('mailbox', [row.id]) !== finding.subjectId) continue
              const label = row.mail ?? row.userPrincipalName
              // Address-only safe presentation; no arbitrary display-name/diagnostic projection.
              if (match || typeof label !== 'string' || label.length > 320 || !/^[^\s<>"'`\\,;:]+@[^\s<>"'`\\,;:]+\.[^\s<>"'`\\,;:]+$/.test(label) || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(label)) return unavailable()
              match = { id: row.id, label }
            }
            return match ? { status: 'AVAILABLE' as const, mailboxId: match.id, label: match.label, observedAt: snapshot.observedAt.toISOString() } : unavailable()
          })
        } finally { session.close?.() }
      }) ?? unavailable()
    } catch { return unavailable() }
  }
}
