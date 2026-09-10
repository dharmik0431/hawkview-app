import { PrismaClient } from '../generated/prisma/client.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import { assessTenant, type ClassifiedStream } from './assess-tenant.js'
import { bindToFeed, capabilityOf, type FeedBoundDetector } from './feed-capability.js'
import { decideFeed, type FeedDecision } from './decide-feed.js'
import { watchedResolver } from './coverage-bridge.js'
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
  /** Which feed to assume when the window returned NO rows, and only then.
   *
   * Not "which feed this tenant uses" — that is read off the rows, because a
   * caller asserting it is how three tenants came to be assessed against a feed
   * none of their evidence belonged to. A tenant with no rows still needs a feed
   * to bind detectors to, so the assumption is allowed; it is named so it cannot
   * be mistaken for a derived answer, and `TenantRead.feed` reports which of the
   * two happened. */
  feedIfNoRows: NormalizationSource
  /** What the collector asked Microsoft for, in the collector's own words, per
   * feed.
   *
   * Keyed by feed rather than given as one value because the feed is no longer
   * known before the rows are read. A single value would have to be chosen by a
   * caller who does not yet know which feed it describes — which is the same
   * asserted-input mistake one field along. */
  collectionScope: Readonly<Record<NormalizationSource, ClassifierCollectionScope>>
  /** From the collector's own sync state. Deciding this from row counts would
   * be the defect the whole four-state vocabulary exists to prevent: an empty
   * window and an uncollected one look identical in the rows. */
  syncStatus: CollectorSyncStatus
  /** Bound to the feed inside, so a caller cannot hand over a rule the feed
   * cannot support without that being reported. */
  detectors: readonly FeedBoundDetector[]
  windowStart: Date
  windowEnd: Date
  maxEvents: number
}>

/** The assessment, plus how many rows were fetched to produce it.
 *
 * `rowsFetched` is not decoration. A wiring fault and a real finding both look
 * like zeros, and the discriminator is whether the classifier accounted for
 * every row it was handed — which cannot be checked without knowing how many
 * that was. Returning it here keeps the two numbers from being read out of
 * different places at different times. */
export type TenantRead = Readonly<{
  assessment: TenantAssessment
  rowsFetched: number
  /** Which feed was assessed, and whether the rows said so or nobody could.
   * Travels with the answer so no run can be quoted without its assumption. */
  feed: FeedDecision
}>

export async function readTenantAssessment(
  prisma: PrismaClient, input: ReadTenantInput,
): Promise<TenantRead> {
  const availability = evidenceFromSync(input.syncStatus)
  if (!availability.read) {
    // No query at all. Asking the database for rows we have already established
    // we cannot treat as evidence would invite reading the answer off the row
    // count, which is exactly what the sync state exists to stop.
    // Nothing was read, so nothing can be derived. The stream is named by the
    // fallback and the decision says so rather than implying the rows agreed.
    const feed = decideFeed([], input.feedIfNoRows)
    return {
      assessment: assessTenant({
        streams: [{ stream: feed.feed, collection: availability.availability }],
        budget: { maxEvents: input.maxEvents },
      }),
      rowsFetched: 0,
      feed,
    }
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


  // Watches the resolver rather than the batch. A collapse erases its own
  // evidence — `resolvedSubjects` is keyed BY reference, so sixteen people
  // becoming one reference leaves ONE entry, and no check inside the batch can
  // see it. This counts what the resolver was asked against what it returned.
  const resolver = watchedResolver(async (kind, identifier) => kind + ':' + identifier)

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

  // Off the rows, before anything is classified. A caller asserting this is how
  // three tenants came to be read against a feed none of their evidence
  // belonged to, and every guard downstream passed while it happened.
  const feed = decideFeed(rows.map(row => row.raw as Record<string, unknown>), input.feedIfNoRows)
  const collectionScope = input.collectionScope[feed.feed]

  const batch = await normalizeSignInBatch({
    scope,
    source: feed.feed,
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
    //
    // TAKES TWO ARGUMENTS. An earlier version took one and named it
    // microsoftUserId, so it received 'subject' and returned the SAME ref for
    // every user — 2046 events collapsing to one subject and a count of 1 for a
    // tenant with several affected accounts. TypeScript permits a shorter
    // function where a longer one is expected, so nothing complained, coverage
    // was perfect, and the sum invariant held. Every guard passed because none
    // of them checks identity resolution.
    reference: resolver.resolve,
    collectionScope,
  })

  // Before anything reads the batch: if distinct people collapsed into one
  // reference, every count below would be wrong while every other check passed.
  resolver.assertNoCollapse()

  const stream: ClassifiedStream = {
    stream: feed.feed,
    collection: 'READ',
    batch,
    scope: { declared: true, asked: collectionScope },
    // Bound to the feed rather than handed over raw: a rule whose feed cannot
    // supply its pattern reports INAPPLICABLE instead of running and finding
    // nothing, which would be indistinguishable from a clean tenant.
    detectors: input.detectors.map(bound => bindToFeed(bound, capabilityOf(feed.feed))),
    rowsFetched: rows.length,
  }

  return {
    assessment: assessTenant({ streams: [stream], budget: { maxEvents: input.maxEvents } }),
    rowsFetched: rows.length,
    feed,
  }
}
