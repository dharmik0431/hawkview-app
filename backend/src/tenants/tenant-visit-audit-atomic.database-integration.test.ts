import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import test, { type TestContext } from 'node:test'
import pg from 'pg'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import type { Prisma } from '../generated/prisma/client.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { PrismaService } from '../prisma/prisma.service.js'
import {
  advanceAuditReconciliationCompletion,
  selectPendingAuditReconciliationWork,
} from './tenant-audit-reconciliation-work.js'
import {
  AuditReconciliationIncompleteError,
  MicrosoftGraphCollectionError,
  NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE,
  claimTenantUsersLease,
  TenantSyncService,
} from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
import { assertTenantVisitLeaseOwner, releaseTenantVisitLease, renewTenantVisitLease, tryAcquireTenantVisitLease } from './tenant-visit-lease-store.js'
import { M365AuditBudgetError, M365ManagementActivityService } from './m365-management-activity.service.js'
import { createTenantVisitLifecycleStore } from './tenant-visit-lifecycle-store.js'
import { assertTenantVisitLifecycleActive, runTenantVisitLifecycle } from './tenant-visit-lifecycle.js'
import { AUDIT_RECONCILIATION_RESOURCES, type AuditReconciliationResource } from './audit-change-reconciliation.js'
import {
  DAILY_INVENTORY_ANCHORS,
  TWENTY_MINUTE_INVENTORY_REFRESH_MS,
  dailyInventoryResources,
  scheduledSyncTenantWhere,
  shouldCollectInventoryInTwentyMinuteFullPass,
} from './scheduled-sync-selection.js'
import { mailboxSourceDigest, sourceAttestationKey } from '../identity-risk/mailbox-source-attestation.js'
import { IdentityRiskSafetyService } from '../identity-risk/identity-risk-safety.service.js'

const registeredCi = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1' &&
  process.env.HAWKVIEW_CI_DISPOSABLE_POSTGRES === '1' && process.env.GITHUB_ACTIONS === 'true'

for (const route of ['report', 'fallback'] as const) {
  test(`physical ${route} registration collector commits its snapshot and exact audit receipt together`, {
    skip: !registeredCi, concurrency: false, timeout: 90_000,
  }, async context => {
    // This witness is registered-hosted-CI only, even if a local disposable URL
    // is accepted by the shared helper for other suites. Validate before clients.
    const databaseUrl = assertDisposableTestDatabase()
    assert.equal(databaseUrl.port, '5432', 'Registration receipt requires the registered CI service')
    const writer = new PrismaService()
    const observer = new PrismaService()
    let organizationId: string | null = null
    context.after(async () => {
      try {
        if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } })
      } finally {
        await Promise.all([writer.$disconnect(), observer.$disconnect()])
      }
    })
    await Promise.all([writer.$connect(), observer.$connect()])
    const organization = await writer.organization.create({
      data: { name: 'Registration receipt CI', slug: `registration-receipt-${randomUUID()}` },
    })
    organizationId = organization.id
    const tenant = await writer.customerTenant.create({
      data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
    })
    const scope = { organizationId, customerTenantId: tenant.id }
    const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
    assert.ok(owner)
    const resourceType = 'AUTH_REGISTRATIONS' as const
    const workKey = { organizationId_customerTenantId_resourceType: { ...scope, resourceType } }
    const snapshotKey = { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType } }
    await writer.tenantAuditReconciliationWork.create({
      data: { ...scope, resourceType, requestedRevision: 2n, completedRevision: 0n },
    })
    const users = [1, 2].map(index => ({ id: `receipt-user-${index}`, userPrincipalName: `user${index}@example.test` }))
    const expectedRows = (registered: boolean) => users.map(user => ({
      ...user, isMfaRegistered: registered,
      ...(route === 'fallback' ? { isMfaCapable: registered,
        methodsRegistered: registered ? ['Microsoft Authenticator'] : [],
        collectionSource: 'per-user-authentication-methods' } : {}),
    }))
    const readState = async () => ({
      snapshot: await observer.tenantEntraSnapshot.findUnique({
        where: snapshotKey, select: { payload: true, observedAt: true },
      }),
      work: await observer.tenantAuditReconciliationWork.findUnique({
        where: workKey, select: { requestedRevision: true, completedRevision: true, lastCompletedAt: true },
      }),
      evidenceCount: await observer.changeEvidenceEvent.count({ where: scope }),
    })
    const readStatus = () => observer.syncState.findUniqueOrThrow({
      where: snapshotKey, select: { status: true, lastSuccessfulAt: true },
    })

    // Keep the real collector, pagination, fallback classification, owner checks,
    // status writes, snapshot and receipt SQL. Only provider/notification transport
    // and optional enrichment are synthetic. Hook the actual snapshot transaction,
    // not the separate RUNNING/SUCCEEDED transactions around it.
    const collector = (registered: boolean, options: {
      partial?: boolean; invalidValue?: boolean; beforeSnapshot?: () => Promise<void>
      afterWrites?: (transaction: Prisma.TransactionClient) => Promise<void>
    } = {}) => {
      let insideSnapshot = false
      let pages = 0
      let batches = 0
      const service = new TenantSyncService({
        $transaction: (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
          writer.$transaction(async transaction => {
            const result = await work(transaction)
            if (insideSnapshot) await options.afterWrites?.(transaction)
            return result
          }, { timeout: 20_000 }),
      } as never, {} as never, {} as never,
      { resolveIncident: async () => {}, publishIncident: async () => {} } as never,
      new ChangeEvidenceService(writer), {} as never) as any
      const saveSnapshot = service.saveSnapshot.bind(service)
      service.saveSnapshot = async (...args: unknown[]) => {
        await options.beforeSnapshot?.()
        insideSnapshot = true
        try { return await saveSnapshot(...args) } finally { insideSnapshot = false }
      }
      service.enrichAuthenticationRegistrationsWithPerUserMfaState = async (_token: string, rows: unknown[]) => rows
      service.enrichAuthenticationRegistrationsWithConditionalAccessContext = async (_token: string, rows: unknown[]) => rows
      service.fetchGraphPage = async (url: string, _token: string, _label: string, request?: { init?: RequestInit }) => {
        if (url.includes('/reports/authenticationMethods/userRegistrationDetails') && route === 'fallback') {
          throw new MicrosoftGraphCollectionError('Synthetic non-premium reporting', 403,
            NON_PREMIUM_AUTH_REGISTRATION_ERROR_CODE)
        }
        if (url === 'https://graph.microsoft.com/v1.0/$batch') {
          assert.equal(route, 'fallback')
          assert.equal(++batches, 1)
          const requests = JSON.parse(String(request?.init?.body)).requests as Array<{ id: string; url: string }>
          assert.deepEqual(requests.map(item => item.url), users.map(user => `/users/${user.id}/authentication/methods`))
          return new Response(JSON.stringify({ responses: requests.map((item, index) => ({
            id: item.id, status: 200, body: { value: options.invalidValue && index === 1
              ? [{ '@odata.type': '#microsoft.graph.syntheticUnknownAuthenticationMethod' }]
              : registered ? [{ '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' }] : [] },
          })) }), { status: 200 })
        }
        const endpoint = route === 'report'
          ? 'https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails'
          : 'https://graph.microsoft.com/v1.0/users'
        assert.ok(url.startsWith(endpoint))
        assert.ok(++pages <= 2)
        const row = route === 'report'
          ? { ...users[pages - 1], isMfaRegistered: options.invalidValue && pages === 2 ? null : registered }
          : users[pages - 1]
        return new Response(JSON.stringify({ value: [row],
          ...(pages === 1 ? { '@odata.nextLink': `${endpoint}?$skiptoken=second` } : {}),
        }), { status: options.partial && pages === 2 ? 206 : 200 })
      }
      return {
        run: (visitOwner = owner, revision: bigint | undefined = 2n) =>
          service.syncAuthenticationRegistrations(tenant, 'synthetic-token', visitOwner, revision) as Promise<void>,
        assertPages: () => {
          assert.equal(pages, 2)
          assert.equal(batches, route === 'fallback' && !options.partial ? 1 : 0)
        },
      }
    }
    const initial = await readState()
    assert.equal(initial.snapshot, null)
    assert.equal(initial.work?.completedRevision, 0n)
    // AUTH_REGISTRATIONS has no snapshot-difference catalog entry. Do not
    // manufacture synthetic evidence and call it the production evidence path.
    assert.equal(initial.evidenceCount, 0)
    let releaseWrites!: () => void
    let reachedWrites!: () => void
    const mayCommit = new Promise<void>(resolve => { releaseWrites = resolve })
    const writesReached = new Promise<void>(resolve => { reachedWrites = resolve })
    const held = collector(true, { afterWrites: async transaction => {
      const snapshot = await transaction.tenantEntraSnapshot.findUniqueOrThrow({ where: snapshotKey })
      const work = await transaction.tenantAuditReconciliationWork.findUniqueOrThrow({ where: workKey })
      assert.deepEqual(snapshot.payload, expectedRows(true))
      assert.equal(work.completedRevision, 2n)
      assert.equal(work.lastCompletedAt?.getTime(), snapshot.observedAt.getTime())
      reachedWrites()
      await mayCommit
    } })
    const pending = held.run()
    try {
      await Promise.race([writesReached, pending.then(() => { throw new Error('Collector returned before held snapshot commit') })])
      held.assertPages()
      assert.deepEqual(await readState(), initial, 'Another client cannot observe either uncommitted write')
      assert.equal((await readStatus()).status, 'RUNNING')
      await assert.rejects(observer.$transaction(transaction => transaction.$queryRawUnsafe(
        `SELECT generation FROM tenant_sync_visit_leases
          WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid FOR UPDATE NOWAIT`,
        organizationId, tenant.id,
      )), (error: unknown) => /55P03|could not obtain lock/i.test(String(error)))
    } finally {
      releaseWrites()
      await pending
    }
    const committed = await readState()
    assert.deepEqual(committed.snapshot?.payload, expectedRows(true))
    assert.equal(committed.work?.completedRevision, 2n)
    assert.equal(committed.work?.lastCompletedAt?.getTime(), committed.snapshot?.observedAt.getTime())
    assert.equal((await readStatus()).status, 'SUCCEEDED')

    await observer.tenantAuditReconciliationWork.update({ where: workKey, data: { requestedRevision: 3n } })
    const stale = collector(false)
    await stale.run(owner, 2n)
    stale.assertPages()
    const newerPending = await readState()
    assert.deepEqual(newerPending.snapshot?.payload, expectedRows(false))
    assert.equal(newerPending.work?.requestedRevision, 3n)
    assert.equal(newerPending.work?.completedRevision, 2n)
    assert.deepEqual(newerPending.work?.lastCompletedAt, committed.work?.lastCompletedAt)
    const previousSuccess = (await readStatus()).lastSuccessfulAt

    let rollbackReached = false
    const failing = collector(true, { afterWrites: async transaction => {
      assert.equal((await transaction.tenantAuditReconciliationWork.findUniqueOrThrow({ where: workKey })).completedRevision, 3n)
      assert.deepEqual((await transaction.tenantEntraSnapshot.findUniqueOrThrow({ where: snapshotKey })).payload, expectedRows(true))
      rollbackReached = true
      throw new Error('SYNTHETIC_AFTER_REGISTRATION_SNAPSHOT_AND_RECEIPT')
    } })
    await assert.rejects(failing.run(owner, 3n))
    assert.equal(rollbackReached, true, 'The test must fail after both physical writes, not before them')
    failing.assertPages()
    assert.deepEqual(await readState(), newerPending, 'Snapshot and receipt must roll back together')
    assert.deepEqual(await readStatus(), { status: 'FAILED', lastSuccessfulAt: previousSuccess })
    for (const options of [{ partial: true }, { invalidValue: true }]) {
      const incomplete = collector(true, options)
      await assert.rejects(incomplete.run(owner, 3n))
      incomplete.assertPages()
      assert.deepEqual(await readState(), newerPending)
      assert.deepEqual(await readStatus(), { status: 'FAILED', lastSuccessfulAt: previousSuccess })
    }

    let successor: typeof owner | null = null
    const displaced = collector(true, { beforeSnapshot: async () => {
      assert.equal(await releaseTenantVisitLease(observer, owner), true)
      successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
      assert.ok(successor)
      assert.notEqual(successor.generation, owner.generation)
    } })
    await assert.rejects(displaced.run(owner, 3n), TenantVisitLeaseLostError)
    displaced.assertPages()
    assert.deepEqual(await readState(), newerPending)
    assert.deepEqual(await readStatus(), { status: 'RUNNING', lastSuccessfulAt: previousSuccess },
      'A displaced owner cannot publish a terminal status after its completed provider read')
    assert.ok(successor)
    const recovered = collector(true)
    await recovered.run(successor, 3n)
    recovered.assertPages()
    const completed = await readState()
    assert.deepEqual(completed.snapshot?.payload, expectedRows(true))
    assert.equal(completed.work?.completedRevision, 3n)
    assert.equal(completed.work?.lastCompletedAt?.getTime(), completed.snapshot?.observedAt.getTime())
    assert.equal((await readStatus()).status, 'SUCCEEDED')
    assert.equal(completed.evidenceCount, 0, 'No registration snapshot-difference evidence is currently emitted')
  })
}

test('physical snapshot audit receipt is atomic and leaves stale requests or owners pending', {
  skip: !registeredCi,
  concurrency: false,
  timeout: 90_000,
}, async context => {
  assertDisposableTestDatabase()
  const writer = new PrismaService()
  const observer = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    try {
      if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } })
    } finally {
      await Promise.all([writer.$disconnect(), observer.$disconnect()])
    }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({
    data: { name: 'Audit snapshot receipt CI', slug: `audit-snapshot-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  const workKey = { organizationId_customerTenantId_resourceType: {
    ...scope, resourceType: 'DOMAINS' as const,
  } }
  const snapshotKey = { customerTenantId_resourceType: {
    customerTenantId: tenant.id, resourceType: 'DOMAINS' as const,
  } }
  await writer.tenantAuditReconciliationWork.create({
    data: { ...scope, resourceType: 'DOMAINS', requestedRevision: 2n, completedRevision: 0n },
  })
  const collection = (name: string) => ({
    completeness: 'authoritative_complete',
    rows: [{ id: `${name}.example.test`, name: `${name}.example.test`, isDefault: true }],
  })
  // Only the transaction boundary is instrumented. The production owner check,
  // snapshot/evidence writes and exact-revision UPDATE all use real PostgreSQL.
  const service = (afterWrites?: (transaction: Prisma.TransactionClient) => Promise<void>) =>
    new TenantSyncService({
      $transaction: (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
        writer.$transaction(async transaction => {
          const value = await work(transaction)
          if (afterWrites) await afterWrites(transaction)
          return value
        }, { timeout: 20_000 }),
    } as never, {} as never, {} as never,
    { resolveIncident: async () => {}, publishIncident: async () => {} } as never,
    new ChangeEvidenceService(writer), {} as never) as any
  const readState = async () => ({
    snapshot: await observer.tenantEntraSnapshot.findUnique({
      where: snapshotKey, select: { payload: true, observedAt: true },
    }),
    work: await observer.tenantAuditReconciliationWork.findUniqueOrThrow({
      where: workKey,
      select: { requestedRevision: true, completedRevision: true, lastCompletedAt: true },
    }),
    evidenceCount: await observer.changeEvidenceEvent.count({ where: scope }),
  })
  const initial = await readState()
  assert.equal(initial.snapshot, null)
  assert.equal(initial.work.completedRevision, 0n)
  assert.equal(initial.work.lastCompletedAt, null)

  let reachedWrites!: () => void
  let releaseWrites!: () => void
  const writesReached = new Promise<void>(resolve => { reachedWrites = resolve })
  const mayCommit = new Promise<void>(resolve => { releaseWrites = resolve })
  const heldService = service(async transaction => {
    const snapshot = await transaction.tenantEntraSnapshot.findUniqueOrThrow({ where: snapshotKey })
    const work = await transaction.tenantAuditReconciliationWork.findUniqueOrThrow({ where: workKey })
    assert.deepEqual(snapshot.payload, collection('committed').rows)
    assert.equal(work.completedRevision, 2n)
    assert.equal(work.lastCompletedAt?.getTime(), snapshot.observedAt.getTime(),
      'the receipt must refer to this complete snapshot observation')
    reachedWrites()
    await mayCommit
  })
  const pending = heldService.saveSnapshot(tenant, 'DOMAINS', collection('committed'),
    undefined, false, undefined, undefined, owner, 2n) as Promise<void>
  try {
    await Promise.race([
      writesReached,
      pending.then(() => { throw new Error('snapshot returned before the held commit boundary') }),
    ])
    assert.deepEqual(await readState(), initial,
      'the other client must see neither the snapshot nor its receipt before commit')
    await assert.rejects(
      observer.$transaction(transaction => transaction.$queryRawUnsafe(
        `SELECT generation FROM tenant_sync_visit_leases
          WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid FOR UPDATE NOWAIT`,
        organizationId, tenant.id,
      )),
      (error: unknown) => /55P03|could not obtain lock/i.test(String(error)),
      'the receipt transaction must retain its owner lock until commit',
    )
  } finally {
    releaseWrites()
    await pending
  }
  const committed = await readState()
  assert.deepEqual(committed.snapshot?.payload, collection('committed').rows)
  assert.equal(committed.work.completedRevision, 2n)
  assert.equal(committed.work.lastCompletedAt?.getTime(), committed.snapshot?.observedAt.getTime())

  await observer.tenantAuditReconciliationWork.update({
    where: workKey, data: { requestedRevision: 3n },
  })
  await service().saveSnapshot(tenant, 'DOMAINS', collection('stale-request'),
    undefined, false, undefined, undefined, owner, 2n)
  const newerPending = await readState()
  assert.deepEqual(newerPending.snapshot?.payload, collection('stale-request').rows)
  assert.equal(newerPending.work.requestedRevision, 3n)
  assert.equal(newerPending.work.completedRevision, 2n,
    'a complete result for revision two cannot clear revision three')
  assert.deepEqual(newerPending.work.lastCompletedAt, committed.work.lastCompletedAt)

  const rollback = new Error('ROLLBACK_AFTER_SNAPSHOT_AND_RECEIPT')
  await assert.rejects(service(async transaction => {
    assert.equal((await transaction.tenantAuditReconciliationWork.findUniqueOrThrow({
      where: workKey,
    })).completedRevision, 3n)
    assert.deepEqual((await transaction.tenantEntraSnapshot.findUniqueOrThrow({
      where: snapshotKey,
    })).payload, collection('rollback').rows)
    assert.ok(await transaction.changeEvidenceEvent.count({ where: scope }) > newerPending.evidenceCount,
      'the rollback fixture must actually write new snapshot difference evidence')
    throw rollback
  }).saveSnapshot(tenant, 'DOMAINS', collection('rollback'),
    undefined, false, undefined, undefined, owner, 3n), error => error === rollback)
  assert.deepEqual(await readState(), newerPending,
    'failure after both writes must restore snapshot, evidence and pending receipt together')

  await assert.rejects(service().saveSnapshot(tenant, 'DOMAINS', {
    ...collection('partial'), completeness: 'partial_or_unknown',
  }, undefined, false, undefined, undefined, owner, 3n), /Refusing to advance/)
  assert.deepEqual(await readState(), newerPending,
    'a partial collection cannot complete a pending audit request')

  assert.equal(await releaseTenantVisitLease(observer, owner), true)
  const successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
  assert.ok(successor)
  assert.notEqual(successor.generation, owner.generation)
  await assert.rejects(service().saveSnapshot(tenant, 'DOMAINS', collection('old-owner'),
    undefined, false, undefined, undefined, owner, 3n), TenantVisitLeaseLostError)
  assert.deepEqual(await readState(), newerPending,
    'a former owner cannot change the snapshot or acknowledge pending work')
  await service().saveSnapshot(tenant, 'DOMAINS', collection('successor'),
    undefined, false, undefined, undefined, successor, 3n)
  const completed = await readState()
  assert.deepEqual(completed.snapshot?.payload, collection('successor').rows)
  assert.equal(completed.work.requestedRevision, 3n)
  assert.equal(completed.work.completedRevision, 3n)
  assert.equal(completed.work.lastCompletedAt?.getTime(), completed.snapshot?.observedAt.getTime())

  await service().saveSnapshot(tenant, 'AUTH_METHOD_POLICIES', {
    completeness: 'authoritative_complete', rows: [],
  }, undefined, false, undefined, undefined, successor, 1n)
  assert.equal(await observer.tenantAuditReconciliationWork.count({
    where: { ...scope, resourceType: 'AUTH_METHOD_POLICIES' },
  }), 0, 'a snapshot receipt cannot manufacture an absent request')

  // Exercise the real DOMAINS collector's revision forwarding and inventory
  // callback as well as the low-level snapshot boundary above. Provider and
  // notification transport are synthetic; status, projection and receipt use SQL.
  await observer.tenantAuditReconciliationWork.update({
    where: workKey, data: { requestedRevision: 4n },
  })
  const collector = service()
  let responseStatus = 200
  collector.fetchGraphPage = async () => new Response(JSON.stringify({ value: [{
    id: tenant.microsoftTenantId, displayName: 'Domain receipt CI',
    verifiedDomains: [{ name: 'receipt.example.test', isDefault: true, isInitial: false }],
  }] }), { status: responseStatus })
  await collector.syncDomains(tenant, 'synthetic-token', successor, 4n)
  const collected = await readState()
  assert.equal(collected.work.completedRevision, 4n)
  assert.equal(collected.work.lastCompletedAt?.getTime(), collected.snapshot?.observedAt.getTime())
  assert.deepEqual(await observer.tenantDomain.findMany({ where: scope, select: { name: true } }),
    [{ name: 'receipt.example.test' }])
  assert.equal((await observer.customerTenant.findUniqueOrThrow({
    where: { id: tenant.id }, select: { primaryDomain: true },
  })).primaryDomain, 'receipt.example.test')

  await observer.tenantAuditReconciliationWork.update({
    where: workKey, data: { requestedRevision: 5n },
  })
  const partialPending = await readState()
  responseStatus = 206
  await assert.rejects(() => collector.syncDomains(tenant, 'synthetic-token', successor, 5n))
  assert.deepEqual(await readState(), partialPending,
    'a partial provider response cannot acknowledge the next domain request')
})

test('physical pending audit selection is tenant-scoped, revision-aware and owner-checked', {
  skip: !registeredCi,
  concurrency: false,
  timeout: 60_000,
}, async context => {
  assertDisposableTestDatabase()
  const database = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    if (organizationId) await database.organization.deleteMany({ where: { id: organizationId } })
    await database.$disconnect()
  })
  await database.$connect()
  const organization = await database.organization.create({
    data: { name: 'Audit pending selection CI', slug: `audit-pending-${randomUUID()}` },
  })
  organizationId = organization.id
  const [tenant, neighbor] = await Promise.all([
    database.customerTenant.create({
      data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
    }),
    database.customerTenant.create({
      data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
    }),
  ])
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(database, scope, 300_000)
  assert.ok(owner)
  await database.tenantAuditReconciliationWork.createMany({ data: [
    { ...scope, resourceType: 'AUTH_METHOD_POLICIES', requestedRevision: 3n, completedRevision: 3n },
    { ...scope, resourceType: 'AUTH_REGISTRATIONS', requestedRevision: 2n, completedRevision: 1n },
    { ...scope, resourceType: 'GROUPS', requestedRevision: 1n, completedRevision: 0n },
    { organizationId, customerTenantId: neighbor.id, resourceType: 'APPLICATIONS',
      requestedRevision: 1n, completedRevision: 0n },
  ] })

  assert.deepEqual(await selectPendingAuditReconciliationWork(database, scope, owner, 1), [
    { resourceType: 'GROUPS', requestedRevision: 1n },
  ])
  assert.deepEqual(await selectPendingAuditReconciliationWork(database, scope, owner, 2), [
    { resourceType: 'GROUPS', requestedRevision: 1n },
    { resourceType: 'AUTH_REGISTRATIONS', requestedRevision: 2n },
  ])

  assert.equal(await advanceAuditReconciliationCompletion(
    database, scope, owner, 'AUTH_REGISTRATIONS', 1n), false,
    'a stale refresh cannot clear a newer request')
  assert.equal(await advanceAuditReconciliationCompletion(
    database, scope, owner, 'AUTH_REGISTRATIONS', 2n), true)
  assert.equal(await advanceAuditReconciliationCompletion(
    database, scope, owner, 'AUTH_REGISTRATIONS', 2n), false,
    'an already completed revision is not acknowledged again')
  assert.deepEqual(await selectPendingAuditReconciliationWork(database, scope, owner, 2), [
    { resourceType: 'GROUPS', requestedRevision: 1n },
  ])
  assert.equal(await releaseTenantVisitLease(database, owner), true)
  await assert.rejects(
    advanceAuditReconciliationCompletion(database, scope, owner, 'GROUPS', 1n),
    TenantVisitLeaseLostError,
  )
  await assert.rejects(
    selectPendingAuditReconciliationWork(database, scope, owner, 2),
    TenantVisitLeaseLostError,
  )
})

test('physical audit replay ledger revisions cannot move backward', {
  skip: !registeredCi,
  concurrency: false,
  timeout: 30_000,
}, async () => {
  const client = new pg.Client({ connectionString: assertDisposableTestDatabase().toString() })
  const [organizationId, customerTenantId, microsoftTenantId] =
    Array.from({ length: 3 }, () => randomUUID())
  const monotonicViolation = (error: unknown): boolean =>
    typeof error === 'object' && error !== null &&
    'code' in error && error.code === '23514' &&
    'constraint' in error && error.constraint === 'tenant_audit_reconciliation_revision_monotonic'
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO organizations (id, name, slug, updated_at)
       VALUES ($1, 'Audit ledger revision CI', $2, now())`,
      [organizationId, `audit-ledger-${organizationId}`])
    await client.query(
      `INSERT INTO customer_tenants (id, organization_id, microsoft_tenant_id, updated_at)
       VALUES ($1, $2, $3, now())`,
      [customerTenantId, organizationId, microsoftTenantId])
    await client.query(
      `INSERT INTO tenant_audit_reconciliation_work
         (organization_id, customer_tenant_id, resource_type,
          requested_revision, completed_revision)
       VALUES ($1, $2, 'GROUPS', 3, 1)`, [organizationId, customerTenantId])

    await client.query('SAVEPOINT requested_cannot_regress')
    await assert.rejects(
      client.query(
        `UPDATE tenant_audit_reconciliation_work SET requested_revision = 2
          WHERE organization_id = $1 AND customer_tenant_id = $2 AND resource_type = 'GROUPS'`,
        [organizationId, customerTenantId]),
      monotonicViolation)
    await client.query('ROLLBACK TO SAVEPOINT requested_cannot_regress')

    await client.query('SAVEPOINT completed_cannot_regress')
    await assert.rejects(
      client.query(
        `UPDATE tenant_audit_reconciliation_work SET completed_revision = 0
          WHERE organization_id = $1 AND customer_tenant_id = $2 AND resource_type = 'GROUPS'`,
        [organizationId, customerTenantId]),
      monotonicViolation)
    await client.query('ROLLBACK TO SAVEPOINT completed_cannot_regress')

    await client.query(
      `UPDATE tenant_audit_reconciliation_work
          SET requested_revision = 4, completed_revision = 3
        WHERE organization_id = $1 AND customer_tenant_id = $2 AND resource_type = 'GROUPS'`,
      [organizationId, customerTenantId])
    const advanced = await client.query<{
      requested_revision: string; completed_revision: string
    }>(`SELECT requested_revision::text, completed_revision::text
          FROM tenant_audit_reconciliation_work
         WHERE organization_id = $1 AND customer_tenant_id = $2 AND resource_type = 'GROUPS'`,
      [organizationId, customerTenantId])
    assert.deepEqual(advanced.rows, [{ requested_revision: '4', completed_revision: '3' }])
  } finally {
    try { await client.query('ROLLBACK') } finally { await client.end() }
  }
})

test('physical owner-bound audit insertion enqueues selected work once and rolls it back with raw evidence', {
  skip: !registeredCi,
  concurrency: false,
  timeout: 60_000,
}, async context => {
  assertDisposableTestDatabase()
  const database = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    if (organizationId) await database.organization.deleteMany({ where: { id: organizationId } })
    await database.$disconnect()
  })
  await database.$connect()
  const organization = await database.organization.create({
    data: { name: 'Audit work enqueue CI', slug: `audit-work-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await database.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(database, scope, 300_000)
  assert.ok(owner)
  const auditRecord = (microsoftAuditId: string) => ({
    organizationId, customerTenantId: tenant.id, microsoftAuditId,
    eventDateTime: new Date('2026-11-12T00:00:00.000Z'),
    activityDisplayName: 'Update authentication method',
    category: 'UserManagement', operationType: 'Update', result: 'success',
    resultReason: null, correlationId: null, loggedByService: 'Core Directory',
    initiatedBy: {}, targetResources: [], additionalDetails: [],
    raw: { id: microsoftAuditId },
    ingestedAt: new Date('2026-11-12T00:01:00.000Z'),
    expiresAt: new Date('2027-05-12T00:00:00.000Z'),
  })
  const service = (evidence: object = new ChangeEvidenceService(database)) =>
    new TenantSyncService(database, {} as never, {} as never,
      new NotificationsService(database), evidence as never, {} as never) as any
  const work = async () => (await database.tenantAuditReconciliationWork.findMany({
    where: scope, orderBy: { resourceType: 'asc' },
    select: { resourceType: true, requestedRevision: true, completedRevision: true },
  })).map(row => ({ ...row, requestedRevision: row.requestedRevision.toString(),
    completedRevision: row.completedRevision.toString() }))
  const expected = [
    { resourceType: 'AUTH_REGISTRATIONS', requestedRevision: '1', completedRevision: '0' },
    { resourceType: 'AUTH_METHOD_POLICIES', requestedRevision: '1', completedRevision: '0' },
  ]

  const insertedId = randomUUID()
  await service().persistDirectoryAuditRows(tenant, [auditRecord(insertedId)], owner, true)
  assert.deepEqual(await work(), expected)
  await service().persistDirectoryAuditRows(tenant, [auditRecord(insertedId)], owner, true)
  assert.deepEqual(await work(), expected, 'duplicate provider rows cannot advance work revisions')

  const rejectedId = randomUUID()
  await assert.rejects(
    service({ projectDirectoryAudits: async () => { throw new Error('synthetic projection rollback') } })
      .persistDirectoryAuditRows(tenant, [auditRecord(rejectedId)], owner, true),
    /synthetic projection rollback/,
  )
  assert.equal(await database.directoryAuditLog.count({
    where: { customerTenantId: tenant.id, microsoftAuditId: rejectedId },
  }), 0)
  assert.deepEqual(await work(), expected, 'failed evidence must not enqueue work')
})

test('physical audit write commits raw, notice and evidence together or none after owner loss', {
  skip: !registeredCi,
  concurrency: false,
  timeout: 90_000,
}, async context => {
  assertDisposableTestDatabase()
  const first = new PrismaService()
  const second = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    if (organizationId) await second.organization.deleteMany({ where: { id: organizationId } })
    await Promise.all([first.$disconnect(), second.$disconnect()])
  })
  await Promise.all([first.$connect(), second.$connect()])
  const organization = await first.organization.create({
    data: { name: 'Visit audit atomic CI', slug: `visit-audit-atomic-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await first.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(first, scope, 300_000)
  assert.ok(owner)

  const writer = (database: PrismaService, evidence: object = new ChangeEvidenceService(database)) =>
    new TenantSyncService(database, {} as never, {} as never,
      new NotificationsService(database), evidence as never, {} as never) as any
  const record = (microsoftAuditId: string) => ({
    organizationId, customerTenantId: tenant.id, microsoftAuditId,
    eventDateTime: new Date('2026-11-12T00:00:00.000Z'),
    activityDisplayName: 'Update authentication method',
    category: 'UserManagement', operationType: 'Update', result: 'success',
    resultReason: null, correlationId: null, loggedByService: 'Core Directory',
    initiatedBy: {}, targetResources: [], additionalDetails: [],
    raw: { id: microsoftAuditId },
    ingestedAt: new Date('2026-11-12T00:01:00.000Z'),
    expiresAt: new Date('2027-05-12T00:00:00.000Z'),
  })
  const counts = async (id: string) => Promise.all([
    first.directoryAuditLog.count({ where: { customerTenantId: tenant.id, microsoftAuditId: id } }),
    first.notification.count({ where: { organizationId, dedupeKey: `security:directory-audit:${id}` } }),
    first.changeEvidenceEvent.count({ where: {
      customerTenantId: tenant.id, source: 'DIRECTORY_AUDIT', sourceEventId: id,
    } }),
  ])

  const committedId = randomUUID()
  await writer(first).persistDirectoryAuditRows(tenant, [record(committedId)], owner)
  assert.deepEqual(await counts(committedId), [1, 1, 1])
  await writer(first).persistDirectoryAuditRows(tenant, [record(committedId)], owner)
  assert.deepEqual(await counts(committedId), [1, 1, 1], 'duplicate page must not duplicate any row')
  const notice = await first.notification.findUniqueOrThrow({ where: {
    organizationId_dedupeKey: { organizationId, dedupeKey: `security:directory-audit:${committedId}` },
  } })
  assert.equal(notice.occurrenceCount, 1, 'insert-if-missing must not reopen or increment an existing notice')

  const rolledBackId = randomUUID()
  const failingEvidence = {
    projectDirectoryAudits: async () => { throw new Error('synthetic projection failure after notice insert') },
  }
  await assert.rejects(
    writer(first, failingEvidence).persistDirectoryAuditRows(tenant, [record(rolledBackId)], owner),
    /synthetic projection failure after notice insert/,
  )
  assert.deepEqual(await counts(rolledBackId), [0, 0, 0], 'failed evidence must roll back raw and notice')

  // Hold the real raw/notice transaction at its evidence boundary. The lease
  // row must remain locked until all three writes commit, and another client
  // must not see a partial raw row or notice while it is paused.
  let enteredProjection!: () => void
  let continueProjection!: () => void
  const projectionEntered = new Promise<void>(resolve => { enteredProjection = resolve })
  const projectionMayContinue = new Promise<void>(resolve => { continueProjection = resolve })
  const actualEvidence = new ChangeEvidenceService(first)
  const heldEvidence = {
    projectDirectoryAudits: async (...args: Parameters<ChangeEvidenceService['projectDirectoryAudits']>) => {
      enteredProjection()
      await projectionMayContinue
      return actualEvidence.projectDirectoryAudits(...args)
    },
  }
  const pausedId = randomUUID()
  const pendingWrite = writer(first, heldEvidence).persistDirectoryAuditRows(tenant, [record(pausedId)], owner)
  await Promise.race([
    projectionEntered,
    pendingWrite.then(() => { throw new Error('audit write committed before the evidence boundary') }),
  ])
  try {
    assert.deepEqual(await Promise.all([
      second.directoryAuditLog.count({ where: { customerTenantId: tenant.id, microsoftAuditId: pausedId } }),
      second.notification.count({ where: { organizationId, dedupeKey: `security:directory-audit:${pausedId}` } }),
      second.changeEvidenceEvent.count({ where: {
        customerTenantId: tenant.id, source: 'DIRECTORY_AUDIT', sourceEventId: pausedId,
      } }),
    ]), [0, 0, 0], 'a second client must see no uncommitted audit material')
    await assert.rejects(
      second.$transaction(transaction => transaction.$queryRawUnsafe(
        `SELECT generation FROM tenant_sync_visit_leases
          WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid FOR UPDATE NOWAIT`,
        tenant.id, organizationId,
      )),
      (error: unknown) => /55P03|could not obtain lock/i.test(String(error)),
      'takeover must not acquire the lease row while the owner write is open',
    )
  } finally {
    continueProjection()
    await pendingWrite
  }
  assert.deepEqual(await counts(pausedId), [1, 1, 1], 'the held write commits all audit material together')

  assert.equal(await releaseTenantVisitLease(second, owner), true)
  const successor = await tryAcquireTenantVisitLease(second, scope, 300_000)
  assert.ok(successor)
  assert.notEqual(successor.generation, owner.generation)
  const takeoverId = randomUUID()
  await assert.rejects(
    writer(first).persistDirectoryAuditRows(tenant, [record(takeoverId)], owner),
    TenantVisitLeaseLostError,
  )
  assert.deepEqual(await counts(takeoverId), [0, 0, 0], 'old owner must not publish after takeover')
  await writer(second).persistDirectoryAuditRows(tenant, [record(takeoverId)], successor)
  assert.deepEqual(await counts(takeoverId), [1, 1, 1], 'successor can publish the same event')
})

test('physical empty audit page repairs a retained security row missing its notice', {
  skip: !registeredCi,
  concurrency: false,
}, async context => {
  assertDisposableTestDatabase()
  const database = new PrismaService()
  const successorDatabase = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    if (organizationId) await database.organization.deleteMany({ where: { id: organizationId } })
    await Promise.all([database.$disconnect(), successorDatabase.$disconnect()])
  })
  await Promise.all([database.$connect(), successorDatabase.$connect()])
  const organization = await database.organization.create({
    data: { name: 'Visit audit notice recovery CI', slug: `visit-audit-notice-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await database.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(database, scope, 300_000)
  assert.ok(owner)
  const retainedRow = (id: string) => ({
    organizationId, customerTenantId: tenant.id, microsoftAuditId: id,
    eventDateTime: new Date('2026-11-12T00:00:00.000Z'),
    activityDisplayName: 'Update authentication method',
    category: 'UserManagement', operationType: 'Update', result: 'success',
    resultReason: null, correlationId: null, loggedByService: 'Core Directory',
    initiatedBy: {}, targetResources: [], additionalDetails: [],
    raw: { id }, ingestedAt: new Date('2026-11-12T00:01:00.000Z'),
    expiresAt: new Date('2027-05-12T00:00:00.000Z'),
  })
  const auditId = randomUUID()
  await database.directoryAuditLog.create({ data: retainedRow(auditId) })

  const evidence = new ChangeEvidenceService(database) as any
  evidence.pruneExpired = async () => undefined
  const service = new TenantSyncService(database, {} as never, {} as never,
    new NotificationsService(database), evidence, {} as never) as any
  service.runSnapshotSync = async (_tenant: unknown, _resource: string, collect: () => Promise<void>) => collect()
  service.logSyncStart = async () => new Date('2026-11-12T00:00:00.000Z')
  service.fetchGraphCollection = async (url: string) => {
    assert.ok(url.includes('/auditLogs/directoryAudits?'))
    return []
  }
  service.pruneExpiredDirectoryAuditLogs = async () => undefined
  service.reconcileDirectoryAuditResources = async () => undefined
  await service.syncDirectoryAuditLogs({ id: tenant.id, organizationId }, 'synthetic-token', false, owner)

  assert.equal(await database.directoryAuditLog.count({ where: { customerTenantId: tenant.id, microsoftAuditId: auditId } }), 1)
  assert.equal(await database.changeEvidenceEvent.count({ where: {
    customerTenantId: tenant.id, source: 'DIRECTORY_AUDIT', sourceEventId: auditId,
  } }), 1, 'the retained-row evidence repair must run despite an empty page')
  assert.equal(await database.notification.count({ where: {
    organizationId, dedupeKey: `security:directory-audit:${auditId}`,
  } }), 1, 'the same retained security row also needs its missing notice')

  // The next retained row was not on the provider page. A successor on a
  // second client may repair it, while the former owner may not publish it.
  const takeoverId = randomUUID()
  await database.directoryAuditLog.create({ data: retainedRow(takeoverId) })
  assert.equal(await releaseTenantVisitLease(successorDatabase, owner), true)
  const successor = await tryAcquireTenantVisitLease(successorDatabase, scope, 300_000)
  assert.ok(successor)
  assert.notEqual(successor.generation, owner.generation)
  await assert.rejects(
    service.repairRetainedDirectoryAuditNotices(tenant, owner, 100),
    TenantVisitLeaseLostError,
  )
  assert.equal(await database.notification.count({ where: {
    organizationId, dedupeKey: `security:directory-audit:${takeoverId}`,
  } }), 0, 'the former owner must not create the retained notice')
  const successorService = new TenantSyncService(successorDatabase, {} as never, {} as never,
    new NotificationsService(successorDatabase), {} as never, {} as never) as any
  assert.deepEqual(await successorService.repairRetainedDirectoryAuditNotices(tenant, successor, 100), {
    attempted: 1, hasMore: false,
  })
  assert.equal(await database.notification.count({ where: {
    organizationId, dedupeKey: `security:directory-audit:${takeoverId}`,
    customerTenantId: tenant.id, eventType: 'security.directory_change',
  } }), 1, 'the successor repairs the missing notice under its own owner')
})

test('physical admission reports busy when a live materializer holds the lease share lock past its lock budget', {
  skip: !registeredCi, concurrency: false, timeout: 30_000,
}, async context => {
  assertDisposableTestDatabase()
  const writer = new PrismaService()
  const contender = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    try { if (organizationId) await contender.organization.deleteMany({ where: { id: organizationId } }) }
    finally { await Promise.all([writer.$disconnect(), contender.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), contender.$connect()])
  const organization = await writer.organization.create({
    data: { name: 'Visit admission contention CI', slug: `visit-admission-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  const readLease = () => contender.$queryRawUnsafe(`
    SELECT owner_token::text, generation::text, expires_at FROM tenant_sync_visit_leases
    WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid`, organizationId, tenant.id)
  const before = await readLease()
  let locked!: () => void
  let release!: () => void
  const lockReached = new Promise<void>(resolve => { locked = resolve })
  const mayRelease = new Promise<void>(resolve => { release = resolve })
  const held = writer.$transaction(async transaction => {
    await assertTenantVisitLeaseOwner(transaction, owner)
    locked()
    await mayRelease
  }, { timeout: 15_000 })
  try {
    await Promise.race([lockReached, held.then(() => { throw new Error('Writer returned before held lock') })])
    const started = performance.now()
    assert.equal(await tryAcquireTenantVisitLease(contender, scope, 300_000), null)
    assert.ok(performance.now() - started >= 900, 'Exercise real lock-timeout contention, not an immediate busy read')
    assert.deepEqual(await readLease(), before, 'A failed admission cannot mutate the live owner or its deadline')
  } finally { release(); await held }
  assert.deepEqual(await readLease(), before)
  assert.equal(await releaseTenantVisitLease(writer, owner), true)
  const successor = await tryAcquireTenantVisitLease(contender, scope, 300_000)
  assert.ok(successor)
  assert.equal(successor.generation, owner.generation + 1n)
})

test('physical M365 raw/evidence/work commit survives an empty successor poll and rolls back partial work', {
  skip: !registeredCi, concurrency: false, timeout: 90_000,
}, async context => {
  assertDisposableTestDatabase()
  const writer = new PrismaService()
  const observer = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    try { if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } }) }
    finally { await Promise.all([writer.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({
    data: { name: 'M365 durable refresh CI', slug: `m365-durable-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  await writer.tenantAuditReconciliationWork.create({ data: {
    ...scope, resourceType: 'EXCHANGE_MAILBOXES', requestedRevision: 4n, completedRevision: 4n,
  } })
  const createContent = () => writer.m365ActivityContent.create({ data: {
    ...scope, contentType: 'Audit.Exchange', microsoftContentId: randomUUID(),
    contentUri: 'https://manage.office.com/synthetic-content', ledgerExpiresAt: new Date(Date.now() + 86_400_000),
  } })
  const readState = async () => ({
    raw: await observer.m365AuditRecord.count({ where: scope }),
    evidence: await observer.changeEvidenceEvent.count({ where: { ...scope, source: 'M365_UNIFIED_AUDIT' } }),
    work: await observer.tenantAuditReconciliationWork.findMany({
      where: scope, orderBy: { resourceType: 'asc' },
      select: { resourceType: true, requestedRevision: true, completedRevision: true },
    }),
    usage: await observer.m365AuditDailyUsage.aggregate({ where: scope, _sum: { recordsStored: true, blobsProcessed: true } }),
  })
  const collector = (ids: string[], afterWrites?: (transaction: Prisma.TransactionClient) => Promise<void>) => {
    const database = new Proxy(writer, { get(target, property) {
      if (property === '$transaction') return (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
        writer.$transaction(async transaction => {
          const result = await work(transaction)
          if (Array.isArray(result)) await afterWrites?.(transaction)
          return result
        }, { timeout: 20_000 })
      if (property === 'm365AuditRecord') return {
        // Force a stale preliminary read to prove returned inserted IDs, not
        // first-seen guesses, decide the exact durable revisions.
        findMany: async () => [],
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const service = new M365ManagementActivityService(database, {} as never) as any
    service.request = async () => new Response(JSON.stringify(ids.map(Id => ({
      Id, OrganizationId: tenant.microsoftTenantId, CreationTime: new Date().toISOString(),
      Operation: 'Set-Mailbox', Workload: 'Exchange', ResultStatus: 'Succeeded',
      UserId: 'admin@example.test', ObjectId: 'mailbox@example.test',
    }))))
    return (content: unknown, visitOwner = owner) => service.processContent(
      tenant, 'synthetic-token', owner.token, { remainingBytes: 1024 * 1024 },
      content, Date.now() + 60_000, visitOwner,
    ) as Promise<unknown[]>
  }
  const content = await createContent()
  const ids = [randomUUID(), randomUUID()]
  const initial = await readState()
  let written!: () => void
  let release!: () => void
  const writesReached = new Promise<void>(resolve => { written = resolve })
  const mayCommit = new Promise<void>(resolve => { release = resolve })
  const pending = collector(ids, async transaction => {
    assert.equal(await transaction.m365AuditRecord.count({ where: scope }), 2)
    assert.equal(await transaction.changeEvidenceEvent.count({ where: { ...scope, source: 'M365_UNIFIED_AUDIT' } }), 2)
    const requested = await transaction.tenantAuditReconciliationWork.findMany({ where: scope })
    assert.equal(requested.length, 5)
    assert.ok(requested.every(row => row.requestedRevision > row.completedRevision))
    written()
    await mayCommit
  })(content)
  try {
    await Promise.race([writesReached, pending.then(() => { throw new Error('M365 returned before held commit') })])
    const invisible = await readState()
    assert.equal(invisible.raw, 0)
    assert.equal(invisible.evidence, 0)
    assert.deepEqual(invisible.work, initial.work)
    assert.equal(invisible.usage._sum.recordsStored, 0, 'Downloaded bytes may be reserved; stored-record accounting is uncommitted')
  } finally { release(); await pending }
  const committed = await readState()
  assert.equal(committed.raw, 2)
  assert.equal(committed.evidence, 2)
  assert.equal(committed.usage._sum.recordsStored, 2)
  assert.equal(committed.usage._sum.blobsProcessed, 1)
  assert.equal(committed.work.length, 5)
  assert.deepEqual(committed.work.find(row => row.resourceType === 'EXCHANGE_MAILBOXES'), {
    resourceType: 'EXCHANGE_MAILBOXES', requestedRevision: 5n, completedRevision: 4n,
  })
  assert.deepEqual(await collector(ids)(await createContent()), [], 'Cross-blob duplicates return no new primary changes')
  assert.deepEqual((await readState()).work, committed.work)
  const beforeFailure = await readState()
  const rejectedContent = await createContent()
  assert.deepEqual(await collector([randomUUID()], async () => {
    throw new Error('synthetic failure after raw/evidence/work/completion writes')
  })(rejectedContent), [])
  assert.deepEqual(await readState(), beforeFailure, 'Failed commit must roll back raw, evidence, work and record accounting')
  assert.equal((await observer.m365ActivityContent.findUniqueOrThrow({ where: { id: rejectedContent.id } })).status, 'RETRY')
  assert.equal(await releaseTenantVisitLease(writer, owner), true)
  const successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
  assert.ok(successor)
  const pendingWork = await selectPendingAuditReconciliationWork(observer, scope, successor, 22)
  assert.equal(pendingWork.length, 5, 'A successor must recover work without seeing the original audit records again')
  const staleContent = await createContent()
  await assert.rejects(collector([randomUUID()])(staleContent), TenantVisitLeaseLostError)
  assert.deepEqual(await readState(), beforeFailure)
})

for (const stage of ['discovery-body', 'subscription-body', 'subscription-start'] as const) {
  test(`physical M365 ${stage} completion cannot replace successor state after visit takeover`, {
    skip: !registeredCi, concurrency: false, timeout: 60_000,
  }, async context => {
    assertDisposableTestDatabase()
    const writer = new PrismaService(), successorDb = new PrismaService()
    let organizationId: string | null = null
    context.after(async () => {
      try { if (organizationId) await successorDb.organization.deleteMany({ where: { id: organizationId } }) }
      finally { await Promise.all([writer.$disconnect(), successorDb.$disconnect()]) }
    })
    await Promise.all([writer.$connect(), successorDb.$connect()])
    const organization = await writer.organization.create({
      data: { name: 'M365 discovery fencing CI', slug: `m365-discovery-${randomUUID()}` },
    })
    organizationId = organization.id
    const tenant = await writer.customerTenant.create({
      data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
    })
    const scope = { organizationId, customerTenantId: tenant.id }
    const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
    assert.ok(owner)
    const now = new Date()
    await writer.m365ActivitySubscription.create({ data: {
      ...scope, contentType: 'Audit.Exchange', status: 'PENDING',
      lastSuccessfulPollAt: new Date(now.getTime() - 3_600_000),
    } })
    const service = new M365ManagementActivityService(writer, {} as never) as any
    let paused!: () => void, resume!: () => void, posts = 0
    const pauseReached = new Promise<void>(resolve => { paused = resolve })
    const mayResume = new Promise<void>(resolve => { resume = resolve })
    const hold = async () => { paused(); await mayResume }
    const source = [{ contentId: randomUUID(),
      contentUri: `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/synthetic` }]
    service.request = async (_url: string, init: RequestInit, _tenant: string, _publisher: string,
      _deadline: number, actual: unknown) => {
      assert.equal(actual, owner)
      if (init.method === 'POST') { posts++; if (stage === 'subscription-start') await hold(); return new Response('{}') }
      return new Response(JSON.stringify(stage === 'discovery-body' ? source : []))
    }
    const readBody = service.readMeteredJson.bind(service)
    service.readMeteredJson = async (...args: unknown[]) => {
      const payload = await readBody(...args)
      if (stage !== 'subscription-start') await hold()
      return payload
    }
    const pending = stage === 'discovery-body'
      ? service.discoverContent(tenant, 'synthetic', owner.token, new Set(['Audit.Exchange']), now,
        Date.now() + 30_000, { remainingBytes: 2 * 1024 * 1024 }, owner)
      : service.ensureSubscriptions(tenant, 'synthetic', owner.token, now, Date.now() + 30_000, owner)
    const rejected = assert.rejects(pending, TenantVisitLeaseLostError)
    try {
      await Promise.race([pauseReached, pending.then(() => { throw new Error('Collector returned before held response') })])
      assert.equal(await releaseTenantVisitLease(successorDb, owner), true)
      const successor = await tryAcquireTenantVisitLease(successorDb, scope, 300_000)
      assert.ok(successor)
      await successorDb.m365ActivitySubscription.updateMany({ where: scope, data: {
        status: 'ENABLED', lastError: 'successor marker', lastVerifiedAt: now,
        discoveryNextPageUri: `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/subscriptions/content?successor=1`,
      } })
      const readSubscriptions = () => successorDb.m365ActivitySubscription.findMany({
        where: scope, orderBy: { contentType: 'asc' },
      })
      const successorState = await readSubscriptions()
      resume()
      await rejected
      assert.deepEqual(await readSubscriptions(), successorState)
      assert.equal(await successorDb.m365ActivityContent.count({ where: scope }), 0)
      assert.equal(posts, stage === 'subscription-start' ? 1 : 0)
      const usage = await successorDb.m365AuditDailyUsage.findMany({ where: scope })
      assert.ok(usage.reduce((sum, row) => sum + row.downloadedBytes, 0n) > 0n,
        'Already-read bytes stay accounted even though owned state publication was rejected')
    } finally { resume(); await rejected }
  })
}

test('physical owned discovery rolls back content rows when its page checkpoint cannot commit', {
  skip: !registeredCi, concurrency: false, timeout: 60_000,
}, async context => {
  assertDisposableTestDatabase()
  const database = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    try { if (organizationId) await database.organization.deleteMany({ where: { id: organizationId } }) }
    finally { await database.$disconnect() }
  })
  await database.$connect()
  const organization = await database.organization.create({ data: {
    name: 'M365 discovery rollback CI', slug: `m365-discovery-rollback-${randomUUID()}`,
  } })
  organizationId = organization.id
  const tenant = await database.customerTenant.create({ data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(database, scope, 300_000)
  assert.ok(owner)
  const now = new Date()
  const before = await database.m365ActivitySubscription.create({ data: {
    ...scope, contentType: 'Audit.Exchange', status: 'ENABLED', lastSuccessfulPollAt: new Date(now.getTime() - 3_600_000),
  } })
  const wrapped = new Proxy(database, { get(target, property) {
    if (property === '$transaction') return (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
      database.$transaction(async transaction => {
        const result = await work(transaction)
        if (result && typeof result === 'object' && 'discoveryNextPageUri' in result) {
          assert.equal(await transaction.m365ActivityContent.count({ where: scope }), 1)
          throw new Error('synthetic discovery checkpoint rollback')
        }
        return result
      })
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const service = new M365ManagementActivityService(wrapped, {} as never) as any
  service.request = async () => new Response(JSON.stringify([{ contentId: randomUUID(),
    contentUri: `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/synthetic` }]))
  await assert.rejects(service.discoverContent(tenant, 'synthetic', owner.token, new Set(['Audit.Exchange']), now,
    Date.now() + 30000, { remainingBytes: 2 * 1024 * 1024 }, owner), /synthetic discovery checkpoint rollback/)
  assert.equal(await database.m365ActivityContent.count({ where: scope }), 0)
  assert.deepEqual(await database.m365ActivitySubscription.findUniqueOrThrow({ where: { id: before.id } }), before)
})

test('physical risk activation rejects stale global and tenant controls and holds the live visit through commit', {
  skip: !registeredCi, concurrency: false, timeout: 60_000,
}, async context => {
  assertDisposableTestDatabase()
  const writer = new PrismaService(), observer = new PrismaService()
  let organizationId: string | null = null
  const correlations = [randomUUID(), randomUUID(), randomUUID()]
  context.after(async () => {
    try {
      await observer.identityRiskOperationalEvent.deleteMany({ where: { correlationId: { in: correlations } } })
      if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } })
    } finally { await Promise.all([writer.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({ data: {
    name: 'Risk activation fencing CI', slug: `risk-activation-fencing-${randomUUID()}`,
  } })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({ data: {
    organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  assert.equal(await releaseTenantVisitLease(observer, owner), true)
  const successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
  assert.ok(successor)
  const service = new IdentityRiskSafetyService(writer)
  const tenantScope = { type: 'TENANT' as const, ...scope }
  const base = { controlType: 'EVALUATION_HARD_DISABLED' as const,
    reasonCode: 'SOURCE_INTEGRITY_CONFLICT', actorServiceId: 'identity-risk-evaluator' }
  for (const [index, controlScope] of [{ type: 'GLOBAL' as const }, tenantScope].entries()) {
    const where: Prisma.IdentityRiskOperationalControlWhereUniqueInput = { controlType_scopeKey: { controlType: base.controlType,
      scopeKey: controlScope.type === 'GLOBAL' ? 'GLOBAL' : `${organizationId}:${tenant.id}` } }
    const before: unknown = await observer.identityRiskOperationalControl.findUnique({ where })
    await assert.rejects(service.activate({ ...base, scope: controlScope, visitOwner: owner,
      correlationId: correlations[index] }), TenantVisitLeaseLostError)
    assert.deepEqual(await observer.identityRiskOperationalControl.findUnique({ where }), before)
    assert.equal(await observer.identityRiskOperationalEvent.count({ where: { correlationId: correlations[index] } }), 0)
  }

  const input = { ...base, scope: tenantScope, visitOwner: successor, correlationId: correlations[2] }
  const wrappedDatabase = (afterWrites: () => Promise<void>) => ({
    $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      writer.$transaction(async tx => { const result = await work(tx); await afterWrites(); return result }, { timeout: 20_000 }),
  }) as unknown as PrismaService
  const read = () => Promise.all([
    observer.identityRiskOperationalControl.count({ where: scope }),
    observer.identityRiskOperationalEvent.count({ where: { correlationId: correlations[2] } }),
  ])
  await assert.rejects(new IdentityRiskSafetyService(wrappedDatabase(async () => {
    throw new Error('synthetic activation commit failure')
  })).activate(input), /synthetic activation commit failure/)
  assert.deepEqual(await read(), [0, 0], 'control and event roll back together')

  let reached!: () => void, resume!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  const pending = new IdentityRiskSafetyService(wrappedDatabase(async () => { reached(); await held })).activate(input)
  try {
    await Promise.race([entered, pending.then(() => { throw new Error('Activation committed before hold') })])
    assert.deepEqual(await read(), [0, 0], 'uncommitted control and event remain invisible')
    await assert.rejects(observer.$transaction(tx => tx.$queryRawUnsafe(
      `SELECT generation FROM tenant_sync_visit_leases WHERE customer_tenant_id=$1::uuid
        AND organization_id=$2::uuid FOR UPDATE NOWAIT`, tenant.id, organizationId)),
    (error: unknown) => /55P03|could not obtain lock/i.test(String(error)),
    'takeover must wait for the safety control and event transaction')
  } finally { resume(); await pending }
  assert.deepEqual(await read(), [1, 1])
})

test('physical expired visit cannot renew or release a concurrent takeover winner', {
  skip: !registeredCi, concurrency: false, timeout: 30_000,
}, async context => {
  assertDisposableTestDatabase()
  const first = new PrismaService()
  const second = new PrismaService()
  let organizationId: string | undefined
  context.after(async () => {
    try {
      if (organizationId) await first.organization.deleteMany({ where: { id: organizationId } })
    } finally { await Promise.all([first.$disconnect(), second.$disconnect()]) }
  })
  await Promise.all([first.$connect(), second.$connect()])
  const organization = await first.organization.create({ data: {
    name: 'Visit expiry CI', slug: `visit-expiry-${randomUUID()}`,
  } })
  organizationId = organization.id
  const tenant = await first.customerTenant.create({ data: {
    organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const owner = await tryAcquireTenantVisitLease(first, scope, 300_000)
  assert.ok(owner)
  const renewed = await first.$transaction(transaction => renewTenantVisitLease(transaction, owner, 60_000))
  assert.ok(renewed)
  assert.equal(renewed.generation, owner.generation)
  assert.equal(renewed.token, owner.token)
  assert.equal(renewed.expiresAt.getTime(), owner.expiresAt.getTime(),
    'a shorter renewal cannot regress an existing later database deadline')

  // Simulate the persisted deadline of a crashed owner without sleeping or
  // changing process/database clocks. The production predicate still uses SQL time.
  await first.$executeRawUnsafe(`UPDATE tenant_sync_visit_leases
    SET expires_at=clock_timestamp()-interval '1 millisecond'
    WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid`, organizationId, tenant.id)
  await assert.rejects(first.$transaction(transaction => assertTenantVisitLeaseOwner(transaction, owner)),
    TenantVisitLeaseLostError)
  assert.equal(await first.$transaction(transaction => renewTenantVisitLease(transaction, owner, 300_000)), null)

  const contenders = await Promise.all([
    tryAcquireTenantVisitLease(first, scope, 300_000),
    tryAcquireTenantVisitLease(second, scope, 300_000),
  ])
  const winners = contenders.filter(candidate => candidate !== null)
  assert.equal(winners.length, 1, 'concurrent recovery admits exactly one successor')
  const successor = winners[0]!
  assert.equal(successor.generation, owner.generation + 1n)
  assert.notEqual(successor.token, owner.token)
  const state = () => first.$queryRawUnsafe<Array<{
    token: string | null; generation: string; expiresAt: Date | null
  }>>(`SELECT owner_token::text AS token, generation::text AS generation, expires_at AS "expiresAt"
    FROM tenant_sync_visit_leases WHERE organization_id=$1::uuid AND customer_tenant_id=$2::uuid`,
  organizationId, tenant.id)
  const before = await state()
  assert.equal(await first.$transaction(transaction => releaseTenantVisitLease(transaction, owner)), false)
  assert.equal(await first.$transaction(transaction => renewTenantVisitLease(transaction, owner, 600_000)), null)
  await assert.rejects(first.$transaction(transaction => assertTenantVisitLeaseOwner(transaction, owner)),
    TenantVisitLeaseLostError)
  assert.deepEqual(await state(), before, 'old cleanup and renewal cannot alter a successor')
  await first.$transaction(transaction => assertTenantVisitLeaseOwner(transaction, successor))
  assert.equal(await second.$transaction(transaction => releaseTenantVisitLease(transaction, successor)), true)
  assert.equal(await second.$transaction(transaction => renewTenantVisitLease(transaction, successor, 300_000)), null)
  const recovered = await tryAcquireTenantVisitLease(first, scope, 300_000)
  assert.ok(recovered)
  assert.equal(recovered.generation, successor.generation + 1n)
  assert.equal(await second.$transaction(transaction => releaseTenantVisitLease(transaction, successor)), false)
  await first.$transaction(transaction => assertTenantVisitLeaseOwner(transaction, recovered))
})

test('physical renewal timeout stops new work and lifecycle drains an owned transaction before release', {
  skip: !registeredCi, concurrency: false, timeout: 30_000,
}, async context => {
  assertDisposableTestDatabase()
  const writer = new PrismaService()
  const observer = new PrismaService()
  let organizationId: string | undefined
  context.after(async () => {
    try {
      if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } })
    } finally { await Promise.all([writer.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({ data: {
    name: 'Visit renewal drain CI', slug: `visit-renewal-drain-${randomUUID()}`,
  } })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({ data: {
    organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const realStore = createTenantVisitLifecycleStore(writer)
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }
  const writeEntered = deferred()
  const releaseWrite = deferred()
  const renewalSettled = deferred()
  let renewCallback: (() => void) | undefined
  let releaseCalls = 0
  let renewalError: unknown
  let workSettled = false
  let scheduled = 0
  let releaseBeforeDrain = false
  let transactionFinished = false
  const store = {
    acquire: realStore.acquire,
    renew: async (...args: Parameters<typeof realStore.renew>) => {
      try { return await realStore.renew(...args) }
      catch (error) { renewalError = error; throw error }
      finally { renewalSettled.resolve() }
    },
    release: async (...args: Parameters<typeof realStore.release>) => {
      releaseCalls++
      releaseBeforeDrain = !workSettled || !transactionFinished
      return realStore.release(...args)
    },
  }
  const pending = runTenantVisitLifecycle(store, scope, async owner => {
    const held = writer.$transaction(async transaction => {
      await assertTenantVisitLeaseOwner(transaction, owner)
      // Exercise an actual owned materialization before retaining its lease
      // share lock; all peer work must settle before cleanup may release it.
      await transaction.customerTenant.update({ where: { id: tenant.id }, data: { primaryDomain: 'drained.example.test' } })
      writeEntered.resolve()
      await releaseWrite.promise
    }, { timeout: 20_000 }).finally(() => { transactionFinished = true })
    try {
      await Promise.race([writeEntered.promise, held.then(() => { throw new Error('Owned transaction did not pause') })])
      assert.ok(renewCallback)
      renewCallback()
      await renewalSettled.promise
      // The store has rejected; allow the production lifecycle rejection
      // continuation to record the same terminal ownership loss.
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.ok(renewalError, 'real bounded renewal must fail behind the held FOR SHARE lock')
      const sqlFailure = renewalError as { code?: string; meta?: {
        code?: string; driverAdapterError?: { cause?: { originalCode?: string } }
      } }
      assert.equal(sqlFailure.code === '55P03' || (sqlFailure.code === 'P2010' && (
        sqlFailure.meta?.code === '55P03' || sqlFailure.meta?.driverAdapterError?.cause?.originalCode === '55P03'
      )), true, 'the witness must observe an actual PostgreSQL lock timeout, not an unrelated failure')
      assert.equal(scheduled, 1, 'failed renewal cannot schedule another renewal')
      assert.equal(releaseCalls, 0, 'renewal loss cannot release the running peer')
      assert.throws(() => assertTenantVisitLifecycleActive(owner), TenantVisitLeaseLostError)
      let newWriteReached = false
      await assert.rejects(writer.$transaction(async transaction => {
        await assertTenantVisitLeaseOwner(transaction, owner)
        newWriteReached = true
      }), TenantVisitLeaseLostError)
      assert.equal(newWriteReached, false)
      assert.equal((await observer.customerTenant.findUniqueOrThrow({ where: { id: tenant.id } })).primaryDomain, null,
        'held materialization is not observable before its peer is drained')
    } finally {
      releaseWrite.resolve()
      await held
      workSettled = true
    }
    return 'must-not-report-success'
  }, {
    now: () => 0,
    schedule: work => { scheduled++; renewCallback = work; return scheduled },
    cancel: () => { renewCallback = undefined },
  })
  await assert.rejects(pending, TenantVisitLeaseLostError)
  assert.equal(releaseCalls, 1)
  assert.equal(releaseBeforeDrain, false)
  assert.equal((await observer.customerTenant.findUniqueOrThrow({ where: { id: tenant.id } })).primaryDomain,
    'drained.example.test')
  const successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
  assert.ok(successor, 'normal subsequent admission can recover only after peer drain and release')
  await observer.$transaction(transaction => assertTenantVisitLeaseOwner(transaction, successor))
})

async function physicalUsersVisitFixture(context: import('node:test').TestContext, label: string) {
  // No client is created until the registered disposable-CI guard has passed.
  assert.equal(assertDisposableTestDatabase().port, '5432')
  const network = context.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external request in physical USERS visit witness')
  })
  const writer = new PrismaService(), observer = new PrismaService()
  let organizationId: string | null = null
  context.after(async () => {
    try { if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } }) }
    finally { await Promise.all([writer.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({ data: {
    name: 'USERS visit fencing CI', slug: `users-visit-${label}-${randomUUID()}`,
  } })
  organizationId = organization.id
  const priorAt = new Date(Date.now() - 3_600_000)
  const tenant = await writer.customerTenant.create({ data: {
    organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
    connection: { create: {
      status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
      clientId: randomUUID(), credentialReference: 'synthetic-unused', lastVerifiedAt: priorAt,
    } },
  }, include: { connection: true } })
  const scope = { organizationId, customerTenantId: tenant.id }
  const stateKey = { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'USERS' as const } }
  const connectionKey = { customerTenantId_organizationId: scope }
  const priorDelta = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=physical-prior'
  await writer.syncState.create({ data: {
    ...scope, resourceType: 'USERS', status: 'SUCCEEDED', deltaLink: priorDelta, lastSuccessfulAt: priorAt,
  } })
  const owner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(owner)
  const takeover = async () => {
    assert.equal(await releaseTenantVisitLease(observer, owner), true)
    const successor = await tryAcquireTenantVisitLease(observer, scope, 300_000)
    assert.ok(successor)
    assert.ok(successor.generation > owner.generation)
    assert.notEqual(successor.token, owner.token)
    return successor
  }
  return {
    writer, observer, tenant, scope, stateKey, connectionKey, owner, priorAt, priorDelta, takeover, network,
    readState: () => observer.syncState.findUniqueOrThrow({ where: stateKey }),
    readConnection: () => observer.tenantConnection.findUniqueOrThrow({ where: connectionKey }),
  }
}

test('physical owned forced-full USERS claim atomically clears its checkpoint and rejects a takeover between claim transactions', {
  skip: !registeredCi, concurrency: false, timeout: 90_000,
}, async context => {
  const f = await physicalUsersVisitFixture(context, 'claim')
  const before = await f.readState()
  let transactions = 0
  const rollbackDatabase = {
    $transaction: (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
      f.writer.$transaction(async transaction => {
        const result = await work(transaction)
        if (++transactions === 2) {
          const claimed = await transaction.syncState.findUniqueOrThrow({ where: f.stateKey })
          assert.equal(claimed.status, 'RUNNING')
          assert.equal(claimed.deltaLink, null)
          assert.deepEqual(await f.readState(), before, 'claim and invalidation are not visible before commit')
          await assert.rejects(f.observer.$transaction(tx => tx.$queryRawUnsafe(
            'SELECT generation FROM tenant_sync_visit_leases WHERE customer_tenant_id=$1::uuid FOR UPDATE NOWAIT',
            f.tenant.id,
          )), (error: unknown) => /55P03|could not obtain lock/i.test(String(error)),
          'the forced-full claim retains the exact owner lock until commit')
          throw new Error('synthetic USERS claim rollback')
        }
        return result
      }, { timeout: 20_000 }),
  }
  await assert.rejects(claimTenantUsersLease(rollbackDatabase, f.tenant, new Date(), f.owner, true),
    /synthetic USERS claim rollback/)
  assert.equal(transactions, 2)
  assert.deepEqual(await f.readState(), before, 'rollback restores both status and old delta')

  transactions = 0
  let successor: Awaited<ReturnType<typeof f.takeover>> | undefined
  const racedDatabase = {
    $transaction: async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => {
      const result = await f.writer.$transaction(work)
      if (++transactions === 1) {
        successor = await f.takeover()
        await f.observer.syncState.update({ where: f.stateKey, data: {
          deltaLink: `${f.priorDelta}-successor`, lastErrorMessage: 'successor claim marker',
        } })
      }
      return result
    },
  }
  await assert.rejects(claimTenantUsersLease(racedDatabase, f.tenant, new Date(), f.owner, true), TenantVisitLeaseLostError)
  const afterRace = await f.readState()
  assert.equal(afterRace.status, 'SUCCEEDED')
  assert.equal(afterRace.deltaLink, `${f.priorDelta}-successor`)
  assert.equal(afterRace.lastErrorMessage, 'successor claim marker')
  assert.ok(successor)
  const claimed = await claimTenantUsersLease(f.writer, f.tenant, new Date(), successor, true)
  assert.equal(claimed.claimed, true)
  assert.equal(claimed.existingState?.deltaLink, afterRace.deltaLink)
  assert.equal((await f.readState()).status, 'RUNNING')
  assert.equal((await f.readState()).deltaLink, null)
  assert.equal(f.network.mock.callCount(), 0)
})

test('physical full USERS takeover after 250 committed rows rejects the next batch and absence sweep; successor can recover', {
  skip: !registeredCi, concurrency: false, timeout: 90_000,
}, async context => {
  const f = await physicalUsersVisitFixture(context, 'batch')
  const unseen = await f.writer.directoryUser.create({ data: {
    ...f.scope, microsoftUserId: randomUUID(), displayName: 'Unseen existing user',
    userPrincipalName: 'unseen@example.test', lastSeenAt: f.priorAt,
  } })
  const otherTenant = await f.writer.customerTenant.create({ data: {
    organizationId: f.scope.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const otherUser = await f.writer.directoryUser.create({ data: {
    organizationId: f.scope.organizationId, customerTenantId: otherTenant.id,
    microsoftUserId: randomUUID(), displayName: 'Other tenant control',
    userPrincipalName: 'other@example.test', lastSeenAt: f.priorAt,
  } })
  const users = Array.from({ length: 251 }, (_, index) => ({
    id: randomUUID(), displayName: `Collected ${index}`, userPrincipalName: `user-${index}@example.test`,
  }))
  const finalDelta = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=physical-complete'
  const readUsers = () => f.observer.directoryUser.findMany({ where: f.scope, orderBy: { microsoftUserId: 'asc' } })
  assert.equal((await claimTenantUsersLease(f.writer, f.tenant, new Date(), f.owner, true)).claimed, true)
  assert.equal((await f.readState()).deltaLink, null)
  let materialized = 0, committedBatches = 0
  let successor: Awaited<ReturnType<typeof f.takeover>> | undefined
  let successorRows: Awaited<ReturnType<typeof readUsers>> | undefined
  const wrapped = new Proxy(f.writer, { get(target, property) {
    if (property === '$transaction') return async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => {
      let batchRows = 0
      const result = await f.writer.$transaction(async transaction => {
        const tracked = new Proxy(transaction, { get(tx, member) {
          if (member === 'directoryUser') return new Proxy(tx.directoryUser, { get(delegate, method) {
            if (method === 'upsert') return (args: Prisma.DirectoryUserUpsertArgs) => {
              batchRows++; materialized++; return delegate.upsert(args)
            }
            const value = Reflect.get(delegate, method)
            return typeof value === 'function' ? value.bind(delegate) : value
          } })
          const value = Reflect.get(tx, member)
          return typeof value === 'function' ? value.bind(tx) : value
        } })
        return work(tracked)
      }, { timeout: 20_000 })
      if (batchRows) {
        committedBatches++
        assert.equal(batchRows, 250)
        assert.equal(committedBatches, 1, 'the stale second batch must fail before its first write')
        assert.equal(await f.observer.directoryUser.count({ where: f.scope }), 251)
        successor = await f.takeover()
        await f.observer.directoryUser.create({ data: {
          ...f.scope, microsoftUserId: users[250]!.id, displayName: 'Successor value',
          userPrincipalName: users[250]!.userPrincipalName, lastSeenAt: new Date(),
        } })
        successorRows = await readUsers()
      }
      return result
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const collector = (database: PrismaService, rows: typeof users) => {
    const service = new TenantSyncService(database, {} as never, {} as never, {} as never, {} as never, {} as never) as any
    service.fetchGraphPage = async () => Response.json({ value: rows, '@odata.deltaLink': finalDelta })
    return service
  }
  await assert.rejects(collector(wrapped, users).synchronizeUsers(f.tenant, 'synthetic', null,
    true, undefined, undefined, f.owner), TenantVisitLeaseLostError)
  assert.equal(materialized, 250)
  assert.equal(committedBatches, 1)
  assert.ok(successorRows)
  assert.deepEqual(await readUsers(), successorRows, 'stale batch must neither replace successor rows nor tombstone unseen users')
  assert.equal((await f.readState()).deltaLink, null, 'an interrupted full enumeration leaves no completed checkpoint')
  await assert.rejects(collector(f.writer, []).synchronizeUsers(f.tenant, 'synthetic', null,
    true, undefined, undefined, f.owner), TenantVisitLeaseLostError,
  'even an empty full response must recheck ownership at its absence sweep')
  assert.deepEqual(await readUsers(), successorRows)
  assert.ok(successor)
  assert.deepEqual(await collector(f.writer, users).synchronizeUsers(f.tenant, 'synthetic', null,
    true, undefined, undefined, successor), { deltaLink: finalDelta })
  assert.equal(await f.observer.directoryUser.count({ where: { ...f.scope, deletedAt: null } }), 251)
  assert.ok((await f.observer.directoryUser.findUniqueOrThrow({ where: { id: unseen.id } })).deletedAt)
  assert.equal((await f.observer.directoryUser.findUniqueOrThrow({
    where: { customerTenantId_microsoftUserId: { customerTenantId: f.tenant.id, microsoftUserId: users[250]!.id } },
  })).displayName, users[250]!.displayName)
  assert.deepEqual(await f.observer.directoryUser.findUniqueOrThrow({ where: { id: otherUser.id } }), otherUser)
  assert.equal(f.network.mock.callCount(), 0)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`physical stale USERS ${outcome} terminal cannot overwrite successor checkpoint or connection`, {
    skip: !registeredCi, concurrency: false, timeout: 90_000,
  }, async context => {
    const f = await physicalUsersVisitFixture(context, `terminal-${outcome}`)
    let providerCalls = 0, auditCalls = 0
    let successorState: Awaited<ReturnType<typeof f.readState>> | undefined
    let successorConnection: Awaited<ReturnType<typeof f.readConnection>> | undefined
    const publishSuccessor = async () => {
      const successor = await f.takeover()
      const verifiedAt = new Date(Date.now() - 1_000)
      await f.observer.$transaction(async transaction => {
        await assertTenantVisitLeaseOwner(transaction, successor)
        await transaction.syncState.update({ where: f.stateKey, data: {
          status: 'SUCCEEDED', deltaLink: `${f.priorDelta}-successor`, lastSuccessfulAt: verifiedAt,
          lastErrorCode: 'successor-marker', lastErrorMessage: 'Retain successor receipt', consecutiveFailures: 3,
        } })
        await transaction.tenantConnection.update({ where: f.connectionKey, data: { lastVerifiedAt: verifiedAt } })
      })
      successorState = await f.readState()
      successorConnection = await f.readConnection()
    }
    const service = new TenantSyncService(f.writer,
      { getTenantAccessToken: async () => 'synthetic' } as never,
      {} as never, {} as never, {} as never,
      { syncTenant: async () => { auditCalls++; return [] } } as never) as any
    service.fetchGraphPage = async () => {
      providerCalls++
      assert.equal((await f.readState()).deltaLink, null, 'actual orchestration clears delta before provider work')
      if (outcome === 'failure') {
        await publishSuccessor()
        throw new Error('Synthetic provider failure from superseded visit')
      }
      return Response.json({ value: [{ id: randomUUID(), userPrincipalName: 'terminal@example.test' }],
        '@odata.deltaLink': `${f.priorDelta}-stale` })
    }
    if (outcome === 'success') {
      const synchronizeUsers = service.synchronizeUsers.bind(service)
      service.synchronizeUsers = async (...args: unknown[]) => {
        const result = await synchronizeUsers(...args)
        assert.equal(await f.observer.directoryUser.count({ where: f.scope }), 1,
          'the real collector materialized and swept before takeover at the terminal boundary')
        await publishSuccessor()
        return result
      }
    }
    await assert.rejects(service.syncConnectedTenantWithinMemoryLane(f.tenant, false, {
      includeBundle: false, forceFullUsers: true, visitOwner: f.owner,
    }), TenantVisitLeaseLostError)
    assert.ok(successorState)
    assert.ok(successorConnection)
    assert.deepEqual(await f.readState(), successorState)
    assert.deepEqual(await f.readConnection(), successorConnection)
    assert.equal(providerCalls, 1)
    assert.equal(auditCalls, 0, 'ownership loss cannot trigger independent audit compensation')
    assert.equal(f.network.mock.callCount(), 0)
  })
}

/** Real dispatcher/collector/status/materialization SQL. Only external provider
 * and DNS transport are synthetic; no collector or publication helper is mocked. */
async function physicalCollectorFixture(context: TestContext) {
  assertDisposableTestDatabase()
  const database = new PrismaService()
  const observer = new PrismaService()
  let organizationId: string | undefined
  context.after(async () => {
    try {
      if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } })
    } finally { await Promise.all([database.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([database.$connect(), observer.$connect()])
  const organization = await database.organization.create({ data: {
    name: 'Collector route CI', slug: `collector-route-${randomUUID()}`,
  } })
  organizationId = organization.id
  const tenant = await database.customerTenant.create({ data: {
    organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
  } })
  const scope = { organizationId, customerTenantId: tenant.id }
  await database.tenantConnection.create({ data: { ...scope, status: 'CONNECTED', connectionMode: 'CUSTOMER_MANAGED',
    clientId: randomUUID(), credentialReference: 'synthetic-unused' } })
  const owner = await tryAcquireTenantVisitLease(database, scope, 300_000)
  assert.ok(owner)
  const userId = randomUUID(), groupId = randomUUID(), skuId = randomUUID(), siteId = randomUUID()
  const directoryUser = await database.directoryUser.create({ data: {
    ...scope, microsoftUserId: userId, displayName: 'Physical fixture user',
    userPrincipalName: 'user@example.test',
  } })
  const now = new Date()
  await database.syncState.create({ data: { ...scope, resourceType: 'USERS', status: 'SUCCEEDED',
    lastSuccessfulAt: now, lastAttemptAt: now } })
  const hooks: {
    afterTransaction?: (transaction: Prisma.TransactionClient) => Promise<void>
    beforeResponse?: (url: string) => Promise<void>
    domainPartial?: boolean
    csvRedirect?: boolean
    csvPartial?: boolean
  } = {}
  const trackedDatabase = new Proxy(database, {
    get(target, property) {
      if (property === '$transaction') return (work: (transaction: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        target.$transaction(async transaction => {
          const result = await work(transaction)
          await hooks.afterTransaction?.(transaction)
          return result
        }, { ...options, timeout: 20_000 })
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const service = new TenantSyncService(trackedDatabase, {} as never, {} as never,
    { resolveIncident: async () => {}, publishIncident: async () => {} } as never,
    new ChangeEvidenceService(database), {} as never) as any
  const providerCalls: string[] = [], dnsCalls: string[] = []
  context.mock.method(Resolver.prototype, 'resolveTxt', async (name: string) => {
    dnsCalls.push(name)
    return [[name.startsWith('_dmarc.') ? 'v=DMARC1; p=reject' : 'v=spf1 -all']]
  })
  context.mock.method(Resolver.prototype, 'resolveCname', async (name: string) => {
    dnsCalls.push(name)
    return ['synthetic.example.test']
  })
  const reportDate = now.toISOString().slice(0, 10)
  const csv = (kind: string) => kind === 'mailbox'
    ? 'User Principal Name,Storage Used (Byte)\r\nuser@example.test,512\r\n'
    : kind === 'sharepoint'
      ? `Report Refresh Date,Site Id,Site URL,Storage Used (Byte),Report Period\r\n${reportDate},${siteId},https://example.sharepoint.com/sites/fixture,1024,180\r\n`
      : `Report Refresh Date,Owner Principal Name,Site URL,Storage Used (Byte),Report Period\r\n${reportDate},user@example.test,https://example-my.sharepoint.com/personal/user,2048,30\r\n`
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    assert.match(url, /^https:\/\/reports\.example\.test\/(mailbox|sharepoint|onedrive)$/,
      'physical fixture must never use a live provider endpoint')
    return new Response(csv(url.split('/').at(-1)!), { status: hooks.csvPartial ? 206 : 200 })
  })
  service.fetchGraphPage = async (url: string) => {
    providerCalls.push(url)
    await hooks.beforeResponse?.(url)
    const page = (value: unknown[], partial = false) => Response.json({ value }, { status: partial ? 206 : 200 })
    if (url.includes('/organization?')) return page([{
      id: tenant.microsoftTenantId, displayName: 'Physical organization',
      verifiedDomains: [{ name: 'example.test', isDefault: true, isInitial: false }],
    }], hooks.domainPartial && url.includes('displayName,verifiedDomains'))
    if (url.includes('/subscribedSkus')) return page([{
      skuId, skuPartNumber: 'PHYSICAL_SKU', consumedUnits: 1, prepaidUnits: { enabled: 3 }, servicePlans: [],
    }])
    if (url.includes(`/groups/${groupId}/owners?`)) return page([{ id: userId, displayName: 'Owner' }])
    if (url.includes(`/groups/${groupId}/members?`)) return page([{ id: userId }])
    if (url.includes('/groups?')) return page([{ id: groupId, displayName: 'Physical group', securityEnabled: true }])
    if (url.includes('/reports/authenticationMethods/userRegistrationDetails')) return page([])
    if (url.includes('/policies/authenticationMethodsPolicy')) return Response.json({
      authenticationMethodConfigurations: [{ id: 'Sms', state: 'enabled', includeTargets: [] }],
    })
    if (url.includes('/policies/identitySecurityDefaultsEnforcementPolicy')) return Response.json({ id: 'defaults', isEnabled: true })
    if (url.includes('/identity/conditionalAccess/policies')) return page([{ id: 'policy', displayName: 'Physical CA', state: 'enabled' }])
    if (url.includes('/identity/conditionalAccess/namedLocations')) return page([{ id: 'location', displayName: 'Physical location' }])
    if (url.includes('/devices?')) return page([{ id: randomUUID(), displayName: 'Physical device', registeredOwners: [] }])
    if (url.includes('/servicePrincipals?')) return page([{ id: randomUUID(), displayName: 'Physical service principal', appRoleAssignedTo: [] }])
    if (url.includes('/applications?')) return page([{ id: randomUUID(), displayName: 'Physical application', owners: [] }])
    if (url.includes('/roleManagement/directory/roleAssignments')) return page([{ id: 'role-assignment', principalId: userId,
      roleDefinition: { id: 'definition', displayName: 'Physical role', templateId: 'template' } }])
    if (url.includes(`/users/${userId}/mailboxSettings?`)) return Response.json({ userPurpose: 'user', timeZone: 'UTC' })
    if (url.includes(`/users/${userId}/mailFolders/inbox/messageRules?`)) return page([{
      id: 'rule', displayName: 'Physical rule', isEnabled: true, hasError: false, actions: {}, conditions: {},
    }])
    if (url.includes('/users?')) return page([{ id: userId, displayName: 'Physical mailbox',
      mail: 'user@example.test', userPrincipalName: 'user@example.test', assignedLicenses: [] }])
    if (url.includes('/reports/get')) {
      const kind = url.includes('getMailbox') ? 'mailbox' : url.includes('getSharePoint') ? 'sharepoint' : 'onedrive'
      return hooks.csvRedirect
        ? new Response(null, { status: 302, headers: { location: `https://reports.example.test/${kind}` } })
        : new Response(csv(kind), { status: hooks.csvPartial ? 206 : 200 })
    }
    if (url.includes('/sites/root?')) return Response.json({ id: siteId, name: 'Root', root: {}, webUrl: 'https://example.sharepoint.com' })
    if (url.includes('/sites?search=')) return page([{ id: siteId, name: 'Root', root: {}, webUrl: 'https://example.sharepoint.com' }])
    if (url.includes('/admin/sharepoint/settings')) return Response.json({ sharingCapability: 'existingExternalUserSharingOnly' })
    assert.fail(`Unregistered physical provider fixture: ${url}`)
  }
  const enqueue = (resources: readonly AuditReconciliationResource[], revision = 2n) =>
    database.tenantAuditReconciliationWork.createMany({ data: resources.map(resourceType => ({
      ...scope, resourceType, requestedRevision: revision, completedRevision: 0n,
    })) })
  const receipts = () => observer.tenantAuditReconciliationWork.findMany({ where: scope, orderBy: { resourceType: 'asc' } })
  const snapshot = (resourceType: AuditReconciliationResource) => observer.tenantEntraSnapshot.findUnique({
    where: { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType } },
  })
  return { database, observer, scope, tenant, owner, userId, groupId, skuId, directoryUser,
    service, trackedDatabase, hooks, providerCalls, dnsCalls, enqueue, receipts, snapshot }
}

test('physical empty successor replay executes every one of the 22 collector routes and exact receipts', {
  skip: !registeredCi, concurrency: false, timeout: 120_000,
}, async context => {
  const f = await physicalCollectorFixture(context)
  await f.enqueue(AUDIT_RECONCILIATION_RESOURCES)
  await f.database.tenantEntraSnapshot.create({ data: { ...f.scope, resourceType: 'EXCHANGE_MAILBOXES',
    observedAt: new Date(Date.now() - 60_000), payload: [{ id: f.userId, accountEnabled: false,
      proxyAddresses: ['smtp:retained@example.test'], mail: 'old@example.test' }] } })
  assert.equal(await releaseTenantVisitLease(f.database, f.owner), true)
  const successor = await tryAcquireTenantVisitLease(f.observer, f.scope, 300_000)
  assert.ok(successor)
  // No new provider event is needed. Actual durable selection and dispatcher
  // must reach the real collectors, including customer-managed directory roles.
  await f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], successor)
  const receipts = await f.receipts()
  assert.equal(receipts.length, AUDIT_RECONCILIATION_RESOURCES.length)
  for (const receipt of receipts) {
    assert.equal(receipt.completedRevision, 2n, receipt.resourceType)
    const snapshot = await f.snapshot(receipt.resourceType as AuditReconciliationResource)
    assert.ok(snapshot, receipt.resourceType)
    assert.equal(receipt.lastCompletedAt?.getTime(), snapshot.observedAt.getTime(), receipt.resourceType)
    const state = await f.observer.syncState.findUniqueOrThrow({ where: {
      customerTenantId_resourceType: { customerTenantId: f.tenant.id, resourceType: receipt.resourceType },
    } })
    assert.equal(state.status, 'SUCCEEDED', receipt.resourceType)
  }
  assert.equal(await f.observer.tenantLicense.count({ where: { ...f.scope, microsoftSkuId: f.skuId } }), 1)
  assert.equal(await f.observer.directoryGroupMembership.count({ where: { ...f.scope, directoryUserId: f.directoryUser.id } }), 1)
  const groups = (await f.snapshot('GROUPS'))!.payload as Array<{ owners: unknown[] }>
  assert.deepEqual(groups[0].owners, [{ id: f.userId, displayName: 'Owner' }])
  const mailbox = (await f.snapshot('EXCHANGE_MAILBOXES'))!.payload as Array<Record<string, unknown>>
  assert.equal(mailbox[0].mail, 'user@example.test')
  assert.equal(mailbox[0].accountEnabled, false, 'omitted provider field must retain the stored mailbox value')
  assert.deepEqual(mailbox[0].proxyAddresses, ['smtp:retained@example.test'])
  assert.equal(f.dnsCalls.length, 4)
  for (const resource of ['EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'] as const) {
    const snapshot = (await f.snapshot(resource))!
    const attestation = await f.observer.tenantCollectionFieldState.findUniqueOrThrow({ where: {
      customerTenantId_fieldKey: { customerTenantId: f.tenant.id, fieldKey: sourceAttestationKey(resource) },
    } })
    assert.equal(attestation.state, 'COMPLETE')
    assert.equal(attestation.correlationId, mailboxSourceDigest(f.scope, resource, snapshot.observedAt, snapshot.payload))
    assert.equal(attestation.lastSuccessfulAt?.getTime(), snapshot.observedAt.getTime())
  }
  await f.database.tenantAuditReconciliationWork.updateMany({ where: f.scope, data: { requestedRevision: 3n } })
  // M365 raw transport has its own physical suite above. At this handoff its
  // empty result must still drive the same real selection/collectors/receipts.
  f.service.m365ManagementActivity = { syncTenant: async (tenant: unknown, owner: unknown) => {
    assert.equal(tenant, f.tenant)
    assert.equal(owner, successor)
    return []
  } }
  assert.deepEqual(await f.service.syncM365AuditActivity(f.tenant, 'synthetic-token', successor), { collectedChanges: 0 })
  for (const receipt of await f.receipts()) {
    assert.equal(receipt.completedRevision, 3n, receipt.resourceType)
    assert.equal(receipt.lastCompletedAt?.getTime(),
      (await f.snapshot(receipt.resourceType as AuditReconciliationResource))!.observedAt.getTime())
  }
  const providerCount = f.providerCalls.length
  await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner), TenantVisitLeaseLostError)
  assert.equal(f.providerCalls.length, providerCount, 'displaced replay cannot start another provider request')
})

test('physical LICENSES collector rolls inventory replacement back with snapshot evidence and receipt', {
  skip: !registeredCi, concurrency: false, timeout: 60_000,
}, async context => {
  const f = await physicalCollectorFixture(context)
  await f.enqueue(['LICENSES'])
  const oldSkuId = randomUUID()
  await f.database.tenantLicense.create({ data: { ...f.scope, microsoftSkuId: oldSkuId,
    skuPartNumber: 'OLD_SKU', servicePlans: [] } })
  await f.database.tenantEntraSnapshot.create({ data: { ...f.scope, resourceType: 'LICENSES',
    observedAt: new Date(Date.now() - 60_000), payload: [{ skuId: oldSkuId, skuPartNumber: 'OLD_SKU',
      consumedUnits: 0, prepaidUnits: { enabled: 0 }, servicePlans: [] }] } })
  const before = { snapshot: await f.snapshot('LICENSES'), receipt: await f.receipts(),
    inventory: await f.observer.tenantLicense.findMany({ where: f.scope }),
    evidence: await f.observer.changeEvidenceEvent.count({ where: f.scope }) }
  let injected = false
  f.hooks.afterTransaction = async transaction => {
    if (injected) return
    const receipt = await transaction.tenantAuditReconciliationWork.findFirst({ where: f.scope })
    if (receipt?.completedRevision !== 2n) return
    assert.equal(await transaction.tenantLicense.count({ where: { ...f.scope, microsoftSkuId: oldSkuId } }), 0)
    assert.equal(await transaction.tenantLicense.count({ where: { ...f.scope, microsoftSkuId: f.skuId } }), 1)
    assert.ok(await transaction.changeEvidenceEvent.count({ where: f.scope }) > before.evidence)
    injected = true
    throw new Error('PHYSICAL_LICENSE_COMMIT_FAILURE')
  }
  await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner))
  assert.equal(injected, true)
  assert.deepEqual({ snapshot: await f.snapshot('LICENSES'), receipt: await f.receipts(),
    inventory: await f.observer.tenantLicense.findMany({ where: f.scope }),
    evidence: await f.observer.changeEvidenceEvent.count({ where: f.scope }) }, before)
  // A new license event uses the existing immediate retry policy; no fixture
  // changes scheduler cadence or turns an old failed receipt into success.
  await f.service.reconcileDirectoryAuditResources(f.tenant, 'synthetic-token', ['LICENSES'], f.owner)
  assert.equal((await f.receipts())[0].completedRevision, 2n)
  assert.equal(await f.observer.tenantLicense.count({ where: { ...f.scope, microsoftSkuId: oldSkuId } }), 0)
})

test('physical GROUPS takeover after definitions preserves memberships and receipt until successor recovery', {
  skip: !registeredCi, concurrency: false, timeout: 60_000,
}, async context => {
  const f = await physicalCollectorFixture(context)
  await f.enqueue(['GROUPS'])
  const oldUser = await f.database.directoryUser.create({ data: { ...f.scope, microsoftUserId: randomUUID(),
    displayName: 'Old group member', userPrincipalName: 'old@example.test' } })
  const group = await f.database.directoryGroup.create({ data: { ...f.scope, microsoftGroupId: f.groupId, displayName: 'Old group' } })
  await f.database.directoryGroupMembership.create({ data: { ...f.scope, directoryGroupId: group.id, directoryUserId: oldUser.id } })
  let successor: typeof f.owner | null = null
  f.hooks.beforeResponse = async url => {
    if (!url.includes(`/groups/${f.groupId}/members?`)) return
    f.hooks.beforeResponse = undefined
    assert.ok(await f.snapshot('GROUPS'), 'definition transaction must already be committed before the relationship race')
    assert.equal((await f.receipts())[0].completedRevision, 0n, 'definitions alone cannot acknowledge the request')
    assert.equal(await releaseTenantVisitLease(f.observer, f.owner), true)
    successor = await tryAcquireTenantVisitLease(f.observer, f.scope, 300_000)
    assert.ok(successor)
  }
  await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner), TenantVisitLeaseLostError)
  assert.equal((await f.receipts())[0].completedRevision, 0n)
  assert.deepEqual(await f.observer.directoryGroupMembership.findMany({ where: f.scope,
    select: { directoryUserId: true } }), [{ directoryUserId: oldUser.id }])
  assert.equal((await f.snapshot('GROUPS'))!.payload instanceof Array, true)
  assert.equal(Object.hasOwn(((await f.snapshot('GROUPS'))!.payload as object[])[0], 'owners'), false)
  assert.ok(successor)
  // Represent the next normally eligible recovery visit; do not weaken the
  // production RUNNING cooldown simply to make the test retry immediately.
  const providerCallsBeforeCooldown = f.providerCalls.length
  const snapshotBeforeCooldown = await f.snapshot('GROUPS')
  const receiptsBeforeCooldown = await f.receipts()
  await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], successor),
    AuditReconciliationIncompleteError)
  assert.equal(f.providerCalls.length, providerCallsBeforeCooldown, 'recent RUNNING work cannot make another provider request')
  assert.deepEqual(await f.snapshot('GROUPS'), snapshotBeforeCooldown)
  assert.deepEqual(await f.receipts(), receiptsBeforeCooldown)
  assert.deepEqual(await f.observer.directoryGroupMembership.findMany({ where: f.scope,
    select: { directoryUserId: true } }), [{ directoryUserId: oldUser.id }])
  await f.database.syncState.updateMany({ where: { ...f.scope, resourceType: 'GROUPS' },
    data: { lastAttemptAt: new Date(Date.now() - 2 * 60 * 60_000) } })
  await f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], successor)
  assert.equal((await f.receipts())[0].completedRevision, 2n)
  assert.deepEqual(await f.observer.directoryGroupMembership.findMany({ where: f.scope,
    select: { directoryUserId: true } }), [{ directoryUserId: f.directoryUser.id }])
  assert.deepEqual(((await f.snapshot('GROUPS'))!.payload as Array<{ owners: unknown[] }>)[0].owners,
    [{ id: f.userId, displayName: 'Owner' }])
})

test('physical domain failure leaves dependent DNS pending and later empty replay uses the new domain inventory', {
  skip: !registeredCi, concurrency: false, timeout: 60_000,
}, async context => {
  const f = await physicalCollectorFixture(context)
  await f.enqueue(['DOMAINS', 'DOMAIN_DNS_HEALTH'])
  await f.database.tenantDomain.create({ data: { ...f.scope, name: 'old.example.test', isDefault: true } })
  f.hooks.domainPartial = true
  await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner))
  assert.equal(f.dnsCalls.length, 0, 'DNS may not run against the retained old targets after domain failure')
  assert.ok((await f.receipts()).every(receipt => receipt.completedRevision === 0n))
  assert.deepEqual(await f.observer.tenantDomain.findMany({ where: f.scope, select: { name: true } }), [{ name: 'old.example.test' }])
  f.hooks.domainPartial = false
  await f.database.syncState.updateMany({ where: { ...f.scope, resourceType: 'DOMAINS' },
    data: { lastAttemptAt: new Date(Date.now() - 26 * 60 * 60_000) } })
  await f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner)
  assert.ok((await f.receipts()).every(receipt => receipt.completedRevision === 2n))
  assert.equal(f.dnsCalls.length, 4)
  assert.ok(f.dnsCalls.every(name => !name.includes('old.example.test')))
  assert.deepEqual(await f.observer.tenantDomain.findMany({ where: f.scope, select: { name: true } }), [{ name: 'example.test' }])
})

for (const resource of ['EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES'] as const) {
  test(`physical ${resource} collector rolls back its risk attestation together with snapshot and audit receipt`, {
    skip: !registeredCi, concurrency: false, timeout: 60_000,
  }, async context => {
    const f = await physicalCollectorFixture(context)
    await f.enqueue([resource])
    let injected = false
    f.hooks.afterTransaction = async transaction => {
      if (injected) return
      const receipt = await transaction.tenantAuditReconciliationWork.findFirst({ where: f.scope })
      if (receipt?.completedRevision !== 2n) return
      const snapshot = await transaction.tenantEntraSnapshot.findFirstOrThrow({ where: { ...f.scope, resourceType: resource } })
      const attestation = await transaction.tenantCollectionFieldState.findFirstOrThrow({ where: {
        ...f.scope, fieldKey: sourceAttestationKey(resource),
      } })
      assert.equal(attestation.state, 'COMPLETE')
      assert.equal(attestation.correlationId, mailboxSourceDigest(f.scope, resource, snapshot.observedAt, snapshot.payload))
      injected = true
      throw new Error('PHYSICAL_ATTESTATION_COMMIT_FAILURE')
    }
    await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner))
    assert.equal(injected, true)
    assert.equal(await f.snapshot(resource), null)
    assert.equal((await f.receipts())[0].completedRevision, 0n)
    assert.equal(await f.observer.tenantCollectionFieldState.count({ where: {
      ...f.scope, fieldKey: sourceAttestationKey(resource),
    } }), 0)
    await f.service.reconcileDirectoryAuditResources(f.tenant, 'synthetic-token', [resource], f.owner)
    assert.equal((await f.receipts())[0].completedRevision, 2n)
  })
}

for (const resource of ['EXCHANGE_MAILBOX_USAGE', 'SHAREPOINT_USAGE'] as const) {
  for (const redirected of [false, true]) {
    test(`physical ${resource} ${redirected ? 'downloaded' : 'direct'} CSV advances the exact receipt and rejects a partial replacement`, {
      skip: !registeredCi, concurrency: false, timeout: 60_000,
    }, async context => {
      const f = await physicalCollectorFixture(context)
      await f.enqueue([resource])
      f.hooks.csvRedirect = redirected
      await f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner)
      const before = await f.snapshot(resource)
      assert.ok(before)
      assert.match(JSON.stringify(before.payload), resource === 'EXCHANGE_MAILBOX_USAGE' ? /512/ : /1024/)
      assert.equal((await f.receipts())[0].completedRevision, 2n)
      await f.database.tenantAuditReconciliationWork.updateMany({ where: f.scope, data: { requestedRevision: 3n } })
      f.hooks.csvPartial = true
      await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner))
      assert.deepEqual(await f.snapshot(resource), before)
      const receipt = (await f.receipts())[0]
      assert.equal(receipt.requestedRevision, 3n)
      assert.equal(receipt.completedRevision, 2n)
      assert.equal(receipt.lastCompletedAt?.getTime(), before.observedAt.getTime())
    })
  }
}

for (const resource of AUDIT_RECONCILIATION_RESOURCES) {
  test(`physical ${resource} dispatched collector rejects takeover at publication and its successor completes the same request`, {
    skip: !registeredCi, concurrency: false, timeout: 60_000,
  }, async context => {
    const f = await physicalCollectorFixture(context)
    await f.enqueue([resource])
    if (resource === 'DOMAIN_DNS_HEALTH') {
      await f.database.tenantDomain.create({ data: { ...f.scope, name: 'example.test', isDefault: true } })
    }
    let successor: typeof f.owner | null = null
    const publish = f.service.saveSnapshot.bind(f.service)
    f.service.saveSnapshot = async (...args: unknown[]) => {
      assert.equal(args[1], resource)
      if (!successor) {
        // Pause the actual collector after it has read its source. The real
        // publication function still receives its original arguments and uses
        // real owner checks/SQL; no snapshot writer is replaced with a mock.
        assert.equal(await releaseTenantVisitLease(f.observer, f.owner), true)
        successor = await tryAcquireTenantVisitLease(f.observer, f.scope, 300_000)
        assert.ok(successor)
      }
      return publish(...args)
    }
    await assert.rejects(f.service.reconcileDirectoryAuditChanges(f.tenant, 'synthetic-token', [], f.owner), TenantVisitLeaseLostError)
    assert.ok(successor, 'the real collector must reach its publication boundary')
    assert.equal(await f.snapshot(resource), null)
    assert.equal((await f.receipts())[0].completedRevision, 0n)
    assert.equal(await f.observer.changeEvidenceEvent.count({ where: f.scope }), 0)
    assert.equal(await f.observer.tenantLicense.count({ where: f.scope }), 0)
    assert.equal(await f.observer.directoryGroup.count({ where: f.scope }), 0)
    assert.equal(await f.observer.tenantCollectionFieldState.count({ where: f.scope }), 0)
    const state = await f.observer.syncState.findUniqueOrThrow({ where: {
      customerTenantId_resourceType: { customerTenantId: f.tenant.id, resourceType: resource },
    } })
    assert.equal(state.status, 'RUNNING', 'displaced catch paths must not overwrite terminal state')
    assert.equal(state.lastSuccessfulAt, null)
    // A new source event authorizes an immediate existing-policy retry; the
    // durable request keeps its exact revision and must be completed by SQL.
    await f.service.reconcileDirectoryAuditResources(f.tenant, 'synthetic-token', [resource], successor)
    const snapshot = await f.snapshot(resource)
    assert.ok(snapshot)
    const receipt = (await f.receipts())[0]
    assert.equal(receipt.completedRevision, 2n)
    assert.equal(receipt.lastCompletedAt?.getTime(), snapshot.observedAt.getTime())
  })
}

for (const resource of ['SECURE_SCORES', 'EXCHANGE_MAILBOX_CONFIGURATION'] as const) {
  test(`physical ${resource} real collector rolls back publication and recovers after takeover`, {
    skip: !registeredCi, concurrency: false, timeout: 90_000,
  }, async context => {
    const f = await physicalCollectorFixture(context)
    const key = { customerTenantId_resourceType: { customerTenantId: f.tenant.id, resourceType: resource } }
    const readSnapshot = () => f.observer.tenantEntraSnapshot.findUniqueOrThrow({ where: key })
    const readState = () => f.observer.syncState.findUniqueOrThrow({ where: key })
    // Only source/token transport is synthetic. Keep the real secure-score
    // validator, Exchange two-page collector/projection, and publication SQL.
    const connection = await f.database.tenantConnection.update({
      where: { customerTenantId_organizationId: f.scope },
      data: { exchangeReadOnlyEnabledAt: new Date(), clientId: randomUUID(), credentialReference: 'synthetic-only' },
    })
    const target = { ...f.tenant, connection }
    const scoreDate = new Date(Date.now() - 60_000).toISOString()
    let version = 1, pages = 0
    f.service.microsoftConsent = { getTenantExchangeAccessToken: async () => 'synthetic-exchange-token' }
    f.service.fetchGraphPage = async (url: string, token: string, _label: string, options?: { init?: RequestInit }) => {
      pages++
      if (resource === 'SECURE_SCORES') {
        assert.equal(url, 'https://graph.microsoft.com/v1.0/security/secureScores?$top=1')
        assert.equal(token, 'synthetic-token')
        return Response.json({ value: [{ id: 'current-score', createdDateTime: scoreDate,
          currentScore: version * 10, maxScore: 100, controlScores: [{ excluded: 'not retained' }] }] })
      }
      assert.equal(token, 'synthetic-exchange-token')
      assert.equal(options?.init?.method, 'POST')
      assert.equal(JSON.parse(String(options?.init?.body)).CmdletInput.CmdletName, 'Get-Mailbox')
      assert.ok(url.startsWith(`https://outlook.office365.com/adminapi/v2.0/${f.tenant.microsoftTenantId}/Mailbox?`))
      const second = url.endsWith('page=second')
      return Response.json({ value: [{ ExternalDirectoryObjectId: second ? f.groupId : f.userId,
        UserPrincipalName: second ? 'other@example.test' : 'user@example.test',
        DisplayName: `Physical mailbox version ${version}`, MaxSendSize: `${version} MB`,
        GrantSendOnBehalfTo: ['delegate@example.test'], UnsupportedPreviewValue: 'must-not-persist' }],
      ...(!second ? { '@odata.nextLink': `https://outlook.office365.com/adminapi/v2.0/${f.tenant.microsoftTenantId}/Mailbox?page=second` } : {}) })
    }
    const run = (owner = f.owner) => resource === 'SECURE_SCORES'
      ? f.service.syncCurrentSecureScore(f.tenant, 'synthetic-token', owner)
      : f.service.syncExchangeMailboxConfiguration(target, owner)
    const payloadVersion = (snapshot: { payload: unknown }) => {
      const rows = snapshot.payload as Array<Record<string, unknown>>
      return resource === 'SECURE_SCORES' ? Number(rows[0].currentScore) / 10 : Number(String(rows[0].maxSendSize).split(' ')[0])
    }
    await run()
    const initial = await readSnapshot()
    const initialState = await readState()
    assert.equal(initialState.status, 'SUCCEEDED')
    assert.equal(pages, resource === 'SECURE_SCORES' ? 1 : 2)
    assert.equal(payloadVersion(initial), 1)
    assert.equal((initial.payload as unknown[]).length, resource === 'SECURE_SCORES' ? 1 : 2)
    assert.ok(!JSON.stringify(initial.payload).includes('must-not-persist'))
    assert.ok(!JSON.stringify(initial.payload).includes('controlScores'))
    const evidence = await f.observer.changeEvidenceEvent.findMany({ where: f.scope, orderBy: { id: 'asc' } })

    version = 2
    const rollback = new Error('Synthetic non-ledger snapshot transaction rollback')
    let reachedPublication = false
    f.hooks.afterTransaction = async transaction => {
      const snapshot = await transaction.tenantEntraSnapshot.findUnique({ where: key })
      if (snapshot && payloadVersion(snapshot) === 2) {
        reachedPublication = true
        throw rollback
      }
    }
    // runSnapshotSync translates ordinary collection errors into its existing
    // public failure, after the original snapshot transaction has rolled back.
    await assert.rejects(run())
    assert.equal(reachedPublication, true, 'the real collector must reach its actual snapshot writes')
    assert.deepEqual(await readSnapshot(), initial, 'failed publication preserves the prior complete snapshot')
    assert.deepEqual(await f.observer.changeEvidenceEvent.findMany({ where: f.scope, orderBy: { id: 'asc' } }), evidence)
    const failedState = await readState()
    assert.equal(failedState.status, 'FAILED')
    assert.equal(failedState.lastSuccessfulAt?.getTime(), initialState.lastSuccessfulAt?.getTime())
    f.hooks.afterTransaction = undefined

    let successor: typeof f.owner | null = null
    const publish = f.service.saveSnapshot.bind(f.service)
    f.service.saveSnapshot = async (...args: unknown[]) => {
      assert.equal(args[1], resource)
      if (!successor) {
        // The source body has been consumed and validated by the real
        // collector. Move ownership immediately before its real publication.
        assert.equal(await releaseTenantVisitLease(f.observer, f.owner), true)
        successor = await tryAcquireTenantVisitLease(f.observer, f.scope, 300_000)
        assert.ok(successor)
      }
      return publish(...args)
    }
    await assert.rejects(run(), TenantVisitLeaseLostError)
    assert.ok(successor)
    assert.deepEqual(await readSnapshot(), initial)
    assert.deepEqual(await f.observer.changeEvidenceEvent.findMany({ where: f.scope, orderBy: { id: 'asc' } }), evidence)
    const displacedState = await readState()
    assert.equal(displacedState.status, 'RUNNING', 'the displaced error path must not publish terminal state')
    assert.equal(displacedState.lastSuccessfulAt?.getTime(), initialState.lastSuccessfulAt?.getTime())
    await run(successor)
    assert.equal(payloadVersion(await readSnapshot()), 2)
    assert.equal((await readState()).status, 'SUCCEEDED')
    assert.equal(await f.observer.tenantAuditReconciliationWork.count({ where: f.scope }), 0,
      'non-ledger resources must not invent durable audit receipts')
  })
}

for (const kind of ['directory-audit', 'change-evidence'] as const) {
  test(`physical ${kind} retention rolls back, holds ownership through deletion, and rejects a displaced visitor`, {
    skip: !registeredCi, concurrency: false, timeout: 90_000,
  }, async context => {
    const f = await physicalCollectorFixture(context)
    const cutoff = new Date()
    const sibling = await f.database.customerTenant.create({ data: {
      organizationId: f.scope.organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE',
    } })
    const insert = async (customerTenantId: string, expiresAt: Date) => {
      const id = randomUUID()
      const common = { id, organizationId: f.scope.organizationId, customerTenantId,
        expiresAt, eventDateTime: new Date(cutoff.getTime() - 60_000), raw: { id } }
      if (kind === 'directory-audit') await f.database.directoryAuditLog.create({ data: {
        ...common, microsoftAuditId: id, activityDisplayName: 'Synthetic audit retention event',
      } })
      else await f.database.changeEvidenceEvent.create({ data: {
        ...common, source: 'DIRECTORY_AUDIT', sourceEventId: id, category: 'configuration',
        severity: 'info', operationName: 'Synthetic evidence retention event', summary: 'Synthetic retention fixture',
      } })
      return id
    }
    const expired = await insert(f.tenant.id, new Date(cutoff.getTime() - 1))
    const boundary = await insert(f.tenant.id, cutoff)
    const retained = await insert(f.tenant.id, new Date(cutoff.getTime() + 60_000))
    const foreign = await insert(sibling.id, new Date(cutoff.getTime() - 1))
    const readRows = (database: Prisma.TransactionClient | PrismaService) => kind === 'directory-audit'
      ? database.directoryAuditLog.findMany({ where: { organizationId: f.scope.organizationId }, orderBy: { id: 'asc' } })
      : database.changeEvidenceEvent.findMany({ where: { organizationId: f.scope.organizationId }, orderBy: { id: 'asc' } })
    const evidence = new ChangeEvidenceService(f.trackedDatabase)
    const prune = (owner = f.owner) => kind === 'directory-audit'
      ? f.service.pruneExpiredDirectoryAuditLogs(f.tenant, cutoff, owner)
      : evidence.pruneExpired(f.tenant.id, cutoff, owner)
    const before = await readRows(f.observer)
    const rollback = new Error('Synthetic retention transaction rollback')
    let reachedDelete = false
    f.hooks.afterTransaction = async transaction => {
      const ids = (await readRows(transaction)).map(row => row.id)
      assert.ok(!ids.includes(expired) && !ids.includes(boundary))
      assert.ok(ids.includes(retained) && ids.includes(foreign))
      reachedDelete = true
      throw rollback
    }
    // Evidence retention intentionally logs ordinary failures as best effort;
    // directory-audit retention propagates them. Both must roll back SQL.
    if (kind === 'directory-audit') await assert.rejects(prune(), error => error === rollback)
    else await prune()
    assert.equal(reachedDelete, true)
    assert.deepEqual(await readRows(f.observer), before)

    let reachedWrites!: () => void, releaseWrites!: () => void
    const writesReached = new Promise<void>(resolve => { reachedWrites = resolve })
    const mayCommit = new Promise<void>(resolve => { releaseWrites = resolve })
    f.hooks.afterTransaction = async transaction => {
      assert.deepEqual((await readRows(transaction)).map(row => row.id).sort(), [retained, foreign].sort())
      reachedWrites()
      await mayCommit
    }
    const pending = prune()
    try {
      await Promise.race([writesReached, pending.then(() => { throw new Error('Prune returned before held deletion') })])
      assert.deepEqual(await readRows(f.observer), before, 'uncommitted retention must remain invisible')
      assert.equal(await tryAcquireTenantVisitLease(f.observer, f.scope, 300_000), null,
        'contending admission must be busy while the guarded retention transaction owns its lock')
    } finally {
      releaseWrites()
      await pending
      f.hooks.afterTransaction = undefined
    }
    assert.deepEqual((await readRows(f.observer)).map(row => row.id).sort(), [retained, foreign].sort())
    const pendingExpiry = await insert(f.tenant.id, cutoff)
    assert.equal(await releaseTenantVisitLease(f.observer, f.owner), true)
    const successor = await tryAcquireTenantVisitLease(f.observer, f.scope, 300_000)
    assert.ok(successor)
    await assert.rejects(prune(f.owner), TenantVisitLeaseLostError,
      'known ownership loss must propagate even through best-effort evidence retention')
    assert.ok((await readRows(f.observer)).some(row => row.id === pendingExpiry))
    await prune(successor)
    assert.deepEqual((await readRows(f.observer)).map(row => row.id).sort(), [retained, foreign].sort())
  })
}

// Byte accounting is deliberately ownerless: the reservation brackets a real
// provider download, so fencing it would drop actual egress from the ceiling,
// and fencing the refund would strand a whole reservation. This witness pins
// that exception instead of changing it. The existing stage-body witnesses
// above observe the ledger only after readMeteredJson has already settled its
// refund, so none of them exercise a takeover inside that window.
test('physical displaced visitor refund cannot erase a successor charge or release real downloaded bytes', {
  skip: !registeredCi, concurrency: false, timeout: 90_000,
}, async context => {
  assertDisposableTestDatabase()
  const writer = new PrismaService()
  const observer = new PrismaService()
  let organizationId: string | null = null
  const configuredDailyMb = process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB
  context.after(async () => {
    // Restore the deployment's real quota value; this witness must not leak one.
    if (configuredDailyMb === undefined) delete process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB
    else process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB = configuredDailyMb
    try { if (organizationId) await observer.organization.deleteMany({ where: { id: organizationId } }) }
    finally { await Promise.all([writer.$disconnect(), observer.$disconnect()]) }
  })
  await Promise.all([writer.$connect(), observer.$connect()])
  const organization = await writer.organization.create({
    data: { name: 'M365 reservation settlement CI', slug: `m365-settlement-${randomUUID()}` },
  })
  organizationId = organization.id
  const tenant = await writer.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const scope = { organizationId, customerTenantId: tenant.id }
  const displaced = await tryAcquireTenantVisitLease(writer, scope, 300_000)
  assert.ok(displaced)

  const createContent = () => writer.m365ActivityContent.create({ data: {
    ...scope, contentType: 'Audit.Exchange', microsoftContentId: randomUUID(),
    contentUri: 'https://manage.office.com/synthetic-content',
    ledgerExpiresAt: new Date(Date.now() + 86_400_000),
  } })
  const blob = (id: string) => JSON.stringify([{
    Id: id, OrganizationId: tenant.microsoftTenantId, CreationTime: '2030-01-01T00:00:00.000Z',
    Operation: 'Set-Mailbox', Workload: 'Exchange', ResultStatus: 'Succeeded',
    UserId: 'admin@example.test', ObjectId: 'mailbox@example.test',
  }])
  // Each visitor reserves its whole remaining budget before reading, so the
  // refund it still owes is exactly `budget - body`. Both budgets stay under
  // MAX_CONTENT_RESPONSE_BYTES so the reservation equals the budget exactly.
  const displacedBody = blob(randomUUID())
  const successorBody = blob(randomUUID())
  const displacedBudget = 4_096
  const successorBudget = 2_048
  const displacedBytes = Buffer.byteLength(displacedBody)
  const successorBytes = Buffer.byteLength(successorBody)
  assert.ok(displacedBytes > 0 && displacedBytes < displacedBudget,
    'the displaced body must leave an unused reservation to refund')
  assert.ok(successorBytes > 0 && successorBytes < successorBudget,
    'the successor body must leave an unused reservation to refund')

  const visitor = (body: string) => {
    const service = new M365ManagementActivityService(writer, {} as never) as any
    service.request = async () => new Response(body)
    return service
  }
  const ledgerBytes = async () => (await observer.m365AuditDailyUsage.aggregate({
    where: scope, _sum: { downloadedBytes: true },
  }))._sum.downloadedBytes ?? 0n

  const displacedContent = await createContent()
  const successorContent = await createContent()
  const displacedService = visitor(displacedBody)
  let atReservation = 0n
  let afterSuccessor = 0n

  // Only the interleaving point is synthetic. Both accounting writes stay the
  // production helpers: the reservation already committed untouched, and the
  // real refund still runs through `settleRefund` at the end of this hook.
  const settleRefund = displacedService.releaseUnusedDownloadReservation.bind(displacedService)
  displacedService.releaseUnusedDownloadReservation = async (...args: unknown[]) => {
    atReservation = await ledgerBytes()
    // Expire the old visit and let a successor win the lease, exactly between
    // the displaced visitor's reservation and the refund it still owes.
    await writer.$executeRawUnsafe(
      `UPDATE tenant_sync_visit_leases SET expires_at = clock_timestamp() - interval '1 second'
       WHERE customer_tenant_id=$1::uuid AND organization_id=$2::uuid`,
      scope.customerTenantId, scope.organizationId)
    const nextOwner = await tryAcquireTenantVisitLease(writer, scope, 300_000)
    assert.ok(nextOwner, 'an expired visit must admit a successor')
    assert.equal(nextOwner.generation, displaced.generation + 1n,
      'the successor must win a new lease generation')
    await visitor(successorBody).processContent(
      tenant, 'synthetic-token', nextOwner.token, { remainingBytes: successorBudget },
      successorContent, Date.now() + 60_000, nextOwner)
    afterSuccessor = await ledgerBytes()
    return settleRefund(...args)
  }

  await assert.rejects(
    displacedService.processContent(
      tenant, 'synthetic-token', displaced.token, { remainingBytes: displacedBudget },
      displacedContent, Date.now() + 60_000, displaced),
    TenantVisitLeaseLostError,
    'the displaced visitor must lose its materialization to the successor')

  // Charged is never below actually downloaded, at every observation.
  assert.equal(atReservation, BigInt(displacedBudget),
    'the displaced visitor charges its whole reservation before reading the body')
  assert.equal(afterSuccessor, BigInt(displacedBudget + successorBytes),
    'the successor settles into the same tenant/day ledger while the old reservation is outstanding')
  const settled = await ledgerBytes()
  assert.equal(settled, BigInt(displacedBytes + successorBytes),
    'the old refund returns only its own unused reservation')
  assert.equal(settled - BigInt(successorBytes), BigInt(displacedBytes),
    'the rejected visitor still accounts for every byte it actually downloaded')
  assert.ok(settled >= BigInt(successorBytes),
    'a displaced refund can never erase the successor charge')

  // The rejected materialization stored nothing, yet its egress stayed charged.
  assert.equal(await observer.m365AuditRecord.count({ where: scope }), 1,
    'only the successor materialized a record')
  const stored = await observer.m365AuditDailyUsage.aggregate({
    where: scope, _sum: { recordsStored: true, blobsProcessed: true },
  })
  assert.equal(stored._sum.recordsStored, 1, 'rolled-back record accounting stays uncommitted')
  assert.equal(stored._sum.blobsProcessed, 1, 'rolled-back blob accounting stays uncommitted')

  const dayRows = await observer.m365AuditDailyUsage.findMany({ where: scope })
  assert.equal(dayRows.length, 1, 'both visitors settled into one UTC day ledger row')
  const usageDate = dayRows[0].usageDate

  // The counterfactual must isolate the displaced visitor's retained bytes. A
  // control ledger is seeded with exactly the successor charge, and the request
  // is sized so that it lands precisely on a one-megabyte ceiling there. The
  // two arms then differ only by `displacedBytes`.
  const controlTenant = await writer.customerTenant.create({
    data: { organizationId, microsoftTenantId: randomUUID(), status: 'ACTIVE' },
  })
  const controlLedger = () => observer.m365AuditDailyUsage.findUniqueOrThrow({
    where: { customerTenantId_usageDate: { customerTenantId: controlTenant.id, usageDate } },
  })
  await displacedService.reserveDailyUsage(controlTenant, { bytes: successorBytes }, usageDate)
  assert.equal((await controlLedger()).downloadedBytes, BigInt(successorBytes),
    'the control ledger holds the successor charge and nothing else')

  const ceilingBytes = 1024 * 1024
  const probeBytes = ceilingBytes - successorBytes
  assert.ok(probeBytes > 0, 'the probe must request a positive byte count')
  process.env.M365_AUDIT_TENANT_DAILY_DOWNLOAD_MB = '1'

  // The overlap ledger holds displacedBytes + successorBytes, so this request
  // exceeds the ceiling by exactly displacedBytes. Requesting a whole megabyte
  // would be refused by the successor charge alone and would prove nothing.
  await assert.rejects(
    displacedService.reserveDailyUsage(tenant, { bytes: probeBytes }, usageDate),
    (error: unknown) => error instanceof M365AuditBudgetError && /daily/.test(error.message),
    'the displaced visitor retained bytes alone must refuse this reservation')
  assert.equal(await ledgerBytes(), BigInt(displacedBytes + successorBytes),
    'a refused reservation leaves the overlap ledger unchanged')

  // Control arm: the identical request against a ledger holding only the
  // successor charge lands exactly on the ceiling and is admitted, so the
  // refusal above cannot be attributed to the limit or the successor charge.
  await displacedService.reserveDailyUsage(controlTenant, { bytes: probeBytes }, usageDate)
  assert.equal((await controlLedger()).downloadedBytes, BigInt(ceilingBytes),
    'the identical request is admitted at exactly the ceiling without the displaced bytes')
})

/**
 * The interrupted ORDINARY full inventory: a GROUPS collector displaced
 * mid-attempt, with NO pending audit-reconciliation request and NO new
 * directory-audit event. This is the one shape the durable audit replay cannot
 * reach, because nothing ever asked for a GROUPS refresh -- the sibling
 * takeover witness above enqueues one deliberately. The absence is constructed
 * here; it is not a claim about any production tenant.
 *
 * Every other daily resource and both anchors are PERSISTED fresh, and the
 * candidate predicate is EXECUTED against those rows rather than evaluated in
 * memory, so the case fails if the real query cannot find the tenant.
 */
test('physical interrupted ordinary GROUPS inventory recovers under a newly acquired fenced visit with no audit request', {
  skip: !registeredCi, concurrency: false, timeout: 90_000,
}, async context => {
  const f = await physicalCollectorFixture(context)
  // Deliberately no f.enqueue(...): the durable replay has nothing to select.
  assert.deepEqual(await f.receipts(), [], 'no pending audit reconciliation request may exist')
  assert.deepEqual(await selectPendingAuditReconciliationWork(f.database, f.scope, f.owner,
    AUDIT_RECONCILIATION_RESOURCES.length), [])

  const clock = new Date()
  const interruptedAt = new Date(clock.getTime() - 26 * 60 * 60_000)
  const earlierSuccess = new Date(clock.getTime() - 27 * 60 * 60_000)
  const fresh = new Date(clock.getTime() - 60_000)
  // Other inventories stay current through targeted events and hourly
  // catch-up, so nothing but the interrupted row may make this tenant due.
  await f.database.syncState.createMany({ data: [
    ...dailyInventoryResources(false).filter(resource => resource !== 'GROUPS'),
    ...DAILY_INVENTORY_ANCHORS,
  ].map(resourceType => ({ ...f.scope, resourceType, status: 'SUCCEEDED' as const,
    lastAttemptAt: fresh, lastSuccessfulAt: fresh })) })
  // Exactly what runSnapshotSync leaves behind when a worker never reaches a
  // terminal write: RUNNING, an old attempt clock, a preserved earlier
  // success, and error fields the attempt marker itself cleared.
  await f.database.syncState.create({ data: { ...f.scope, resourceType: 'GROUPS', status: 'RUNNING',
    lastAttemptAt: interruptedAt, lastSuccessfulAt: earlierSuccess,
    lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 } })

  const stored = () => f.observer.syncState.findUniqueOrThrow({
    where: { customerTenantId_resourceType: { customerTenantId: f.tenant.id, resourceType: 'GROUPS' } },
    select: { resourceType: true, status: true, lastAttemptAt: true, lastSuccessfulAt: true,
      lastErrorCode: true, lastErrorMessage: true, consecutiveFailures: true },
  })
  /** Runs the REAL candidate predicate, narrowed to this tenant so unrelated
   *  rows in the disposable database cannot decide the outcome. */
  const isCandidate = async (recoverAbandoned: boolean) => (await f.observer.customerTenant.findMany({
    where: { AND: [
      scheduledSyncTenantWhere(clock, TWENTY_MINUTE_INVENTORY_REFRESH_MS, recoverAbandoned),
      { id: f.tenant.id },
    ] },
    select: { id: true },
  })).length === 1

  assert.equal(await isCandidate(false), false,
    'with every other inventory fresh the existing query cannot find this tenant at all')
  assert.equal(await isCandidate(true), true,
    'the owned full20 candidate query must find the interrupted row')
  // Decide the dispatch gate from the DURABLE row, not a literal, so a column
  // default or a timestamp round-trip cannot make the rule look satisfied.
  const interrupted = await stored()
  assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(interrupted, clock), false,
    'the existing ownerless full-pass policy is unchanged for the real row')
  assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(interrupted, clock, true), true)

  // A displaced old owner can neither resurrect the row nor clear it.
  assert.equal(await releaseTenantVisitLease(f.database, f.owner), true)
  const successor = await tryAcquireTenantVisitLease(f.database, f.scope, 300_000)
  assert.ok(successor)
  const providerCallsBeforeDisplaced = f.providerCalls.length
  await assert.rejects(f.service.syncGroups(f.tenant, 'synthetic-token', f.owner), TenantVisitLeaseLostError)
  assert.deepEqual(await stored(), interrupted, 'the displaced owner must not change the durable row')
  assert.equal(f.providerCalls.length, providerCallsBeforeDisplaced,
    'a displaced owner must make no provider request')

  // The newly acquired fenced visit performs the recovery itself.
  await f.service.syncGroups(f.tenant, 'synthetic-token', successor)
  const recovered = await stored()
  assert.equal(recovered.status, 'SUCCEEDED')
  assert.equal(recovered.lastErrorCode, null)
  assert.equal(recovered.lastErrorMessage, null)
  assert.ok(recovered.lastSuccessfulAt! > earlierSuccess, 'recovery must advance the success clock')
  assert.ok(recovered.lastAttemptAt! > interruptedAt, 'recovery must advance the attempt clock')
  assert.ok((await f.snapshot('GROUPS'))!.payload instanceof Array)
  assert.deepEqual(await f.observer.directoryGroupMembership.findMany({ where: f.scope,
    select: { directoryUserId: true } }), [{ directoryUserId: f.directoryUser.id }])
  // Recovery must not fabricate a receipt for a request that never existed.
  assert.deepEqual(await f.receipts(), [])
  // Nothing is due any more, so the recovery cannot become a repeating loop.
  assert.equal(await isCandidate(true), false)

  // EXCHANGE_MAILBOX_CONFIGURATION keeps its existing connection gate: the
  // same interrupted shape must not schedule a tenant with Exchange read-only
  // disabled, and must schedule it once that access is enabled.
  await f.database.syncState.create({ data: { ...f.scope, resourceType: 'EXCHANGE_MAILBOX_CONFIGURATION',
    status: 'RUNNING', lastAttemptAt: interruptedAt, lastSuccessfulAt: earlierSuccess,
    lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 } })
  assert.equal(await isCandidate(true), false,
    'an old configuration row must not schedule a tenant with Exchange read-only disabled')
  await f.database.tenantConnection.updateMany({ where: f.scope,
    data: { exchangeReadOnlyEnabledAt: new Date(clock.getTime() - 86_400_000) } })
  assert.equal(await isCandidate(true), true,
    'once Exchange read-only is enabled the same row becomes a candidate')
  assert.equal(await isCandidate(false), false, 'and only under the gate')
})
