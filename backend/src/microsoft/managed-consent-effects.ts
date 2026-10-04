import { randomUUID } from 'node:crypto'
import { withManagedAuthority, type AuthorityDatabase } from './managed-connector-authority.js'
import type { ConsentOperationKey } from './consent-operation-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Result = 'applied' | 'replayed' | 'stale' | 'unavailable'
/** Existing in-app state only. No send, worker, scheduler, or provider calls.
 * A terminal replay alone never authorizes effects against today's connection. */
export async function applyManagedConsentEffects(db: AuthorityDatabase, input: ConsentOperationKey): Promise<Result> {
  if (input.flow !== 'EXISTING_TENANT' || ![input.organizationId,input.customerTenantId,input.operationId].every(v => UUID.test(v)) ||
    !/^[a-f0-9]{64}$/.test(input.stateHash)) throw new Error('INVALID_CONSENT_EFFECT_KEY')
  input = { ...input, organizationId: input.organizationId.toLowerCase(), customerTenantId: input.customerTenantId.toLowerCase(), operationId: input.operationId.toLowerCase() }
  const args = [input.operationId,input.organizationId,input.customerTenantId,input.stateHash]
  try {
    const initial = await db.$transaction(tx => tx.$queryRawUnsafe<{ revision: string }[]>(`SELECT expected_configuration::text AS revision
      FROM microsoft_consent_attempts WHERE id=$1::uuid AND organization_id=$2::uuid AND customer_tenant_id=$3::uuid
      AND state_hash=$4 AND flow='EXISTING_TENANT' AND operation_version=1
      AND operation_state IN ('SUCCEEDED','FAILED')`,...args), { isolationLevel: 'ReadCommitted' })
    if (initial.length !== 1 || !UUID.test(initial[0].revision)) return 'stale'
    const result = await withManagedAuthority(db, initial[0].revision, async (tx, authority): Promise<Result> => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      const tenants = await tx.$queryRawUnsafe<{ microsoftTenant: string }[]>(`SELECT microsoft_tenant_id::text AS "microsoftTenant"
        FROM customer_tenants WHERE id=$1::uuid AND organization_id=$2::uuid AND status<>'DISCONNECTED' FOR NO KEY UPDATE`,input.customerTenantId,input.organizationId)
      if (tenants.length !== 1) return 'stale'
      const connections = await tx.$queryRawUnsafe<{ incarnation: string; status: string }[]>(`SELECT collection_incarnation::text AS incarnation,status
        FROM tenant_connections WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid
        AND connection_mode='HAWKVIEW_MANAGED' FOR NO KEY UPDATE`,input.customerTenantId,input.organizationId)
      if (connections.length !== 1) return 'stale'
      const operations = await tx.$queryRawUnsafe<any[]>(`SELECT *,operation_terminal_at::text AS terminal_at FROM microsoft_consent_attempts
        WHERE id=$1::uuid AND organization_id=$2::uuid AND customer_tenant_id=$3::uuid AND state_hash=$4
        AND flow='EXISTING_TENANT' AND operation_version=1 FOR UPDATE`,...args)
      const op = operations[0], connection = connections[0]
      if (!op || !['SUCCEEDED','FAILED'].includes(op.operation_state) ||
        op.expected_configuration !== authority.configurationRevision || op.expected_client_id !== authority.clientId ||
        op.expected_home_tenant_id !== authority.homeTenantId || op.expected_credential_reference !== authority.credentialReference ||
        op.expected_microsoft_tenant !== tenants[0].microsoftTenant ||
        !op.operation_result_connection || connection.incarnation !== op.operation_result_connection ||
        connection.status !== (op.operation_state === 'SUCCEEDED' ? 'CONNECTED' : 'ERROR')) return 'stale'
      const success = op.operation_state === 'SUCCEEDED'
      const connectionKey = `tenant:${input.customerTenantId}:connection`
      const authorizedKey = `tenant:${input.customerTenantId}:onboarding-authorized`
      const targetKey = success ? authorizedKey : connectionKey
      const snapshot = op.operation_effects_snapshot
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length > 2) return 'stale'
      type Occurrence = { id: string; key: string; tenant: string; count: number; at: string }
      const expected: Occurrence[] = snapshot.rows
      if (expected.some(row => !row || !UUID.test(row.id) || ![connectionKey,authorizedKey].includes(row.key) ||
        row.tenant !== input.customerTenantId || !Number.isInteger(row.count) || row.count < 1 || typeof row.at !== 'string') ||
        new Set(expected.map(row => row.key)).size !== expected.length) return 'stale'
      // T/C serialize consent effects, but legacy notification writers do not take
      // those locks. Lock existing rows; an absent row grants no right to update a
      // later insert. Keep the exact PostgreSQL occurrence timestamp for the CAS.
      const rows = await tx.$queryRawUnsafe<{
        id: string; dedupe_key: string; customer_tenant_id: string | null; metadata: any;
        occurrence_count: number; occurrence_at: string; resolved_at: Date | null; precedes_terminal: boolean
      }[]>(`SELECT id,dedupe_key,customer_tenant_id,metadata,occurrence_count,
          last_occurred_at::text AS occurrence_at,resolved_at,
          date_trunc('milliseconds',last_occurred_at) < date_trunc('milliseconds',$4::timestamptz) AS precedes_terminal
        FROM notifications WHERE organization_id=$1::uuid AND dedupe_key IN ($2,$3) ORDER BY dedupe_key FOR UPDATE`,
        input.organizationId,connectionKey,authorizedKey,op.terminal_at)
      if (rows.some(row => row.customer_tenant_id !== input.customerTenantId)) return 'stale'
      const target = rows.find(row => row.dedupe_key === targetKey)
      const incident = rows.find(row => row.dedupe_key === connectionKey)
      if (target?.metadata?.consentOperationId === input.operationId) return 'replayed'
      // Replays reuse the terminal snapshot, never a freshly adopted occurrence.
      // A deletion, replacement, increment, or previously absent row is stale,
      // even when its writer supplied an older timestamp.
      if (rows.length !== expected.length || rows.some(row => !expected.some(prior =>
        prior.key === row.dedupe_key && prior.id === row.id && prior.count === row.occurrence_count && prior.at === row.occurrence_at))) return 'stale'
      // Legacy writers use millisecond Date values. Even an earlier microsecond
      // within the same millisecond cannot prove the occurrence preceded success.
      if (rows.some(row => !row.precedes_terminal)) return 'stale'
      const missing = op.result_code === 'MISSING_PERMISSIONS'
      const event = success ? 'tenant.connection_authorized' : missing ? 'tenant.connection_permissions_missing' : 'tenant.connection_failed'
      const title = success ? 'Microsoft 365 connection authorized' : missing ? 'Microsoft 365 permissions need attention' : 'Microsoft 365 authorization failed'
      const description = success ? 'HawkView verified the tenant connection. It is ready for scheduled synchronization.'
        : missing ? 'Required connection permissions must be approved before synchronization can begin.' : 'Microsoft tenant authorization did not complete. Review the connection and try again.'
      const metadata = JSON.stringify({ consentOperationId: input.operationId, errorCode: success ? null : op.result_code })
      const id = target?.id ?? randomUUID()
      const written = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO notifications
        (id,organization_id,customer_tenant_id,event_type,category,severity,title,description,metadata,action_url,action_label,source,dedupe_key,
         occurrence_count,first_occurred_at,last_occurred_at,created_at,updated_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'microsoft-consent',$12,1,$13::timestamptz,$13::timestamptz,$13::timestamptz,$13::timestamptz)
        ON CONFLICT (organization_id,dedupe_key) DO UPDATE SET event_type=EXCLUDED.event_type,category=EXCLUDED.category,severity=EXCLUDED.severity,
        title=EXCLUDED.title,description=EXCLUDED.description,metadata=EXCLUDED.metadata,action_url=EXCLUDED.action_url,action_label=EXCLUDED.action_label,
        last_occurred_at=EXCLUDED.last_occurred_at,updated_at=GREATEST(notifications.updated_at,EXCLUDED.updated_at),resolved_at=NULL,expires_at=NULL,occurrence_count=notifications.occurrence_count+1
        WHERE notifications.customer_tenant_id=EXCLUDED.customer_tenant_id
          AND notifications.id=$14::uuid AND notifications.occurrence_count=$15::int
          AND notifications.last_occurred_at=$16::timestamptz
          AND date_trunc('milliseconds',notifications.last_occurred_at)<date_trunc('milliseconds',EXCLUDED.last_occurred_at)
          AND (notifications.metadata->>'consentOperationId') IS DISTINCT FROM ($9::jsonb->>'consentOperationId') RETURNING id`,
        id,input.organizationId,input.customerTenantId,event,success?'success':missing?'warning':'error',success?'info':'high',title,description,metadata,
        `/tenants/${input.customerTenantId}${success?'':'/settings'}`,success?'View tenant':'Review connection',targetKey,op.terminal_at,target?.id ?? null,target?.occurrence_count ?? null,target?.occurrence_at ?? null)
      if (written.length !== 1) return 'stale'
      await tx.$executeRawUnsafe('DELETE FROM notification_user_states WHERE notification_id=$1::uuid',written[0].id)
      // Never resolve by dedupe key alone: absent rows cannot be locked. Only
      // the exact observed, still-unresolved occurrence is eligible for resolution.
      if (success && incident && !incident.resolved_at) {
        const resolved = await tx.$executeRawUnsafe(`UPDATE notifications SET resolved_at=$3::timestamptz,updated_at=GREATEST(updated_at,$3::timestamptz)
          WHERE organization_id=$1::uuid AND dedupe_key=$2 AND customer_tenant_id=$4::uuid
            AND id=$5::uuid AND occurrence_count=$6::int AND last_occurred_at=$7::timestamptz
            AND resolved_at IS NULL AND date_trunc('milliseconds',last_occurred_at)<date_trunc('milliseconds',$3::timestamptz)`,
          input.organizationId,connectionKey,op.terminal_at,input.customerTenantId,incident.id,incident.occurrence_count,incident.occurrence_at)
        // Roll back the target write and recipient reset together if the observed
        // occurrence was not updated. The separately committed authority is intact.
        if (resolved !== 1) throw new Error('CONSENT_EFFECT_OCCURRENCE_CHANGED')
      }
      return 'applied'
    })
    return result.status === 'current' ? result.value : 'stale'
  } catch { return 'unavailable' }
}
