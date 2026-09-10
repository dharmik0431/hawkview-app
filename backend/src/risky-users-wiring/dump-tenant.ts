import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { readTenantAssessment } from './read-tenant.js'
import { credentialFailureDetector } from './detectors/credential-failure.js'
import { withheldExplanations } from '../evaluation-core/evaluate.js'
import type { CollectionScope } from '../risky-users-normalization/reasons.js'
import type { NormalizationSource } from '../risky-users-normalization/contract.js'
import type { CollectorSyncStatus } from '../tenants/service-sync-freshness.js'

/** Runs the pipeline against a real tenant and prints what it produced.
 *
 * Deliberately a dump rather than a persisted assessment or a shaped response.
 * The question this answers is only "does the engine produce a sensible answer
 * on real rows", and a stored result or a DTO would let a shaping bug look like
 * an engine result.
 *
 * READ-ONLY. Two findMany calls, no write of any kind.
 *
 *   DATABASE_URL=... npx tsx src/risky-users-wiring/dump-tenant.ts \
 *     --org <uuid> --tenant <uuid> [--feed-if-no-rows GRAPH_SIGN_INS] [--days 30]
 */

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const organizationId = arg('org')
  const customerTenantId = arg('tenant')
  if (!organizationId || !customerTenantId) {
    console.error('usage: --org <uuid> --tenant <uuid> [--feed-if-no-rows GRAPH_SIGN_INS|M365_AUDIT_STS] [--days 30]')
    process.exitCode = 2
    return
  }

  // Used ONLY if the window returns no rows. `--source` used to choose the feed
  // outright, and on three tenants it chose the wrong one and said nothing.
  const feedIfNoRows = (arg('feed-if-no-rows') ?? 'GRAPH_SIGN_INS') as NormalizationSource
  const days = Number(arg('days') ?? '30')
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000)

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set. This script reads and never writes, but it needs somewhere to read from.')
    process.exitCode = 2
    return
  }
  const pool = new PrismaPg({ connectionString, max: 2 })
  const prisma = new PrismaClient({ adapter: pool })
  try {
    const { assessment, rowsFetched, feed } = await readTenantAssessment(prisma, {
      organizationId,
      customerTenantId,
      feedIfNoRows,
      detectors: [credentialFailureDetector({ rejectionThreshold: Number(arg('threshold') ?? '5') })],
      // Stated per feed, because which one applies is not known until the rows
      // are read. One value would have to be picked by a caller who does not yet
      // know what it describes.
      collectionScope: {
        GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY' as CollectionScope,
        M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS' as CollectionScope,
      },
      // Asserted rather than read, and printed as such: the sync-state read is
      // the next piece. Passing SUCCESS here means "assume it was collected",
      // which is the assumption the four-state vocabulary exists to remove — so
      // a run of this script cannot be quoted as proving anything about a
      // tenant whose collection may have stopped.
      // Per feed, and still ASSERTED rather than read — printed below as such.
      // Which of the two applies is decided by the rows, so a single value
      // would have to be chosen before the feed is known.
      syncStatus: {
        GRAPH_SIGN_INS: (arg('sync') ?? 'SUCCESS') as CollectorSyncStatus,
        M365_AUDIT_STS: (arg('sync') ?? 'SUCCESS') as CollectorSyncStatus,
      },
      windowStart,
      windowEnd,
      maxEvents: Number(arg('max') ?? '20000'),
    })

    const stream = assessment.streams[0]
    const coverage = stream?.assessment.coverage
    // Engineer 3's warning made explicit, because the symptom of a wrong input
    // shape is a batch of zeros rather than a crash. Rows in and nothing
    // classified means the payload did not look like what the classifier
    // expects — and read as a result rather than a fault, that is "no risky
    // users" for a tenant nobody assessed.
    const sum = (counts: Readonly<Record<string, number>> | undefined): number =>
      Object.values(counts ?? {}).reduce((running: number, count: number) => running + count, 0)
    const classified = (coverage?.applies ?? 0)
      + sum(coverage?.doesNotApply) + sum(coverage?.notYetCited) + sum(coverage?.unknown)
    const unprocessable = sum(coverage?.unprocessable)
    // PM's discriminator, computed rather than remembered. A wiring fault and a
    // real finding both look like zeros, and whoever reads this output will not
    // have the contract in front of them.
    //
    //   rows in, nothing accounted for  -> WIRING. Five-minute fix.
    //   rows in, all accounted for      -> the classifier ran. Its answer is
    //                                      the finding, whatever it says.
    const accountedFor = classified + unprocessable
    const reading = rowsFetched === 0
      ? 'NO_ROWS: the window returned nothing. Check the window and the tenant before reading anything else.'
      : accountedFor !== rowsFetched
        ? `WIRING: ${rowsFetched} rows fetched, ${accountedFor} accounted for. Rows went missing between the query and the classifier; this is not a result.`
        : classified === 0
          ? 'WIRING: every row was unprocessable and none classified. This is what a wrong raw-payload shape looks like — it does not error. Do NOT read the count as a result.'
          : 'CLASSIFIER RAN: every fetched row is accounted for. Whatever the count says below is a real answer about this window.'
    console.log(JSON.stringify({
      reading,
      window: { from: windowStart.toISOString(), to: windowEnd.toISOString(), days },
      rowsFetched,
      feed,
      syncStatusAssumed: arg('sync') ?? 'SUCCESS',
      coverage,
      rowsClassified: classified,
      rowsUnprocessable: unprocessable,
      state: stream?.assessment.state,
      detectors: stream?.assessment.detectors,
      count: assessment.count,
      claim: assessment.claim,
      whyWithheld: withheldExplanations(stream?.assessment.claim ?? { permitted: true }),
      findings: assessment.findings.items.length,
      findingsComplete: assessment.findings.complete,
    }, null, 2))
  } finally {
    await prisma.$disconnect()
  }
}

void main()
