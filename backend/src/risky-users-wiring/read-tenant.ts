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
  /** From the collector's own sync state, PER FEED. Deciding this from row
   * counts would be the defect the whole four-state vocabulary exists to
   * prevent: an empty window and an uncollected one look identical in the rows.
   *
   * Keyed by feed for a reason that only appeared once the feed stopped being
   * asserted. Graph sign-ins come from the SIGN_INS collector and the audit
   * fallback from M365_AUDIT — two collectors with independent health. A single
   * status would mean gating an audit-fed tenant on the Graph collector's
   * state: a tenant whose own evidence collected perfectly reported as
   * uncollectable because a feed it does not use is failing, or worse, the
   * reverse. Three of five tenants are audit-fed, so that is the majority case,
   * not an edge. */
  syncStatus: Readonly<Record<NormalizationSource, CollectorSyncStatus>>
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
  // WHICH FEED'S SYNC STATE APPLIES CANNOT BE KNOWN UNTIL THE ROWS ARE READ,
  // and that ordering is the whole reason this looks inside-out.
  //
  // The gate exists so a row COUNT never decides whether evidence was
  // collected — an empty window and an uncollected one are identical in the
  // rows. It does not require us to stay ignorant of which COLLECTOR to ask
  // about. Reading rows to learn the feed is not reading the answer off them;
  // the answer is still gated, one step later, on that feed's own state.
  //
  // Doing it the other way meant picking a collector before knowing which one
  // produced the evidence — gating three audit-fed tenants on the health of a
  // Graph collector they do not use.
  //
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

  // THE GATE, now that the feed is known. Rows already fetched are discarded
  // rather than assessed: they were read to identify the collector, not to
  // stand as evidence, and a collector whose state says its evidence cannot be
  // treated as current does not become trustworthy because rows happen to
  // exist. `rowsFetched` still reports what the query returned, because
  // claiming zero here would be the count-shaped lie one layer out.
  const availability = evidenceFromSync(input.syncStatus[feed.feed])
  if (!availability.read) {
    return {
      assessment: assessTenant({
        streams: [{ stream: feed.feed, collection: availability.availability }],
        budget: { maxEvents: input.maxEvents },
      }),
      rowsFetched: rows.length,
      feed,
    }
  }

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
