import { IDENTITY_RISK_RUN_RETENTION_MS } from '../identity-risk/identity-risk.contract.js'
import { collectorStatus } from '../tenants/service-sync-freshness.js'
import { credentialFailureDetector } from './detectors/credential-failure.js'
import { persistRun } from './persist-run.js'
import { readTenantAssessment } from './read-tenant.js'
import type { PrismaClient } from '../generated/prisma/client.js'
import type { CollectorSyncStatus } from '../tenants/service-sync-freshness.js'
import type { NormalizationSource } from '../risky-users-normalization/contract.js'
import type { CollectionScope } from '../risky-users-normalization/reasons.js'

/** Assess one tenant and record the result. The piece that makes everything
 * else reachable.
 *
 * Read-only except for the single run row it writes, and that row is invisible
 * to the live reader by construction — see `persist-run.ts`, where the status
 * value and the test asserting the old reader's own filter live.
 */

/** Thirty days of evidence, and the window END is set HERE rather than accepted
 * from a caller.
 *
 * An invariant that depends on who calls you is not an invariant. Downstream
 * reads `windowEnd` against `completedAt` to tell a live assessment from a stale
 * or replayed one — a four-day gap between them means the answer is about a
 * window that closed days before anyone looked. That distinction only holds if
 * the two are set together, here, from one clock. */
const WINDOW_DAYS = 30

/** Which collector feeds which classifier source.
 *
 * Two collectors with independent health: Graph sign-ins arrive via SIGN_INS,
 * the audit fallback via M365_AUDIT. Three of five tenants are audit-fed, so
 * asking the wrong collector about a tenant's evidence is the majority case
 * rather than an edge. */
const COLLECTOR_FOR: Readonly<Record<NormalizationSource, string>> = {
  GRAPH_SIGN_INS: 'SIGN_INS',
  M365_AUDIT_STS: 'M365_AUDIT',
}

const COLLECTION_SCOPE_FOR: Readonly<Record<NormalizationSource, CollectionScope>> = {
  GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY',
  M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS',
}

/** The collector's own state, per feed, read rather than assumed.
 *
 * `collectorStatus` is the classifier-side function that already owns this
 * mapping — reused rather than re-derived, because a second copy of a closed
 * vocabulary is a second thing to keep in step, and every serious defect on this
 * feature has been one fact held in two places that drifted.
 *
 * A collector with NO row is `NOT_CONFIGURED`, which `evidenceFromSync` treats
 * as never collected. That is the honest reading: a tenant with no M365_AUDIT
 * sync state has not had that evidence collected, and saying so is different
 * from saying it was collected and was empty. */
async function syncStatusPerFeed(
  prisma: PrismaClient, scope: Readonly<{ organizationId: string; customerTenantId: string }>, now: Date,
): Promise<Readonly<Record<NormalizationSource, CollectorSyncStatus>>> {
  const states = await prisma.syncState.findMany({
    where: {
      organizationId: scope.organizationId,
      customerTenantId: scope.customerTenantId,
      resourceType: { in: Object.values(COLLECTOR_FOR) as never },
    },
    select: {
      resourceType: true, status: true, lastAttemptAt: true,
      lastSuccessfulAt: true, lastErrorCode: true, lastErrorMessage: true,
    },
  })
  const byResource = new Map(states.map(state => [String(state.resourceType), state]))

  // RUNNING MEANS TWO DIFFERENT THINGS and `collectorStatus` returns it before
  // looking at either. Measured against production: the collectors run every
  // five minutes, so at any moment several tenants are mid-collection — and all
  // of them have succeeded before, 4.5 to 7 hours earlier. Taking RUNNING at
  // face value maps to NEVER_COLLECTED, which would have reported three tenants
  // holding 1,219, 1,003 and 9 rows of real evidence as having none, most of
  // the time, including the two under live credential attack.
  //
  // A refresh being in flight does not un-collect what was already collected.
  // So for a collector that HAS succeeded, the question asked is the one that
  // matters — "setting aside the run in progress, is the evidence we already
  // hold current?" — by handing their function a settled status and letting it
  // apply its own freshness rule. Re-implementing that rule here would be a
  // second copy of a closed vocabulary, which is the defect this file's
  // neighbour exists to prevent.
  //
  // RUNNING with NO prior success still means never collected, which is the
  // reading that was right all along for the case the label was written for.
  const settled = (state: (typeof states)[number] | undefined) =>
    state !== undefined && String(state.status) === 'RUNNING' && state.lastSuccessfulAt !== null
      ? { ...state, status: 'IDLE' }
      : state

  const read = (source: NormalizationSource): CollectorSyncStatus =>
    collectorStatus(COLLECTOR_FOR[source], settled(byResource.get(COLLECTOR_FOR[source])) as never, now)
  return { GRAPH_SIGN_INS: read('GRAPH_SIGN_INS'), M365_AUDIT_STS: read('M365_AUDIT_STS') }
}

export type EvaluateAndPersistResult = Readonly<{
  runId: string
  rowsFetched: number
  feed: NormalizationSource
  findings: number
}>

export async function evaluateAndPersistTenant(
  prisma: PrismaClient,
  scope: Readonly<{ organizationId: string; customerTenantId: string }>,
  options: Readonly<{ now?: Date; rejectionThreshold?: number; maxEvents?: number }> = {},
): Promise<EvaluateAndPersistResult> {
  // ONE CLOCK for the window end, the completion stamp and the retention
  // horizon. Three reads of `new Date()` would put microseconds between values
  // that downstream compares for equality of intent.
  const now = options.now ?? new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1_000)

  const { assessment, rowsFetched, feed } = await readTenantAssessment(prisma, {
    organizationId: scope.organizationId,
    customerTenantId: scope.customerTenantId,
    // Only consulted when the window returns no rows at all. Which feed a
    // tenant uses is read off its rows; this is the one case nothing can be
    // read from.
    feedIfNoRows: 'GRAPH_SIGN_INS',
    collectionScope: COLLECTION_SCOPE_FOR,
    syncStatus: await syncStatusPerFeed(prisma, scope, now),
    detectors: [credentialFailureDetector({ rejectionThreshold: options.rejectionThreshold ?? 5 })],
    windowStart,
    windowEnd,
    maxEvents: options.maxEvents ?? 20_000,
  })

  // The writer takes a MINIMAL structural type so its tests can supply a double —
  // the columns it writes do not exist in production yet, so a test needing a
  // real client could not run at all. Prisma's generated `create` is generic and
  // is not nominally assignable to that simpler shape even though the real client
  // satisfies it at runtime, so the seam is crossed once, here, rather than by
  // widening the writer's type until the double stops being checked.
  const { id } = await persistRun(prisma as unknown as Parameters<typeof persistRun>[0], assessment, {
    organizationId: scope.organizationId,
    customerTenantId: scope.customerTenantId,
    windowStart,
    windowEnd,
    rowsFetched,
    // The same retention the old engine's runs use, reused rather than chosen,
    // so one maintenance job prunes both and neither outlives the other.
    expiresAt: new Date(now.getTime() + IDENTITY_RISK_RUN_RETENTION_MS),
    completedAt: now,
  })

  return { runId: id, rowsFetched, feed: feed.feed, findings: assessment.findings.items.length }
}
