import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import { persistAuthenticationRecords } from '../identity-risk/authentication-ingestion-integrity.js'
import { persistCompletedAuthenticationWindow } from '../identity-risk/authentication-window-collector.js'
import { LIMITED_SIGN_IN_ENRICHMENT_LIMITS, TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { tryAcquireTenantVisitLease, releaseTenantVisitLease } from './tenant-visit-lease-store.js'

const registeredCi = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1' &&
  process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1' && process.env.GITHUB_ACTIONS === 'true'
const options = { skip: !registeredCi, concurrency: false, timeout: 90_000 }

async function fixture(context: TestContext) {
  assert.equal(assertDisposableTestDatabase().port, '5432')
  const writer = new PrismaService(), observer = new PrismaService()
  let organizationId: string | undefined
  context.after(async () => {
    try { if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } }) }
    finally { await Promise.all([writer.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({ data: { name: 'Owned materialization CI', slug: `visit-materialization-${randomUUID()}` } })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({ data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  const takeOver = async () => {
    assert.equal(await releaseTenantVisitLease(observer, owner), true)
    const successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
    assert.ok(successor)
    assert.notEqual(successor.generation, owner.generation)
    return successor
  }
  const service = (database: PrismaService = writer, notices = new NotificationsService(database), evidence = new ChangeEvidenceService(database)) =>
    new TenantSyncService(database, {} as never, {} as never, notices, evidence, {} as never) as any
  const record = (id: string) => ({ ...scope, microsoftSignInId: id, eventDateTime: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000), ipAddress: '192.0.2.1',
    raw: { id, createdDateTime: new Date().toISOString(), userId: 'synthetic-user', status: { errorCode: 0 } } })
  return { writer, observer, tenant, scope, owner, takeOver, service, record }
}

test('physical authentication chunks, conflict markers, windows, pruning and enrichment reject a displaced visitor', options, async context => {
  const f = await fixture(context)
  let successor: Awaited<ReturnType<typeof f.takeOver>> | undefined
  let committed = 0
  const boundary = { $transaction: async (work: any, settings: any) => {
    const result = await f.writer.$transaction(work, settings)
    if (++committed === 1) successor = await f.takeOver()
    return result
  } } as PrismaService
  const records = Array.from({ length: 501 }, (_, index) => f.record(`event-${index}`))
  await assert.rejects(persistAuthenticationRecords(boundary, f.scope, records, undefined, undefined, f.owner), TenantVisitLeaseLostError)
  assert.equal(await f.observer.signInLog.count({ where: f.scope }), 500)
  assert.equal(await f.observer.signInLog.count({ where: { ...f.scope, microsoftSignInId: 'event-500' } }), 0)
  assert.ok(successor)
  const conflict = { ...records[0]!, raw: { ...records[0]!.raw, userId: 'different-user' } }
  const rowKey = { customerTenantId_microsoftSignInId: { customerTenantId: f.tenant.id, microsoftSignInId: 'event-0' } }
  await assert.rejects(persistAuthenticationRecords(f.writer, f.scope, [conflict], undefined, undefined, f.owner), TenantVisitLeaseLostError)
  assert.deepEqual((await f.observer.signInLog.findUniqueOrThrow({ where: rowKey })).raw, records[0]!.raw)
  const start = new Date(Date.now() - 60_000), end = new Date()
  const window = (owner: typeof f.owner) => persistCompletedAuthenticationWindow(f.writer, f.scope, 'GRAPH_SIGN_INS', start, end, true,
    { events: 500, latestEventAt: end.toISOString() }, owner)
  await assert.rejects(window(f.owner), TenantVisitLeaseLostError)
  assert.equal(await f.observer.tenantEntraSnapshot.count({ where: { ...f.scope, resourceType: 'SIGN_INS' } }), 0)
  const service = f.service()
  await assert.rejects(service.pruneExpiredSignInLogs(f.tenant, new Date(Date.now() + 172_800_000), f.owner), TenantVisitLeaseLostError)
  assert.equal(await f.observer.signInLog.count({ where: f.scope }), 500)
  const historical = await f.writer.signInLog.create({ data: f.record('management:historical') })
  const inferred = new Map([['192.0.2.1', { city: 'Synthetic', countryOrRegion: 'US', geoCoordinates: { latitude: 1, longitude: 2 } }]])
  await assert.rejects(service.backfillLimitedSignInLocations(f.tenant, inferred, LIMITED_SIGN_IN_ENRICHMENT_LIMITS, Date.now() + 30_000, f.owner), TenantVisitLeaseLostError)
  assert.equal((await f.observer.signInLog.findUniqueOrThrow({ where: { id: historical.id } })).location, null)
  await persistAuthenticationRecords(f.writer, f.scope, [conflict], undefined, undefined, successor)
  assert.equal(((await f.observer.signInLog.findUniqueOrThrow({ where: rowKey })).raw as any).hawkviewAuthenticationIntegrity.state, 'CONFLICT')
  await window(successor)
  assert.equal(await f.observer.tenantEntraSnapshot.count({ where: { ...f.scope, resourceType: 'SIGN_INS' } }), 1)
  const enriched = await service.backfillLimitedSignInLocations(f.tenant, inferred, LIMITED_SIGN_IN_ENRICHMENT_LIMITS, Date.now() + 30_000, successor)
  assert.equal(enriched.updatedRows, 1)
  await service.pruneExpiredSignInLogs(f.tenant, new Date(Date.now() + 172_800_000), successor)
  assert.equal(await f.observer.signInLog.count({ where: f.scope }), 0)
})

test('physical sign-in collector cannot stamp a complete window or terminal state after takeover following raw commit', options, async context => {
  const f = await fixture(context)
  let successor: Awaited<ReturnType<typeof f.takeOver>> | undefined
  const evidence = new ChangeEvidenceService(f.writer)
  const originalPrune = evidence.pruneExpired.bind(evidence)
  evidence.pruneExpired = async (...args: Parameters<typeof originalPrune>) => {
    await originalPrune(...args)
    if (!successor) successor = await f.takeOver()
  }
  const service = f.service(f.writer, new NotificationsService(f.writer), evidence)
  const now = new Date().toISOString()
  service.fetchGraphCollection = async () => [{ id: 'provider-sign-in', createdDateTime: now, userId: 'synthetic-user', status: { errorCode: 0 } }]
  service.signInEntitlement = async () => 'PREMIUM'
  await assert.rejects(service.syncSignInLogs(f.tenant, 'synthetic', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, f.owner), TenantVisitLeaseLostError)
  assert.equal(await f.observer.signInLog.count({ where: f.scope }), 1, 'already committed bounded source evidence remains')
  const key = { customerTenantId_resourceType: { customerTenantId: f.tenant.id, resourceType: 'SIGN_INS' as const } }
  assert.equal(await f.observer.tenantEntraSnapshot.findUnique({ where: key }), null)
  assert.equal((await f.observer.syncState.findUniqueOrThrow({ where: key })).status, 'RUNNING')
  assert.ok(successor)
  await service.syncSignInLogs(f.tenant, 'synthetic', LIMITED_SIGN_IN_ENRICHMENT_LIMITS, successor)
  assert.equal((await f.observer.syncState.findUniqueOrThrow({ where: key })).status, 'SUCCEEDED')
  assert.ok(await f.observer.tenantEntraSnapshot.findUnique({ where: key }))
})

test('physical owned incident resolution and connection failure roll back their paired notices and preserve successor state', options, async context => {
  const f = await fixture(context)
  const input = { ...f.scope, eventType: 'tenant.connection_lost', category: 'error' as const,
    title: 'Synthetic connection loss', description: 'Synthetic', dedupeKey: `tenant:${f.tenant.id}:connection`, source: 'test' }
  const notices = new NotificationsService(f.writer)
  const incident = await notices.publishIncident(input, f.owner)
  assert.ok(incident)
  const recovery = { customerTenantId: f.tenant.id, eventType: 'tenant.sync_recovered', category: 'success' as const,
    title: 'Synthetic recovery', description: 'Synthetic', source: 'test' }
  let observedBoth = false
  const rollbackDb = { $transaction: (work: any) => f.writer.$transaction(async tx => {
    await work(tx)
    const recovered = await tx.notification.findFirst({ where: { ...f.scope, eventType: recovery.eventType } })
    assert.ok(recovered)
    assert.ok((await tx.notification.findUniqueOrThrow({ where: { id: incident.id } })).resolvedAt)
    observedBoth = true
    throw new Error('SYNTHETIC_AFTER_RESOLUTION_AND_RECOVERY')
  }) } as unknown as PrismaService
  assert.equal(await new NotificationsService(rollbackDb).resolveIncident(f.scope.organizationId, input.dedupeKey, recovery, f.owner), null)
  assert.equal(observedBoth, true)
  assert.equal((await f.observer.notification.findUniqueOrThrow({ where: { id: incident.id } })).resolvedAt, null)
  assert.equal(await f.observer.notification.count({ where: { ...f.scope, eventType: recovery.eventType } }), 0)
  await f.writer.tenantConnection.create({ data: { ...f.scope, status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    clientId: randomUUID(), credentialReference: 'synthetic-unused' } })
  const target = { ...f.tenant, connection: { connectionMode: 'CUSTOMER_MANAGED' } }
  const failingNotices = new NotificationsService(f.writer)
  const originalPublish = failingNotices.publishIncidentInTransaction.bind(failingNotices)
  failingNotices.publishIncidentInTransaction = async (...args: Parameters<typeof originalPublish>) => {
    await originalPublish(...args)
    throw new Error('SYNTHETIC_AFTER_CONNECTION_NOTICE')
  }
  await assert.rejects(f.service(f.writer, failingNotices).markConnectionUnavailable(target, new Error('Synthetic'), undefined, f.owner), /SYNTHETIC_AFTER_CONNECTION_NOTICE/)
  assert.equal((await f.observer.customerTenant.findUniqueOrThrow({ where: { id: f.tenant.id } })).status, 'ACTIVE')
  assert.equal((await f.observer.tenantConnection.findUniqueOrThrow({ where: { customerTenantId_organizationId: f.scope } })).status, 'CONNECTED')
  assert.equal((await f.observer.notification.findUniqueOrThrow({ where: { id: incident.id } })).occurrenceCount, 1)
  const successor = await f.takeOver()
  await assert.rejects(notices.publishIncident({ ...input, title: 'Stale' }, f.owner), TenantVisitLeaseLostError)
  await assert.rejects(notices.resolveIncident(f.scope.organizationId, input.dedupeKey, recovery, f.owner), TenantVisitLeaseLostError)
  await assert.rejects(f.service().markConnectionUnavailable(target, new Error('Stale'), undefined, f.owner), TenantVisitLeaseLostError)
  await assert.rejects(f.service().refreshCollectionFieldStates(target, f.owner), TenantVisitLeaseLostError)
  assert.equal(await f.observer.tenantCollectionFieldState.count({ where: f.scope }), 0)
  await f.service().refreshCollectionFieldStates(target, successor)
  assert.equal(await f.observer.tenantCollectionFieldState.count({ where: f.scope }), 13)
  await f.service().markConnectionUnavailable(target, new Error('Current'), undefined, successor)
  assert.equal((await f.observer.customerTenant.findUniqueOrThrow({ where: { id: f.tenant.id } })).status, 'SUSPENDED')
  assert.equal((await f.observer.notification.findUniqueOrThrow({ where: { id: incident.id } })).occurrenceCount, 2)
  assert.ok(await notices.resolveIncident(f.scope.organizationId, input.dedupeKey, recovery, successor))
  assert.equal(await f.observer.notification.count({ where: { ...f.scope, eventType: recovery.eventType } }), 1)
})

test('physical owned publication and recovery refuse foreign-tenant dedupe collisions atomically', options, async context => {
  const f = await fixture(context)
  const other = await f.writer.customerTenant.create({ data: { organizationId: f.scope.organizationId, microsoftTenantId: randomUUID() } })
  const user = await f.writer.user.create({ data: { email: `notice-reader-${randomUUID()}@example.test` } })
  context.after(async () => {
    const cleanup = new PrismaService()
    try { await cleanup.user.deleteMany({ where: { id: user.id } }) }
    finally { await cleanup.$disconnect() }
  })
  const notices = new NotificationsService(f.writer)
  const input = { ...f.scope, eventType: 'tenant.connection_lost', category: 'error' as const,
    title: 'Target notice', description: 'Synthetic', dedupeKey: `collision-${randomUUID()}`, source: 'test' }
  const foreign = await notices.publishIncident({ ...input, customerTenantId: other.id, title: 'Foreign preserved' })
  assert.ok(foreign)
  await f.writer.notificationUserState.create({ data: { notificationId: foreign.id, userId: user.id, readAt: new Date() } })
  const prior = await f.observer.notification.findUniqueOrThrow({ where: { id: foreign.id } })
  assert.equal(await notices.publishIncident(input, f.owner), null)
  assert.deepEqual(await f.observer.notification.findUniqueOrThrow({ where: { id: foreign.id } }), prior)
  assert.equal(await f.observer.notificationUserState.count({ where: { notificationId: foreign.id } }), 1)
  const originalKey = `original-${randomUUID()}`
  const original = await notices.publishIncident({ ...input, dedupeKey: originalKey }, f.owner)
  assert.ok(original)
  const recovery = { customerTenantId: f.tenant.id, eventType: 'tenant.sync_recovered', category: 'success' as const,
    title: 'Recovery', description: 'Synthetic', source: 'test' }
  const foreignRecovery = await notices.publishIncident({ ...recovery, organizationId: f.scope.organizationId,
    customerTenantId: other.id, dedupeKey: `${originalKey}:recovered:${original.occurrenceCount}`, title: 'Foreign recovery preserved' })
  assert.ok(foreignRecovery)
  const recoveryBefore = await f.observer.notification.findUniqueOrThrow({ where: { id: foreignRecovery.id } })
  assert.equal(await notices.resolveIncident(f.scope.organizationId, originalKey, recovery, f.owner), null)
  assert.equal((await f.observer.notification.findUniqueOrThrow({ where: { id: original.id } })).resolvedAt, null)
  assert.deepEqual(await f.observer.notification.findUniqueOrThrow({ where: { id: foreignRecovery.id } }), recoveryBefore)
})
