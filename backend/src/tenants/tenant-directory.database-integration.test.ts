import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { ChangesService } from '../changes/changes.service.js'
import { TenantsService } from './tenants.service.js'

const databaseIntegrationEnabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

test(
  'a migrated PostgreSQL database returns only the authenticated MSP workspace tenants',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()

    const testRun = randomUUID()
    const organizationIds: string[] = []
    const userIds: string[] = []

    context.after(async () => {
      await prisma.organization.deleteMany({
        where: { id: { in: organizationIds } },
      })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
      await prisma.$disconnect()
    })

    const createWorkspace = async (label: 'a' | 'b') => {
      const subject = randomUUID()
      const user = await prisma.user.create({
        data: {
          authProviderUserId: subject,
          email: `${label}-${testRun}@integration.hawkview.invalid`,
          displayName: `Integration Owner ${label.toUpperCase()}`,
        },
      })
      userIds.push(user.id)

      const organization = await prisma.organization.create({
        data: {
          name: `Integration MSP ${label.toUpperCase()}`,
          slug: `integration-${label}-${testRun}`,
          onboardingCompletedAt: new Date(),
        },
      })
      organizationIds.push(organization.id)

      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: 'MSP_OWNER',
          status: 'ACTIVE',
        },
      })

      const tenant = await prisma.customerTenant.create({
        data: {
          organizationId: organization.id,
          microsoftTenantId: randomUUID(),
          displayName: `Customer ${label.toUpperCase()}`,
          primaryDomain: `${label}.${testRun}.example`,
          status: 'ACTIVE',
          connection: {
            create: {
              connectionMode: 'HAWKVIEW_MANAGED',
              status: 'CONNECTED',
              consentedPermissions: [],
              onboardingCompletedAt: new Date(),
            },
          },
        },
      })

      return { subject, user, organization, tenant }
    }

    const workspaceA = await createWorkspace('a')
    const workspaceB = await createWorkspace('b')
    const microsoftConsent = {
      getRequiredPermissions: () => [],
      getAccessContract: () => ({
        version: 1,
        requestedPermissions: [],
        connectionRequiredPermissions: [],
        capabilities: [],
      }),
    }
    const service = new TenantsService(
      prisma,
      microsoftConsent as never,
      {} as never,
    )

    const resultA = await service.listForIdentity({
      subject: workspaceA.subject,
      email: workspaceA.user.email,
    })
    const resultB = await service.listForIdentity({
      subject: workspaceB.subject,
      email: workspaceB.user.email,
    })

    assert.deepEqual(resultA.tenants.map((tenant) => tenant.id), [workspaceA.tenant.id])
    assert.deepEqual(resultB.tenants.map((tenant) => tenant.id), [workspaceB.tenant.id])
    assert.equal(resultA.tenants[0]?.onboarding.complete, true)
    assert.equal(resultB.tenants[0]?.onboarding.complete, true)
    assert.equal(
      resultA.tenants.some((tenant) => tenant.id === workspaceB.tenant.id),
      false,
    )
    assert.equal(
      resultB.tenants.some((tenant) => tenant.id === workspaceA.tenant.id),
      false,
    )
  },
)


// --------------------------------------------------------------------------
// Physical cases for the stored-redacted directory-audit export. These run
// ONLY in the existing disposable CI database; locally they skip, so a green
// local run says nothing about them.
//
// Every service call below is made against a FIXED request clock passed
// through the production `internals.now` seam, and every fixture expires
// later than that clock. The first version pinned expiry at a date that had
// already passed, so the production expiry guard -- which is unchanged and
// still compares a real instant by default -- excluded every seeded row and
// no positive case could reach its assertion. A fixed clock keeps these
// deterministic on any future date, and each case asserts its fixture is live
// before exercising the behaviour under test.
// --------------------------------------------------------------------------

/** The request clock for every physical export call below. */
const PHYSICAL_CLOCK = new Date(Date.UTC(2026, 2, 15, 0, 0, 0))
const physicalNow = () => PHYSICAL_CLOCK
/** Later than PHYSICAL_CLOCK, so seeded rows are retained at that instant. */
const PHYSICAL_EXPIRY = new Date(Date.UTC(2026, 8, 1))

type ExportWorkspace = {
  subject: string
  email: string
  organizationId: string
  tenantId: string
}

async function seedExportWorkspace(
  prisma: PrismaService,
  label: string,
  testRun: string,
  track: { organizationIds: string[]; userIds: string[] },
): Promise<ExportWorkspace> {
  const subject = randomUUID()
  const email = `${label}-${testRun}@integration.hawkview.invalid`
  const user = await prisma.user.create({
    data: { authProviderUserId: subject, email, displayName: `Export Owner ${label}` },
  })
  track.userIds.push(user.id)
  const organization = await prisma.organization.create({
    data: {
      name: `Export MSP ${label}`,
      slug: `export-${label}-${testRun}`,
      onboardingCompletedAt: new Date(),
    },
  })
  track.organizationIds.push(organization.id)
  await prisma.membership.create({
    data: { userId: user.id, organizationId: organization.id, role: 'MSP_OWNER', status: 'ACTIVE' },
  })
  const tenant = await prisma.customerTenant.create({
    data: {
      organizationId: organization.id,
      microsoftTenantId: randomUUID(),
      displayName: `Export Customer ${label}`,
      primaryDomain: `${label}.${testRun}.example`,
      status: 'ACTIVE',
    },
  })
  return { subject, email, organizationId: organization.id, tenantId: tenant.id }
}

const identityOf = (workspace: ExportWorkspace) =>
  ({ subject: workspace.subject, email: workspace.email }) as never

/** An eligible stored directory-audit row. Its classification is measured
 *  against the reviewed catalog in the focused suite, not assumed here. */
function exportAuditRow(workspace: ExportWorkspace, index: number, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: workspace.organizationId,
    customerTenantId: workspace.tenantId,
    microsoftAuditId: `export-${workspace.tenantId}-${index}`,
    eventDateTime: new Date(Date.UTC(2026, 2, 1, 0, 0, 0) + index * 1000),
    activityDisplayName: 'Reset user password',
    category: 'UserManagement',
    operationType: 'Update',
    result: 'success',
    correlationId: randomUUID(),
    loggedByService: 'Core Directory',
    initiatedBy: { user: { userPrincipalName: 'admin@example.test' } },
    targetResources: [{ type: 'User', userPrincipalName: `target-${index}@example.test` }],
    additionalDetails: [{ key: 'Note', value: 'kept' }],
    raw: { correlationId: `c-${index}` },
    expiresAt: PHYSICAL_EXPIRY,
    ...overrides,
  }
}

/** Reads the seeded rows back and asserts they are retained AT the request
 *  clock. Without this, an expiry regression would silently empty every
 *  positive case instead of failing one. */
async function assertFixtureLive(prisma: PrismaService, workspace: ExportWorkspace, expected: number) {
  const live = await prisma.directoryAuditLog.count({
    where: { customerTenantId: workspace.tenantId, expiresAt: { gt: PHYSICAL_CLOCK } },
  })
  assert.equal(live, expected,
    `the fixture must be retained at the request clock, or the case proves nothing`)
}

/** A narrow forwarding wrapper around the real Prisma raw-query method, so a
 *  refusal can be judged on what the ACTUAL production guarded statement
 *  returned. The first version ran a separate simplified statement, which
 *  could have passed even if the production query had returned payload and the
 *  service discarded it before throwing. Nothing is reimplemented here: the
 *  real method is called and its result forwarded unchanged. */
function observeGuardedQuery(prisma: PrismaService) {
  const real = prisma.$queryRawUnsafe.bind(prisma)
  const seen: { sql: string; rows: unknown }[] = []
  ;(prisma as unknown as { $queryRawUnsafe: unknown }).$queryRawUnsafe =
    async (sql: string, ...values: unknown[]) => {
      const rows = await real(sql, ...values)
      seen.push({ sql, rows })
      return rows
    }
  return {
    seen,
    restore: () => {
      ;(prisma as unknown as { $queryRawUnsafe: unknown }).$queryRawUnsafe = real
    },
  }
}

/** The guarded statement the export issues, identified by its own shape rather
 *  than by call order. */
function lastGuardRow(seen: { sql: string; rows: unknown }[]) {
  const guarded = seen.filter((entry) => /row_to_json\(j\)/.test(entry.sql) && /json_agg\(j/.test(entry.sql))
  assert.ok(guarded.length > 0, 'the production guarded statement must have run')
  const rows = guarded[guarded.length - 1]!.rows as {
    candidate_count: number
    selected_bytes: bigint | number
    records: unknown
  }[]
  assert.ok(Array.isArray(rows) && rows.length === 1, 'the guard returns exactly one tally row')
  return rows[0]!
}

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run()
    return null
  } catch (error) {
    return error as { getStatus?: () => number; getResponse?: () => Record<string, unknown> }
  }
}

function physicalContext(context: { after: (fn: () => Promise<void>) => void }) {
  const prisma = new PrismaService()
  const track = { organizationIds: [] as string[], userIds: [] as string[] }
  context.after(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: track.organizationIds } } })
    await prisma.user.deleteMany({ where: { id: { in: track.userIds } } })
    await prisma.$disconnect()
  })
  return { prisma, track }
}

test(
  'a migrated PostgreSQL database exports only the requesting workspace directory audit records',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const mine = await seedExportWorkspace(prisma, 'iso-a', testRun, track)
    const theirs = await seedExportWorkspace(prisma, 'iso-b', testRun, track)
    await prisma.directoryAuditLog.createMany({
      data: [exportAuditRow(mine, 1), exportAuditRow(mine, 2), exportAuditRow(theirs, 3)],
    })
    await assertFixtureLive(prisma, mine, 2)

    const changes = new ChangesService(prisma)
    const { envelope } = await changes.exportDirectoryAudit(
      identityOf(mine), mine.tenantId, undefined, undefined, { now: physicalNow })
    assert.equal(envelope.candidates, 2)
    assert.equal(envelope.returned, 2)
    assert.equal(
      envelope.records.some((record) => String(record.microsoftAuditId).includes(theirs.tenantId)),
      false,
    )

    await assert.rejects(
      () => changes.exportDirectoryAudit(
        identityOf(mine), theirs.tenantId, undefined, undefined, { now: physicalNow }),
      /unavailable or outside retention/,
    )
  },
)

test(
  'a migrated PostgreSQL database excludes a directory audit record that has expired at the request clock',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'expiry', testRun, track)
    await prisma.directoryAuditLog.createMany({
      data: [
        exportAuditRow(workspace, 1),
        // Expired one millisecond before the request clock, and not deleted:
        // the production guard must exclude it without any cleanup running.
        exportAuditRow(workspace, 2, { expiresAt: new Date(PHYSICAL_CLOCK.getTime() - 1) }),
      ],
    })
    await assertFixtureLive(prisma, workspace, 1)
    assert.equal(await prisma.directoryAuditLog.count({ where: { customerTenantId: workspace.tenantId } }), 2,
      'the expired row must still be present, or this case proves nothing about the guard')

    const changes = new ChangesService(prisma)
    const { envelope } = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow })
    assert.equal(envelope.candidates, 1)
    assert.equal(envelope.records.length, 1)
    assert.equal(envelope.records[0]!.microsoftAuditId, `export-${workspace.tenantId}-1`)
  },
)

test(
  'a migrated PostgreSQL database refuses a directory audit export one past the candidate cap',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'cap', testRun, track)
    const changes = new ChangesService(prisma)

    await prisma.directoryAuditLog.createMany({
      data: Array.from({ length: 500 }, (_, index) => exportAuditRow(workspace, index + 1)),
    })
    await assertFixtureLive(prisma, workspace, 500)
    const atCap = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow })
    assert.equal(atCap.envelope.candidates, 500)
    assert.equal(atCap.envelope.returned, 500)

    await prisma.directoryAuditLog.create({ data: exportAuditRow(workspace, 501) })
    await assertFixtureLive(prisma, workspace, 501)

    const observer = observeGuardedQuery(prisma)
    const refusal = await refusalOf(() => changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow }))
    observer.restore()

    const body = refusal?.getResponse?.() as Record<string, unknown>
    assert.equal(refusal?.getStatus?.(), 409)
    assert.equal(body.refusal, 'CANDIDATE_CAP_EXCEEDED')
    assert.equal(body.observedAtLeast, 501)
    // Judged on the ACTUAL production statement's own result, not on a
    // simplified statement written for the test.
    const guard = lastGuardRow(observer.seen)
    assert.equal(guard.records, null)
    assert.equal(Number(guard.candidate_count), 501)
    assert.doesNotMatch(JSON.stringify(body), /admin@example\.test|Reset user password/)
  },
)

test(
  'a migrated PostgreSQL database enforces the read budget on oversized stored directory payload',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'budget-directory', testRun, track)
    const changes = new ChangesService(prisma)

    const bulk = 'd'.repeat(300_000)
    await prisma.directoryAuditLog.createMany({
      data: Array.from({ length: 4 }, (_, index) =>
        exportAuditRow(workspace, index + 1, { additionalDetails: [{ key: 'Detail', value: bulk }] })),
    })
    await assertFixtureLive(prisma, workspace, 4)

    const observer = observeGuardedQuery(prisma)
    const refusal = await refusalOf(() => changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow }))
    observer.restore()

    const body = refusal?.getResponse?.() as Record<string, unknown>
    assert.equal(body.refusal, 'READ_BUDGET_EXCEEDED')
    assert.equal(body.readBudgetBytes, 1_000_000)
    assert.ok(Number(body.observedBytes) > 1_000_000)
    assert.doesNotMatch(JSON.stringify(body), new RegExp(bulk.slice(0, 64)))

    // No payload left the database for the application to discard: the
    // guarded statement's own records column is null. PostgreSQL necessarily
    // examined stored values to compute the byte lengths, so this is not a
    // claim of zero database-side reads.
    assert.equal(lastGuardRow(observer.seen).records, null)
  },
)

test(
  'a migrated PostgreSQL database counts oversized projected evidence against the read budget',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'budget-projected', testRun, track)
    const changes = new ChangesService(prisma)

    // The directory rows are small; the oversize is entirely in the PROJECTED
    // raw/beforeState/afterState that the classifier reads. A budget covering
    // only the directory columns would admit this export.
    const rows = Array.from({ length: 3 }, (_, index) => exportAuditRow(workspace, index + 1))
    await prisma.directoryAuditLog.createMany({ data: rows })
    await assertFixtureLive(prisma, workspace, 3)

    const smallDirectoryBytes = await prisma.$queryRawUnsafe<{ bytes: bigint }[]>(
      `SELECT coalesce(sum(octet_length(row_to_json(d)::text)), 0)::bigint AS bytes
         FROM directory_audit_logs d WHERE d.customer_tenant_id = $1::uuid`,
      workspace.tenantId,
    )
    assert.ok(Number(smallDirectoryBytes[0]?.bytes ?? 0) < 1_000_000,
      'the directory rows must fit, or this case would not isolate the projected input')

    const bulk = 'p'.repeat(200_000)
    for (const row of rows) {
      await prisma.changeEvidenceEvent.create({
        data: {
          organizationId: workspace.organizationId,
          customerTenantId: workspace.tenantId,
          source: 'DIRECTORY_AUDIT',
          sourceEventId: row.microsoftAuditId,
          eventDateTime: row.eventDateTime,
          operationName: 'Reset user password',
          category: 'Passwords',
          severity: 'High',
          summary: 'Oversized projected evidence for the read-budget physical case.',
          result: 'success',
          raw: { bulk },
          beforeState: { bulk },
          afterState: { bulk },
          expiresAt: PHYSICAL_EXPIRY,
        },
      })
    }

    const observer = observeGuardedQuery(prisma)
    const refusal = await refusalOf(() => changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow }))
    observer.restore()

    const body = refusal?.getResponse?.() as Record<string, unknown>
    assert.equal(body.refusal, 'READ_BUDGET_EXCEEDED')
    assert.ok(Number(body.observedBytes) > 1_000_000)
    assert.doesNotMatch(JSON.stringify(body), new RegExp(bulk.slice(0, 64)))
    assert.equal(lastGuardRow(observer.seen).records, null)
  },
)

test(
  'a migrated PostgreSQL database applies the half-open window at stored microsecond precision',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'micro', testRun, track)
    const changes = new ChangesService(prisma)

    // Two rows: one a microsecond above the lower bound, one exactly ON the
    // exclusive upper bound. Prisma's Date is millisecond-valued, so the
    // microsecond instant is written as a literal timestamptz -- the precision
    // under test cannot be expressed through the client.
    await prisma.directoryAuditLog.createMany({
      data: [exportAuditRow(workspace, 1), exportAuditRow(workspace, 2)],
    })
    await assertFixtureLive(prisma, workspace, 2)
    await prisma.$executeRawUnsafe(
      `UPDATE directory_audit_logs
          SET event_date_time = '2026-03-01T00:00:00.000500Z'::timestamptz
        WHERE customer_tenant_id = $1::uuid AND microsoft_audit_id = $2`,
      workspace.tenantId, `export-${workspace.tenantId}-1`,
    )
    await prisma.$executeRawUnsafe(
      `UPDATE directory_audit_logs
          SET event_date_time = '2026-03-01T00:00:01.000Z'::timestamptz
        WHERE customer_tenant_id = $1::uuid AND microsoft_audit_id = $2`,
      workspace.tenantId, `export-${workspace.tenantId}-2`,
    )
    const stored = await prisma.$queryRawUnsafe<{ id: string; exact: string }[]>(
      `SELECT microsoft_audit_id AS id,
              to_char(event_date_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS exact
         FROM directory_audit_logs WHERE customer_tenant_id = $1::uuid
        ORDER BY event_date_time ASC`,
      workspace.tenantId,
    )
    assert.deepEqual(stored.map((row) => row.exact), [
      '2026-03-01T00:00:00.000500', '2026-03-01T00:00:01.000000',
    ], 'the fixture must carry microseconds and an exact upper-bound row')

    // A real allowed half-open interval: the bounds differ, so the parser
    // accepts them and the comparison actually reaches SQL.
    const { envelope } = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId,
      '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:01.000Z', { now: physicalNow })
    assert.equal(envelope.candidates, 1)
    assert.equal(envelope.records.length, 1)
    // The microsecond row below the bound is included...
    assert.equal(envelope.records[0]!.microsoftAuditId, `export-${workspace.tenantId}-1`)
    // ...and the row exactly AT the exclusive upper bound is not.
    assert.equal(
      envelope.records.some((record) => record.microsoftAuditId === `export-${workspace.tenantId}-2`),
      false,
    )
    // The stored microsecond value survives into the file unrounded.
    assert.match(String(envelope.records[0]!.eventDateTime), /00:00:00\.0005/)

    // A lower bound one millisecond above the microsecond row excludes it.
    const above = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId,
      '2026-03-01T00:00:00.001Z', '2026-03-01T00:00:01.000Z', { now: physicalNow })
    assert.equal(above.envelope.candidates, 0)
  },
)

test(
  'a migrated PostgreSQL database lets a stored projection decide an exported row',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'projection', testRun, track)
    const changes = new ChangesService(prisma)

    // A stored row the reviewed catalog does not admit on its own.
    const row = exportAuditRow(workspace, 1, {
      activityDisplayName: 'Export directory report',
      operationType: 'Read',
    })
    await prisma.directoryAuditLog.create({ data: row })
    await assertFixtureLive(prisma, workspace, 1)

    const withoutProjection = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow })
    assert.equal(withoutProjection.envelope.candidates, 1)
    assert.equal(withoutProjection.envelope.returned, 0)
    assert.equal(withoutProjection.envelope.excludedByClassification, 1)

    await prisma.changeEvidenceEvent.create({
      data: {
        organizationId: workspace.organizationId,
        customerTenantId: workspace.tenantId,
        source: 'DIRECTORY_AUDIT',
        sourceEventId: String(row.microsoftAuditId),
        eventDateTime: row.eventDateTime as Date,
        operationName: 'Reset user password',
        category: 'Passwords',
        severity: 'High',
        summary: 'Stored projection for the directory-audit export physical case.',
        result: 'success',
        raw: {},
        expiresAt: PHYSICAL_EXPIRY,
      },
    })

    const withProjection = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow })
    assert.equal(withProjection.envelope.returned, 1)
    assert.equal(withProjection.envelope.excludedByClassification, 0)
  },
)

test(
  'a migrated PostgreSQL database redacts a sensitive detail pair on export',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()

    const workspace = await seedExportWorkspace(prisma, 'redaction', testRun, track)
    const changes = new ChangesService(prisma)

    // Ingestion-shaped: the collector stores these structured fields exactly as
    // received, so the value is genuinely in the database before the export
    // reads it. This is a read safeguard, not storage cleanup.
    await prisma.directoryAuditLog.create({
      data: exportAuditRow(workspace, 1, {
        additionalDetails: [
          { key: 'Authorization', value: 'Bearer physical-bearer-value' },
          { key: 'Note', value: 'kept-note' },
        ],
        raw: {
          correlationId: 'c-1',
          additionalDetails: [{ key: 'Client-Secret', value: 'physical-nested-secret' }],
        },
      }),
    })
    await assertFixtureLive(prisma, workspace, 1)

    const [storedRow] = await prisma.$queryRawUnsafe<{ stored: string }[]>(
      `SELECT additional_details::text AS stored
         FROM directory_audit_logs WHERE customer_tenant_id = $1::uuid`,
      workspace.tenantId,
    )
    assert.match(String(storedRow?.stored), /physical-bearer-value/,
      'the value must actually be stored unredacted, or the export safeguard is untested')

    const { envelope } = await changes.exportDirectoryAudit(
      identityOf(workspace), workspace.tenantId, undefined, undefined, { now: physicalNow })
    const text = JSON.stringify(envelope)
    for (const leak of ['physical-bearer-value', 'physical-nested-secret']) {
      assert.doesNotMatch(text, new RegExp(leak), leak)
    }
    assert.match(text, /kept-note/)
  },
)
