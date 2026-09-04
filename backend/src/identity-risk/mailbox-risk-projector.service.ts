import { Inject, Injectable } from '@nestjs/common'
import { withMailboxReadTransaction } from './mailbox-read-transaction.js'
import { IDENTITY_RISK_CATALOG_VERSION, IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
  type IdentityRiskSourceBatch, type IdentityRiskSourceEnvelope } from './identity-risk.contract.js'
import { IDENTITY_SIGNAL_RULE_IDS, IDENTITY_SIGNAL_MAX_BATCH_CANDIDATES, IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES } from './identity-signal-contract.js'
import { boundedInputBytes, isIdentitySignalCandidateRuntime } from './identity-signal-runtime.js'
import { projectApprovedContext, isApprovedIdentitySignalCandidateProjection } from './identity-risk-approved-evaluator.adapter.js'
import { IdentityRiskPseudonymProvider, type PinnedPseudonymSession, type PseudonymKeyVersion } from './identity-risk-pseudonym.js'
import { forwardingRule, mailboxSourceDigest, MAILBOX_SOURCE_MAX_AGE_MS, MAILBOX_SOURCE_RESOURCES,
  MAILBOX_SOURCE_VERSION, MAILBOX_PROJECTOR_MAX_BYTES, MAILBOX_PROJECTOR_MAX_RULES, sourceAttestationKey,
  verifiedDomain, type ForwardingRule, type MailboxSourceResource, type MailboxSourceScope } from './mailbox-source-attestation.js'

export const MAILBOX_FIRST_SLICE_FLAGS = Object.freeze(Object.fromEntries(
  IDENTITY_SIGNAL_RULE_IDS.map((id) => [id, id === 'HV-ID-MBX-001.v1']),
))
export type AttestedMailboxSnapshot = MailboxSourceScope & {
  resourceType: MailboxSourceResource; observedAt: Date; payload: unknown
  state: string; source: string; digest: string | null; attestedAt: Date | null
  syncStatus: string; lastSuccessfulAt: Date | null; lastAttemptAt: Date | null
}

function current(date: Date | null, now: Date) {
  return date instanceof Date && Number.isFinite(date.getTime()) &&
    now.getTime() - date.getTime() <= MAILBOX_SOURCE_MAX_AGE_MS && date.getTime() - now.getTime() <= 5 * 60 * 1000
}

function mailboxCandidate(rule: ForwardingRule, domains: string[], sources: AttestedMailboxSnapshot[], subject: string, evidence: string) {
  return { ruleId: 'HV-ID-MBX-001.v1' as const, subject: { type: 'MAILBOX' as const, opaqueId: subject },
    evidenceReferences: [evidence], evidenceState: 'COMPLETE' as const,
    evidence: sources.map((row) => ({ observedAt: row.observedAt.toISOString(), maxAgeHours: 36 })),
    enabled: rule.enabled, recipientAddresses: rule.recipients, verifiedAcceptedDomains: domains }
}

export async function readActiveMailboxKeys(scope: MailboxSourceScope, environment: string, evaluationAt: Date, deadlineAt: number) {
  try {
    return await withMailboxReadTransaction(deadlineAt, 6000, async (client) => (await client.query<PseudonymKeyVersion>(`
      SELECT id, organization_id AS "organizationId", customer_tenant_id AS "customerTenantId",
        environment, provider, immutable_key_id AS "immutableKeyId"
      FROM identity_risk_pseudonym_key_versions WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid
        AND environment=$3 AND status='ACTIVE' AND activated_at<=$4 AND retired_at IS NULL LIMIT 2`,
    [scope.organizationId, scope.customerTenantId, environment, evaluationAt])).rows)
  } catch { throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE') }
}

export async function projectMailboxEvidence(scope: MailboxSourceScope, evaluationAt: Date,
  snapshots: readonly AttestedMailboxSnapshot[], session: PinnedPseudonymSession): Promise<IdentityRiskSourceBatch> {
  const context = { ...scope, evaluationAt, engineVersion: IDENTITY_RISK_ENGINE_VERSION, catalogVersion: IDENTITY_RISK_CATALOG_VERSION }
  const unavailable: IdentityRiskSourceBatch = { context, sourceEnvelopes: [], orderedSourceWatermarks: [], earliestSourceExpiry: null, capability: 'UNAVAILABLE' }
  if (session.keyVersion.organizationId !== scope.organizationId || session.keyVersion.customerTenantId !== scope.customerTenantId) throw new Error('IDENTITY_RISK_SOURCE_SCOPE_INVALID')
  if (snapshots.length !== 2) return unavailable
  for (const resource of MAILBOX_SOURCE_RESOURCES) {
    const matching = snapshots.filter((row) => row.resourceType === resource)
    if (matching.length !== 1) return unavailable
    const row = matching[0]!
    if (row.organizationId !== scope.organizationId || row.customerTenantId !== scope.customerTenantId) throw new Error('IDENTITY_RISK_SOURCE_SCOPE_INVALID')
    if (!current(row.observedAt, evaluationAt) || !current(row.lastSuccessfulAt, evaluationAt) ||
      row.syncStatus !== 'SUCCEEDED' || row.lastSuccessfulAt!.getTime() < row.observedAt.getTime() ||
      (row.lastAttemptAt && row.lastAttemptAt.getTime() > row.lastSuccessfulAt!.getTime()) ||
      row.state !== 'COMPLETE' || row.source !== MAILBOX_SOURCE_VERSION || row.attestedAt?.getTime() !== row.observedAt.getTime() ||
      !Array.isArray(row.payload) || row.payload.length > (resource === 'EXCHANGE_MAILBOX_RULES' ? MAILBOX_PROJECTOR_MAX_RULES : 1000) ||
      Buffer.byteLength(JSON.stringify(row.payload)) > MAILBOX_PROJECTOR_MAX_BYTES ||
      !row.digest || row.digest !== mailboxSourceDigest(scope, resource, row.observedAt, row.payload)) return unavailable
  }
  const rules = snapshots.find((row) => row.resourceType === 'EXCHANGE_MAILBOX_RULES')!
  const domains = snapshots.find((row) => row.resourceType === 'EXCHANGE_ACCEPTED_DOMAINS')!
  // Source completeness does not imply evaluator eligibility. Never truncate a
  // complete inventory or send an out-of-contract candidate into the safety gate.
  if ((rules.payload as unknown[]).length > IDENTITY_SIGNAL_MAX_BATCH_CANDIDATES) return unavailable
  const approvedContext = projectApprovedContext({ ...context, capability: 'FULL', sources: {} },
    { readiness: 'READY', featureFlags: MAILBOX_FIRST_SLICE_FLAGS })
  const contextBytes = boundedInputBytes(approvedContext, IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES)
  if (contextBytes === null) return unavailable
  const verifiedDomains = (domains.payload as unknown[]).map((row) => verifiedDomain((row as Record<string, unknown>).domain)!).sort()
  const orderedRules = (rules.payload as unknown[]).map((row) => forwardingRule(row)!)
    .sort((a, b) => { const left = JSON.stringify([a.mailboxId, a.ruleId]); const right = JSON.stringify([b.mailboxId, b.ruleId]); return left < right ? -1 : left > right ? 1 : 0 })
  // Fixed-width shape references are used ONLY for preflight measurement, never
  // returned, persisted, or used as identities. Real references below require MAC.
  let inputBytes = contextBytes
  for (const rule of orderedRules) {
    const candidate = mailboxCandidate(rule, verifiedDomains, [rules, domains], `hvr1_mailbox_${'0'.repeat(64)}`, `hvr1_evidence_${'0'.repeat(64)}`)
    if (!isIdentitySignalCandidateRuntime(candidate) || !isApprovedIdentitySignalCandidateProjection(candidate)) return unavailable
    const bytes = boundedInputBytes(candidate, IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES - inputBytes)
    if (bytes === null) return unavailable
    inputBytes += bytes
  }
  const observation = await session.reference('observation', [MAILBOX_SOURCE_VERSION, rules.observedAt.toISOString(), domains.observedAt.toISOString()])
  const sourceEnvelopes: IdentityRiskSourceEnvelope[] = []
  inputBytes = contextBytes
  for (const rule of orderedRules) {
    const subjectReference = await session.reference('mailbox', [rule.mailboxId])
    const objectId = await session.reference('evidence', [rule.mailboxId, rule.ruleId])
    const evidenceReference = await session.reference('evidence', [rule.mailboxId, rule.ruleId, observation])
    const envelope: IdentityRiskSourceEnvelope = { kind: 'AUTHORITATIVE_SNAPSHOT', resourceType: 'EXCHANGE_MAILBOX_RULES',
      objectId, authoritativeObservationId: observation, observedAt: rules.observedAt,
      projectorSchemaVersion: 'mailbox-investigation-source.v1', sourceWatermark: observation,
      payload: { schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION, recordReference: evidenceReference, subjectReference,
        candidate: mailboxCandidate(rule, verifiedDomains, [rules, domains], subjectReference, evidenceReference) } }
    const candidate = envelope.payload.candidate
    if (!isIdentitySignalCandidateRuntime(candidate) || !isApprovedIdentitySignalCandidateProjection(candidate)) return unavailable
    // Exactly the evaluator's accounting: context once, each actual candidate
    // separately (including repeated domain lists), UTF-16 bytes and node bounds.
    const candidateBytes = boundedInputBytes(candidate, IDENTITY_SIGNAL_MAX_BATCH_INPUT_BYTES - inputBytes)
    if (candidateBytes === null) return unavailable
    inputBytes += candidateBytes
    sourceEnvelopes.push(envelope)
  }
  const sourceObservedAt = new Date(Math.min(rules.observedAt.getTime(), domains.observedAt.getTime()))
  return { context, sourceEnvelopes, orderedSourceWatermarks: [observation],
    earliestSourceExpiry: new Date(sourceObservedAt.getTime() + MAILBOX_SOURCE_MAX_AGE_MS), capability: 'FULL',
    pseudonymKeyVersionId: session.keyVersion.id, sourceObservedAt,
    mailboxAttestations: snapshots.map(row => ({ resourceType: row.resourceType, observedAt: row.observedAt, digest: row.digest! })) }
}

@Injectable()
export class MailboxRiskProjector {
  constructor(@Inject(IdentityRiskPseudonymProvider) private readonly provider: IdentityRiskPseudonymProvider) {}

  async load(scope: MailboxSourceScope, evaluationAt: Date, executionDeadlineAt = Date.now() + 30_000): Promise<IdentityRiskSourceBatch> {
    // No tenant source reads, registry lookups, or evaluation writes when unconfigured.
    const environment = process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    if (!this.provider.configured || !environment || !/^[a-z][a-z0-9-]{0,39}$/.test(environment) ||
      !this.provider.allowsScope({ ...scope, environment })) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const deadlineAt = Math.min(Date.now() + 30000, executionDeadlineAt)
    const keys = await readActiveMailboxKeys(scope, environment, evaluationAt, deadlineAt)
    const key = keys[0]
    if (keys.length !== 1 || !key || key.organizationId !== scope.organizationId || key.customerTenantId !== scope.customerTenantId ||
      key.environment !== environment || !['AWS_KMS_HMAC_256', 'WRAPPED_AES_GCM_V1'].includes(key.provider)) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const session = await this.provider.pin(key as PseudonymKeyVersion, deadlineAt)
    try {
    const snapshots = await withMailboxReadTransaction(deadlineAt, 12000, async (client, transactionDeadlineAt) => {
      const result: AttestedMailboxSnapshot[] = []
      for (const resource of MAILBOX_SOURCE_RESOURCES) {
        const statementMs = Math.min(5000, transactionDeadlineAt - Date.now() - 50)
        if (statementMs < 1) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementMs)])
        // SQL gates bytes/rows BEFORE JSON crosses the driver boundary. Each source is fetched once,
        // in the same repeatable-read snapshot as its companion and sync metadata.
        const rows = await client.query<AttestedMailboxSnapshot>(`
          SELECT s.organization_id AS "organizationId", s.customer_tenant_id AS "customerTenantId",
            s.resource_type AS "resourceType", s.observed_at AS "observedAt",
            CASE WHEN jsonb_typeof(s.payload) = 'array' THEN
              CASE WHEN jsonb_array_length(s.payload) <= $1
                AND octet_length(s.payload::text) <= $2 THEN s.payload ELSE NULL END ELSE NULL END AS payload,
            f.state, f.source, f.correlation_id AS digest, f.last_successful_at AS "attestedAt",
            y.status AS "syncStatus", y.last_successful_at AS "lastSuccessfulAt", y.last_attempt_at AS "lastAttemptAt"
          FROM tenant_entra_snapshots s
          JOIN tenant_collection_field_states f ON f.organization_id=s.organization_id AND f.customer_tenant_id=s.customer_tenant_id AND f.field_key=$3
          JOIN sync_states y ON y.organization_id=s.organization_id AND y.customer_tenant_id=s.customer_tenant_id AND y.resource_type=s.resource_type
          WHERE s.organization_id=$4::uuid AND s.customer_tenant_id=$5::uuid AND s.resource_type::text=$6 LIMIT 2`,
        [resource === 'EXCHANGE_MAILBOX_RULES' ? MAILBOX_PROJECTOR_MAX_RULES : 1000, MAILBOX_PROJECTOR_MAX_BYTES,
          sourceAttestationKey(resource), scope.organizationId, scope.customerTenantId, resource])
        result.push(...rows.rows)
      }
      return result
    })
    if (Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    // A provider outage aborts before the existing evaluator claims or writes a run.
    const batch = await projectMailboxEvidence(scope, evaluationAt, snapshots, session)
    if (!this.provider.allowsScope({ ...scope, environment })) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    return batch
    } finally { session.close?.() }
  }
}
