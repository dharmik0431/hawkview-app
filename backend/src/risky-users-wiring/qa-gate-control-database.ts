// QA GATE — CONTROL through the REAL read path. The regression guard.
//
// A genuinely clean tenant: real assessed activity, NOTHING excluded, nothing
// found. It must still report a confident zero. Trading a false zero for no
// zero at all is the worst outcome available, and "we cannot tell you" looks
// careful, so nobody notices it.
//
// Shaped after a real dev tenant: successes only, zero failures of any kind.
// Synthetic rows on a disposable loopback database. No production data.
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
const microsoftTenantId = randomUUID(), userA = randomUUID(), userB = randomUUID()
const windowEnd = new Date(), windowStart = new Date(windowEnd.getTime() - 24 * 3600_000)
const at = (n: number) => new Date(windowEnd.getTime() - (n + 1) * 60_000)

const row = (n: number, user: string, upn: string) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-ctl-${n}`, eventDateTime: at(n),
  raw: { id: `qa-ctl-${n}`, createdDateTime: at(n).toISOString(), userId: user, userPrincipalName: upn,
    appId: randomUUID(), ipAddress: '203.0.113.9', isInteractive: true, status: { errorCode: 0 } },
  riskLevel: 'none', ingestedAt: new Date(), expiresAt: new Date(windowEnd.getTime() + 90 * 86_400_000),
})

const totalOn = (v: unknown): number =>
  typeof v === 'number' ? v
  : Array.isArray(v) ? v.reduce<number>((s, x) => s + totalOn(x), 0)
  : v !== null && typeof v === 'object' ? Object.values(v as Record<string, unknown>).reduce<number>((s, x) => s + totalOn(x), 0)
  : 0

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA control', slug: `qa-ctl-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA clean tenant', status: 'ACTIVE' } })
  for (const [id, upn] of [[userA, 'alice@fixture.invalid'], [userB, 'bob@fixture.invalid']] as const) {
    await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: id,
      displayName: upn, userPrincipalName: upn, userType: 'Member', lastSeenAt: windowStart, updatedAt: windowStart } })
  }
  // 20 ordinary successes across two users. Nothing to find, nothing excluded.
  await prisma.signInLog.createMany({ data: Array.from({ length: 20 }, (_, i) =>
    row(i, i % 2 === 0 ? userA : userB, i % 2 === 0 ? 'alice@fixture.invalid' : 'bob@fixture.invalid')) })

  const read = await readTenantAssessment(prisma, {
    organizationId, customerTenantId, feedIfNoRows: 'GRAPH_SIGN_INS',
    collectionScope: { GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY', M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS' } as any, syncStatus: 'SUCCESS',
    detectors: [credentialFailureDetector({ rejectionThreshold: 5 })],
    windowStart, windowEnd, maxEvents: 5000,
  })

  const a = read.assessment
  const coverage = a.streams[0]!.assessment.coverage
  const excluded = totalOn(coverage.doesNotApply)
  const zero = a.count.accuracy === 'EXACT' && a.count.value === 0
  const reports = a.streams[0]!.assessment.detectors
  const scope = a.count.scope
  // A zero must rest on checks that COVERED it. An exact zero whose covered
  // list is empty is a confident answer asserting nothing checked it -- the
  // bare-zero family inverted, and the count alone cannot see it.
  // covered alone is NOT enough: it names a detector even when applies === 0.
  // Verified at 81e70f3 -- a fully-excluded window has covered non-empty and is
  // held safe only by a SEPARATE gate. An assertion that reads covered on its
  // own is leaning on a guarantee it does not check.
  const scopeSupportsZero = scope.covered.length > 0 && coverage.applies > 0
  // And a check that could not run must be NAMED, not silently absent: the
  // common clean shape is audit-fallback where one check is inapplicable.
  const inapplicable = reports.filter(r => r.status === 'INAPPLICABLE').map(r => r.detectorId)
  const namedInScope = inapplicable.every(id => scope.notCovered.some(n => n.detectorId === id))

  console.log(JSON.stringify({ QA_GATE_CONTROL_DATABASE: {
    rowsFetched: read.rowsFetched, applies: coverage.applies, excluded,
    count: { accuracy: a.count.accuracy, value: a.count.value },
    claimPermitted: a.claim.permitted, covered: scope.covered, notCovered: scope.notCovered, scopeSupportsZero, inapplicable, namedInScope,
    withheldReasons: a.claim.permitted ? [] : a.claim.withheld,
    detectorReports: reports,
    findings: a.findings.items.length,
    verdict: excluded > 0 ? 'UNEXPECTED - the control window contained exclusions'
      : zero && !scopeSupportsZero ? 'CONTRADICTION - EXACT 0 but no check is listed as covering it'
      : zero && !namedInScope ? 'CONTRADICTION - a check could not run and the scope does not name it'
      : zero ? 'CONTROL HOLDS - EXACT 0, and the scope supports it'
      : 'OVERCORRECTION - a clean tenant does not get a confident zero',
  } }, null, 2))
} finally {
  await prisma.signInLog.deleteMany({ where: { organizationId } })
  await prisma.directoryUser.deleteMany({ where: { organizationId } })
  await prisma.customerTenant.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
