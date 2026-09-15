import type { AuthScope } from '../risky-users-auth/contract.js'
import type { IdentityRiskSourceBatch } from './identity-risk.contract.js'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { AUTH_WINDOW_SCHEMA_V1, authenticationWindow, prepareAuthenticationEvaluation, selectedAuthenticationSource, unavailableAuthenticationSource, type AuthenticationWindow, type AuthenticationDirectoryUser,
  type AuthenticationProof, type AuthenticationReference, type AuthenticationRow } from './authentication-source-readiness.js'
import { AUTHENTICATION_GENERATION_SQL, authenticationGenerationParameters, authenticationGenerationValid, type AuthenticationGeneration } from './authentication-generation-proof.js'

/** Bounded read-only adapter. No provider request, raw-event logging or writes.
 * The source/page-chain proof, logs and current directory share one DB snapshot. */
export async function loadAuthenticationRiskEvidence(scope: AuthScope, evaluationAt: Date, deadlineAt: number, reference: AuthenticationReference) {
  const read = await withMailboxReadTransaction(deadlineAt, 6000, async client => {
    const owners = await client.query(`SELECT t.id FROM customer_tenants t JOIN organizations o ON o.id=t.organization_id
      JOIN tenant_connections c ON c.customer_tenant_id=t.id AND c.organization_id=t.organization_id
      WHERE t.id=$1::uuid AND t.organization_id=$2::uuid AND t.microsoft_tenant_id=$3::uuid
        AND t.status='ACTIVE' AND o.status='ACTIVE' AND c.status='CONNECTED' LIMIT 2`,
    [scope.customerTenantId, scope.organizationId, scope.microsoftTenantId])
    if (owners.rows.length !== 1) throw new Error('IDENTITY_AUTH_SCOPE_INVALID')
    const states = (await client.query<AuthenticationProof & { resource: string }>(`SELECT resource_type AS resource, status,
      last_successful_at AS "lastSuccessfulAt",last_attempt_at AS "lastAttemptAt",last_error_code AS "lastErrorCode"
      FROM sync_states WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type IN ('SIGN_INS','USERS') LIMIT 3`,
    [scope.organizationId, scope.customerTenantId])).rows
    const proof = states.find(row => row.resource === 'SIGN_INS') ?? null
    const userProof = states.find(row => row.resource === 'USERS') ?? null
    const snapshots = (await client.query<{ observedAt: Date; payload: unknown }>(`SELECT observed_at AS "observedAt",
      CASE WHEN octet_length(payload::text)<=8192 THEN payload ELSE NULL END AS payload
      FROM tenant_entra_snapshots WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type='SIGN_INS' LIMIT 2`,
    [scope.organizationId, scope.customerTenantId])).rows
    const snapshot = snapshots.length === 1 ? snapshots[0] : undefined
    const reportedWindow = authenticationWindow(snapshot?.payload)
    const snapshotValid = reportedWindow?.paginationComplete === true && snapshot?.observedAt instanceof Date && proof?.lastSuccessfulAt instanceof Date &&
      snapshot.observedAt <= proof.lastSuccessfulAt && snapshot.observedAt <= evaluationAt &&
      Date.parse(reportedWindow.end) <= snapshot.observedAt.getTime() && reportedWindow.source === selectedAuthenticationSource(proof)
    const selected = selectedAuthenticationSource(proof)
    // Unattested legacy collections can still supply exact supported positive
    // witnesses. This is a bounded read window, NEVER a pagination assertion.
    const window: AuthenticationWindow | null = snapshotValid ? reportedWindow : selected && proof?.lastSuccessfulAt instanceof Date && Number.isFinite(proof.lastSuccessfulAt.getTime())
      // V1 DELIBERATELY. This is the unattested legacy fallback: a bounded read
      // window built from a proof timestamp, with nothing observed recorded. v2
      // promises an observation and this has none, so labelling it v2 would be a
      // version claiming a fact that is not in the object.
      ? { schemaVersion: AUTH_WINDOW_SCHEMA_V1, source: selected, start: new Date(proof.lastSuccessfulAt.getTime() - 24 * 60 * 60_000).toISOString(),
        end: proof.lastSuccessfulAt.toISOString(), paginationComplete: false } : null
    const directoryReady = !!userProof && userProof.status === 'SUCCEEDED' && userProof.lastErrorCode === null &&
      userProof.lastSuccessfulAt instanceof Date && userProof.lastSuccessfulAt <= evaluationAt &&
      evaluationAt.getTime() - userProof.lastSuccessfulAt.getTime() <= 26 * 60 * 60_000 &&
      (!userProof.lastAttemptAt || userProof.lastAttemptAt <= userProof.lastSuccessfulAt)
    if (!window) return { proof, userProof, window: null, observedAt: null, directoryReady, rows: [] as AuthenticationRow[], directory: [] as AuthenticationDirectoryUser[], generation: null }
    const generation = (await client.query<AuthenticationGeneration>(AUTHENTICATION_GENERATION_SQL,
      [...authenticationGenerationParameters(scope, window, evaluationAt)])).rows[0]
    if (!authenticationGenerationValid(generation)) return { proof, userProof, window, observedAt: snapshotValid ? snapshot!.observedAt : null, directoryReady: false,
      rows: [] as AuthenticationRow[], directory: [] as AuthenticationDirectoryUser[], generation: null }
    const directory = (await client.query<AuthenticationDirectoryUser>(`SELECT organization_id AS "organizationId",customer_tenant_id AS "customerTenantId",
      microsoft_user_id AS "microsoftUserId",user_principal_name AS "userPrincipalName",user_type AS "userType"
      FROM directory_users WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND deleted_at IS NULL ORDER BY id LIMIT 5001`,
    [scope.organizationId, scope.customerTenantId])).rows
    const rows = (await client.query<AuthenticationRow>(`SELECT organization_id AS "organizationId",customer_tenant_id AS "customerTenantId",raw,ingested_at AS "ingestedAt"
      FROM sign_in_logs WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
        AND event_date_time >= $3::timestamptz AND event_date_time <= $4::timestamptz AND expires_at > $5::timestamptz ORDER BY id LIMIT 10001`,
    [...authenticationGenerationParameters(scope, window, evaluationAt)])).rows
    return { proof, userProof, window, observedAt: snapshotValid ? snapshot!.observedAt : null, directoryReady, rows, directory, generation }
  })
  const prepared = read.window && !read.generation ? { input: null, sources: (['GRAPH_SIGN_INS','M365_AUDIT_STS'] as const).map(source => unavailableAuthenticationSource(source,'CAPACITY_LIMIT')), resolvedSubjects: [], disputedEventIds: [] as string[] }
    : await prepareAuthenticationEvaluation(scope, read.rows, read.directory, read.proof, read.window, read.directoryReady, evaluationAt, reference)
  const proof: IdentityRiskSourceBatch['authenticationProof'] = prepared.input && read.proof?.lastSuccessfulAt && read.userProof?.lastSuccessfulAt && read.window && read.generation?.digest
    ? { resourceType: 'SIGN_INS', ...read.proof, lastSuccessfulAt: read.proof.lastSuccessfulAt, selectedSource: prepared.input.source,
      window: read.window, observedAt: read.observedAt, rowDigest: read.generation.digest,
      directory: { ...read.userProof, lastSuccessfulAt: read.userProof.lastSuccessfulAt } } : undefined
  return { ...prepared, proof }
}
