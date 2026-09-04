import type { Prisma } from '../generated/prisma/client.js'
import type { IdentityRiskEvaluationRequest, IdentityRiskSourceBatch } from './identity-risk.contract.js'
import { isGlobalRiskConfig, riskRuntimeConfig, riskScopeAllowed } from './risk-runtime-config.js'
import { MAILBOX_SOURCE_VERSION, sourceAttestationKey } from './mailbox-source-attestation.js'

export function assertRiskExecutionBudget(request: Pick<IdentityRiskEvaluationRequest, 'executionDeadlineAt'>) {
  if (request.executionDeadlineAt !== undefined &&
    (!Number.isSafeInteger(request.executionDeadlineAt) || request.executionDeadlineAt - Date.now() < 100))
    throw new Error('IDENTITY_RISK_CYCLE_DEFERRED')
}

export async function configureRiskStatementBudget(transaction: Prisma.TransactionClient,
  request: Pick<IdentityRiskEvaluationRequest, 'executionDeadlineAt'>) {
  assertRiskExecutionBudget(request)
  if (request.executionDeadlineAt !== undefined) await transaction.$executeRawUnsafe(
    "SELECT set_config('statement_timeout', $1, true)",
    String(Math.max(1, Math.min(4_500, request.executionDeadlineAt - Date.now() - 50))))
}

/** Called AFTER the evaluator's sorted control locks, within claim/commit. No
 * source payload reload, new Graph call, provisioning, or customer API change. */
export async function assertGlobalRiskCommitScope(transaction: Prisma.TransactionClient,
  request: IdentityRiskEvaluationRequest, capability: IdentityRiskSourceBatch['capability'],
  attestations: IdentityRiskSourceBatch['mailboxAttestations']) {
  assertRiskExecutionBudget(request)
  await configureRiskStatementBudget(transaction, request)
  if (process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT !== 'global' && request.executionDeadlineAt === undefined) return
  const config = riskRuntimeConfig()
  if (!isGlobalRiskConfig(config) || !riskScopeAllowed({ ...request, environment: config.environment }, config))
    throw new Error('IDENTITY_RISK_SCOPE_UNAVAILABLE')
  const owners = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
    "SELECT id FROM organizations WHERE id=$1::uuid AND status='ACTIVE' FOR SHARE", request.organizationId)
  if (owners.length !== 1) throw new Error('IDENTITY_RISK_SCOPE_UNAVAILABLE')
  const tenants = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM customer_tenants
    WHERE id=$1::uuid AND organization_id=$2::uuid AND status='ACTIVE' FOR SHARE`, request.customerTenantId, request.organizationId)
  if (tenants.length !== 1) throw new Error('IDENTITY_RISK_SCOPE_UNAVAILABLE')
  const connections = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM tenant_connections
    WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid AND status='CONNECTED' FOR SHARE`, request.customerTenantId, request.organizationId)
  if (connections.length !== 1) throw new Error('IDENTITY_RISK_SCOPE_UNAVAILABLE')
  if (capability !== 'FULL') return
  if (!Array.isArray(attestations) || attestations.length !== 2) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  for (const resource of ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS'] as const) {
    const proofs = attestations.filter(row => row.resourceType === resource)
    const proof = proofs[0]
    if (proofs.length !== 1 || !proof || !(proof.observedAt instanceof Date) ||
      !Number.isFinite(proof.observedAt.getTime()) || !/^[0-9a-f]{64}$/.test(proof.digest))
      throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    const rows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT s.id FROM tenant_entra_snapshots s
      JOIN tenant_collection_field_states f ON f.organization_id=s.organization_id AND f.customer_tenant_id=s.customer_tenant_id AND f.field_key=$4
      JOIN sync_states y ON y.organization_id=s.organization_id AND y.customer_tenant_id=s.customer_tenant_id AND y.resource_type=s.resource_type
      WHERE s.organization_id=$1::uuid AND s.customer_tenant_id=$2::uuid AND s.resource_type::text=$3
        AND s.observed_at=$5 AND s.observed_at>=CURRENT_TIMESTAMP-INTERVAL '36 hours'
        AND s.observed_at<=CURRENT_TIMESTAMP+INTERVAL '5 minutes'
        AND f.state='COMPLETE' AND f.source=$6 AND f.correlation_id=$7 AND f.last_successful_at=s.observed_at
        AND y.status='SUCCEEDED' AND y.last_successful_at>=s.observed_at
        AND (y.last_attempt_at IS NULL OR y.last_attempt_at<=y.last_successful_at)
      FOR SHARE OF s,f,y`, request.organizationId, request.customerTenantId, resource,
      sourceAttestationKey(resource), proof.observedAt, MAILBOX_SOURCE_VERSION, proof.digest)
    if (rows.length !== 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
  }
  assertRiskExecutionBudget(request)
}
