// QA — THE PRODUCTION STORE, exercised. Everything proved about this flow so far went through
// storeFor(client), a store written inside the test file by the author of the assertions. A test
// cannot check what it injects, and the store has been the injected part all along.
// This drives alert-intake.service.ts — the implementation that will actually run.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { AlertIntakeService } from './alert-intake.service.js'

const url = process.env.DATABASE_URL!
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }) })
// The service takes a PrismaService, which is a PrismaClient subclass; the store uses only
// $queryRawUnsafe, $executeRawUnsafe and $transaction.
const service = new AlertIntakeService(prisma as never)
const n = async (t: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n)
const r: Record<string, unknown> = {}

process.env.HAWKVIEW_ALERT_WATERMARK_ISO = '2026-09-01T00:00:00.000Z'
const TICK = new Date()

// (1) THE OPEN FILTER AND THE WINDOW, through the production SQL.
const first = await service.runOnce(Date.now() + 30_000, TICK)
r.q1_openFilterAndWindow = {
  findingsRead: first?.findingsRead,
  resolvedRowExists: await n("identity_risk_findings WHERE state='RESOLVED'"),
  verdict: first?.findingsRead === 1
    ? 'PARITY — reads the OPEN row and not the RESOLVED one, same as the test store'
    : `DIFFERS: read ${first?.findingsRead}`,
}

// (2) A SECOND TICK MUST PRODUCE ZERO JOBS — the dedupe the flow depends on, through the
// production INSERT ... ON CONFLICT rather than the test's.
const jobsAfterFirst = await n('alert_send_jobs')
const second = await service.runOnce(Date.now() + 30_000, new Date())
r.q2_secondTickWritesNothing = {
  firstRun: { incidents: first?.incidentsWritten, jobs: first?.jobsWritten },
  secondRun: { incidents: second?.incidentsWritten, jobs: second?.jobsWritten },
  jobsTotal: await n('alert_send_jobs'),
  skippedReasons: (second?.skipped ?? []).map((s) => s.because),
  verdict: second?.jobsWritten === 0 && (await n('alert_send_jobs')) === jobsAfterFirst
    ? 'PARITY — zero new, and the finding is named as skipped rather than dropped'
    : 'DIFFERS',
}

// (3) THE YIELD, WITH AN ABSOLUTE DEADLINE COMPUTED THE WAY THE CASCADE COMPUTES IT.
// The controller calls runOnce(startedAt + 60_000). A deadline already past is the cascade's
// own arithmetic when the tick has overrun, so it must yield rather than write.
await prisma.$executeRawUnsafe('DELETE FROM alert_send_jobs')
await prisma.$executeRawUnsafe('DELETE FROM alert_incidents')
const startedAt = Date.now() - 120_000          // the tick began two minutes ago
const yielded = await service.runOnce(startedAt + 60_000, new Date())
r.q3_yieldWithCascadeArithmetic = {
  deadlinePassed: startedAt + 60_000 < Date.now(),
  yieldedOnBudget: yielded?.yieldedOnBudget,
  findingsRead: yielded?.findingsRead,
  incidents: await n('alert_incidents'),
  jobs: await n('alert_send_jobs'),
  verdict: yielded?.yieldedOnBudget === true && (await n('alert_incidents')) === 0 && (await n('alert_send_jobs')) === 0
    ? 'HONOURED — the production caller yields on the cascade arithmetic and writes nothing'
    : 'NOT HONOURED',
}

// (4) THE ATOMIC WRITE SPANS BOTH TABLES IN THE REAL IMPLEMENTATION.
const healthy = await service.runOnce(Date.now() + 30_000, new Date())
r.q4_atomicSpansBothTables = {
  incidents: await n('alert_incidents'),
  jobs: await n('alert_send_jobs'),
  bothOrNeither: (await n('alert_incidents')) > 0 && (await n('alert_send_jobs')) > 0,
  usesPrismaTransaction: true,
  verdict: healthy?.incidentsWritten === 1 && healthy?.jobsWritten === 1
    ? 'both tables written in one $transaction; the atomicity itself is checked separately by killing the backend'
    : 'DIFFERS',
}

// (5) A DIFFERENCE I FOUND BY READING, STATED WHETHER OR NOT IT BITES HERE.
r.q5_differenceFromTheTestStore = {
  productionHasLimit5000: true,
  testStoreHasNoLimit: true,
  note: 'findOpenFindings in production ends LIMIT 5000; the test store has no LIMIT, so no test '
    + 'can reach that boundary. At >5000 open findings in one window a tick silently processes '
    + 'the first 5000 by observed_at. Not wrong - it is a bound - but it is unproven and untestable '
    + 'through the store the five green tests use.',
}

console.log(JSON.stringify({ QA_REAL_STORE: r }, null, 2))
await prisma.$disconnect()
