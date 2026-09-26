import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AlertIntakeService } from '../alerts/alert-intake.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableNativeAlertDatabase } from '../prisma/native-alert-test-database.js'
import { evaluateAndPersistTenant } from './evaluate-and-persist.js'
import { readLatestRun } from './read-run.js'
import { IDENTITY_RISK_RUN_RETENTION_MS } from '../identity-risk/identity-risk.contract.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

type Scope = Readonly<{ organizationId: string; customerTenantId: string; humanId: string }>

function disposable(): void {
  assertDisposableNativeAlertDatabase()
}

async function seedFailingSignIns(prisma: PrismaService, at: Date, humanId = randomUUID()): Promise<Scope> {
  const scope = { organizationId: randomUUID(), customerTenantId: randomUUID(), humanId }
  await prisma.organization.create({
    data: { id: scope.organizationId, name: 'Native lifecycle org', slug: `native-${scope.organizationId}` },
  })
  await prisma.customerTenant.create({
    data: {
      id: scope.customerTenantId,
      organizationId: scope.organizationId,
      microsoftTenantId: randomUUID(),
      displayName: 'Native lifecycle tenant',
      status: 'ACTIVE',
    },
  })
  await prisma.tenantConnection.create({ data: {
    organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, status: 'CONNECTED',
  } })
  await prisma.syncState.create({
    data: {
      organizationId: scope.organizationId,
      customerTenantId: scope.customerTenantId,
      resourceType: 'SIGN_INS',
      status: 'SUCCEEDED',
      lastAttemptAt: at,
      lastSuccessfulAt: at,
      updatedAt: at,
    },
  })
  await prisma.directoryUser.create({
    data: {
      organizationId: scope.organizationId,
      customerTenantId: scope.customerTenantId,
      microsoftUserId: humanId,
      displayName: 'Native lifecycle human',
      userPrincipalName: `native-${scope.customerTenantId.slice(0, 8)}@fixture.invalid`,
      userType: 'Member',
      lastSeenAt: at,
      updatedAt: at,
    },
  })
  for (let index = 0; index < 8; index += 1) {
    const eventDateTime = new Date(at.getTime() - (index + 1) * 60_000)
    const id = randomUUID()
    await prisma.signInLog.create({
      data: {
        organizationId: scope.organizationId,
        customerTenantId: scope.customerTenantId,
        microsoftSignInId: id,
        eventDateTime,
        raw: {
          id,
          createdDateTime: eventDateTime.toISOString(),
          userId: humanId,
          appId: randomUUID(),
          ipAddress: '192.0.2.20',
          isInteractive: true,
          status: { errorCode: 50126 },
        },
        riskLevel: 'none',
        ingestedAt: at,
        expiresAt: new Date(at.getTime() + 90 * 86_400_000),
      },
    })
  }
  return scope
}

async function runIntake(prisma: PrismaService, at: Date) {
  const previous = process.env.HAWKVIEW_ALERT_WATERMARK_ISO
  process.env.HAWKVIEW_ALERT_WATERMARK_ISO = new Date(at.getTime() - 86_400_000).toISOString()
  try {
    const outcome = await new AlertIntakeService(prisma)
      .runOnce(Date.now() + 30_000, new Date(at.getTime() + 1_000))
    assert.equal(outcome.kind, 'COMPLETED', `intake did not run: ${JSON.stringify(outcome)}`)
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable after assertion')
    return outcome.report
  } finally {
    if (previous === undefined) delete process.env.HAWKVIEW_ALERT_WATERMARK_ISO
    else process.env.HAWKVIEW_ALERT_WATERMARK_ISO = previous
  }
}

const cleanUp = (prisma: PrismaService, scopes: readonly Scope[]) =>
  prisma.organization.deleteMany({ where: { id: { in: scopes.map(scope => scope.organizationId) } } })

// Read stored rows, not the publisher's return value. In particular, a second
// run key must reach SQL ON CONFLICT rather than the same-run replay shortcut.
test('distinct positive runs preserve unassessed classification on SQL conflict and do not regress observations',
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedFailingSignIns(prisma, at)
    const where = { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId }
    const unassessed = (row: { severity: string; confidence: string; coverage: string }) => {
      assert.equal(row.severity, 'NOT_ASSESSED', 'SQL conflict must not invent severity')
      assert.equal(row.confidence, 'NOT_ASSESSED')
      assert.equal(row.coverage, 'NOT_ASSESSED')
    }
    try {
      const first = await evaluateAndPersistTenant(prisma as never, scope, { now: at })
      assert.equal(first.publication, 'PUBLISHED')
      assert.equal(first.findings, 1)
      const original = await prisma.identityRiskFinding.findFirstOrThrow({ where })
      unassessed(original)
      const newerAt = new Date(at.getTime() + 120_000)
      const observedAt = new Date(at.getTime() + 60_000)
      const eventId = randomUUID()
      const added = await prisma.signInLog.create({ data: {
        ...where, microsoftSignInId: eventId, eventDateTime: observedAt,
        raw: { id: eventId, createdDateTime: observedAt.toISOString(), userId: scope.humanId,
          appId: randomUUID(), ipAddress: '192.0.2.20', isInteractive: true, status: { errorCode: 50126 } },
        riskLevel: 'none', ingestedAt: newerAt,
        expiresAt: new Date(newerAt.getTime() + 90 * 86_400_000),
      } })
      const newer = await evaluateAndPersistTenant(prisma as never, scope, { now: newerAt })
      assert.equal(newer.publication, 'PUBLISHED')
      assert.equal(newer.findings, 1)
      assert.notEqual(newer.runId, first.runId, 'same-run replay does not exercise the conflict arm')
      const standing = await prisma.identityRiskFinding.findFirstOrThrow({ where })
      const matched = await prisma.identityRiskMatchedResult.findFirstOrThrow({
        where: { ...where, evaluationRunId: newer.runId },
      })
      assert.equal(await prisma.identityRiskFinding.count({ where }), 1)
      assert.equal(standing.id, original.id)
      assert.equal(standing.dedupeKey, original.dedupeKey)
      assert.notEqual(standing.matchedResultId, original.matchedResultId)
      assert.equal(standing.matchedResultId, matched.id)
      assert.equal(matched.evaluationRunId, newer.runId)
      unassessed(standing)
      unassessed(matched)
      assert.equal(standing.observedAt.getTime(), observedAt.getTime())
      assert.equal(matched.observedAt.getTime(), observedAt.getTime())
      assert.equal(standing.createdAt.getTime(), original.createdAt.getTime())
      assert.equal(standing.updatedAt.getTime(), newerAt.getTime())
      assert.equal(standing.expiresAt.getTime(), observedAt.getTime() + IDENTITY_RISK_RUN_RETENTION_MS)
      // Parent retains the run horizon; standing evidence retains its source cap.
      assert.equal(matched.expiresAt.getTime(), newerAt.getTime() + IDENTITY_RISK_RUN_RETENTION_MS)

      // Equal occurrence in a NEW run reaches the conflict arm but cannot reopen
      // an already resolved standing finding. This is not a human disposition.
      await prisma.identityRiskFinding.update({ where: { id: standing.id }, data: { state: 'RESOLVED' } })
      const equalAt = new Date(at.getTime() + 240_000)
      const equal = await evaluateAndPersistTenant(prisma as never, scope, { now: equalAt })
      assert.equal(equal.publication, 'PUBLISHED')
      assert.equal(equal.findings, 1)
      assert.notEqual(equal.runId, newer.runId)
      const equalStanding = await prisma.identityRiskFinding.findFirstOrThrow({ where })
      const equalMatched = await prisma.identityRiskMatchedResult.findFirstOrThrow({
        where: { ...where, evaluationRunId: equal.runId },
      })
      assert.equal(equalStanding.id, standing.id)
      assert.equal(equalStanding.dedupeKey, standing.dedupeKey)
      assert.equal(equalStanding.state, 'RESOLVED')
      assert.equal(equalStanding.matchedResultId, equalMatched.id)
      assert.notEqual(equalStanding.matchedResultId, standing.matchedResultId)
      assert.equal(equalStanding.observedAt.getTime(), observedAt.getTime())
      assert.equal(equalStanding.expiresAt.getTime(), standing.expiresAt.getTime())
      assert.equal(equalStanding.updatedAt.getTime(), equalAt.getTime())
      unassessed(equalStanding)
      unassessed(equalMatched)

      // Older occurrence, still in a NEWER evaluation window: this must reach
      // the SQL observation guard, not OLDER_WINDOW_NOT_PUBLISHED or replay.
      assert.equal((await prisma.signInLog.deleteMany({ where: { ...where, id: added.id } })).count, 1)
      const olderAt = new Date(at.getTime() + 360_000)
      const older = await evaluateAndPersistTenant(prisma as never, scope, { now: olderAt })
      assert.equal(older.publication, 'PUBLISHED')
      assert.equal(older.findings, 1)
      assert.notEqual(older.runId, equal.runId)
      const olderMatched = await prisma.identityRiskMatchedResult.findFirstOrThrow({
        where: { ...where, evaluationRunId: older.runId },
      })
      assert.ok(olderMatched.observedAt.getTime() < observedAt.getTime())
      unassessed(olderMatched)
      assert.deepEqual(await prisma.identityRiskFinding.findFirstOrThrow({ where }), equalStanding,
        'older occurrence must not regress any standing evidence, FK, classification, state or clock')
      assert.equal(await prisma.identityRiskFinding.count({ where }), 1)
      assert.equal(await prisma.identityRiskMatchedResult.count({ where }), 4)
      assert.equal(await prisma.identityRiskEvaluationRun.count({ where }), 4)
    } finally {
      await cleanUp(prisma, [scope])
      await prisma.$disconnect()
    }
  })

for (const priorSuccess of [false, true]) test(
  `rejected observation ${priorSuccess ? 'preserves the prior readable assessment' : 'leaves no first-run partial publication'}`,
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedFailingSignIns(prisma, at)
    const where = { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId }
    const snapshot = async () => ({
      runs: await prisma.identityRiskEvaluationRun.findMany({ where, orderBy: { id: 'asc' } }),
      matched: await prisma.identityRiskMatchedResult.findMany({ where, orderBy: { id: 'asc' } }),
      standing: await prisma.identityRiskFinding.findMany({ where, orderBy: { id: 'asc' } }),
    })
    try {
      if (priorSuccess) {
        const first = await evaluateAndPersistTenant(prisma as never, scope, { now: at })
        assert.equal(first.publication, 'PUBLISHED')
        assert.equal(first.findings, 1)
      }
      const attemptedAt = new Date(at.getTime() + 120_000)
      const before = await snapshot()
      assert.equal(before.runs.length, priorSuccess ? 1 : 0)
      assert.equal(before.matched.length, priorSuccess ? 1 : 0)
      assert.equal(before.standing.length, priorSuccess ? 1 : 0)
      const reader = prisma as unknown as Parameters<typeof readLatestRun>[0]
      const readableBefore = await readLatestRun(reader, where, attemptedAt)
      assert.equal(readableBefore.present, priorSuccess)
      if (priorSuccess) {
        const findings = before.runs[0]!.evaluationFindings as Record<string, unknown>
        assert.deepEqual(findings.nativeAlertPublication, { version: 1, status: 'PUBLISHED' })
      }

      // Synthetic disagreement between the column used to fetch evidence and
      // its source occurrence. This reproduces validation refusal independently
      // of host timezone; it does NOT change or fix audit timestamp ingestion.
      const outsideWindow = new Date(attemptedAt.getTime() - 31 * 86_400_000).toISOString()
      const sourceRows = await prisma.signInLog.findMany({ where })
      assert.equal(sourceRows.length, 8)
      for (const row of sourceRows) {
        const raw = row.raw as Record<string, unknown>
        assert.equal((await prisma.signInLog.updateMany({ where: { ...where, id: row.id },
          data: { raw: { ...raw, createdDateTime: outsideWindow } },
        })).count, 1)
      }
      await assert.rejects(
        evaluateAndPersistTenant(prisma as never, scope, { now: attemptedAt }),
        /NATIVE_PUBLICATION_INVALID_OBSERVATION/,
      )
      assert.deepEqual(await snapshot(), before,
        'rejected new run must not change existing coverage, findings, marker, FK, evidence clocks or expiry')
      const readableAfter = await readLatestRun(reader, where, attemptedAt)
      assert.deepEqual(readableAfter, readableBefore)
      if (priorSuccess && readableAfter.present) {
        assert.equal(readableAfter.completedAt.getTime(), at.getTime())
      } else if (!priorSuccess) {
        assert.deepEqual(readableAfter, { present: false, because: 'NO_RUN' })
      }
    } finally {
      await cleanUp(prisma, [scope])
      await prisma.$disconnect()
    }
  })

test('concurrent same-run publication commits once and alert intake never replays the notification',
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedFailingSignIns(prisma, at)
    try {
      const results = await Promise.all([
        evaluateAndPersistTenant(prisma as never, scope, { now: at }),
        evaluateAndPersistTenant(prisma as never, scope, { now: at }),
      ])
      assert.deepEqual(results.map(result => result.publication).sort(), ['ALREADY_PUBLISHED', 'PUBLISHED'])
      assert.equal(await prisma.identityRiskEvaluationRun.count({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      }), 1)
      assert.equal(await prisma.identityRiskMatchedResult.count({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      }), 1)
      assert.equal(await prisma.identityRiskFinding.count({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      }), 1)

      const first = await runIntake(prisma, at)
      const second = await runIntake(prisma, new Date(at.getTime() + 2_000))
      assert.equal(first.notificationsWritten, 1)
      assert.equal(second.notificationsWritten, 0, 'the same standing finding notified twice')
      assert.equal(await prisma.notification.count({ where: { organizationId: scope.organizationId } }), 1)
    } finally {
      await cleanUp(prisma, [scope])
      await prisma.$disconnect()
    }
  })

test('incomplete absence preserves a standing finding; authoritative complete absence resolves it',
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedFailingSignIns(prisma, at)
    try {
      const first = await evaluateAndPersistTenant(prisma as never, scope, { now: at })
      assert.equal(first.findings, 1)
      await prisma.signInLog.deleteMany({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      })
      const partialAt = new Date(at.getTime() + 120_000)
      const successfulSignInId = randomUUID()
      await prisma.signInLog.create({
        data: {
          organizationId: scope.organizationId,
          customerTenantId: scope.customerTenantId,
          microsoftSignInId: successfulSignInId,
          eventDateTime: new Date(partialAt.getTime() - 1_000),
          raw: {
            id: successfulSignInId,
            createdDateTime: new Date(partialAt.getTime() - 1_000).toISOString(),
            userId: scope.humanId,
            appId: randomUUID(),
            ipAddress: '192.0.2.21',
            isInteractive: true,
            status: { errorCode: 0 },
          },
          riskLevel: 'none',
          ingestedAt: partialAt,
          expiresAt: new Date(partialAt.getTime() + 90 * 86_400_000),
        },
      })
      await prisma.syncState.update({
        where: { customerTenantId_resourceType: {
          customerTenantId: scope.customerTenantId, resourceType: 'SIGN_INS',
        } },
        data: {
          status: 'FAILED',
          lastAttemptAt: partialAt,
          lastErrorCode: 'QA_PARTIAL',
          lastErrorMessage: 'Synthetic incomplete evidence',
        },
      })
      const partial = await evaluateAndPersistTenant(prisma as never, scope, { now: partialAt })
      assert.equal(partial.findings, 0)
      assert.equal((await prisma.identityRiskFinding.findFirstOrThrow({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      })).state, 'OPEN', 'incomplete evidence falsely resolved the standing finding')

      const completeAt = new Date(at.getTime() + 240_000)
      await prisma.syncState.update({
        where: { customerTenantId_resourceType: {
          customerTenantId: scope.customerTenantId, resourceType: 'SIGN_INS',
        } },
        data: {
          status: 'SUCCEEDED',
          lastAttemptAt: completeAt,
          lastSuccessfulAt: completeAt,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      })
      const complete = await evaluateAndPersistTenant(prisma as never, scope, { now: completeAt })
      assert.equal(complete.findings, 0)
      assert.equal((await prisma.identityRiskFinding.findFirstOrThrow({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      })).state, 'RESOLVED')
    } finally {
      await cleanUp(prisma, [scope])
      await prisma.$disconnect()
    }
  })

test('identical subjects in separate MSP organizations publish and notify in isolation',
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const sharedHumanId = randomUUID()
    const first = await seedFailingSignIns(prisma, at, sharedHumanId)
    const second = await seedFailingSignIns(prisma, at, sharedHumanId)
    try {
      await evaluateAndPersistTenant(prisma as never, first, { now: at })
      await evaluateAndPersistTenant(prisma as never, second, { now: at })
      const report = await runIntake(prisma, at)
      assert.equal(report.findingsRead, 2)
      assert.equal(report.notificationsWritten, 2)
      for (const scope of [first, second]) {
        assert.equal(await prisma.identityRiskFinding.count({
          where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
        }), 1)
        const notifications = await prisma.notification.findMany({ where: { organizationId: scope.organizationId } })
        assert.equal(notifications.length, 1)
        assert.equal(notifications[0]!.customerTenantId, scope.customerTenantId)
      }
    } finally {
      await cleanUp(prisma, [first, second])
      await prisma.$disconnect()
    }
  })

function failAtPublicationMarker(prisma: PrismaService): Parameters<typeof evaluateAndPersistTenant>[0] {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver)
      return async (
        work: (transaction: object) => Promise<unknown>,
        options?: Readonly<{ maxWait?: number; timeout?: number }>,
      ) => target.$transaction(async transaction => {
        const failingTransaction = new Proxy(transaction, {
          get(transactionTarget, transactionProperty, transactionReceiver) {
            if (transactionProperty !== 'identityRiskEvaluationRun') {
              return Reflect.get(transactionTarget, transactionProperty, transactionReceiver)
            }
            const model = transactionTarget.identityRiskEvaluationRun
            return new Proxy(model, {
              get(modelTarget, modelProperty, modelReceiver) {
                if (modelProperty === 'update') return async () => {
                  throw new Error('QA_FORCED_PUBLICATION_MARKER_FAILURE')
                }
                const value = Reflect.get(modelTarget, modelProperty, modelReceiver)
                return typeof value === 'function' ? value.bind(modelTarget) : value
              },
            })
          },
        })
        return work(failingTransaction)
      }, options)
    },
  }) as unknown as Parameters<typeof evaluateAndPersistTenant>[0]
}

test('a failure after standing writes rolls back run, parent, and finding together',
  { skip: !enabled, timeout: 120_000 }, async () => {
    disposable()
    const prisma = new PrismaService()
    await prisma.$connect()
    const at = new Date()
    const scope = await seedFailingSignIns(prisma, at)
    try {
      await assert.rejects(
        evaluateAndPersistTenant(failAtPublicationMarker(prisma), scope, { now: at }),
        /QA_FORCED_PUBLICATION_MARKER_FAILURE/,
      )
      assert.equal(await prisma.identityRiskEvaluationRun.count({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      }), 0)
      assert.equal(await prisma.identityRiskMatchedResult.count({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      }), 0)
      assert.equal(await prisma.identityRiskFinding.count({
        where: { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId },
      }), 0)
    } finally {
      await cleanUp(prisma, [scope])
      await prisma.$disconnect()
    }
  })
