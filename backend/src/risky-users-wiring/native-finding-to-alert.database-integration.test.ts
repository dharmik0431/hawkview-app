import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableNativeAlertDatabase } from '../prisma/native-alert-test-database.js'
import { AlertIntakeService } from '../alerts/alert-intake.service.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { NATIVE_RULE_ID, NOT_ASSESSED } from './publish-to-intake.js'

/**
 * **A REAL NATIVE FINDING PRODUCING THE INTENDED IN-APP ALERT, AND A CONTROL THAT DOES NOT.**
 *
 * Everything before this measured the gap; this measures the connection. Real producer, real
 * persisted run, production-published rows, and the **real `AlertIntakeService.runOnce`** — the
 * production caller, not `runIntake` with a hand-built store and not test-authored bridge rows.
 *
 * **THE CONTROL IS THE HALF THAT MAKES IT MEAN ANYTHING.** A test that only shows a notification
 * appearing cannot distinguish "intake read our finding" from "intake notifies about anything" —
 * and a build that notifies unconditionally would pass it. So the second case is a tenant whose
 * disposition for this alert type is `RECORD_ONLY`: the same finding, the same writer, and **no
 * notification**.
 */

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

function disposable(): void {
  assertDisposableNativeAlertDatabase()
}

type Scope = { organizationId: string; customerTenantId: string; humanId: string }

async function seedTenantWithFailures(prisma: PrismaService, at: Date): Promise<Scope> {
  const scope: Scope = {
    organizationId: randomUUID(), customerTenantId: randomUUID(), humanId: randomUUID(),
  }
  await prisma.organization.create({
    data: { id: scope.organizationId, name: 'Intake org', slug: `intake-${scope.organizationId}` },
  })
  await prisma.customerTenant.create({
    data: {
      id: scope.customerTenantId, organizationId: scope.organizationId,
      microsoftTenantId: randomUUID(), displayName: 'Intake tenant', status: 'ACTIVE',
    },
  })
  await prisma.tenantConnection.create({ data: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, status: 'CONNECTED',
  } })
  await prisma.syncState.create({
    data: {
      organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      resourceType: 'SIGN_INS', status: 'SUCCEEDED',
      lastAttemptAt: at, lastSuccessfulAt: at, updatedAt: at,
    },
  })
  await prisma.directoryUser.create({
    data: {
      organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
      microsoftUserId: scope.humanId, displayName: 'Intake human',
      userPrincipalName: `intake-${scope.humanId.slice(0, 8)}@fixture.invalid`,
      userType: 'Member', lastSeenAt: at, updatedAt: at,
    },
  })
  for (let index = 0; index < 8; index += 1) {
    const eventDateTime = new Date(at.getTime() - (index + 1) * 60_000)
    const id = randomUUID()
    await prisma.signInLog.create({
      data: {
        organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
        microsoftSignInId: id, eventDateTime,
        raw: {
          id, createdDateTime: eventDateTime.toISOString(), userId: scope.humanId,
          appId: randomUUID(), ipAddress: '192.0.2.10', isInteractive: true,
          status: { errorCode: 50126 },
        },
        riskLevel: 'none', ingestedAt: at,
        expiresAt: new Date(at.getTime() + 90 * 86_400_000),
      },
    })
  }
  return scope
}

/** Invoke the native producer exactly as production does, then observe what it published.
 *
 * This intentionally does not call `readLatestRun`, `intakeRowsFor`, or either Prisma `create`
 * method for the bridge tables. If the production producer does not publish, this test stays red.
 */
async function runProductionNativeEvaluation(
  prisma: PrismaService,
  scope: Scope,
  at: Date,
): Promise<{ runId: string; findingsEvaluated: number; findingsPublished: number }> {
  const produced = await evaluateAndPersistTenant(prisma as never, {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
  }, { now: at })
  const findingsPublished = await prisma.identityRiskFinding.count({
    where: {
      organizationId: scope.organizationId,
      customerTenantId: scope.customerTenantId,
      matchedResult: { evaluationRunId: produced.runId },
    },
  })
  return {
    runId: produced.runId,
    findingsEvaluated: produced.findings,
    findingsPublished,
  }
}

/** **RUNS INTAKE AND PROVES IT RAN.**
 *
 * The first version of this test called `runOnce` and asserted notification counts. Intake
 * returned `NOT_CONFIGURED` — `HAWKVIEW_ALERT_WATERMARK_ISO` is unset by default and intake does
 * nothing without it — so the positive case failed honestly and **the CONTROL PASSED for the wrong
 * reason**: zero notifications because nothing ran. A control that holds because no work happened
 * is not a control.
 *
 * So the outcome is asserted to be `RAN` before any count is read, in BOTH cases. */
async function runIntakeOnce(prisma: PrismaService, at: Date) {
  // Chosen here rather than inherited from the environment, so the test states its own
  // precondition instead of depending on one.
  const previous = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  process.env.HAWKVIEW_ALERT_WATERMARK_ISO = new Date(at.getTime() - 86_400_000).toISOString()
  try {
    const outcome = await new AlertIntakeService(prisma)
      .runOnce(Date.now() + 30_000, new Date(at.getTime() + 1_000))
    assert.equal(outcome.kind, 'COMPLETED', `intake did not run: ${JSON.stringify(outcome)}`)
    return outcome as Extract<typeof outcome, { kind: 'COMPLETED' }>
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO
    else process.env.HAWKVIEW_ALERT_WATERMARK_ISO = previous
  }
}

const cleanUp = (prisma: PrismaService, scope: Scope) =>
  prisma.organization.deleteMany({ where: { id: scope.organizationId } })

// ---------------------------------------------------------------------------------------

test('A REAL NATIVE FINDING PRODUCES THE INTENDED IN-APP ALERT',
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedTenantWithFailures(prisma, at)
    try {
      const production = await runProductionNativeEvaluation(prisma, scope, at)
      assert.equal(production.findingsEvaluated, 1,
        'the native evaluator did not yield the one finding this test is about')
      assert.equal(production.findingsPublished, 1,
        'production native evaluation did not publish its finding to alert intake')

      // NOTHING THE DETECTOR DID NOT DETERMINE IS ASSERTED IN THE ROW. This is the property the
      // build was blocked on, checked against what actually landed rather than against the writer.
      const stored = await prisma.identityRiskFinding.findFirst({
        where: { organizationId: scope.organizationId },
      })
      assert.ok(stored)
      assert.equal(stored.ruleId, NATIVE_RULE_ID)
      assert.equal(stored.severity, NOT_ASSESSED)
      assert.equal(stored.confidence, NOT_ASSESSED, 'confidence of compromise must stay unasserted')
      assert.equal(stored.coverage, NOT_ASSESSED)

      // THE REAL PRODUCTION CALLER.
      const outcome = await runIntakeOnce(prisma, at)

      const notifications = await prisma.notification.findMany({
        where: { organizationId: scope.organizationId },
      })
      assert.equal(notifications.length, 1, 'no in-app alert was produced for a real native finding')
      assert.equal(notifications[0]!.alertTypeId, 'security.suspected_credential_attack',
        'the alert did not reach the type the accepted mapping proposes')
      assert.equal(notifications[0]!.source, 'identity-risk')

      // THE RULE ID MAPPED, rather than being read and discarded. An unmapped rule is reported
      // by intake rather than thrown, so without this a new id that reaches nothing would look
      // identical to one that works — until no alert appeared in production.
      // Global intake totals include other organizations in the shared test database.
      // The exact notification cardinality and mapping above belong to this fixture.
      assert.equal(outcome.report.unmappedRules.includes(NATIVE_RULE_ID), false,
        'the native rule id reached no alert type')

      // Replaying intake must preserve the same single notification, not create a duplicate.
      await runIntakeOnce(prisma, at)
      const replayedNotifications = await prisma.notification.findMany({
        where: { organizationId: scope.organizationId },
      })
      assert.deepEqual(replayedNotifications.map(row => row.id), notifications.map(row => row.id))
    } finally {
      await cleanUp(prisma, scope)
      await prisma.$disconnect()
    }
  })

test('CONTROL: the same finding under a RECORD_ONLY disposition produces no alert',
  { skip: !enabled, timeout: 120_000 }, async () => {
    // WITHOUT THIS THE TEST ABOVE PROVES ONLY THAT NOTIFICATIONS HAPPEN. A build that notified
    // unconditionally would pass it. Same producer, same writer, same intake — one row changed.
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedTenantWithFailures(prisma, at)
    try {
      await prisma.alertRuleDisposition.create({
        data: {
          organizationId: scope.organizationId,
          alertTypeId: 'security.suspected_credential_attack',
          disposition: 'RECORD_ONLY', updatedAt: at,
        },
      })

      const production = await runProductionNativeEvaluation(prisma, scope, at)
      assert.equal(production.findingsEvaluated, 1,
        'the control must evaluate the same finding as the positive case')
      assert.equal(production.findingsPublished, 1,
        'the control must publish the same finding as the positive case')

      const stored = await prisma.identityRiskFinding.findFirst({
        where: {
          organizationId: scope.organizationId,
          customerTenantId: scope.customerTenantId,
          matchedResult: { evaluationRunId: production.runId },
        },
      })
      assert.ok(stored)
      assert.equal(stored.ruleId, NATIVE_RULE_ID)

      const outcome = await runIntakeOnce(prisma, at)

      const notifications = await prisma.notification.findMany({
        where: { organizationId: scope.organizationId },
      })
      assert.deepEqual(notifications.map(row => row.alertTypeId), [],
        'a RECORD_ONLY disposition still produced an in-app alert')

      // AND IT WAS A DECISION, NOT AN ABSENCE. Intake read the same finding and chose not to
      // notify. Without this the control would also pass if the finding were never read at all —
      // which is exactly how it passed before, when intake was NOT_CONFIGURED.
      assert.equal(outcome.report.unmappedRules.includes(NATIVE_RULE_ID), false,
        'the control native rule id reached no alert type')
      const withheld = await prisma.alertWithheldNotice.findMany({
        where: { organizationId: scope.organizationId },
      })
      assert.equal(withheld.length, 1, 'the control did not persist exactly one withheld decision')
      assert.equal(withheld[0]!.findingId, stored.id)
      assert.equal(withheld[0]!.alertTypeId, 'security.suspected_credential_attack')
      assert.equal(withheld[0]!.because, 'RECORD_ONLY')
    } finally {
      await cleanUp(prisma, scope)
      await prisma.$disconnect()
    }
  })
