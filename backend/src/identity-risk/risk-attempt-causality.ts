import type { Prisma } from '../generated/prisma/client.js'
import type { IdentityRiskEvaluationRequest } from './identity-risk.contract.js'
import { isGlobalRiskConfig, riskRuntimeConfig } from './risk-runtime-config.js'
import { RISK_UUID } from './pilot-risk-config.js'

export async function lockGlobalRiskAttempt(tx: Prisma.TransactionClient, request: IdentityRiskEvaluationRequest) {
  const config = riskRuntimeConfig()
  if (!isGlobalRiskConfig(config)) {
    if (request.globalAttemptId !== undefined) throw new Error('IDENTITY_RISK_ATTEMPT_UNAVAILABLE')
    return
  }
  if (!request.globalAttemptId || !RISK_UUID.test(request.globalAttemptId)) throw new Error('IDENTITY_RISK_ATTEMPT_UNAVAILABLE')
  const heads = await tx.$queryRawUnsafe<Array<{ attemptId: string }>>(`SELECT attempt_id AS "attemptId"
    FROM identity_risk_attempt_heads WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
    AND environment=$3 FOR UPDATE`, request.organizationId, request.customerTenantId, config.environment)
  if (heads.length !== 1 || heads[0]?.attemptId !== request.globalAttemptId)
    throw new Error('IDENTITY_RISK_ATTEMPT_UNAVAILABLE')
}

/** Same transaction as successful persistence or authoritative replay. No clock
 * compares attempts; the current head CAS prevents out-of-order completion from
 * blessing a newer pending/failed attempt. */
export async function completeGlobalRiskAttempt(tx: Prisma.TransactionClient, request: IdentityRiskEvaluationRequest, runId: string) {
  const config = riskRuntimeConfig()
  if (!isGlobalRiskConfig(config)) return
  const changed = await tx.$executeRawUnsafe(`UPDATE identity_risk_attempt_heads h SET completed_run_id=$5::uuid
    WHERE h.organization_id=$1::uuid AND h.customer_tenant_id=$2::uuid AND h.environment=$3
    AND h.attempt_id=$4::uuid AND EXISTS (SELECT 1 FROM identity_risk_evaluation_runs r
      WHERE r.id=$5::uuid AND r.organization_id=h.organization_id AND r.customer_tenant_id=h.customer_tenant_id
      AND r.status='COMPLETED')`, request.organizationId, request.customerTenantId, config.environment, request.globalAttemptId, runId)
  if (changed !== 1) throw new Error('IDENTITY_RISK_ATTEMPT_UNAVAILABLE')
}
