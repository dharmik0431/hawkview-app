// QA GATE — does subject-name resolution widen the read across tenants?
//
// WHAT THIS TESTS AND WHAT IT DOES NOT. It does NOT test authorization: the
// controller delegates that to `authorizeRiskyUsersRead`, and this probe stubs
// that decision to an already-authorized tenant. Cross-tenant *access* is a
// different path with its own guard. The question here is narrower and is the
// one reading the code cannot settle: GIVEN a correctly authorized tenant, can
// another tenant's person appear in the answer?
//
// THE FAILURE MODE. The resolver builds `wanted: microsoftUserId -> subjectRef`,
// queries `directoryUser`, then does `named.set(ref, row)`. The map is keyed by
// REF, not by tenant. If the query were ever scoped on `organizationId` alone, a
// sibling tenant's row would match and land in the answer. No error, no blank —
// a plausible wrong name beside real findings.
//
// THE FIXTURE TOOK THREE ATTEMPTS AND EACH FAILURE IS WORTH RECORDING.
//
// 1. BOTH tenants hold a row for the same id. Non-deterministic, and measured
//    being so: with the scope widened both rows match, `named.set` keeps
//    whichever Postgres returned last, and there is no ORDER BY. Against
//    deliberately broken code it reported PASS once and CROSS-TENANT LEAK the
//    next run. A gate that catches a real leak half the time is worse than
//    none, because the half that passes is the half that gets quoted.
//
// 2. Only tenant B holds a row. Deterministic and completely INERT: with no
//    directory row of its own, tenant A's subject binds by UPN, carries no
//    directory id, and never enters the resolver's lookup set at all. PASS
//    three times against broken code. The absence being relied on also removed
//    the lookup key.
//
// 3. What is here. Tenant A holds the row DURING evaluation, so the subject
//    binds to a directory id and reaches `wanted`. The row is then deleted
//    before the read, leaving tenant B's as the only candidate for that id.
//    Correctly scoped, U2 resolves to nothing and renders as the opaque ref;
//    widened, it can only resolve to tenant B's person. Verified PASS twice
//    clean and CROSS-TENANT LEAK three times mutated.
//
// That the first version was intermittent is itself worth knowing: if this
// defect ever reaches production it will appear and disappear between
// requests, which is the hardest kind of report to believe.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { RiskyUsersController } from './risky-users.controller.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA database only')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) })
const organizationId = randomUUID()
const tenantA = randomUUID(), tenantB = randomUUID()
const msTenantA = randomUUID(), msTenantB = randomUUID()

const U1 = '11111111-1111-4111-8111-111111111111'   // stays in A: proves resolution ran
const U2 = '22222222-2222-4222-8222-222222222222'   // in A during evaluation, deleted before the read
const NAME_A = 'Alice OfTenantA', UPN_A = 'alice@tenant-a.invalid'
const UPN_U2 = 'u2@tenant-a.invalid'                 // the UPN A's sign-ins carry
const NAME_B = 'Bob OfTenantB', UPN_B = 'bob@tenant-b.invalid'

const now = new Date()
const ago = (ms: number) => new Date(now.getTime() - ms)
const HOUR = 3600_000
const LOCKOUT_TEXT = "The account is locked, you've tried to sign in too many times with an incorrect user ID or password."

// Lockouts for BOTH subjects, so tenant A produces a finding for each and there
// are two refs to resolve. Ingestion follows the event, or every row is rejected
// on integrity and the run is empty for an unrelated reason.
const eventAt = (n: number) => ago(HOUR + (n + 1) * 60_000)
const row = (n: number, userId: string, upn: string) => ({
  organizationId, customerTenantId: tenantA, microsoftSignInId: `qa-iso-${userId.slice(0, 4)}-${n}`,
  eventDateTime: eventAt(n),
  raw: {
    id: `qa-iso-${userId.slice(0, 4)}-${n}`, createdDateTime: eventAt(n).toISOString(), userId,
    userPrincipalName: upn, appId: randomUUID(), ipAddress: '203.0.113.9', isInteractive: true,
    status: { errorCode: 50053, failureReason: LOCKOUT_TEXT },
  },
  riskLevel: 'none', ingestedAt: ago(30 * 60_000), expiresAt: new Date(now.getTime() + 90 * 86_400_000),
})

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA iso', slug: `qa-iso-${organizationId}` } })
  for (const [id, ms, label] of [[tenantA, msTenantA, 'A'], [tenantB, msTenantB, 'B']] as const) {
    await prisma.customerTenant.create({ data: { id, organizationId, microsoftTenantId: ms, displayName: `QA tenant ${label}`, status: 'ACTIVE' } })
  }
  await prisma.tenantConnection.create({ data: { organizationId, customerTenantId: tenantA,
    connectionMode: 'HAWKVIEW_MANAGED', status: 'CONNECTED' } })
  // U1 lives in tenant A and stays there — it is the proof that resolution ran.
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId: tenantA,
    microsoftUserId: U1, displayName: NAME_A, userPrincipalName: UPN_A,
    userType: 'Member', lastSeenAt: ago(24 * HOUR), updatedAt: ago(24 * HOUR) } })
  // Tenant A DOES hold U2 during evaluation. Without a directory row the subject
  // binds by UPN, carries no directory id, and never enters the resolver's lookup
  // set at all -- an earlier version of this fixture omitted it and the probe was
  // inert: it reported PASS three times against deliberately broken code, because
  // the absence it relied on also removed the lookup key.
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId: tenantA,
    microsoftUserId: U2, displayName: 'U2 OfTenantA', userPrincipalName: UPN_U2,
    userType: 'Member', lastSeenAt: ago(24 * HOUR), updatedAt: ago(24 * HOUR) } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId: tenantB,
    microsoftUserId: U2, displayName: NAME_B, userPrincipalName: UPN_B,
    userType: 'Member', lastSeenAt: ago(24 * HOUR), updatedAt: ago(24 * HOUR) } })
  await prisma.syncState.create({ data: { organizationId, customerTenantId: tenantA, resourceType: 'SIGN_INS',
    status: 'IDLE', lastAttemptAt: ago(6 * 60_000), lastSuccessfulAt: ago(6 * 60_000), consecutiveFailures: 0 } })
  await prisma.signInLog.createMany({ data: [
    ...Array.from({ length: 8 }, (_, i) => row(i, U1, UPN_A)),
    ...Array.from({ length: 8 }, (_, i) => row(100 + i, U2, UPN_U2)),
  ] })

  const persisted = await evaluateAndPersistTenant(prisma, { organizationId, customerTenantId: tenantA }, { now })

  // NOW remove tenant A's U2 row, leaving tenant B's as the ONLY candidate for
  // that id. This is what makes the leak deterministic instead of raced: with a
  // row in both tenants the widened query returns two and `named.set` keeps
  // whichever Postgres happened to return last -- measured reporting PASS once
  // and CROSS-TENANT LEAK the next run against identical broken code.
  //
  // It is also a real state, not a contrivance: a person removed from a tenant's
  // directory after a run was evaluated.
  await prisma.directoryUser.deleteMany({ where: { customerTenantId: tenantA, microsoftUserId: U2 } })

  // evidenceDetailAllowed TRUE ON PURPOSE. Names are role-gated — only MSP_OWNER
  // and MSP_ADMIN see who. A stub omitting it produced a response with no names
  // at all, which the guard reported as INCONCLUSIVE rather than a clean pass:
  // nothing resolved, so nothing could widen. The probe must turn resolution ON
  // or it tests the role gate instead of the scoping.
  const authorized = {
    authorizeRiskyUsersRead: async () => ({
      gate: null,
      tenant: { id: tenantA, organizationId, evidenceDetailAllowed: true },
    }),
  }
  const controller = new RiskyUsersController(authorized as never, prisma as never)
  const response = await controller.assessment({ auth: { kind: 'qa-probe' } } as never, tenantA)

  const body = JSON.stringify(response)
  const leaksName = body.includes(NAME_B)
  const leaksUpn = body.includes(UPN_B)
  const namesOwnPerson = body.includes(NAME_A)

  // GUARD: resolution actually ran. U1 must be named, or there was nothing to
  // widen and a clean reading means only that the scenario did not execute.
  const inputCanFail = persisted.findings > 0 && namesOwnPerson

  console.log(JSON.stringify({
    QA_NAME_RESOLUTION_ISOLATION: {
      subjects: {
        U1: `directory row in tenant A only -> expect "${NAME_A}"`,
        U2: 'directory row in tenant B only -> expect NO name, opaque ref',
      },
      findings: persisted.findings,
      rowsFetched: persisted.rowsFetched,
      responseNamesOwnPerson: namesOwnPerson,
      responseLeaksTenantBName: leaksName,
      responseLeaksTenantBUpn: leaksUpn,
      inputCanFail,
      // LEAK IS CHECKED FIRST, AND THE ORDER IS LOAD-BEARING. The guard used to
      // come first and it masked the defect: a leak that overwrites the local
      // name also removes the guard's own input, so the verdict read
      // INCONCLUSIVE while `responseLeaksTenantBName: true` sat directly above
      // it. An absent guard input is not evidence of safety when the thing that
      // removed it is the leak.
      verdict: leaksName || leaksUpn
        ? 'CROSS-TENANT LEAK - another tenant\'s person appears in this tenant\'s answer'
        : !inputCanFail
          ? 'INCONCLUSIVE - no named subject in the response, so no resolution happened and nothing could widen'
          : 'PASS - resolution is tenant-scoped; a sibling tenant\'s directory row for a subject this tenant lacks does not reach the answer',
    },
  }, null, 2))
} finally {
  for (const t of [tenantA, tenantB]) {
    await prisma.identityRiskEvaluationRun.deleteMany({ where: { customerTenantId: t } }).catch(() => {})
    await prisma.syncState.deleteMany({ where: { customerTenantId: t } })
    await prisma.signInLog.deleteMany({ where: { customerTenantId: t } })
    await prisma.directoryUser.deleteMany({ where: { customerTenantId: t } })
    await prisma.customerTenant.deleteMany({ where: { id: t } })
  }
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
}
