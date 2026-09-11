// QA GATE — a collector's health may not erase evidence it did not supply.
//
// WHY THIS GATE DID NOT EXIST, AND WHY THAT IS THE INTERESTING PART. Every
// other database gate here passes `syncStatus` with both feeds SUCCESS. That
// makes an entire class of defect invisible: if the freshness signal asks about
// the WRONG collector, both answers are SUCCESS and nothing changes. A fixture
// that sets every input to healthy cannot fail on which input was consulted.
//
// The engine reads exactly one table. `read-tenant.ts:126` issues
// `prisma.signInLog.findMany` and nothing else — audit-shaped rows and
// Graph-shaped rows both live there, distinguished by `hawkviewSource`. It
// never reads `m365_audit_records`. So whatever the health of the collector
// that fills `m365_audit_records`, it says nothing about whether the rows this
// engine actually reads are current.
//
// THE ASSERTION. Real, readable rows are present. The only thing that differs
// between the two readings below is a status about a collector. If the same
// rows produce "here is your evidence" under one status and "this was never
// collected" under the other, then a collector's health erased evidence — the
// veto pattern, in the machinery built to remove it.
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

// STS-shaped, so the tenant resolves to the audit feed — the majority case, and
// the one whose freshness is read from a collector that does not fill this table.
const row = (n: number) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-fresh-${n}`, eventDateTime: at(n),
  raw: {
    hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
    managementActivityRecord: {
      Id: `qa-fresh-${n}`, CreationTime: at(n).toISOString(), OrganizationId: microsoftTenantId,
      UserId: upn, UserType: 0, RecordType: 15, Operation: 'UserLoggedIn',
      ApplicationId: randomUUID(), ActorIpAddress: '203.0.113.9',
    },
  },
  riskLevel: 'none', ingestedAt: new Date(), expiresAt: new Date(windowEnd.getTime() + 90 * 86_400_000),
})

const read = (auditStatus: 'SUCCESS' | 'STALE') => readTenantAssessment(prisma, {
  organizationId, customerTenantId, feedIfNoRows: 'M365_AUDIT_STS',
  collectionScope: { GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY', M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS' } as any,
  // The ONLY difference between the two readings. The rows are identical, the
  // window is identical, the detector is identical.
  syncStatus: { GRAPH_SIGN_INS: 'SUCCESS', M365_AUDIT_STS: auditStatus },
  detectors: [credentialFailureDetector({ rejectionThreshold: 5 })],
  windowStart, windowEnd, maxEvents: 5000,
})

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA freshness', slug: `qa-fresh-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA freshness tenant', status: 'ACTIVE' } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: userId,
    displayName: upn, userPrincipalName: upn, userType: 'Member', lastSeenAt: windowStart, updatedAt: windowStart } })
  await prisma.signInLog.createMany({ data: Array.from({ length: 15 }, (_, i) => row(i)) })

  const healthy = await read('SUCCESS')
  const auditStale = await read('STALE')

  const shape = (r: Awaited<ReturnType<typeof read>>) => ({
    feed: r.feed.feed,
    rowsFetched: r.rowsFetched,
    applies: r.assessment.streams[0]?.assessment.coverage.applies ?? null,
    count: { accuracy: r.assessment.count.accuracy, value: r.assessment.count.value },
    claimPermitted: r.assessment.claim.permitted,
    withheld: r.assessment.claim.permitted ? [] : r.assessment.claim.withheld,
  })

  const a = shape(healthy), b = shape(auditStale)

  // GUARD. If the rows never arrived, or never reached the classifier, then both
  // readings are empty for a reason that has nothing to do with sync status and
  // this gate is measuring nothing.
  const inputCanFail = a.rowsFetched > 0 && (a.applies ?? 0) > 0

  // The observable, not the mechanism: did the SAME rows read differently?
  const sameRowsDifferentAnswer =
    a.claimPermitted !== b.claimPermitted || (a.applies ?? 0) !== (b.applies ?? 0)
  // The specific harm: evidence we hold, reported as evidence we do not have.
  const staleErasedReadableEvidence = b.rowsFetched > 0 && (b.applies ?? 0) === 0

  console.log(JSON.stringify({
    QA_FRESHNESS_ASKS_THE_RIGHT_COLLECTOR: {
      tableTheEngineReads: 'sign_in_logs (read-tenant.ts:126 — signInLog.findMany, and nothing else)',
      rowsInserted: 15,
      bothCollectorsHealthy: a,
      auditCollectorStale: b,
      inputCanFail,
      sameRowsDifferentAnswer,
      staleErasedReadableEvidence,
      verdict: !inputCanFail
        ? 'INCONCLUSIVE - the rows did not reach the classifier, so nothing here could be erased'
        : !sameRowsDifferentAnswer
          ? 'PASS - a collector status did not change what the held evidence reports'
          : staleErasedReadableEvidence
            ? 'VETO REPRODUCED - 15 readable rows are reported as no evidence because a collector that does not fill this table is stale'
            : 'DIVERGENT - the same rows read differently under two collector statuses',
    },
  }, null, 2))
} finally {
  await prisma.signInLog.deleteMany({ where: { customerTenantId } })
  await prisma.directoryUser.deleteMany({ where: { customerTenantId } })
  await prisma.customerTenant.deleteMany({ where: { id: customerTenantId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
