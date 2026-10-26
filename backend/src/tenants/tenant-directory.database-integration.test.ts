import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { ChangesService } from '../changes/changes.service.js'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import { TenantsService } from './tenants.service.js'
import { readTenantDirectoryAuditWindows, TENANT_DIRECTORY_AUDIT_LIMIT } from './tenant-directory-audit-reader.js'
import { TenantSyncService } from './tenant-sync.service.js'

const databaseIntegrationEnabled =
  process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

// Physical deletion is distinct from read-side invisibility. Each case owns
// fresh workspaces; no earlier prune or teardown can satisfy its assertions.
const CLEANUP_CLOCK = Date.UTC(2030, 0, 2, 12)
const cleanupDate = (offset = 0) => new Date(CLEANUP_CLOCK + offset)
type CleanupFamily = 'SIGN_INS' | 'AUDIT_LOGS'
type CleanupRow = { id: string; organizationId: string; customerTenantId: string; expiresAt: Date }
const cleanupIdentity = (row: CleanupRow) => ({
  id: row.id, organizationId: row.organizationId,
  customerTenantId: row.customerTenantId, expiresAt: row.expiresAt.toISOString(),
})
const byCleanupId = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id))

async function readCleanupRows(prisma: PrismaService, organizationIds: string[]) {
  const where = { organizationId: { in: organizationIds } }
  const [signIns, audits, projections] = await Promise.all([
    prisma.signInLog.findMany({ where }),
    prisma.directoryAuditLog.findMany({ where }),
    prisma.changeEvidenceEvent.findMany({ where }),
  ])
  return { signIns: byCleanupId(signIns), audits: byCleanupId(audits), projections: byCleanupId(projections) }
}

async function cleanupFixture(context: import('node:test').TestContext, label: string) {
  assertDisposableTestDatabase()
  const network = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external request in physical cleanup proof')
  })
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const run = randomUUID()
  const mine = await seedExportWorkspace(prisma, `cleanup-${label}`, run, track)
  const foreign = await seedExportWorkspace(prisma, `cleanup-${label}-foreign`, run, track)
  const otherTenant = await prisma.customerTenant.create({ data: {
    organizationId: mine.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const scopes = [mine, { ...mine, tenantId: otherTenant.id }, foreign]
  const specimens = scopes.flatMap(workspace => [-1, 0, 1].map(offset => ({
    workspace, offset, id: randomUUID(),
    dates: { eventDateTime: cleanupDate(-300_000), ingestedAt: cleanupDate(-200_000), expiresAt: cleanupDate(offset) },
  })))
  const signs = specimens.map(s => ({ ...bundleSignIn(s.workspace, s.id, s.offset), ...s.dates }))
  const audits = specimens.map(s => ({ ...retainedAudit(s.workspace, s.id, s.offset), ...s.dates }))
  const projections = specimens.map(s => ({
    ...retainedEvent(s.workspace, s.id, s.offset), ...s.dates,
    // Real prune is tenant-scoped, not restricted to the collector's family.
    source: s.offset === 0 ? 'DIRECTORY_SNAPSHOT' : 'DIRECTORY_AUDIT',
  }))
  await prisma.signInLog.createMany({ data: signs })
  await prisma.directoryAuditLog.createMany({ data: audits })
  await prisma.changeEvidenceEvent.createMany({ data: projections })
  const before = await readCleanupRows(prisma, track.organizationIds)
  const seeded = { signIns: signs, audits, projections }
  for (const key of ['signIns', 'audits', 'projections'] as const) {
    assert.equal(before[key].length, 9, `${key}: nonempty before/equal/after in all three scopes`)
    assert.deepEqual(before[key].map(cleanupIdentity), byCleanupId<CleanupRow>(seeded[key]).map(cleanupIdentity))
  }
  const forbidden = new Proxy({}, { get: (_target, name) => () => {
    throw new Error(`Unexpected external collaborator: ${String(name)}`)
  } })
  const service = new TenantSyncService(prisma, forbidden as never, forbidden as never, {
    resolveIncident: async () => {}, publishIncident: async () => {},
  } as never, new ChangeEvidenceService(prisma), forbidden as never) as unknown as {
    fetchGraphCollection: () => Promise<unknown[]>
    syncSignInLogs: (tenant: { id: string; organizationId: string }, token: string) => Promise<void>
    syncDirectoryAuditLogs: (tenant: { id: string; organizationId: string }, token: string) => Promise<void>
  }
  let providerResult: 'error' | 'empty' | 'invalid' = 'error'
  const provider = context.mock.method(service, 'fetchGraphCollection', async () => {
    assert.equal(Date.now(), CLEANUP_CLOCK)
    assert.equal(new Date().getTime(), CLEANUP_CLOCK, 'collector uses this same fixed Date for ingestedAt')
    if (providerResult === 'error') throw new Error('Synthetic provider read failed before cleanup')
    if (providerResult === 'invalid') return [{ id: 'synthetic-invalid', createdDateTime: 'invalid' }]
    return []
  })
  const tenant = { id: mine.tenantId, organizationId: mine.organizationId }
  const state = (family: CleanupFamily) => prisma.syncState.findUniqueOrThrow({ where: {
    customerTenantId_resourceType: { customerTenantId: mine.tenantId, resourceType: family },
  } })
  const window = () => prisma.tenantEntraSnapshot.findUnique({ where: {
    customerTenantId_resourceType: { customerTenantId: mine.tenantId, resourceType: 'SIGN_INS' },
  } })
  return {
    prisma, before, mine, network, provider, state, window,
    setProvider: (result: typeof providerResult) => { providerResult = result },
    run: (family: CleanupFamily) => family === 'SIGN_INS'
      ? service.syncSignInLogs(tenant, 'synthetic-cleanup-token')
      : service.syncDirectoryAuditLogs(tenant, 'synthetic-cleanup-token'),
    read: () => readCleanupRows(prisma, track.organizationIds),
    async assertDeleted(family: CleanupFamily) {
      const after = await readCleanupRows(prisma, track.organizationIds)
      for (const key of ['signIns', 'audits', 'projections'] as const) {
        const selectedFamily = key === 'projections' || (family === 'SIGN_INS' ? key === 'signIns' : key === 'audits')
        const deleted = (row: CleanupRow) => selectedFamily && row.customerTenantId === mine.tenantId && row.expiresAt.getTime() <= CLEANUP_CLOCK
        const expectedDeleted = before[key].filter(deleted).map(row => row.id)
        assert.equal(expectedDeleted.length, selectedFamily ? 2 : 0)
        assert.deepEqual(before[key].filter(row => !after[key].some(retained => retained.id === row.id)).map(row => row.id), expectedDeleted)
        // Compare full saved contents, including DB-owned timestamps, with the
        // preflight readback. Database defaults need not equal Node's clock.
        assert.deepEqual(after[key], before[key].filter(row => !deleted(row)), `${key}: exact positive/control/foreign survivors`)
      }
      assert.equal(network.mock.callCount(), 0)
      return after
    },
  }
}

for (const family of ['SIGN_INS', 'AUDIT_LOGS'] as const) {
  test(`physical collector cleanup: ${family} inclusive expiry, scope, failed-read preservation and idempotence`,
    { skip: !databaseIntegrationEnabled, concurrency: false }, async context => {
      const h = await cleanupFixture(context, family.toLowerCase())
      context.mock.timers.enable({ apis: ['Date'], now: CLEANUP_CLOCK })
      try {
        // This failure is injected at provider read, before either deletion.
        await assert.rejects(h.run(family))
        assert.equal(h.provider.mock.callCount(), 1)
        assert.deepEqual(await h.read(), h.before)
        const failed = await h.state(family)
        assert.equal(failed.status, 'FAILED')
        assert.equal(failed.lastSuccessfulAt, null)
        assert.equal(failed.lastAttemptAt?.getTime(), CLEANUP_CLOCK)
        assert.equal(await h.window(), null)

        // Both production collectors place cleanup outside records.length > 0.
        // Thus this empty complete result still reaches real raw + projection deletion.
        h.setProvider('empty')
        await h.run(family)
        const after = await h.assertDeleted(family)
        const succeeded = await h.state(family)
        assert.equal(succeeded.status, 'SUCCEEDED')
        assert.equal(succeeded.lastSuccessfulAt?.getTime(), CLEANUP_CLOCK)
        assert.equal(succeeded.lastAttemptAt?.getTime(), CLEANUP_CLOCK)
        assert.equal(succeeded.lastErrorCode, null)
        assert.equal(succeeded.consecutiveFailures, 0)
        if (family === 'SIGN_INS') {
          const window = await h.window()
          assert.ok(window)
          assert.equal(window.observedAt.getTime(), CLEANUP_CLOCK)
          assert.equal((window.payload as { end: string }).end, cleanupDate().toISOString())
          assert.equal((window.payload as { observedEvents: number }).observedEvents, 0)
          assert.equal((window.payload as { paginationComplete: boolean }).paginationComplete, true)
        } else assert.equal(await h.window(), null)
        await h.run(family)
        assert.deepEqual(await h.assertDeleted(family), after, 'repeated cleanup is idempotent')
        assert.equal(h.provider.mock.callCount(), 3)
      } finally {
        context.mock.timers.reset()
        context.mock.restoreAll()
      }
    })
}

test('physical collector cleanup: invalid sign-in records reject after deleting expired rows',
  { skip: !databaseIntegrationEnabled, concurrency: false }, async context => {
    const h = await cleanupFixture(context, 'partial')
    context.mock.timers.enable({ apis: ['Date'], now: CLEANUP_CLOCK })
    try {
      assert.equal(await h.window(), null)
      h.setProvider('invalid')
      // Zero validated records out of one provider row triggers the real core
      // partial check AFTER cleanup, without inserting unrelated new evidence.
      await assert.rejects(h.run('SIGN_INS'), /coverage remains incomplete/)
      await h.assertDeleted('SIGN_INS')
      const failed = await h.state('SIGN_INS')
      assert.equal(failed.status, 'FAILED')
      assert.equal(failed.lastErrorCode, 'sign-ins-record-validation-partial')
      assert.equal(failed.lastSuccessfulAt, null)
      assert.equal(failed.lastAttemptAt?.getTime(), CLEANUP_CLOCK)
      assert.equal(failed.consecutiveFailures, 1)
      assert.equal(await h.window(), null, 'a partial pass cannot certify a completed authentication window')
      assert.equal(h.provider.mock.callCount(), 1)
    } finally {
      context.mock.timers.reset()
      context.mock.restoreAll()
    }
  })

// Read-side expiry tests run only in the registered disposable CI suite. The
// dates are relative to one injected clock; expired rows remain physically
// present before AND after reads. Mismatched pairs are defensive seeded states,
// not production observations or a claim of atomic raw/projection insertion.
const READ_CLOCK = new Date('2026-10-11T12:00:00.000Z')
const readDate = (offset: number) => new Date(READ_CLOCK.getTime() + offset)
const readNow = () => READ_CLOCK
const readWindow = { from: readDate(-3_600_000).toISOString(), to: READ_CLOCK.toISOString() }

const tenantListReader = (prisma: PrismaService) => new TenantsService(prisma, {
  getRequiredPermissions: () => [],
  getAccessContract: () => ({ connectionRequiredPermissions: [], capabilities: [] }),
} as never, {} as never)
const listAuditKeys = (value: { attention: Array<{ key: string }> }) =>
  value.attention.filter(item => item.key.startsWith('audit-')).map(item => item.key)
function listAudit(workspace: ExportWorkspace, id: string, expiry: number, event = -300_000) {
  return { ...retainedAudit(workspace, id, expiry), eventDateTime: readDate(event),
    activityDisplayName: 'Update authentication method',
    targetResources: [{ type: 'authenticationMethod', displayName: id }] }
}

// These are defensive saved-expiry states. Correctly ordered event <= ingestion
// with six-month expiry cannot be expired and inside a recent24h window. This
// proves the read contract, not a production occurrence or physical deletion.
test('physical tenant list expiry: saved boundary, event window, workspace scope and stored presence', { skip: !databaseIntegrationEnabled }, async context => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const run = randomUUID()
  const mine = await seedExportWorkspace(prisma, 'list-boundary', run, track)
  const foreign = await seedExportWorkspace(prisma, 'list-foreign', run, track)
  const other = await prisma.customerTenant.create({ data: {
    organizationId: mine.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const rows = [-1, 0, 1].map(offset => listAudit(mine, `boundary-${offset}`, offset))
  rows.push(listAudit(mine, 'outside-window', 1, -86_400_001),
    listAudit(foreign, 'foreign', 1), listAudit({ ...mine, tenantId: other.id }, 'second-tenant', 1))
  await prisma.directoryAuditLog.createMany({ data: rows })
  const ids = rows.map(row => row.id)
  await assertPersistedExpiry(prisma.directoryAuditLog, ids, 6, 4)
  const service = tenantListReader(prisma)
  const result = await service.listForIdentity(identityOf(mine), { now: readNow })
  assert.deepEqual(result.tenants.map(t => t.id).sort(), [mine.tenantId, other.id].sort())
  assert.deepEqual(listAuditKeys(result.tenants.find(t => t.id === mine.tenantId)!), ['audit-auth-boundary-1'])
  assert.deepEqual(listAuditKeys(result.tenants.find(t => t.id === other.id)!), ['audit-auth-second-tenant'])
  const snapshot = await prisma.tenantHealthSnapshot.findFirstOrThrow({ where: {
    organizationId: mine.organizationId, customerTenantId: mine.tenantId,
  } })
  assert.deepEqual(listAuditKeys(snapshot.payload as any), ['audit-auth-boundary-1'])
  await prisma.user.update({ where: { authProviderUserId: mine.subject }, data: { disabledAt: READ_CLOCK } })
  await assert.rejects(service.listForIdentity(identityOf(mine), { now: readNow }), /disabled/)
  await prisma.user.update({ where: { authProviderUserId: mine.subject }, data: { disabledAt: null } })
  await prisma.membership.deleteMany({ where: { organizationId: mine.organizationId } })
  assert.deepEqual(await service.listForIdentity(identityOf(mine), { now: readNow }), { tenants: [] })
  await assertPersistedExpiry(prisma.directoryAuditLog, ids, 6, 4)
})

test('physical tenant list expiry: positive attention survives expired pre-take crowd-out', { skip: !databaseIntegrationEnabled }, async context => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const mine = await seedExportWorkspace(prisma, 'list-cap', randomUUID(), track)
  const rows = [...Array.from({ length: 501 }, (_, i) => listAudit(mine, `expired-${i}`, -1, -i)),
    listAudit(mine, 'equal', 0, -600), listAudit(mine, 'eligible-newer', 1, -700),
    listAudit(mine, 'eligible-older', 2, -800)]
  await prisma.directoryAuditLog.createMany({ data: rows })
  const ids = rows.map(row => row.id)
  await assertPersistedExpiry(prisma.directoryAuditLog, ids, 504, 2)
  const first = await prisma.directoryAuditLog.findMany({ where: {
    organizationId: mine.organizationId, customerTenantId: mine.tenantId,
    eventDateTime: { gte: readDate(-86_400_000) },
  }, orderBy: { eventDateTime: 'desc' }, take: 500 })
  assert.equal(first.length, 500)
  assert.equal(first.every(row => row.expiresAt < READ_CLOCK), true)
  assert.equal(first.every(row => row.eventDateTime > readDate(-700)), true, 'both eligible witnesses outside unfiltered first500')
  const result = await tenantListReader(prisma).listForIdentity(identityOf(mine), { now: readNow })
  assert.deepEqual(listAuditKeys(result.tenants[0]!), ['audit-auth-eligible-newer', 'audit-auth-eligible-older'])
  const snapshot = await prisma.tenantHealthSnapshot.findFirstOrThrow({ where: {
    organizationId: mine.organizationId, customerTenantId: mine.tenantId,
  } })
  assert.deepEqual(listAuditKeys(snapshot.payload as any), ['audit-auth-eligible-newer', 'audit-auth-eligible-older'])
  await assertPersistedExpiry(prisma.directoryAuditLog, ids, 504, 2)
})

test('physical tenant list expiry: concurrent clients save one snapshot per evidence state',
  { skip: !databaseIntegrationEnabled }, async context => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    const secondClient = new PrismaService()
    context.after(async () => { await secondClient.$disconnect() })
    await Promise.all([prisma.$connect(), secondClient.$connect()])
    const mine = await seedExportWorkspace(prisma, 'list-snapshot-race', randomUUID(), track)
    const scope = { organizationId: mine.organizationId, customerTenantId: mine.tenantId }
    await prisma.directoryAuditLog.create({ data: listAudit(mine, 'first', 60_000) })
    const firstClient = tenantListReader(prisma)
    const otherClient = tenantListReader(secondClient)

    await Promise.all([
      firstClient.listForIdentity(identityOf(mine), { now: readNow }),
      otherClient.listForIdentity(identityOf(mine), { now: readNow }),
    ])
    assert.equal(await prisma.tenantHealthSnapshot.count({ where: scope }), 1,
      'identical concurrent requests must not create duplicate history rows')

    await prisma.directoryAuditLog.create({ data: listAudit(mine, 'second', 60_000, -301_000) })
    await Promise.all([
      firstClient.listForIdentity(identityOf(mine), { now: () => readDate(1) }),
      otherClient.listForIdentity(identityOf(mine), { now: () => readDate(1) }),
    ])
    const snapshots = await prisma.tenantHealthSnapshot.findMany({
      where: scope, orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    })
    assert.equal(snapshots.length, 2, 'one changed evidence state adds exactly one history row')
    assert.ok(snapshots[0]!.evaluatedAt > snapshots[1]!.evaluatedAt,
      'changed evidence must have a later evaluation clock')
    assert.deepEqual(new Set(listAuditKeys(snapshots[0]!.payload as any)),
      new Set(['audit-auth-first', 'audit-auth-second']))

    await prisma.directoryAuditLog.create({ data: listAudit(mine, 'older-only', 60_000, -302_000) })
    await otherClient.listForIdentity(identityOf(mine), { now: () => readDate(-1000) })
    assert.equal(await prisma.tenantHealthSnapshot.count({ where: scope }), 2,
      'an older evaluation cannot become the latest saved history')
  })

test('physical tenant health history: a contended tenant lock preserves list and another tenant',
  { skip: !databaseIntegrationEnabled, timeout: 15_000 }, async context => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    const blocker = new PrismaService()
    context.after(async () => { await blocker.$disconnect() })
    await Promise.all([prisma.$connect(), blocker.$connect()])
    const mine = await seedExportWorkspace(prisma, 'health-lock-timeout', randomUUID(), track)
    const other = await prisma.customerTenant.create({ data: {
      organizationId: mine.organizationId, microsoftTenantId: randomUUID(),
      displayName: 'Independent health history tenant', status: 'ACTIVE',
    } })
    const mineScope = { organizationId: mine.organizationId, customerTenantId: mine.tenantId }
    const otherScope = { organizationId: mine.organizationId, customerTenantId: other.id }
    let acquired!: () => void
    const lockAcquired = new Promise<void>(resolve => { acquired = resolve })
    let release!: () => void
    const releaseLock = new Promise<void>(resolve => { release = resolve })
    const held = blocker.$transaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))',
        `hawkview:tenant-health-snapshot:${mine.organizationId}:${mine.tenantId}`,
      )
      acquired()
      await releaseLock
    }, { timeout: 12_000 })
    await Promise.race([lockAcquired, held.then(() => {
      throw new Error('Health snapshot lock holder finished before acquiring its lock')
    })])
    try {
      const otherLock = await prisma.$transaction(tx => tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
        `hawkview:tenant-health-snapshot:${mine.organizationId}:${other.id}`,
      ))
      assert.equal(otherLock[0]?.locked, true,
        'another tenant can acquire its own history lock while the first remains held')
      const list = await tenantListReader(prisma).listForIdentity(identityOf(mine), { now: readNow })
      assert.deepEqual(list.tenants.map(tenant => tenant.id).sort(), [mine.tenantId, other.id].sort(),
        'lock failure must leave the authorized tenant directory available')
      assert.equal(await prisma.tenantHealthSnapshot.count({ where: mineScope }), 0,
        'a timed-out transaction must leave no partial snapshot for its tenant')
      assert.equal(await prisma.tenantHealthSnapshot.count({ where: otherScope }), 1,
        'another tenant must save independently while this tenant is locked')
    } finally {
      release()
      await held
    }
    await tenantListReader(prisma).listForIdentity(identityOf(mine), { now: () => readDate(1) })
    assert.equal(await prisma.tenantHealthSnapshot.count({ where: mineScope }), 1,
      'the tenant recovers on its next ordinary read after the lock clears')
    assert.equal(await prisma.tenantHealthSnapshot.count({ where: otherScope }), 1,
      'an unchanged tenant does not gain a duplicate history row')
  })

test('physical verification: a blocked audit read reaches its DB deadline without undoing publication',
  { skip: !databaseIntegrationEnabled, timeout: 15_000 }, async context => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    const blocker = new PrismaService()
    context.after(async () => { await blocker.$disconnect() })
    await Promise.all([prisma.$connect(), blocker.$connect()])
    const mine = await seedExportWorkspace(prisma, 'verify-audit-timeout', randomUUID(), track)
    const before = new Date()
    await prisma.customerTenant.update({ where: { id: mine.tenantId }, data: { status: 'SUSPENDED' } })
    await prisma.tenantConnection.create({ data: {
      organizationId: mine.organizationId, customerTenantId: mine.tenantId,
      connectionMode: 'CUSTOMER_MANAGED', status: 'ERROR', clientId: randomUUID(),
      credentialReference: 'synthetic-disposable-verification-reference',
      collectionIncarnation: randomUUID(), consentedPermissions: [],
      lastErrorCode: 'before-verification',
    } })
    await prisma.directoryAuditLog.create({ data: exportAuditRow(mine, 1, {
      eventDateTime: new Date(before.getTime() - 5 * 60_000),
      expiresAt: new Date(before.getTime() + 60 * 60_000),
    }) })
    const baseline = await readTenantDirectoryAuditWindows(prisma,
      [{ id: mine.tenantId, organizationId: mine.organizationId }], before)
    assert.equal(baseline.get(mine.tenantId)?.status, 'COMPLETE')
    assert.equal(baseline.get(mine.tenantId)?.events.length, 1,
      'the blocked query would otherwise return a retained finding')

    let providerCalls = 0
    let warnings = 0
    const service = new TenantsService(prisma, {
      async verifyConnectedTenant(input: { connectionMode: string }) {
        providerCalls++
        assert.equal(input.connectionMode, 'CUSTOMER_MANAGED')
        return { displayName: 'Verified after blocked audit', primaryDomain: 'verified.example',
          grantedPermissions: [], missingRequiredPermissions: [] }
      },
      getRequiredPermissions: () => [],
      getAccessContract: () => ({ connectionRequiredPermissions: [], capabilities: [] }),
    } as never, {} as never)
    ;(service as unknown as { logger: { warn: () => void } }).logger = { warn: () => { warnings++ } }

    let acquired!: () => void
    const lockAcquired = new Promise<void>(resolve => { acquired = resolve })
    let release!: () => void
    const releaseLock = new Promise<void>(resolve => { release = resolve })
    let lockReleased = false
    const held = blocker.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE directory_audit_logs IN ACCESS EXCLUSIVE MODE')
      acquired()
      await releaseLock
      lockReleased = true
    }, { timeout: 10_000 })
    await Promise.race([lockAcquired, held.then(() => {
      throw new Error('Audit table lock holder finished before acquiring its lock')
    })])
    const started = process.hrtime.bigint()
    const verification = service.verifyConnectionForIdentity(identityOf(mine), mine.tenantId)
    try {
      let deadline!: ReturnType<typeof setTimeout>
      const responseLimit = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(
          new Error('Verification waited beyond its configured audit DB deadline')), 4000)
      })
      const verified = await Promise.race([
        verification, responseLimit,
      ]).finally(() => { clearTimeout(deadline) })
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000
      assert.equal(lockReleased, false, 'the response must finish while PostgreSQL still holds the blocking lock')
      assert.ok(elapsedMs >= 100, 'the audit SELECT must actually wait on the physical table lock')
      assert.ok(elapsedMs < 4000, 'the audit DB deadline must bound the interactive response')
      assert.equal(providerCalls, 1)
      assert.equal(warnings, 1, 'the blocked audit statement must fail and be reported internally')
      assert.equal(verified.connected, true)
      assert.equal(verified.tenant.tenantHealth.security.directoryAuditRead.status, 'NOT_READ')
      assert.notEqual(verified.tenant.tenantHealth.overallStatus, 'HEALTHY')
      const published = await prisma.tenantConnection.findUniqueOrThrow({ where: {
        customerTenantId_organizationId: { customerTenantId: mine.tenantId, organizationId: mine.organizationId },
      } })
      const tenant = await prisma.customerTenant.findUniqueOrThrow({ where: { id: mine.tenantId } })
      assert.equal(published.status, 'CONNECTED')
      assert.equal(published.lastErrorCode, null)
      assert.ok(published.lastVerifiedAt)
      assert.equal(tenant.status, 'ACTIVE')
      assert.equal(tenant.displayName, 'Verified after blocked audit')
    } finally {
      release()
      try { await held }
      finally { await verification.catch(() => {}) }
    }
  })

const bundleReader = (prisma: PrismaService) => new TenantSyncService(
  prisma, {} as never, {} as never, {} as never, {} as never, {} as never,
)
function bundleSignIn(workspace: ExportWorkspace, id: string, expiry: number, event = -300_000) {
  return {
    id: randomUUID(), organizationId: workspace.organizationId, customerTenantId: workspace.tenantId,
    microsoftSignInId: id, eventDateTime: readDate(event), ingestedAt: readDate(-200_000),
    expiresAt: readDate(expiry), raw: {}, userDisplayName: 'Stored fixture',
    userPrincipalName: 'fixture@example.invalid', ipAddress: '192.0.2.1', statusErrorCode: '0',
  }
}

test('physical tenant bundle expiry: boundary, scope, stored presence and access refusals', { skip: !databaseIntegrationEnabled }, async context => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const run = randomUUID()
  const mine = await seedExportWorkspace(prisma, 'bundle-boundary', run, track)
  const foreign = await seedExportWorkspace(prisma, 'bundle-foreign', run, track)
  const other = await prisma.customerTenant.create({ data: {
    organizationId: mine.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const signIns = [-1, 0, 1].map(offset => bundleSignIn(mine, `bundle-sign-${offset}`, offset))
  const audits = [-1, 0, 1].map(offset => retainedAudit(mine, `bundle-audit-${offset}`, offset))
  for (const workspace of [foreign, { ...mine, tenantId: other.id }]) {
    signIns.push(bundleSignIn(workspace, 'outside-sign', 1))
    audits.push(retainedAudit(workspace, 'outside-audit', 1))
  }
  await prisma.signInLog.createMany({ data: signIns })
  await prisma.directoryAuditLog.createMany({ data: audits })
  const signIds = signIns.map(r => r.id), auditIds = audits.map(r => r.id)
  await assertPersistedExpiry(prisma.signInLog, signIds, 5, 3)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 5, 3)
  const service = bundleReader(prisma)
  let clockReads = 0
  const { bundle } = await service.getBundleForIdentity(identityOf(mine), mine.tenantId, {
    now: () => readDate(clockReads++ * 2),
  })
  assert.deepEqual(bundle.signIns.map(r => r.id), ['bundle-sign-1'])
  assert.deepEqual(bundle.auditLogs.map(r => r.id), ['bundle-audit-1'])
  assert.equal(clockReads, 1, 'one shared expiry clock before both real queries')
  assert.equal(bundle.signIns[0]!.ipAddress, '192.0.2.1')
  assert.deepEqual(bundle.auditLogs[0]!.initiatedBy, audits[2]!.initiatedBy)
  await assert.rejects(service.getBundleForIdentity(identityOf(mine), foreign.tenantId, { now: readNow }), /not found/)
  await prisma.user.update({ where: { authProviderUserId: mine.subject }, data: { disabledAt: READ_CLOCK } })
  await assert.rejects(service.getBundleForIdentity(identityOf(mine), mine.tenantId, { now: readNow }), /cannot access/)
  await prisma.user.update({ where: { authProviderUserId: mine.subject }, data: { disabledAt: null } })
  await prisma.membership.deleteMany({ where: { organizationId: mine.organizationId } })
  await assert.rejects(service.getBundleForIdentity(identityOf(mine), mine.tenantId, { now: readNow }), /not found/)
  await assertPersistedExpiry(prisma.signInLog, signIds, 5, 3)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 5, 3)
})

test('physical tenant bundle expiry: both pre-take crowd-out witnesses remain stored', { skip: !databaseIntegrationEnabled }, async context => {
  assertDisposableTestDatabase()
  const { prisma, track } = physicalContext(context)
  await prisma.$connect()
  const mine = await seedExportWorkspace(prisma, 'bundle-cap', randomUUID(), track)
  // Exactly 5004 rows per model (10008 total): 5001 expired newer, one equal
  // boundary, two eligible older. Existing disposable CI only; no cleanup call.
  const specs = [...Array.from({ length: 5001 }, (_, i) => ({ id: `expired-${i}`, expiry: -1, event: -i })),
    { id: 'boundary', expiry: 0, event: -6000 },
    { id: 'eligible-newer', expiry: 1, event: -7000 },
    { id: 'eligible-older', expiry: 2, event: -8000 }]
  const signs = specs.map(s => bundleSignIn(mine, s.id, s.expiry, s.event))
  const audits = specs.map(s => ({ ...retainedAudit(mine, s.id, s.expiry), eventDateTime: readDate(s.event) }))
  for (let start = 0; start < specs.length; start += 500) {
    await prisma.signInLog.createMany({ data: signs.slice(start, start + 500) })
    await prisma.directoryAuditLog.createMany({ data: audits.slice(start, start + 500) })
  }
  const signIds = signs.map(r => r.id), auditIds = audits.map(r => r.id)
  await assertPersistedExpiry(prisma.signInLog, signIds, 5004, 2)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 5004, 2)
  const where = { organizationId: mine.organizationId, customerTenantId: mine.tenantId }
  for (const model of [prisma.signInLog, prisma.directoryAuditLog]) {
    // Pin the real ordering precondition: without eligibility neither positive
    // witness can appear in the first5000. This is not just an expected count.
    const first = await (model.findMany as any)({ where, orderBy: { eventDateTime: 'desc' }, take: 5000 })
    assert.equal(first.length, 5000)
    assert.equal(first.every((r: any) => r.expiresAt < READ_CLOCK), true)
    assert.equal(first.every((r: any) => r.eventDateTime > readDate(-7000)), true)
  }
  const { bundle } = await bundleReader(prisma).getBundleForIdentity(identityOf(mine), mine.tenantId, { now: readNow })
  assert.deepEqual(bundle.signIns.map(r => r.id), ['eligible-newer', 'eligible-older'], 'real sign-in eligibility precedes take5000')
  assert.deepEqual(bundle.auditLogs.map(r => r.id), ['eligible-newer', 'eligible-older'], 'real audit eligibility precedes take5000')
  await assertPersistedExpiry(prisma.signInLog, signIds, 5004, 2)
  await assertPersistedExpiry(prisma.directoryAuditLog, auditIds, 5004, 2)
})

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
  'a migrated PostgreSQL users delta preserves a stored disabled account when accountEnabled is omitted',
  { skip: !databaseIntegrationEnabled, concurrency: false },
  async (context) => {
    assertDisposableTestDatabase()
    context.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected external request in physical users delta proof')
    })
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const workspace = await seedExportWorkspace(prisma, 'user-delta-status', randomUUID(), track)
    const microsoftUserId = randomUUID()
    await prisma.directoryUser.create({ data: {
      organizationId: workspace.organizationId,
      customerTenantId: workspace.tenantId,
      microsoftUserId,
      displayName: 'Observed Disabled',
      userPrincipalName: 'disabled@example.test',
      accountEnabled: false,
    } })
    const service = new TenantSyncService(
      prisma, {} as never, {} as never, {} as never, {} as never, {} as never,
    )
    const checkpoint = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=synthetic'
    let page: Record<string, unknown> = { id: microsoftUserId, userPrincipalName: 'disabled@example.test' }
    ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({
      value: [page], '@odata.deltaLink': checkpoint,
    }), { headers: { 'content-type': 'application/json' } })
    const collect = () => (service as any).synchronizeUsers(
      { id: workspace.tenantId, organizationId: workspace.organizationId }, 'synthetic-token', checkpoint,
    )
    const stored = () => prisma.directoryUser.findUniqueOrThrow({
      where: { customerTenantId_microsoftUserId: { customerTenantId: workspace.tenantId, microsoftUserId } },
    })

    await collect()
    assert.equal((await stored()).accountEnabled, false,
      'a real Prisma upsert replaced the previously observed disabled state')
    page = { ...page, accountEnabled: true }
    await collect()
    assert.equal((await stored()).accountEnabled, true, 'an explicit true must still update the row')
    page = { ...page, accountEnabled: false }
    await collect()
    assert.equal((await stored()).accountEnabled, false, 'an explicit false must still update the row')

    const newMicrosoftUserId = randomUUID()
    page = { id: newMicrosoftUserId, userPrincipalName: 'new@example.test' }
    await collect()
    const newRow = await prisma.directoryUser.findUniqueOrThrow({
      where: { customerTenantId_microsoftUserId: {
        customerTenantId: workspace.tenantId, microsoftUserId: newMicrosoftUserId,
      } },
    })
    assert.equal(newRow.accountEnabled, true,
      'a new user without the field still takes the existing schema default; unknown is not yet representable')
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

test(
  'a migrated PostgreSQL database reads bounded eligible audit windows independently per tenant',
  { skip: !databaseIntegrationEnabled },
  async (context) => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const testRun = randomUUID()
    const noisy = await seedExportWorkspace(prisma, 'fair-audit-noisy', testRun, track)
    const foreign = await seedExportWorkspace(prisma, 'fair-audit-foreign', testRun, track)
    const quietTenant = await prisma.customerTenant.create({ data: {
      organizationId: noisy.organizationId, microsoftTenantId: randomUUID(),
      displayName: 'Fair audit quiet tenant', status: 'ACTIVE',
    } })
    const emptyTenant = await prisma.customerTenant.create({ data: {
      organizationId: noisy.organizationId, microsoftTenantId: randomUUID(),
      displayName: 'Fair audit empty tenant', status: 'ACTIVE',
    } })
    const quiet = { ...noisy, tenantId: quietTenant.id }
    const at = READ_CLOCK
    const base = (workspace: ExportWorkspace, index: number, overrides: Record<string, unknown> = {}) => ({
      ...exportAuditRow(workspace, index, {
        eventDateTime: readDate(-index), expiresAt: readDate(1), ...overrides,
      }),
      id: randomUUID(),
    })
    const noisyRows = Array.from({ length: TENANT_DIRECTORY_AUDIT_LIMIT }, (_, i) =>
      base(noisy, i, { eventDateTime: readDate(-100) }))
    await prisma.directoryAuditLog.createMany({ data: [
      ...noisyRows,
      base(quiet, 300, { activityDisplayName: 'Disable conditional access policy' }),
      base(quiet, 301, { eventDateTime: readDate(-1), expiresAt: at }),
      base(quiet, 302, { eventDateTime: readDate(-24 * 60 * 60 * 1000 - 1) }),
      base(foreign, 303),
    ] })
    const requested = [
      { id: noisy.tenantId, organizationId: noisy.organizationId },
      { id: quiet.tenantId, organizationId: quiet.organizationId },
      { id: emptyTenant.id, organizationId: noisy.organizationId },
      // A foreign tenant ID paired with this organization cannot join a row.
      { id: foreign.tenantId, organizationId: noisy.organizationId },
    ]
    const exact = await readTenantDirectoryAuditWindows(prisma, requested, at)
    assert.equal(exact.get(noisy.tenantId)?.status, 'COMPLETE')
    assert.equal(exact.get(noisy.tenantId)?.events.length, TENANT_DIRECTORY_AUDIT_LIMIT)
    assert.deepEqual(exact.get(noisy.tenantId)?.events.map(row => row.microsoftAuditId),
      [...noisyRows].sort((a, b) => b.id.localeCompare(a.id)).map(row => row.microsoftAuditId),
      'equal event times use the row ID as a deterministic tie-breaker')
    assert.deepEqual(exact.get(quiet.tenantId)?.events.map(row => row.microsoftAuditId),
      [`export-${quiet.tenantId}-300`], 'expiry and 24-hour eligibility precede LIMIT')
    assert.deepEqual(exact.get(emptyTenant.id), { status: 'COMPLETE', events: [] })
    assert.deepEqual(exact.get(foreign.tenantId), { status: 'COMPLETE', events: [] })

    const overflow = base(noisy, 400, { eventDateTime: readDate(-100) })
    await prisma.directoryAuditLog.create({ data: overflow })
    let sentinel: Record<string, unknown> | undefined
    const observed = { $queryRaw: async (query: unknown) => {
      const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(query as never)
      sentinel = rows.find(row => row.customerTenantId === noisy.tenantId && row.overflow === true)
      return rows
    } }
    const capped = await readTenantDirectoryAuditWindows(observed as never, requested, at)
    assert.equal(capped.get(noisy.tenantId)?.status, 'CAPPED')
    assert.equal(capped.get(noisy.tenantId)?.events.length, TENANT_DIRECTORY_AUDIT_LIMIT)
    assert.ok(sentinel, 'the seventeenth selected row is present only as a cap witness')
    assert.equal(sentinel?.detailPresent, false)
    for (const field of ['microsoftAuditId', 'activityDisplayName', 'category', 'operationType',
      'result', 'initiatedBy', 'targetResources']) assert.equal(sentinel?.[field], null)
    assert.deepEqual(capped.get(noisy.tenantId)?.events.map(row => row.microsoftAuditId),
      [...noisyRows, overflow].sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, TENANT_DIRECTORY_AUDIT_LIMIT).map(row => row.microsoftAuditId))
    assert.equal(capped.get(quiet.tenantId)?.status, 'COMPLETE')
    assert.deepEqual(capped.get(quiet.tenantId)?.events.map(row => row.microsoftAuditId),
      [`export-${quiet.tenantId}-300`])
  },
)

test('physical tenant audit read: oversized JSONB stays on the server and only its tenant fails closed',
  { skip: !databaseIntegrationEnabled }, async context => {
    assertDisposableTestDatabase()
    const { prisma, track } = physicalContext(context)
    await prisma.$connect()
    const mine = await seedExportWorkspace(prisma, 'audit-sql-byte-guard', randomUUID(), track)
    const quietRow = await prisma.customerTenant.create({ data: {
      organizationId: mine.organizationId, microsoftTenantId: randomUUID(),
      displayName: 'SQL byte guard quiet tenant', status: 'ACTIVE',
    } })
    const quiet = { ...mine, tenantId: quietRow.id }
    await prisma.directoryAuditLog.createMany({ data: [
      { ...exportAuditRow(mine, 1), eventDateTime: readDate(-100), expiresAt: readDate(60_000),
        activityDisplayName: 'Disable conditional access policy' },
      { ...exportAuditRow(mine, 2), eventDateTime: readDate(-200), expiresAt: readDate(60_000),
        initiatedBy: { user: { displayName: 'x'.repeat(256 * 1024) } } },
      { ...exportAuditRow(quiet, 3), eventDateTime: readDate(-100), expiresAt: readDate(60_000),
        activityDisplayName: 'Disable conditional access policy' },
    ] })
    let transferredBytes = 0
    let oversizedRow: Record<string, unknown> | undefined
    const observed = { $queryRaw: async (query: unknown) => {
      const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(query as never)
      transferredBytes = Buffer.byteLength(JSON.stringify(rows))
      oversizedRow = rows.find(row => row.customerTenantId === mine.tenantId && row.payloadTooLarge === true)
      return rows
    } }
    const windows = await readTenantDirectoryAuditWindows(observed as never,
      [{ id: mine.tenantId, organizationId: mine.organizationId },
        { id: quiet.tenantId, organizationId: quiet.organizationId }], READ_CLOCK)
    assert.equal(windows.get(mine.tenantId)?.status, 'NOT_READ')
    assert.equal(windows.get(mine.tenantId)?.events.length, 1,
      'a valid critical event preceding the oversized row remains available')
    assert.equal(windows.get(quiet.tenantId)?.status, 'COMPLETE')
    assert.equal(windows.get(quiet.tenantId)?.events.length, 1)
    assert.ok(oversizedRow, 'the database returns an oversized marker rather than the payload')
    for (const field of ['microsoftAuditId', 'activityDisplayName', 'category', 'operationType',
      'result', 'initiatedBy', 'targetResources']) assert.equal(oversizedRow?.[field], null)
    assert.ok(transferredBytes < 16 * 1024,
      `the oversized JSONB must not cross the database connection (${transferredBytes} bytes)`)
  })
