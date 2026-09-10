// QA ACCEPTANCE GATE for the COLLECTOR_FOR fix (10d1116).
//
// WHY THIS EXISTS SEPARATELY FROM qa-gate-freshness-asks-the-right-collector.ts,
// which is the mistake worth not repeating: that gate calls
// `readTenantAssessment` and INJECTS `syncStatus` itself. The mapping it was
// meant to test lives in `evaluate-and-persist.ts`, one level above, in
// `syncStatusPerFeed`. So it reproduces the CONSEQUENCE of a wrong status and
// is completely blind to WHICH COLLECTOR WAS ASKED — it would have reported the
// veto unchanged after a correct fix, and blocked it.
//
// A test that injects the value under test cannot check how that value is
// chosen.
//
// This one goes through `evaluateAndPersistTenant`, the real entry point, and
// supplies the two collectors as database rows shaped like production:
//
//   SIGN_INS     succeeded minutes ago   — the collector that writes sign_in_logs
//   M365_AUDIT   last success 16 days    — a different collector, different table
//
// Before the fix, the audit feed asked M365_AUDIT and withheld. After it, the
// audit feed asks SIGN_INS, which is fresh, and the evidence is read.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) })
const organizationId = randomUUID(), customerTenantId = randomUUID()
const microsoftTenantId = randomUUID(), userId = randomUUID()
const upn = 'alice@fixture.invalid'
const now = new Date()
const ago = (ms: number) => new Date(now.getTime() - ms)
const HOUR = 3600_000

// Audit-shaped, so the tenant resolves to M365_AUDIT_STS — the feed whose
// freshness was being read off the wrong collector.
// INGESTION MUST FOLLOW THE EVENT. A first version stamped ingestedAt 30
// minutes ago against events 1-15 minutes old, and all fifteen rows came back
// UNPROCESSABLE / INGESTION_PRECEDES_EVENT — applies 0 with the evidence read
// perfectly well. That reads exactly like the veto being tested and is not it.
// Events sit an hour back; ingestion is half an hour back, matching the
// production shape where rows arrive after the events they describe.
const eventAt = (n: number) => ago(HOUR + (n + 1) * 60_000)
const row = (n: number) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-map-${n}`, eventDateTime: eventAt(n),
  raw: {
    hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
    managementActivityRecord: {
      Id: `qa-map-${n}`, CreationTime: eventAt(n).toISOString(), OrganizationId: microsoftTenantId,
      UserId: upn, UserType: 0, RecordType: 15, Operation: 'UserLoggedIn',
      ApplicationId: randomUUID(), ActorIpAddress: '203.0.113.9',
    },
  },
  riskLevel: 'none', ingestedAt: ago(30 * 60_000), expiresAt: new Date(now.getTime() + 90 * 86_400_000),
})

// Shape-agnostic. The persisted coverage is JSON whose field names I have not
// verified, and keying on a guessed name is how a probe reports a false result.
const deepFind = (node: unknown, want: string): boolean =>
  typeof node === 'string' ? node === want
  : Array.isArray(node) ? node.some(child => deepFind(child, want))
  : node !== null && typeof node === 'object' ? Object.values(node as Record<string, unknown>).some(child => deepFind(child, want))
  : false
const deepNumber = (node: unknown, key: string): number | null => {
  if (node === null || typeof node !== 'object') return null
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === key && typeof v === 'number') return v
    const nested = deepNumber(v, key)
    if (nested !== null) return nested
  }
  return null
}

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA mapping', slug: `qa-map-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA mapping tenant', status: 'ACTIVE' } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: userId,
    displayName: upn, userPrincipalName: upn, userType: 'Member', lastSeenAt: ago(24 * HOUR), updatedAt: ago(24 * HOUR) } })
  await prisma.signInLog.createMany({ data: Array.from({ length: 15 }, (_, i) => row(i)) })

  // Production's shape: the collector that wrote the rows is healthy, the
  // similarly-named one that writes a different table has not succeeded in 16 days.
  await prisma.syncState.create({ data: { organizationId, customerTenantId, resourceType: 'SIGN_INS',
    status: 'IDLE', lastAttemptAt: ago(6 * 60_000), lastSuccessfulAt: ago(6 * 60_000), consecutiveFailures: 0 } })
  await prisma.syncState.create({ data: { organizationId, customerTenantId, resourceType: 'M365_AUDIT',
    status: 'RUNNING', lastAttemptAt: ago(5 * 60_000), lastSuccessfulAt: ago(389 * HOUR), consecutiveFailures: 0 } })

  const result = await evaluateAndPersistTenant(prisma, { organizationId, customerTenantId }, { now })
  const run = await prisma.identityRiskEvaluationRun.findFirst({
    where: { id: result.runId }, select: { evaluationCoverage: true },
  })
  const coverage = run?.evaluationCoverage ?? null
  const applies = deepNumber(coverage, 'applies')
  const unreadable = deepFind(coverage, 'UNREADABLE_NOW') || deepFind(coverage, 'NEVER_COLLECTED')

  // GUARD. If the rows never reached the reader, both outcomes look identical
  // and this gate is measuring nothing.
  const unprocessable = deepNumber(coverage, 'INGESTION_PRECEDES_EVENT') ?? 0
  // Rows fetched is not enough: 15 rows that all fail integrity give applies 0
  // with the evidence read fine, which is indistinguishable from the veto at a
  // glance and was the first thing this gate reported.
  const inputCanFail = result.rowsFetched > 0 && unprocessable === 0

  const evidenceWasRead = applies !== null && applies > 0 && !unreadable

  console.log(JSON.stringify({
    QA_COLLECTOR_MAPPING: {
      feedSelected: result.feed,
      rowsFetched: result.rowsFetched,
      appliesInPersistedRun: applies,
      persistedCoverageMentionsUnread: unreadable,
      rowsRejectedOnIngestionOrder: unprocessable,
      syncStateGiven: {
        SIGN_INS: 'IDLE, last success 6 minutes ago (writes sign_in_logs)',
        M365_AUDIT: 'RUNNING, last success 389 hours ago (writes m365_audit_records)',
      },
      inputCanFail,
      rawPersistedCoverage: coverage,
      verdict: !inputCanFail
        ? 'INCONCLUSIVE - the rows did not survive integrity checks, so the mapping was never exercised'
        : evidenceWasRead
          ? 'PASS - the audit feed read freshness from the collector that wrote the rows; 15 held rows were assessed'
          : 'VETO - held rows were discarded because freshness was read from a collector that did not write them',
    },
  }, null, 2))
} finally {
  await prisma.identityRiskEvaluationRun.deleteMany({ where: { customerTenantId } }).catch(() => {})
  await prisma.syncState.deleteMany({ where: { customerTenantId } })
  await prisma.signInLog.deleteMany({ where: { customerTenantId } })
  await prisma.directoryUser.deleteMany({ where: { customerTenantId } })
  await prisma.customerTenant.deleteMany({ where: { id: customerTenantId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
