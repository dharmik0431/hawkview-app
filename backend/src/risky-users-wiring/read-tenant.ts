import { PrismaClient } from '../generated/prisma/client.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import { assessTenant, type ClassifiedStream } from './assess-tenant.js'
import { capabilityOf } from './feed-capability.js'
import { evidenceFromSync } from './evidence-availability.js'
import type { NormalizationSource } from '../risky-users-normalization/contract.js'
import type { CollectionScope as ClassifierCollectionScope } from '../risky-users-normalization/reasons.js'
import type { CollectorSyncStatus } from '../tenants/service-sync-freshness.js'
import type { TenantAssessment } from '../evaluation-core/compose.js'

/** Reads a tenant's stored evidence and runs it through the pipeline.
 *
 * The first thing in this workstream that touches a database. Everything above
 * it has been pure and testable, which was worth having and is not worth
 * anything until something feeds it real rows.
 *
 * Read-only by construction: it issues `findMany` and nothing else. No write,
 * no migration, no schema change.
 */

export type ReadTenantInput = Readonly<{
  organizationId: string
  customerTenantId: string
  source: NormalizationSource
  /** What the collector asked Microsoft for, in the collector's own words. */
  collectionScope: ClassifierCollectionScope
  /** From the collector's own sync state. Deciding this from row counts would
   * be the defect the whole four-state vocabulary exists to prevent: an empty
   * window and an uncollected one look identical in the rows. */
  syncStatus: CollectorSyncStatus
  windowStart: Date
  windowEnd: Date
  maxEvents: number
}>

export async function readTenantAssessment(
  prisma: PrismaClient, input: ReadTenantInput,
): Promise<TenantAssessment> {
  const availability = evidenceFromSync(input.syncStatus)
  if (!availability.read) {
    // No query at all. Asking the database for rows we have already established
    // we cannot treat as evidence would invite reading the answer off the row
    // count, which is exactly what the sync state exists to stop.
    return assessTenant({
      streams: [{ stream: input.source, collection: availability.availability }],
      budget: { maxEvents: input.maxEvents },
    })
  }

  // Microsoft's directory tenant id is a DIFFERENT id from our internal tenant
  // uuid, and the classifier binds audit rows on it — a row whose
  // OrganizationId does not match is rejected as TENANT_BINDING_MISMATCH.
  // Passing our own uuid here would have rejected every audit row and produced
  // a batch of zeros with no error, which is the symptom Engineer 3 warned
  // about: found because they said what to look for, not because anything
  // failed.
  const tenant = await prisma.customerTenant.findFirst({
    where: { id: input.customerTenantId, organizationId: input.organizationId },
    select: { microsoftTenantId: true },
  })
  if (tenant === null) {
    throw new Error(
      'No such customer tenant in this organization. Refusing to assess rather than '
      + 'assessing against a directory we cannot identify.')
  }

  const scope = {
    organizationId: input.organizationId,
    customerTenantId: input.customerTenantId,
    microsoftTenantId: tenant.microsoftTenantId,
  }

  const [rows, directory] = await Promise.all([
    prisma.signInLog.findMany({
      where: {
        organizationId: input.organizationId,
        customerTenantId: input.customerTenantId,
        eventDateTime: { gte: input.windowStart, lte: input.windowEnd },
      },
      select: { raw: true, ingestedAt: true },
      orderBy: { eventDateTime: 'asc' },
    }),
    prisma.directoryUser.findMany({
      where: { organizationId: input.organizationId, customerTenantId: input.customerTenantId },
      select: { microsoftUserId: true, userPrincipalName: true, userType: true },
    }),
  ])

  const batch = await normalizeSignInBatch({
    scope,
    source: input.source,
    rows: rows.map(row => ({
      organizationId: input.organizationId,
      customerTenantId: input.customerTenantId,
      raw: row.raw,
      ingestedAt: row.ingestedAt,
    })),
    directory: directory.map(user => ({
      organizationId: input.organizationId,
      customerTenantId: input.customerTenantId,
      microsoftUserId: user.microsoftUserId,
      userPrincipalName: user.userPrincipalName,
      userType: user.userType,
    })),
    // Pseudonymous by default. The real reader resolves subject refs through the
    // pseudonym service; this keeps a raw directory id out of the assessment
    // while the shape is being proven.
    reference: async (microsoftUserId: string) => `subject:${microsoftUserId}`,
    collectionScope: input.collectionScope,
  })

  const stream: ClassifiedStream = {
    stream: input.source,
    collection: 'READ',
    batch,
    scope: { declared: true, asked: input.collectionScope },
    // No detectors yet. That is deliberate for this step: it proves the rows
    // reach the engine and what the engine says about coverage, without a
    // detector's findings standing in for whether the pipeline works.
    detectors: [],
  }

  // Capability is available and unused until there are detectors to bind. Named
  // here so the next person sees where it attaches rather than reinventing it.
  void capabilityOf(input.source)

  return assessTenant({ streams: [stream], budget: { maxEvents: input.maxEvents } })
}
