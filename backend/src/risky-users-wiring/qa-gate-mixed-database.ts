// QA GATE — MIXED through the REAL read path against a disposable database.
// Synthetic fixtures only, loopback-only, no production data.
//
// Seeds a window that is mostly out of scope, reads it through
// readTenantAssessment exactly as the pipeline does, and asks the gate's rule:
// if an exact zero is claimed, is the discarded evidence carried with it?
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { readTenantAssessment } from './read-tenant.js'
import { credentialFailureDetector } from './detectors/credential-failure.js'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) })
const organizationId = randomUUID(), customerTenantId = randomUUID()
const microsoftTenantId = randomUUID(), userId = randomUUID()
const windowEnd = new Date(), windowStart = new Date(windowEnd.getTime() - 24 * 3600_000)
const at = (n: number) => new Date(windowEnd.getTime() - (n + 1) * 60_000)

const row = (n: number, assessed: boolean) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-${n}`, eventDateTime: at(n),
  raw: { id: `qa-${n}`, createdDateTime: at(n).toISOString(), userId, userPrincipalName: 'alice@fixture.invalid',
    appId: randomUUID(), ipAddress: '203.0.113.9', isInteractive: true,
    status: { errorCode: assessed ? (n % 2 === 0 ? 50126 : 0) : 50140 } },
  riskLevel: 'none', ingestedAt: new Date(), expiresAt: new Date(windowEnd.getTime() + 90 * 86_400_000),
})

// Deep numeric sum: shape-agnostic on purpose. This check has now been wrong
// three times because it assumed a shape -- a named key, then an object of
// counts, then an array of records. It asks only whether the number is in there.
const totalOn = (v: unknown): number =>
  typeof v === 'number' ? v
  : Array.isArray(v) ? v.reduce<number>((s, x) => s + totalOn(x), 0)
  : v !== null && typeof v === 'object' ? Object.values(v as Record<string, unknown>).reduce<number>((s, x) => s + totalOn(x), 0)
  : 0

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA gate', slug: `qa-gate-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA tenant', status: 'ACTIVE' } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: userId,
    displayName: 'Alice', userPrincipalName: 'alice@fixture.invalid', userType: 'Member', lastSeenAt: windowStart, updatedAt: windowStart } })
  // MIXED: 4 assessed, 8 out of scope.
  await prisma.signInLog.createMany({ data: [
    ...Array.from({ length: 4 }, (_, i) => row(i, true)),
    ...Array.from({ length: 8 }, (_, i) => row(100 + i, false))] })

  const read = await readTenantAssessment(prisma, {
    organizationId, customerTenantId, feedIfNoRows: 'GRAPH_SIGN_INS',
    collectionScope: { GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY', M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS' } as any, syncStatus: { GRAPH_SIGN_INS: 'SUCCESS', M365_AUDIT_STS: 'SUCCESS' },
    detectors: [credentialFailureDetector({ rejectionThreshold: 5 })], windowStart, windowEnd, maxEvents: 5000,
  })

  const a = read.assessment
  const coverage = a.streams[0]!.assessment.coverage
  const excludedInWindow = totalOn(coverage.doesNotApply)
  const inputCanFail = excludedInWindow > 0
  const reachableFromCountAlone = Object.values(a.count.scope as Record<string, unknown>)
    .some(v => excludedInWindow > 0 && totalOn(v) === excludedInWindow)
  const zero = a.count.accuracy === 'EXACT' && a.count.value === 0

  console.log(JSON.stringify({ QA_GATE_MIXED_DATABASE: {
    rowsFetched: read.rowsFetched, applies: coverage.applies, excludedInWindow,
    count: { accuracy: a.count.accuracy, value: a.count.value },
    countScopeKeys: Object.keys(a.count.scope as object), claimPermitted2: a.claim.permitted, withheldReasons: a.claim.permitted ? [] : a.claim.withheld,
    inputCanFail, exclusionsReachableFromCountAlone: reachableFromCountAlone,
    findings: a.findings.items.length,
    verdict: !inputCanFail ? 'INCONCLUSIVE: no exclusions in the window'
      : zero && !reachableFromCountAlone ? 'BARE ZERO — gate FAILS'
      : zero ? 'SCOPED ZERO — gate PASSES at the data layer'
      : `count is ${a.count.accuracy}, not an exact zero`,
  } }, null, 2))
} finally {
  await prisma.signInLog.deleteMany({ where: { organizationId } })
  await prisma.directoryUser.deleteMany({ where: { organizationId } })
  await prisma.customerTenant.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
