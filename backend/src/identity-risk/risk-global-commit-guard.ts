import type { Prisma } from '../generated/prisma/client.js'
import type { IdentityRiskEvaluationRequest, IdentityRiskSourceBatch } from './identity-risk.contract.js'
import { isGlobalRiskConfig, riskRuntimeConfig, riskScopeAllowed } from './risk-runtime-config.js'
import { MAILBOX_SOURCE_VERSION, sourceAttestationKey } from './mailbox-source-attestation.js'
import { lockGlobalRiskAttempt } from './risk-attempt-causality.js'
import type { StoredRiskAssessment } from './risk-assessment-projection.js'
import { authenticationWindow, selectedAuthenticationSource } from './authentication-source-readiness.js'
import { AUTHENTICATION_GENERATION_SQL, authenticationGenerationParameters, authenticationGenerationValid, type AuthenticationGeneration } from './authentication-generation-proof.js'

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
  attestations: IdentityRiskSourceBatch['mailboxAttestations'],
  authenticationProof?: IdentityRiskSourceBatch['authenticationProof'],
  assessment?: StoredRiskAssessment) {
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
  await lockGlobalRiskAttempt(transaction, request)
  if (assessment) {
    const authenticationUsed = assessment.rules.some(rule => rule.ruleId !== 'HV-ID-MBX-001.v1' &&
      (rule.status === 'READY' || (rule.status === 'PARTIAL' && rule.selectedSource !== null && rule.evaluatedAt !== null))) ||
      assessment.subjects.some(subject => subject.findings.some(finding => finding.ruleId !== 'HV-ID-MBX-001.v1' && finding.activityState === 'CURRENT'))
    if (authenticationUsed) {
      await transaction.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `hawkview:auth-ingestion:${request.organizationId}:${request.customerTenantId}`)
      const proof = authenticationProof
      if (!proof || proof.resourceType !== 'SIGN_INS' || !(proof.lastSuccessfulAt instanceof Date) ||
        !Number.isFinite(proof.lastSuccessfulAt.getTime()) || proof.lastSuccessfulAt > request.evaluationAt)
        throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      // Preserve exact collection generation, including known limited-feed
      // outcomes. No Graph request and no assumption that all feeds succeeded.
      const rows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM sync_states
        WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type='SIGN_INS'
          AND status::text=$3 AND last_successful_at=$4
          AND last_attempt_at IS NOT DISTINCT FROM $5::timestamptz
          AND last_error_code IS NOT DISTINCT FROM $6::text FOR SHARE`,
      request.organizationId, request.customerTenantId, proof.status, proof.lastSuccessfulAt, proof.lastAttemptAt, proof.lastErrorCode)
      if (rows.length !== 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      const window = authenticationWindow(proof.window)
      if (!window || window.source !== proof.selectedSource || selectedAuthenticationSource(proof) !== proof.selectedSource ||
        !/^[a-f0-9]{64}$/.test(proof.rowDigest) ||
        (window.paginationComplete && (!(proof.observedAt instanceof Date) || !Number.isFinite(proof.observedAt.getTime()) ||
          proof.observedAt > proof.lastSuccessfulAt || Date.parse(window.end) > proof.observedAt.getTime())) ||
        (!window.paginationComplete && (proof.observedAt !== null || window.end !== proof.lastSuccessfulAt.toISOString())) ||
        assessment.rules.some(rule => rule.ruleId !== 'HV-ID-MBX-001.v1' && ['READY','PARTIAL'].includes(rule.status) && rule.selectedSource !== proof.selectedSource))
        throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      if (window.paginationComplete) {
      const snapshots = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM tenant_entra_snapshots
        WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type='SIGN_INS'
          AND observed_at=$3 AND payload=$4::jsonb FOR SHARE`,
      request.organizationId, request.customerTenantId, proof.observedAt, JSON.stringify(window))
      if (snapshots.length !== 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      } else if (assessment.rules.some(rule => rule.ruleId !== 'HV-ID-MBX-001.v1' && rule.status === 'READY')) {
        throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      }
      const directory = proof.directory
      if (!directory || directory.status !== 'SUCCEEDED' || directory.lastErrorCode !== null ||
        !(directory.lastSuccessfulAt instanceof Date) || !Number.isFinite(directory.lastSuccessfulAt.getTime()) ||
        directory.lastSuccessfulAt > request.evaluationAt || request.evaluationAt.getTime() - directory.lastSuccessfulAt.getTime() > 26 * 60 * 60_000 ||
        (directory.lastAttemptAt && directory.lastAttemptAt > directory.lastSuccessfulAt)) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      const directories = await transaction.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM sync_states
        WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid AND resource_type='USERS' AND status='SUCCEEDED'
          AND last_error_code IS NULL AND last_successful_at=$3 AND last_attempt_at IS NOT DISTINCT FROM $4::timestamptz FOR SHARE`,
      request.organizationId, request.customerTenantId, directory.lastSuccessfulAt, directory.lastAttemptAt)
      if (directories.length !== 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
      // Collectors acquire/update their scoped SyncState before writing logs or
      // directory rows. The locks above hold that writer boundary until commit.
      // Recheck every bounded row's content as well, not just the generic status.
      const generations = await transaction.$queryRawUnsafe<AuthenticationGeneration[]>(AUTHENTICATION_GENERATION_SQL,
        ...authenticationGenerationParameters(request, window, request.evaluationAt))
      if (generations.length !== 1 || !authenticationGenerationValid(generations[0]) || generations[0].digest !== proof.rowDigest)
        throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    }
    const mailboxUsed = assessment.rules.some(rule => rule.ruleId === 'HV-ID-MBX-001.v1' && (rule.status === 'READY' || rule.status === 'PARTIAL')) ||
      assessment.subjects.some(subject => subject.findings.some(finding => finding.ruleId === 'HV-ID-MBX-001.v1' && finding.activityState === 'CURRENT'))
    if (!mailboxUsed) return
  } else if (capability !== 'FULL') return
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
