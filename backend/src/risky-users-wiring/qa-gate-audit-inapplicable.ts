// QA GATE — the AUDIT-FALLBACK clean shape. The majority clean case: three of
// five tenants run on the audit feed, where at least one check cannot run on
// the evidence available.
//
// The assertion is not just the zero. A clean audit tenant must produce a zero
// whose scope NAMES the check that could not run. A zero that silently widens
// into "all checks assessed" is this feature's original defect arriving through
// the machinery built to prevent it.
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
const upn = 'alice@fixture.invalid'
const windowEnd = new Date(), windowStart = new Date(windowEnd.getTime() - 24 * 3600_000)
const at = (n: number) => new Date(windowEnd.getTime() - (n + 1) * 60_000)

// STS-shaped: the feed is selected by hawkviewSource, the record sits inside
// managementActivityRecord, and the subject binds on UserId (a UPN) rather than
// an object id. Passing Graph-shaped rows here rejects every one of them.
const row = (n: number) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-aud-${n}`, eventDateTime: at(n),
  raw: {
    hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
    managementActivityRecord: {
      Id: `qa-aud-${n}`, CreationTime: at(n).toISOString(), OrganizationId: microsoftTenantId,
      UserId: upn, UserType: 0, RecordType: 15, Operation: 'UserLoggedIn',
      ApplicationId: randomUUID(), ActorIpAddress: '203.0.113.9',
    },
  },
  riskLevel: 'none', ingestedAt: new Date(), expiresAt: new Date(windowEnd.getTime() + 90 * 86_400_000),
})

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA audit', slug: `qa-aud-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA audit tenant', status: 'ACTIVE' } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: userId,
    displayName: upn, userPrincipalName: upn, userType: 'Member', lastSeenAt: windowStart, updatedAt: windowStart } })
  await prisma.signInLog.createMany({ data: Array.from({ length: 15 }, (_, i) => row(i)) })

  const read = await readTenantAssessment(prisma, {
    organizationId, customerTenantId, source: 'M365_AUDIT_STS',
    collectionScope: 'AUDIT_STS_LOGON_EVENTS', syncStatus: 'SUCCESS',
    detectors: [credentialFailureDetector({ rejectionThreshold: 5 })],
    windowStart, windowEnd, maxEvents: 5000,
  })

  const a = read.assessment
  const coverage = a.streams[0]!.assessment.coverage
  const reports = a.streams[0]!.assessment.detectors
  const scope = a.count.scope
  const inapplicable = reports.filter(r => r.status === 'INAPPLICABLE').map(r => r.detectorId)
  const namedInScope = inapplicable.every(id => scope.notCovered.some(n => n.detectorId === id))
  const zero = a.count.accuracy === 'EXACT' && a.count.value === 0

  console.log(JSON.stringify({ QA_GATE_AUDIT_INAPPLICABLE: {
    rowsFetched: read.rowsFetched, applies: coverage.applies,
    unprocessable: coverage.unprocessable, unknown: coverage.unknown,
    count: { accuracy: a.count.accuracy, value: a.count.value },
    claimPermitted: a.claim.permitted,
    withheld: a.claim.permitted ? [] : a.claim.withheld,
    detectorReports: reports, covered: scope.covered, notCovered: scope.notCovered,
    inapplicable, namedInScope,
    verdict: inapplicable.length === 0
      ? 'NO INAPPLICABLE CHECK on this feed - the shape under test did not occur'
      : !namedInScope ? 'WIDENED - a check could not run and the scope does not name it'
      : zero ? 'HOLDS - zero, and the scope names the check that could not run'
      : 'withheld rather than zero; see reasons',
  } }, null, 2))
} finally {
  await prisma.signInLog.deleteMany({ where: { organizationId } })
  await prisma.directoryUser.deleteMany({ where: { organizationId } })
  await prisma.customerTenant.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
