import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { readTenantAssessment } from './read-tenant.js'
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
 *     --org <uuid> --tenant <uuid> [--source GRAPH_SIGN_INS] [--days 30]
 */

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const organizationId = arg('org')
  const customerTenantId = arg('tenant')
  if (!organizationId || !customerTenantId) {
    console.error('usage: --org <uuid> --tenant <uuid> [--source GRAPH_SIGN_INS|M365_AUDIT_STS] [--days 30]')
    process.exitCode = 2
    return
  }

  const source = (arg('source') ?? 'GRAPH_SIGN_INS') as NormalizationSource
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
    const assessment = await readTenantAssessment(prisma, {
      organizationId,
      customerTenantId,
      source,
      collectionScope: (source === 'GRAPH_SIGN_INS' ? 'GRAPH_INTERACTIVE_ONLY' : 'AUDIT_STS_LOGON_EVENTS') as CollectionScope,
      // Asserted rather than read, and printed as such: the sync-state read is
      // the next piece. Passing SUCCESS here means "assume it was collected",
      // which is the assumption the four-state vocabulary exists to remove — so
      // a run of this script cannot be quoted as proving anything about a
      // tenant whose collection may have stopped.
      syncStatus: (arg('sync') ?? 'SUCCESS') as CollectorSyncStatus,
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
    const classified = (coverage?.applies ?? 0)
      + Object.values(coverage?.doesNotApply ?? {}).reduce((a, b) => a + b, 0)
      + Object.values(coverage?.notYetCited ?? {}).reduce((a, b) => a + b, 0)
      + Object.values(coverage?.unknown ?? {}).reduce((a, b) => a + b, 0)
    const unprocessable = Object.values(coverage?.unprocessable ?? {}).reduce((a, b) => a + b, 0)
    if (unprocessable > 0 && classified === 0) {
      console.error(
        'SUSPECT INPUT SHAPE: every row was unprocessable and none was classified. '
        + 'This is what a wrong raw-payload shape looks like — it does not error. '
        + 'Do not read the count below as a result.')
    }
    console.log(JSON.stringify({
      window: { from: windowStart.toISOString(), to: windowEnd.toISOString(), days },
      source,
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
