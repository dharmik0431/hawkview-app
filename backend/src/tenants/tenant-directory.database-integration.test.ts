import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { ChangesService } from '../changes/changes.service.js'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import { TenantsService } from './tenants.service.js'

const databaseIntegrationEnabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

// Read-side expiry tests run only in the registered disposable CI suite. The
// dates are relative to one injected clock; expired rows remain physically
// present before AND after reads. Mismatched pairs are defensive seeded states,
// not production observations or a claim of atomic raw/projection insertion.
const READ_CLOCK = new Date('2026-10-11T12:00:00.000Z')
const readDate = (offset: number) => new Date(READ_CLOCK.getTime() + offset)
const readNow = () => READ_CLOCK
const readWindow = { from: readDate(-3_600_000).toISOString(), to: READ_CLOCK.toISOString() }

function retainedAudit(workspace: ExportWorkspace, sourceId: string, offset: number) {
  return {
    ...exportAuditRow(workspace, 0),
    id: randomUUID(), microsoftAuditId: sourceId, eventDateTime: readDate(-300_000),
    ingestedAt: readDate(-200_000), expiresAt: readDate(offset), correlationId: null,
  }
}

function retainedEvent(workspace: ExportWorkspace, sourceId: string, offset: number) {
  return {
    id: randomUUID(), organizationId: workspace.organizationId, customerTenantId: workspace.tenantId,
    source: 'DIRECTORY_AUDIT', sourceEventId: sourceId, eventDateTime: readDate(-300_000),
    ingestedAt: readDate(-200_000), expiresAt: readDate(offset), operationName: 'Add member to group',
    category: 'Groups', severity: 'Medium', summary: 'Expiry fixture', result: 'success',
    actorId: 'actor-1', actorPrincipalName: 'admin@example.test', targetId: 'target-1',
    targetDisplayName: 'target@example.test', raw: {},
  }
}

async function assertPersistedExpiry(
  model: { findMany: (args: any) => Promise<Array<{ id: string; expiresAt: Date }>> },
  ids: string[], expectedTotal: number, expectedUnexpired: number,
) {
  assert.equal(ids.length, expectedTotal)
  const rows = await model.findMany({ where: { id: { in: ids } }, select: { id: true, expiresAt: true } })
  assert.deepEqual(rows.map((row) => row.id).sort(), [...ids].sort(), 'every exact seeded row still exists, including expired rows')
  assert.equal(rows.filter((row) => row.expiresAt > READ_CLOCK).length, expectedUnexpired, 'unexpired population at the fixed clock')
  assert.equal(rows.filter((row) => row.expiresAt <= READ_CLOCK).length, expectedTotal - expectedUnexpired)
}

test('physical evidence expiry: list boundaries, workspace scope and fresh writer copying', { skip: !databaseIntegrationEnabled }, async (context) => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const run = randomUUID()
  const mine = await seedExportWorkspace(prisma, 'expiry-list', run, track)
  const foreign = await seedExportWorkspace(prisma, 'expiry-foreign', run, track)
  const otherTenant = await prisma.customerTenant.create({ data: {
    organizationId: mine.organizationId, microsoftTenantId: randomUUID(), displayName: 'Unselected tenant', status: 'ACTIVE',
  } })
  const unselected = { ...mine, tenantId: otherTenant.id }
  const audits = [-1, 0, 1].map((offset) => retainedAudit(mine, `raw-${offset}`, offset))
  const events = [-1, 0, 1].map((offset) => retainedEvent(mine, `projection-${offset}`, offset))
  for (const workspace of [foreign, unselected]) {
    audits.push(retainedAudit(workspace, 'foreign', 1))
    events.push(retainedEvent(workspace, 'foreign', 1))
  }
  await prisma.directoryAuditLog.createMany({ data: audits })
  await prisma.changeEvidenceEvent.createMany({ data: events })
  // Actual writer on a fresh raw row: copies input dates, then skips duplicates.
  const raw = audits[2]!
  const projector = new ChangeEvidenceService(prisma)
  await projector.projectDirectoryAudits({ id: mine.tenantId, organizationId: mine.organizationId }, [raw])
  await projector.projectDirectoryAudits({ id: mine.tenantId, organizationId: mine.organizationId }, [{ ...raw, expiresAt: readDate(50), ingestedAt: readDate(10) }])
  const pair = await prisma.changeEvidenceEvent.findMany({ where: { customerTenantId: mine.tenantId, source: 'DIRECTORY_AUDIT', sourceEventId: raw.microsoftAuditId } })
  assert.equal(pair.length, 1)
  assert.equal(pair[0]!.expiresAt.getTime(), raw.expiresAt.getTime())
  assert.equal(pair[0]!.ingestedAt.getTime(), raw.ingestedAt.getTime())
  const auditIds = audits.map((row) => row.id)
  const eventIds = [...events.map((row) => row.id), pair[0]!.id]
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 5, 3)
  await assertPersistedExpiry(prisma.changeEvidenceEvent, eventIds, 6, 4)
  const result = await new ChangesService(prisma).list(identityOf(mine), { ...readWindow, tenantId: mine.tenantId }, { now: readNow })
  assert.deepEqual(result.changes.map((row) => row.id).sort(), ['audit:projection-1', 'audit:raw-1'])
  assert.equal(result.summary.total, 2)
  assert.equal(result.changes.every((row) => row.tenantId === mine.tenantId), true)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 5, 3)
  await assertPersistedExpiry(prisma.changeEvidenceEvent, eventIds, 6, 4)
})

test('physical evidence expiry: independent primary and raw fallback boundaries and presentation', { skip: !databaseIntegrationEnabled }, async (context) => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const run = randomUUID()
  const mine = await seedExportWorkspace(prisma, 'expiry-detail', run, track)
  const foreign = await seedExportWorkspace(prisma, 'expiry-detail-foreign', run, track)
  const audits = [retainedAudit(mine, 'fallback', 1), retainedAudit(mine, 'projected', 0), retainedAudit(mine, 'equal', 1),
    retainedAudit(mine, 'expired', 0), retainedAudit(mine, 'older', -1),
    { ...retainedAudit(mine, 'hidden-raw', 1), activityDisplayName: 'Read user', operationType: 'Read' },
    retainedAudit(foreign, 'foreign', 1)]
  const events = [{ ...retainedEvent(mine, 'fallback', 0), operationName: 'Successful sign-in', category: 'Authentication' },
    retainedEvent(mine, 'projected', 1), retainedEvent(mine, 'equal', 1), retainedEvent(mine, 'expired', 0),
    retainedEvent(mine, 'older', -1), retainedEvent(mine, 'hidden-raw', 0), retainedEvent(foreign, 'foreign', 1)]
  await prisma.directoryAuditLog.createMany({ data: audits })
  await prisma.changeEvidenceEvent.createMany({ data: events })
  const auditIds = audits.map((row) => row.id), eventIds = events.map((row) => row.id)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 7, 4)
  await assertPersistedExpiry(prisma.changeEvidenceEvent, eventIds, 7, 3)
  const service = new ChangesService(prisma)
  const fallback = await service.detail(identityOf(mine), 'audit:fallback', mine.tenantId, { now: readNow })
  assert.equal(fallback.event.id, audits[0]!.id)
  assert.deepEqual([fallback.classification, fallback.event.category, fallback.event.severity], ['administrative_action', 'Passwords', 'High'])
  const projected = await service.detail(identityOf(mine), 'audit:projected', mine.tenantId, { now: readNow })
  assert.equal(projected.event.id, events[1]!.id)
  assert.deepEqual([projected.classification, projected.event.category, projected.event.severity], ['identity_change', 'Groups', 'Medium'])
  assert.equal((await service.detail(identityOf(mine), 'audit:equal', mine.tenantId, { now: readNow })).event.id, events[2]!.id)
  for (const id of ['expired', 'older', 'foreign']) {
    await assert.rejects(service.detail(identityOf(mine), `audit:${id}`, mine.tenantId, { now: readNow }), /unavailable or outside retention/)
  }
  await assert.rejects(service.detail(identityOf(mine), 'audit:hidden-raw', mine.tenantId, { now: readNow }), /telemetry/)
  await assert.rejects(service.detail(identityOf(mine), 'audit:fallback', foreign.tenantId, { now: readNow }), /unavailable or outside retention/)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 7, 4)
  await assertPersistedExpiry(prisma.changeEvidenceEvent, eventIds, 7, 3)
})

test('physical evidence expiry: supporting candidates are filtered before take and remain stored', { skip: !databaseIntegrationEnabled }, async (context) => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const run = randomUUID()
  const mine = await seedExportWorkspace(prisma, 'expiry-support', run, track)
  const foreign = await seedExportWorkspace(prisma, 'expiry-support-foreign', run, track)
  const events = [
    { ...retainedEvent(mine, 'primary', 1), correlationId: 'expiry-correlation' },
    ...Array.from({ length: 210 }, (_, i) => ({ ...retainedEvent(mine, `expired-${i}`, i % 2 ? -1 : 0), correlationId: 'expiry-correlation', eventDateTime: readDate(-600_000) })),
    { ...retainedEvent(mine, 'related', 1), correlationId: 'expiry-correlation' },
    { ...retainedEvent(foreign, 'foreign', 1), correlationId: 'expiry-correlation' },
  ]
  const signIn = (workspace: ExportWorkspace, id: string, offset: number) => ({
    id: randomUUID(), organizationId: workspace.organizationId, customerTenantId: workspace.tenantId,
    microsoftSignInId: id, eventDateTime: readDate(-300_000), ingestedAt: readDate(-200_000), expiresAt: readDate(offset),
    raw: { correlationId: 'expiry-correlation' }, userPrincipalName: 'admin@example.test', statusErrorCode: '0',
  })
  const signIns = [-1, 0, 1].map((offset) => signIn(mine, `signin-${offset}`, offset))
  signIns.push(signIn(foreign, 'signin-foreign', 1))
  const mailboxRow = (workspace: ExportWorkspace, id: string, offset: number) => ({
    id: randomUUID(), organizationId: workspace.organizationId, customerTenantId: workspace.tenantId,
    microsoftRecordId: id, contentType: 'Audit.Exchange', operation: 'MoveToDeletedItems', workload: 'Exchange',
    actorId: 'admin@example.test', objectId: 'target@example.test', correlationId: 'expiry-correlation',
    eventDateTime: readDate(-300_000), ingestedAt: readDate(-200_000), expiresAt: readDate(offset),
    raw: { Operation: 'MoveToDeletedItems', Workload: 'Exchange' },
  })
  const mailbox = Array.from({ length: 2001 }, (_, i) => ({ ...mailboxRow(mine, `old-mail-${i}`, i % 2 ? -1 : 0), eventDateTime: readDate(-600_000) }))
  mailbox.push(mailboxRow(mine, 'mail-valid', 1), mailboxRow(foreign, 'mail-foreign', 1))
  await prisma.changeEvidenceEvent.createMany({ data: events })
  await prisma.signInLog.createMany({ data: signIns })
  await prisma.m365AuditRecord.createMany({ data: mailbox })
  const eventIds = events.map((row) => row.id), signInIds = signIns.map((row) => row.id), mailboxIds = mailbox.map((row) => row.id)
  await assertPersistedExpiry(prisma.changeEvidenceEvent, eventIds, 213, 3)
  await assertPersistedExpiry(prisma.signInLog, signInIds, 4, 2)
  await assertPersistedExpiry(prisma.m365AuditRecord, mailboxIds, 2003, 2)
  const result = await new ChangesService(prisma).detail(identityOf(mine), 'audit:primary', mine.tenantId, { now: readNow })
  assert.deepEqual(result.relatedEvents.map((row) => row.sourceEventId), ['related'])
  assert.deepEqual(result.relatedSignIns.map((row) => row.id), ['signin-1'])
  assert.match(result.relatedSignIns[0]!.relationship, /supporting evidence and does not establish causation/)
  assert.deepEqual(result.associatedChanges.map((row) => row.id), ['audit:related'])
  assert.equal(result.associatedChangesTruncated, false)
  assert.deepEqual(result.relatedMailboxActivity.map((row) => row.sampleMicrosoftRecordIds), [['mail-valid']])
  assert.equal(result.relatedMailboxActivity[0]?.count, 1)
  assert.match(result.relatedMailboxActivity[0]!.relationship, /supporting evidence and does not establish causation/)
  assert.equal(result.relatedMailboxActivityTruncated, false)
  await assertPersistedExpiry(prisma.changeEvidenceEvent, eventIds, 213, 3)
  await assertPersistedExpiry(prisma.signInLog, signInIds, 4, 2)
  await assertPersistedExpiry(prisma.m365AuditRecord, mailboxIds, 2003, 2)
})

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
