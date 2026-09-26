// QA GATE — a run that was written must read back as a run.
//
// Answers PM's question directly: does a real persist against a database with
// the SHIPPED MIGRATIONS succeed end to end? Not "does the writer's double
// accept it" — `persist-run.ts` says in its own comment that its tests supply a
// structural double, and a double cannot enforce a check constraint. This goes
// through `evaluateAndPersistTenant` against a real cluster and then reads the
// row back through `readLatestRun`, the same path a customer's request takes.
//
// TWO HALVES, because the two constraints fail in different directions and only
// one of them announces itself.
//
// A. ROUND TRIP. Write a run, read it back, and require `present: true`. A
//    write that raises 23514 fails loudly. The half that does not is B.
//
// B. THE SILENT ONE. `identity_risk_runs_completion_check` reads
//    `(status='COMPLETED' AND completed_at IS NOT NULL) OR status<>'COMPLETED'`.
//    A new status satisfies the second arm trivially and inherits NO
//    completed-at guarantee. `read-run.ts:93` returns NO_RUN on a null
//    `completedAt` — so a run that completed successfully, with findings, would
//    be reported as never having been evaluated. A tenant under attack and a
//    tenant nobody looked at would render identically, which is the defect this
//    entire rebuild exists to remove, arriving through a constraint gap rather
//    than through any line of application code.
//
//    So B asserts the DATABASE refuses it, not that the writer happens not to
//    do it. A guarantee the schema does not hold is a convention, and this
//    project has spent the day removing conventions.
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { readLatestRun } from './read-run.js'
import { RUN_STATUS } from './persist-run.js'
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

// Ingestion follows the event, or every row is rejected on integrity and the
// run is empty for a reason that has nothing to do with what is being tested.
const eventAt = (n: number) => ago(HOUR + (n + 1) * 60_000)
const row = (n: number) => ({
  organizationId, customerTenantId, microsoftSignInId: `qa-rt-${n}`, eventDateTime: eventAt(n),
  raw: {
    hawkviewSource: 'MICROSOFT_365_MANAGEMENT_ACTIVITY',
    managementActivityRecord: {
      Id: `qa-rt-${n}`, CreationTime: eventAt(n).toISOString(), OrganizationId: microsoftTenantId,
      UserId: upn, UserType: 0, RecordType: 15, Operation: 'UserLoggedIn',
      ApplicationId: randomUUID(), ActorIpAddress: '203.0.113.9',
    },
  },
  riskLevel: 'none', ingestedAt: ago(30 * 60_000), expiresAt: new Date(now.getTime() + 90 * 86_400_000),
})

const constraintOf = async (name: string): Promise<string | null> => {
  const rows = await prisma.$queryRawUnsafe<{ def: string }[]>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, name)
  return rows[0]?.def ?? null
}

let writeError: string | null = null
let present: boolean | null = null
let because: string | null = null
let completedAtWasNull: boolean | null = null
let databaseRefusesNullCompletedAt: boolean | null = null
let refusedBy: string | null = null

try {
  await prisma.organization.create({ data: { id: organizationId, name: 'QA round trip', slug: `qa-rt-${organizationId}` } })
  await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId, displayName: 'QA round trip tenant', status: 'ACTIVE' } })
  await prisma.tenantConnection.create({ data: { organizationId, customerTenantId,
    connectionMode: 'HAWKVIEW_MANAGED', status: 'CONNECTED' } })
  await prisma.directoryUser.create({ data: { organizationId, customerTenantId, microsoftUserId: userId,
    displayName: upn, userPrincipalName: upn, userType: 'Member', lastSeenAt: ago(24 * HOUR), updatedAt: ago(24 * HOUR) } })
  await prisma.signInLog.createMany({ data: Array.from({ length: 15 }, (_, i) => row(i)) })
  await prisma.syncState.create({ data: { organizationId, customerTenantId, resourceType: 'SIGN_INS',
    status: 'IDLE', lastAttemptAt: ago(6 * 60_000), lastSuccessfulAt: ago(6 * 60_000), consecutiveFailures: 0 } })

  // ---- A. ROUND TRIP ----
  try {
    await evaluateAndPersistTenant(prisma, { organizationId, customerTenantId }, { now })
  } catch (error) {
    writeError = error instanceof Error ? error.message.split('\n').find(line => line.includes('23514') || line.includes('constraint')) ?? error.message.slice(0, 200) : String(error)
  }

  if (writeError === null) {
    const read = await readLatestRun(prisma as never, { organizationId, customerTenantId }, now)
    present = read.present
    because = read.present ? null : read.because
    const stored = await prisma.identityRiskEvaluationRun.findFirst({
      where: { customerTenantId }, select: { completedAt: true },
    })
    completedAtWasNull = stored !== null && stored.completedAt === null
  }

  // ---- B. THE SILENT ONE ----
  // Ask the DATABASE whether it would accept a completed run with no completion
  // time. Done by direct insert rather than through the writer, because the
  // question is what the schema guarantees, not what today's writer happens to send.
  const probeId = randomUUID()
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO identity_risk_evaluation_runs
         (id, organization_id, customer_tenant_id, run_key, engine_version, catalog_version,
          status, window_start, window_end, source_watermark_hash, source_content_hash,
          capability, aggregate, expires_at, completed_at)
       VALUES ($1,$2,$3,$4,'qa/1','qa/1',$5, $6, $7, 'qa','qa','UNAVAILABLE','{}'::jsonb, $8, NULL)`,
      probeId, organizationId, customerTenantId, `qa-null-completed-${probeId}`,
      RUN_STATUS, ago(24 * HOUR), now, new Date(now.getTime() + 86_400_000))
    databaseRefusesNullCompletedAt = false
    await prisma.$executeRawUnsafe(`DELETE FROM identity_risk_evaluation_runs WHERE id = $1`, probeId)
  } catch (error) {
    // WHICH constraint refused it, not merely that something did. While the
    // status check still rejects the new value, this insert never reaches the
    // completion check at all — so a bare "refused" reads as a guarantee that
    // has not been tested. That is the same one-blocker-hiding-another shape
    // reported one level up, arriving inside the probe written to check it.
    refusedBy = error instanceof Error && error.message.includes('identity_risk_runs_completion_check')
      ? 'identity_risk_runs_completion_check'
      : error instanceof Error && error.message.includes('identity_risk_runs_status_check')
        ? 'identity_risk_runs_status_check'
        : 'other'
    databaseRefusesNullCompletedAt = refusedBy === 'identity_risk_runs_completion_check'
  }

  const statusCheck = await constraintOf('identity_risk_runs_status_check')
  const completionCheck = await constraintOf('identity_risk_runs_completion_check')
  const roundTripHolds = writeError === null && present === true

  console.log(JSON.stringify({
    QA_PERSIST_ROUND_TRIP: {
      runStatusWritten: RUN_STATUS,
      liveStatusCheck: statusCheck,
      liveCompletionCheck: completionCheck,
      a_roundTrip: {
        writeError,
        readBackPresent: present,
        readBackBecause: because,
        completedAtWasNull,
        holds: roundTripHolds,
      },
      b_databaseRefusesCompletedRunWithNoCompletionTime: databaseRefusesNullCompletedAt,
      b_refusedBy: refusedBy,
      b_wasActuallyTested: refusedBy !== 'identity_risk_runs_status_check',
      verdict: writeError !== null
        ? `BLOCKED - the write is rejected by the database: ${writeError}`
        : present !== true
          ? `WRITTEN BUT UNREADABLE - the run persisted and reads back as ${because}; a completed evaluation is being reported as one that never happened`
          : refusedBy === 'identity_risk_runs_status_check'
            ? 'INCONCLUSIVE ON B - the status check rejected the probe insert before the completion check was reached, so the completion guarantee is untested'
          : databaseRefusesNullCompletedAt !== true
            ? 'ROUND TRIP HOLDS, BUT THE GUARANTEE IS A CONVENTION - the database accepts a completed run with no completion time, and read-run.ts returns NO_RUN for exactly that row'
            : 'PASS - a real persist succeeds end to end against the shipped migrations, and the schema refuses the row that would read back as never-evaluated',
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
