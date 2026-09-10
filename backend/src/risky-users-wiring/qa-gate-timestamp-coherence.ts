// QA — does a finding's timestamp describe an event that actually drove it?
//
// The detector tallies lockouts and rejections together and stamps the finding
// with the latest event of EITHER. A finding can therefore rest entirely on
// lockouts and carry the time of a later rejection that contributed nothing.
// Count right, timestamp right, different events.
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
const ago = (minutes: number) => new Date(windowEnd.getTime() - minutes * 60_000)

const LOCKOUT_MINUTES = 600
const REJECTION_MINUTES = 5

const row = (n: number, code: number, minutes: number) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-ts-${n}`, eventDateTime: ago(minutes),
  raw: { id: `qa-ts-${n}`, createdDateTime: ago(minutes).toISOString(), userId, userPrincipalName: upn,
    appId: randomUUID(), ipAddress: '203.0.113.9', isInteractive: true, status: { errorCode: code,
      failureReason: code === 50053
        ? "The account is locked, you've tried to sign in too many times with an incorrect user ID or password."
        : 'Error validating credentials due to invalid username or password.' } },
  riskLevel: 'none', ingestedAt: new Date(), expiresAt: new Date(windowEnd.getTime() + 90 * 86_400_000),
})

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA ts', slug: `qa-ts-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA ts tenant', status: 'ACTIVE' } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: userId,
    displayName: upn, userPrincipalName: upn, userType: 'Member', lastSeenAt: windowStart, updatedAt: windowStart } })

  // Six lockouts, ten hours ago. One rejection, five minutes ago -- alone it is
  // far below the threshold of five, so it contributes nothing to the finding.
  await prisma.signInLog.createMany({ data: [
    ...Array.from({ length: 6 }, (_, i) => row(i, 50053, LOCKOUT_MINUTES + i)),
    row(99, 50126, REJECTION_MINUTES),
  ] })

  const read = await readTenantAssessment(prisma, {
    organizationId, customerTenantId, feedIfNoRows: 'GRAPH_SIGN_INS',
    collectionScope: { GRAPH_SIGN_INS: 'GRAPH_INTERACTIVE_ONLY', M365_AUDIT_STS: 'AUDIT_STS_LOGON_EVENTS' } as any,
    syncStatus: 'SUCCESS', detectors: [credentialFailureDetector({ rejectionThreshold: 5 })],
    windowStart, windowEnd, maxEvents: 5000,
  })

  const a = read.assessment
  const finding = a.findings.items[0]
  const latestLockout = ago(LOCKOUT_MINUTES).toISOString()
  const loneRejection = ago(REJECTION_MINUTES).toISOString()

  // The finding no longer carries one `observedAt`. Each signal carries its own
  // count and its own `latest`, which is exactly the repair this probe asked
  // for -- so the question changes shape rather than going away. It is no longer
  // "is the single stamp the wrong one" but "is any signal stamped from evidence
  // that is not its own".
  //
  // Asked by COUNT, not by signal name. The lockout evidence is six events and
  // the rejection is one, so the arithmetic identifies which signal is which
  // without this probe having to know the detector's vocabulary. Keying on a
  // name would assert the mechanism, and would pass silently the day the name
  // changed.
  const signals = finding?.signals ?? []
  const near = (value: string | null, target: string) =>
    value !== null && Math.abs(Date.parse(value) - Date.parse(target)) < 60_000
  const misattributed = signals.filter(signal =>
    (signal.count === 6 && near(signal.latest?.at ?? null, loneRejection)) ||
    (signal.count === 1 && near(signal.latest?.at ?? null, latestLockout)))
  const lockoutSignal = signals.find(signal => signal.count === 6) ?? null
  const lockoutStampedRight = lockoutSignal !== null && near(lockoutSignal.latest?.at ?? null, latestLockout)

  // GUARD. If the six lockouts never became a signal of their own, there is
  // nothing here that could be misattributed and a clean reading means only
  // that the scenario did not run.
  const inputCanFail = lockoutSignal !== null

  console.log(JSON.stringify({ QA_TIMESTAMP_COHERENCE: {
    lockouts: 6, rejectionsBelowThreshold: 1,
    latestLockoutAt: latestLockout, theLoneRejectionAt: loneRejection,
    findings: a.findings.items.length,
    signals: signals.map(signal => ({ signal: signal.signal, count: signal.count, latest: signal.latest })),
    applies: a.streams[0]!.assessment.coverage.applies,
    count: { accuracy: a.count.accuracy, value: a.count.value },
    inputCanFail,
    lockoutStampedFromItsOwnEvidence: lockoutStampedRight,
    misattributedSignals: misattributed.map(signal => signal.signal),
    hoursApart: Math.round(Math.abs(Date.parse(loneRejection) - Date.parse(latestLockout)) / 3600_000),
    verdict: a.findings.items.length === 0 ? 'no finding - the scenario did not fire'
      : !inputCanFail ? 'INCONCLUSIVE - the lockouts did not become a signal, so nothing here could be misattributed'
      : misattributed.length > 0
        ? 'INCOHERENT - a signal is stamped with the latest of evidence that did not contribute to it'
        : lockoutStampedRight
          ? 'COHERENT - each signal is stamped from its own evidence'
          : 'INCOHERENT - the lockout signal is not stamped from the lockouts',
  } }, null, 2))

} finally {
  await prisma.signInLog.deleteMany({ where: { organizationId } })
  await prisma.directoryUser.deleteMany({ where: { organizationId } })
  await prisma.customerTenant.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
