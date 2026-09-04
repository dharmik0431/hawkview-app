import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { IDENTITY_RISK_CATALOG_VERSION, IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION,
  type IdentityRiskSourceBatch, type IdentityRiskSourceEnvelope } from './identity-risk.contract.js'
import { IDENTITY_SIGNAL_RULE_IDS } from './identity-signal-contract.js'
import { IdentityRiskPseudonymProvider, type PinnedPseudonymSession, type PseudonymKeyVersion } from './identity-risk-pseudonym.js'
import { forwardingRule, mailboxSourceDigest, MAILBOX_SOURCE_MAX_AGE_MS, MAILBOX_SOURCE_RESOURCES,
  MAILBOX_SOURCE_VERSION, MAILBOX_PROJECTOR_MAX_BYTES, MAILBOX_PROJECTOR_MAX_RULES, sourceAttestationKey,
  verifiedDomain, type MailboxSourceResource, type MailboxSourceScope } from './mailbox-source-attestation.js'

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
  const verifiedDomains = (domains.payload as unknown[]).map((row) => verifiedDomain((row as Record<string, unknown>).domain)!).sort()
  const observation = await session.reference('observation', [MAILBOX_SOURCE_VERSION, rules.observedAt.toISOString(), domains.observedAt.toISOString()])
  const sourceEnvelopes: IdentityRiskSourceEnvelope[] = []
  const orderedRules = (rules.payload as unknown[]).map((row) => forwardingRule(row)!)
    .sort((a, b) => { const left = JSON.stringify([a.mailboxId, a.ruleId]); const right = JSON.stringify([b.mailboxId, b.ruleId]); return left < right ? -1 : left > right ? 1 : 0 })
  for (const rule of orderedRules) {
    const subjectReference = await session.reference('mailbox', [rule.mailboxId])
    const objectId = await session.reference('evidence', [rule.mailboxId, rule.ruleId])
    const evidenceReference = await session.reference('evidence', [rule.mailboxId, rule.ruleId, observation])
    sourceEnvelopes.push({ kind: 'AUTHORITATIVE_SNAPSHOT', resourceType: 'EXCHANGE_MAILBOX_RULES',
      objectId, authoritativeObservationId: observation, observedAt: rules.observedAt,
      projectorSchemaVersion: 'mailbox-investigation-source.v1', sourceWatermark: observation,
      payload: { schemaVersion: IDENTITY_RISK_SOURCE_PAYLOAD_SCHEMA_VERSION, recordReference: evidenceReference, subjectReference,
        candidate: { ruleId: 'HV-ID-MBX-001.v1', subject: { type: 'MAILBOX', opaqueId: subjectReference },
          evidenceReferences: [evidenceReference], evidenceState: 'COMPLETE',
          evidence: [rules, domains].map((row) => ({ observedAt: row.observedAt.toISOString(), maxAgeHours: 36 })),
          enabled: rule.enabled, recipientAddresses: rule.recipients, verifiedAcceptedDomains: verifiedDomains } } })
  }
  const sourceObservedAt = new Date(Math.min(rules.observedAt.getTime(), domains.observedAt.getTime()))
  return { context, sourceEnvelopes, orderedSourceWatermarks: [observation],
    earliestSourceExpiry: new Date(sourceObservedAt.getTime() + MAILBOX_SOURCE_MAX_AGE_MS), capability: 'FULL',
    pseudonymKeyVersionId: session.keyVersion.id, sourceObservedAt }
}

@Injectable()
export class MailboxRiskProjector {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityRiskPseudonymProvider) private readonly provider: IdentityRiskPseudonymProvider) {}

  async load(scope: MailboxSourceScope, evaluationAt: Date): Promise<IdentityRiskSourceBatch> {
    // No tenant source reads, registry lookups, or evaluation writes when unconfigured.
    const environment = process.env.HAWKVIEW_IDENTITY_RISK_ENVIRONMENT
    if (!this.provider.configured || !environment || !/^[a-z][a-z0-9-]{0,39}$/.test(environment)) throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const deadlineAt = Date.now() + 30000
    const keys = await this.prisma.identityRiskPseudonymKeyVersion.findMany({ where: { ...scope, environment, status: 'ACTIVE',
      activatedAt: { lte: evaluationAt }, retiredAt: null }, take: 2 })
    const key = keys[0]
    if (keys.length !== 1 || !key || key.organizationId !== scope.organizationId || key.customerTenantId !== scope.customerTenantId ||
      key.environment !== environment || key.provider !== 'AWS_KMS_HMAC_256') throw new Error('IDENTITY_RISK_KEY_UNAVAILABLE')
    const session = await this.provider.pin(key as PseudonymKeyVersion, deadlineAt)
    const snapshots = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5000ms'")
      const result: AttestedMailboxSnapshot[] = []
      for (const resource of MAILBOX_SOURCE_RESOURCES) {
        if (Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
        // SQL gates bytes/rows BEFORE JSON crosses the driver boundary. Each source is fetched once,
        // in the same repeatable-read snapshot as its companion and sync metadata.
        const rows = await tx.$queryRaw<AttestedMailboxSnapshot[]>`
          SELECT s.organization_id AS "organizationId", s.customer_tenant_id AS "customerTenantId",
            s.resource_type AS "resourceType", s.observed_at AS "observedAt",
            CASE WHEN jsonb_typeof(s.payload) = 'array' THEN
              CASE WHEN jsonb_array_length(s.payload) <= ${resource === 'EXCHANGE_MAILBOX_RULES' ? MAILBOX_PROJECTOR_MAX_RULES : 1000}
                AND octet_length(s.payload::text) <= ${MAILBOX_PROJECTOR_MAX_BYTES} THEN s.payload ELSE NULL END ELSE NULL END AS payload,
            f.state, f.source, f.correlation_id AS digest, f.last_successful_at AS "attestedAt",
            y.status AS "syncStatus", y.last_successful_at AS "lastSuccessfulAt", y.last_attempt_at AS "lastAttemptAt"
          FROM tenant_entra_snapshots s
          JOIN tenant_collection_field_states f ON f.organization_id=s.organization_id AND f.customer_tenant_id=s.customer_tenant_id AND f.field_key=${sourceAttestationKey(resource)}
          JOIN sync_states y ON y.organization_id=s.organization_id AND y.customer_tenant_id=s.customer_tenant_id AND y.resource_type=s.resource_type
          WHERE s.organization_id=${scope.organizationId}::uuid AND s.customer_tenant_id=${scope.customerTenantId}::uuid AND s.resource_type::text=${resource} LIMIT 2`
        result.push(...rows)
      }
      return result
    }, { isolationLevel: 'RepeatableRead', timeout: 12000 })
    if (Date.now() >= deadlineAt) throw new Error('IDENTITY_RISK_SOURCE_UNAVAILABLE')
    // A provider outage aborts before the existing evaluator claims or writes a run.
    return projectMailboxEvidence(scope, evaluationAt, snapshots, session)
  }
}
