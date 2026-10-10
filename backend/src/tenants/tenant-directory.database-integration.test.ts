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
// only in the existing disposable CI database; locally they skip, so a green
// local run says nothing about them.
// --------------------------------------------------------------------------

type ExportWorkspace = {
  subject: string
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
  const user = await prisma.user.create({
    data: {
      authProviderUserId: subject,
      email: `${label}-${testRun}@integration.hawkview.invalid`,
      displayName: `Export Owner ${label}`,
    },
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
  return { subject, organizationId: organization.id, tenantId: tenant.id }
}

/** An eligible stored directory-audit row: measured against the reviewed
 *  catalog in the focused suite, not assumed to classify. */
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
    expiresAt: new Date(Date.UTC(2026, 8, 1)),
    ...overrides,
  }
}

async function refusalOf(run: () => Promise<unknown>) {
  try {
    await run()
    return null
  } catch (error) {
    return error as { getStatus?: () => number; getResponse?: () => Record<string, unknown> }
  }
}

test(
  'a migrated PostgreSQL database exports only the requesting workspace directory audit records',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const testRun = randomUUID()
    const track = { organizationIds: [] as string[], userIds: [] as string[] }
    context.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: track.organizationIds } } })
      await prisma.user.deleteMany({ where: { id: { in: track.userIds } } })
      await prisma.$disconnect()
    })

    const mine = await seedExportWorkspace(prisma, 'iso-a', testRun, track)
    const theirs = await seedExportWorkspace(prisma, 'iso-b', testRun, track)
    await prisma.directoryAuditLog.createMany({
      data: [exportAuditRow(mine, 1), exportAuditRow(mine, 2), exportAuditRow(theirs, 3)],
    })

    const changes = new ChangesService(prisma)
    const { envelope } = await changes.exportDirectoryAudit(
      { subject: mine.subject, email: `iso-a-${testRun}@integration.hawkview.invalid` } as never,
      mine.tenantId, undefined, undefined,
    )
    assert.equal(envelope.candidates, 2)
    assert.equal(envelope.returned, 2)
    assert.equal(
      envelope.records.some((record) => String(record.microsoftAuditId).includes(theirs.tenantId)),
      false,
    )

    // The other workspace's tenant is indistinguishable from absent.
    await assert.rejects(
      () => changes.exportDirectoryAudit(
        { subject: mine.subject, email: `iso-a-${testRun}@integration.hawkview.invalid` } as never,
        theirs.tenantId, undefined, undefined,
      ),
      /unavailable or outside retention/,
    )
  },
)

test(
  'a migrated PostgreSQL database refuses a directory audit export one past the candidate cap',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const testRun = randomUUID()
    const track = { organizationIds: [] as string[], userIds: [] as string[] }
    context.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: track.organizationIds } } })
      await prisma.user.deleteMany({ where: { id: { in: track.userIds } } })
      await prisma.$disconnect()
    })

    const workspace = await seedExportWorkspace(prisma, 'cap', testRun, track)
    const identity = { subject: workspace.subject, email: `cap-${testRun}@integration.hawkview.invalid` } as never
    const changes = new ChangesService(prisma)

    // Exactly the cap succeeds against real rows and the real statement.
    await prisma.directoryAuditLog.createMany({
      data: Array.from({ length: 500 }, (_, index) => exportAuditRow(workspace, index + 1)),
    })
    const atCap = await changes.exportDirectoryAudit(identity, workspace.tenantId, undefined, undefined)
    assert.equal(atCap.envelope.candidates, 500)
    assert.equal(atCap.envelope.returned, 500)

    // The 501st candidate refuses rather than returning a silently short page.
    await prisma.directoryAuditLog.create({ data: exportAuditRow(workspace, 501) })
    const refusal = await refusalOf(() =>
      changes.exportDirectoryAudit(identity, workspace.tenantId, undefined, undefined))
    const body = refusal?.getResponse?.() as Record<string, unknown>
    assert.equal(refusal?.getStatus?.(), 409)
    assert.equal(body.refusal, 'CANDIDATE_CAP_EXCEEDED')
    assert.equal(body.observedAtLeast, 501)
    // The refusal body carries no record payload out of the database.
    assert.doesNotMatch(JSON.stringify(body), /admin@example\.test|Reset user password/)
  },
)

test(
  'a migrated PostgreSQL database enforces the read budget before materializing records',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const testRun = randomUUID()
    const track = { organizationIds: [] as string[], userIds: [] as string[] }
    context.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: track.organizationIds } } })
      await prisma.user.deleteMany({ where: { id: { in: track.userIds } } })
      await prisma.$disconnect()
    })

    const workspace = await seedExportWorkspace(prisma, 'budget', testRun, track)
    const identity = { subject: workspace.subject, email: `budget-${testRun}@integration.hawkview.invalid` } as never
    const changes = new ChangesService(prisma)

    // Four oversized stored rows exceed the real 1,000,000-byte budget.
    const bulk = 'd'.repeat(300_000)
    await prisma.directoryAuditLog.createMany({
      data: Array.from({ length: 4 }, (_, index) =>
        exportAuditRow(workspace, index + 1, { additionalDetails: [{ key: 'Detail', value: bulk }] })),
    })
    const refusal = await refusalOf(() =>
      changes.exportDirectoryAudit(identity, workspace.tenantId, undefined, undefined))
    const body = refusal?.getResponse?.() as Record<string, unknown>
    assert.equal(body.refusal, 'READ_BUDGET_EXCEEDED')
    assert.equal(body.readBudgetBytes, 1_000_000)
    assert.ok(Number(body.observedBytes) > 1_000_000)
    assert.doesNotMatch(JSON.stringify(body), new RegExp(bulk.slice(0, 64)))

    // The database itself did not materialize the aggregate: this establishes
    // that no payload or classification value crossed into the application,
    // not that the database performed no reads at all.
    const [guard] = await prisma.$queryRawUnsafe<{ records: unknown }[]>(
      `WITH candidates AS (
         SELECT d.id, d.raw, d.additional_details
         FROM directory_audit_logs d
         WHERE d.organization_id = $1::uuid AND d.customer_tenant_id = $2::uuid
         LIMIT 501
       ), tally AS (
         SELECT count(*)::int AS candidate_count,
                coalesce(sum(octet_length(row_to_json(c)::text)), 0)::bigint AS selected_bytes
         FROM candidates c
       )
       SELECT CASE WHEN t.selected_bytes <= $3::bigint
                   THEN (SELECT json_agg(c) FROM candidates c) END AS records
       FROM tally t`,
      workspace.organizationId, workspace.tenantId, 1_000_000,
    )
    assert.equal(guard?.records, null)
  },
)

test(
  'a migrated PostgreSQL database applies the half-open window at stored microsecond precision',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const testRun = randomUUID()
    const track = { organizationIds: [] as string[], userIds: [] as string[] }
    context.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: track.organizationIds } } })
      await prisma.user.deleteMany({ where: { id: { in: track.userIds } } })
      await prisma.$disconnect()
    })

    const workspace = await seedExportWorkspace(prisma, 'micro', testRun, track)
    const identity = { subject: workspace.subject, email: `micro-${testRun}@integration.hawkview.invalid` } as never
    const changes = new ChangesService(prisma)

    await prisma.directoryAuditLog.create({ data: exportAuditRow(workspace, 1) })
    // Prisma's Date is millisecond-valued, so the microsecond row is written
    // as a literal timestamptz -- the precision under test cannot be
    // expressed through the client.
    await prisma.$executeRawUnsafe(
      `UPDATE directory_audit_logs
          SET event_date_time = '2026-03-01T00:00:00.000500Z'::timestamptz
        WHERE customer_tenant_id = $1::uuid`,
      workspace.tenantId,
    )
    const [stored] = await prisma.$queryRawUnsafe<{ exact: string }[]>(
      `SELECT to_char(event_date_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS exact
         FROM directory_audit_logs WHERE customer_tenant_id = $1::uuid`,
      workspace.tenantId,
    )
    assert.equal(stored?.exact, '2026-03-01T00:00:00.000500',
      'the fixture must actually carry microseconds, or this case proves nothing')

    // Millisecond bounds either side of the stored microsecond instant.
    const included = await changes.exportDirectoryAudit(
      identity, workspace.tenantId, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.001Z')
    assert.equal(included.envelope.returned, 1)

    // The upper bound is exclusive at exactly the stored millisecond floor.
    const excluded = await changes.exportDirectoryAudit(
      identity, workspace.tenantId, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
      .then(() => 'resolved', (error: Error) => error.message)
    assert.match(String(excluded), /start is before its end/)

    const above = await changes.exportDirectoryAudit(
      identity, workspace.tenantId, '2026-03-01T00:00:00.001Z', undefined)
    assert.equal(above.envelope.candidates, 0)
  },
)

test(
  'a migrated PostgreSQL database lets a stored projection decide an exported row',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const prisma = new PrismaService()
    await prisma.$connect()
    const testRun = randomUUID()
    const track = { organizationIds: [] as string[], userIds: [] as string[] }
    context.after(async () => {
      await prisma.organization.deleteMany({ where: { id: { in: track.organizationIds } } })
      await prisma.user.deleteMany({ where: { id: { in: track.userIds } } })
      await prisma.$disconnect()
    })

    const workspace = await seedExportWorkspace(prisma, 'projection', testRun, track)
    const identity = { subject: workspace.subject, email: `projection-${testRun}@integration.hawkview.invalid` } as never
    const changes = new ChangesService(prisma)

    // A stored row the reviewed catalog does not admit on its own.
    const row = exportAuditRow(workspace, 1, {
      activityDisplayName: 'Export directory report',
      operationType: 'Read',
    })
    await prisma.directoryAuditLog.create({ data: row })

    const withoutProjection = await changes.exportDirectoryAudit(
      identity, workspace.tenantId, undefined, undefined)
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
        expiresAt: new Date(Date.UTC(2026, 8, 1)),
      },
    })

    const withProjection = await changes.exportDirectoryAudit(
      identity, workspace.tenantId, undefined, undefined)
    assert.equal(withProjection.envelope.returned, 1)
    assert.equal(withProjection.envelope.excludedByClassification, 0)
  },
)
