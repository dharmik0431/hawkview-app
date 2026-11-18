import assert from 'node:assert/strict'
import test from 'node:test'
import { M365ActivityDeadlineError, M365ManagementActivityService } from './m365-management-activity.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

const tenant = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  microsoftTenantId: '33333333-3333-3333-3333-333333333333',
  connection: { connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null },
}
const owner = {
  customerTenantId: tenant.id,
  organizationId: tenant.organizationId,
  token: '44444444-4444-4444-4444-444444444444',
  generation: 4n,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
}
const content = {
  id: '55555555-5555-5555-5555-555555555555',
  contentType: 'Audit.Exchange',
  microsoftContentId: 'blob-1',
  contentUri: 'https://manage.office.com/synthetic-content',
  attemptCount: 0,
}

function durableContentHarness(options: {
  alreadyStored?: string[]; failAt?: 'work' | 'evidence' | 'completion'; supportingOnly?: boolean
} = {}) {
  let state = {
    raw: options.alreadyStored ?? [], evidence: [] as string[], status: 'PENDING', charged: 0,
    work: { EXCHANGE_MAILBOXES: { requested: 4n, completed: 4n } } as Record<string, { requested: bigint; completed: bigint }>,
  }
  const prisma: any = {
    // A stale existence read cannot decide which cross-blob duplicates are new.
    m365AuditRecord: { findMany: async () => [] },
    $transaction: async (work: (transaction: any) => Promise<unknown>) => {
      const candidate = structuredClone(state)
      const transaction: any = {
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
          if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
          if (sql.includes('FROM tenant_sync_visit_leases')) return [{ generation: owner.generation.toString() }]
          assert.fail(`Unexpected owner query ${sql}`)
        },
        m365AuditRecord: { createManyAndReturn: async ({ data, select, skipDuplicates }: any) => {
          assert.deepEqual(select, { microsoftRecordId: true })
          assert.equal(skipDuplicates, true)
          const inserted = data.filter(({ microsoftRecordId }: any) => !candidate.raw.includes(microsoftRecordId))
          candidate.raw.push(...inserted.map(({ microsoftRecordId }: any) => microsoftRecordId))
          return inserted.map(({ microsoftRecordId }: any) => ({ microsoftRecordId }))
        } },
        tenantAuditReconciliationWork: { upsert: async ({ where, create, update }: any) => {
          if (options.failAt === 'work') throw new Error('synthetic durable work failure')
          const key = where.organizationId_customerTenantId_resourceType
          assert.equal(key.organizationId, tenant.organizationId)
          assert.equal(key.customerTenantId, tenant.id)
          assert.deepEqual(create, key)
          assert.deepEqual(update, { requestedRevision: { increment: 1n } })
          const previous = candidate.work[key.resourceType]
          candidate.work[key.resourceType] = { requested: previous ? previous.requested + 1n : 1n, completed: previous?.completed ?? 0n }
        } },
        changeEvidenceEvent: { createMany: async ({ data }: any) => {
          if (options.failAt === 'evidence') throw new Error('synthetic evidence failure')
          candidate.evidence.push(...data.map(({ sourceEventId }: any) => sourceEventId))
        } },
        m365ActivityContent: {
          updateMany: async ({ data }: any) => { candidate.status = data.status; return { count: 1 } },
          update: async ({ data }: any) => {
            if (options.failAt === 'completion') throw new Error('synthetic completion failure')
            candidate.status = data.status
          },
        },
        charge: (records: number) => { candidate.charged += records },
      }
      const result = await work(transaction)
      state = candidate
      return result
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  const records = options.supportingOnly
    ? [{ Id: 'supporting', Operation: 'MailItemsAccessed', Workload: 'Exchange' }]
    : [
        { Id: 'exchange-1', Operation: 'Set-Mailbox', Workload: 'Exchange' },
        { Id: 'exchange-2', Operation: 'Set-Mailbox', Workload: 'Exchange' },
        { Id: 'site-1', Operation: 'Set-SPOTenant', Workload: 'SharePoint' },
      ]
  ;(service as any).request = async () => new Response(JSON.stringify(records.map((record) => ({
    ...record, OrganizationId: tenant.microsoftTenantId, CreationTime: '2026-11-14T12:30:00.000Z',
    ResultStatus: 'Succeeded', UserId: 'admin@example.test', ObjectId: 'target@example.test',
  }))))
  ;(service as any).reserveDailyUsage = async () => undefined
  ;(service as any).releaseUnusedDownloadReservation = async () => undefined
  ;(service as any).reserveUsageInTransaction = async (transaction: any, scope: any, usage: any) => {
    assert.equal(scope, tenant)
    transaction.charge(usage.records)
  }
  return { state: () => state, collect: () => (service as any).processContent(
    tenant, 'synthetic-token', owner.token, { remainingBytes: 1024 * 1024 }, content, Date.now() + 60_000, owner,
  ) }
}

test('M365 raw commit durably coalesces refresh requests and preserves completed revisions', async () => {
  const harness = durableContentHarness()
  assert.equal((await harness.collect()).length, 3)
  assert.equal(harness.state().status, 'COMPLETED')
  assert.equal(harness.state().charged, 3)
  assert.equal(harness.state().raw.length, 3)
  assert.equal(harness.state().evidence.length, 3)
  assert.deepEqual(harness.state().work.EXCHANGE_MAILBOXES, { requested: 5n, completed: 4n })
  assert.equal(Object.keys(harness.state().work).length, 8)
  for (const revision of Object.values(harness.state().work)) assert.ok(revision.requested > revision.completed)
})

test('M365 cross-blob duplicates cannot increment refresh revisions after a stale existence read', async () => {
  const harness = durableContentHarness({ alreadyStored: ['exchange-1', 'exchange-2'] })
  const changes = await harness.collect()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].loggedByService, 'SharePoint')
  assert.deepEqual(harness.state().work.EXCHANGE_MAILBOXES, { requested: 4n, completed: 4n })
  assert.equal(harness.state().charged, 1)
  assert.equal(Object.keys(harness.state().work).length, 4)
})

for (const failAt of ['work', 'evidence', 'completion'] as const) {
  test(`M365 ${failAt} failure rolls back raw rows, refresh work, evidence and accounting`, async () => {
    const harness = durableContentHarness({ failAt })
    assert.deepEqual(await harness.collect(), [])
    assert.deepEqual(harness.state().raw, [])
    assert.deepEqual(harness.state().evidence, [])
    assert.deepEqual(harness.state().work, { EXCHANGE_MAILBOXES: { requested: 4n, completed: 4n } })
    assert.equal(harness.state().charged, 0)
    assert.equal(harness.state().status, 'RETRY')
  })
}

test('M365 supporting telemetry is retained without authoritative refresh work', async () => {
  const harness = durableContentHarness({ supportingOnly: true })
  assert.deepEqual(await harness.collect(), [])
  assert.equal(harness.state().raw.length, 1)
  assert.deepEqual(harness.state().evidence, [])
  assert.deepEqual(harness.state().work, { EXCHANGE_MAILBOXES: { requested: 4n, completed: 4n } })
  assert.equal(harness.state().status, 'COMPLETED')
})

for (const stale of [true, false]) {
  test(`M365 content ${stale ? 'rejects a superseded claim before the provider request' : 'checks the live visit at claim and commit'}`, async () => {
    const writes: string[] = []
    let ownerChecks = 0
    let providerRequests = 0
    let insideTransaction = false
    const transaction: any = {
      $queryRawUnsafe: async (sql: string) => {
        assert.equal(insideTransaction, true)
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          ownerChecks += 1
          return stale ? [] : [{ generation: '4' }]
        }
        assert.fail(`Unexpected owner query: ${sql}`)
      },
      m365AuditRecord: { createManyAndReturn: async ({ data }: any) => {
        writes.push('tx:raw')
        return data.map(({ microsoftRecordId }: any) => ({ microsoftRecordId }))
      } },
      tenantAuditReconciliationWork: { upsert: async () => { writes.push('tx:reconciliation') } },
      changeEvidenceEvent: { createMany: async () => { writes.push('tx:evidence') } },
      m365ActivityContent: {
        updateMany: async () => {
          assert.ok(ownerChecks > 0, 'claim must follow the exact-owner check')
          writes.push('tx:PROCESSING')
          return { count: 1 }
        },
        update: async () => { writes.push('tx:COMPLETED') },
      },
    }
    const prisma: any = {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
        insideTransaction = true
        try { return await work(transaction) } finally { insideTransaction = false }
      },
      m365ActivityContent: { updateMany: async () => assert.fail('owned claim must not commit outside the visit transaction') },
      m365AuditRecord: { findMany: async () => [] },
    }
    const service = new M365ManagementActivityService(prisma, {} as never)
    ;(service as any).request = async () => {
      providerRequests += 1
      return new Response(JSON.stringify([{
        Id: 'record-1', OrganizationId: tenant.microsoftTenantId,
        CreationTime: '2026-08-17T12:30:00.000Z', Operation: 'Set-Mailbox',
        Workload: 'Exchange', ResultStatus: 'Succeeded', UserId: 'admin@example.test',
        ObjectId: 'mailbox@example.test',
      }]))
    }
    ;(service as any).reserveDailyUsage = async () => undefined
    ;(service as any).releaseUnusedDownloadReservation = async () => undefined
    ;(service as any).reserveUsageInTransaction = async () => { writes.push('tx:usage') }

    const collect = () => (service as any).processContent(
      tenant, 'synthetic-token', owner.token, { remainingBytes: 1024 * 1024 },
      content, Date.now() + 60_000, owner,
    )
    if (stale) {
      await assert.rejects(collect, TenantVisitLeaseLostError)
      assert.deepEqual(writes, [])
      assert.equal(providerRequests, 0)
    } else {
      const changes = await collect()
      assert.equal(changes.length, 1)
      assert.deepEqual(writes, [
        'tx:PROCESSING', 'tx:raw', ...Array<string>(5).fill('tx:reconciliation'), 'tx:usage', 'tx:evidence', 'tx:COMPLETED',
      ])
      assert.equal(providerRequests, 1)
    }
    assert.equal(ownerChecks, stale ? 1 : 2, 'claim and materialization must validate the exact owner')
  })
}

test('M365 content failure after visit takeover cannot downgrade a successor completion', async () => {
  let ownerLive = true
  let ownerChecks = 0
  let status = 'PENDING'
  let staleCatchWrites = 0
  const transaction: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        ownerChecks += 1
        return ownerLive ? [{ generation: owner.generation.toString() }] : []
      }
      assert.fail(`Unexpected owner query: ${sql}`)
    },
    m365ActivityContent: {
      updateMany: async () => {
        status = 'PROCESSING'
        return { count: 1 }
      },
    },
  }
  const prisma: any = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
    m365ActivityContent: {
      updateMany: async ({ where, data }: any) => {
        assert.equal(where.id, content.id)
        assert.equal(where.organizationId, tenant.organizationId)
        assert.equal(where.customerTenantId, tenant.id)
        if (where.status && where.status !== status) return { count: 0 }
        staleCatchWrites += 1
        status = data.status
        return { count: 1 }
      },
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  ;(service as any).request = async () => {
    // A claimed the row, then B took over and committed its own completion.
    // A's ordinary request failure must not replace B's terminal checkpoint.
    ownerLive = false
    status = 'COMPLETED'
    throw new Error('synthetic provider read failure after takeover')
  }
  let outcome: unknown
  try {
    await (service as any).processContent(
      tenant, 'synthetic-token', owner.token, { remainingBytes: 1024 * 1024 },
      content, Date.now() + 60_000, owner,
    )
  } catch (error) {
    outcome = error
  }
  assert.equal(status, 'COMPLETED', 'old failure handling must preserve the successor checkpoint')
  assert.equal(staleCatchWrites, 0, 'the superseded visitor must not issue an ownerless status write')
  assert.ok(outcome instanceof TenantVisitLeaseLostError, 'exact owner loss must propagate')
  assert.equal(ownerChecks, 2, 'claim and failure disposition must each check the exact owner')
})

for (const replacedClaim of [false, true]) {
  test(`M365 content failure ${replacedClaim ? 'rejects a replaced claim' : 'marks only its own live claim for retry'}`, async () => {
    let status = 'PENDING'
    let attemptCount = 0
    let ownerChecks = 0
    let dispositionWrites = 0
    const transaction: any = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          ownerChecks += 1
          return [{ generation: owner.generation.toString() }]
        }
        assert.fail(`Unexpected owner query: ${sql}`)
      },
      m365ActivityContent: {
        updateMany: async ({ where, data }: any) => {
          if (data.status === 'PROCESSING') {
            assert.deepEqual(where.status, { in: ['PENDING', 'RETRY'] })
            status = 'PROCESSING'
            attemptCount += 1
            return { count: 1 }
          }
          assert.equal(where.id, content.id)
          assert.equal(where.organizationId, tenant.organizationId)
          assert.equal(where.customerTenantId, tenant.id)
          assert.equal(where.status, 'PROCESSING')
          if (where.status !== status || where.attemptCount !== attemptCount) return { count: 0 }
          dispositionWrites += 1
          status = data.status
          return { count: 1 }
        },
      },
    }
    const prisma: any = {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      m365ActivityContent: {
        updateMany: async () => assert.fail('owned failure must stay inside the visit transaction'),
      },
    }
    const service = new M365ManagementActivityService(prisma, {} as never)
    ;(service as any).request = async () => {
      if (replacedClaim) attemptCount += 1
      throw new Error('synthetic ordinary provider failure')
    }
    const collect = () => (service as any).processContent(
      tenant, 'synthetic-token', owner.token, { remainingBytes: 1024 * 1024 },
      content, Date.now() + 60_000, owner,
    )
    if (replacedClaim) {
      await assert.rejects(collect, TenantVisitLeaseLostError)
      assert.equal(status, 'PROCESSING')
      assert.equal(dispositionWrites, 0)
    } else {
      assert.deepEqual(await collect(), [])
      assert.equal(status, 'RETRY')
      assert.equal(dispositionWrites, 1)
    }
    assert.equal(ownerChecks, 2, 'claim and failure disposition must each check the exact owner')
  })
}

test('M365 content rejects a cross-tenant owner before claiming a blob', async () => {
  const prisma: any = {
    m365ActivityContent: { updateMany: async () => assert.fail('must not claim under a foreign owner') },
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  await assert.rejects(
    () => (service as any).processContent(
      tenant, 'synthetic-token', owner.token, { remainingBytes: 1024 * 1024 },
      content, Date.now() + 60_000, { ...owner, customerTenantId: '66666666-6666-6666-6666-666666666666' },
    ),
    TenantVisitLeaseLostError,
  )
})

test('M365 content GET retry refuses a superseded visitor before another provider request', async () => {
  let ownerLive = true
  let ownerChecks = 0
  let providerRequests = 0
  const prisma: any = {
    $transaction: async (work: any) => work({
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          ownerChecks += 1
          return ownerLive ? [{ generation: owner.generation.toString() }] : []
        }
        assert.fail(`Unexpected owner query: ${sql}`)
      },
    }),
  }
  const service = new M365ManagementActivityService(prisma, {} as never)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    providerRequests += 1
    if (providerRequests === 1) {
      // The first GET was legitimate. A successor takes over while the old
      // visitor is waiting to retry its retryable response.
      ownerLive = false
      return new Response('temporarily unavailable', {
        status: 503, headers: { 'Retry-After': '0' },
      })
    }
    return new Response('[]')
  }
  try {
    let requestError: unknown
    try {
      await (service as any).request(
        `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/content`,
        { headers: { Authorization: 'Bearer synthetic-token' } },
        tenant.microsoftTenantId, owner.token, Date.now() + 10_000, owner,
      )
    } catch (error) {
      requestError = error
    }
    assert.equal(providerRequests, 1, 'the old visitor must not issue a second GET after takeover')
    assert.ok(requestError instanceof TenantVisitLeaseLostError, 'owner loss must escape the request retry loop')
    assert.equal(ownerChecks, 2, 'each GET attempt needs a fresh exact-owner preflight')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('M365 content request does not start after owner preflight consumes its deadline', async () => {
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  let now = 1_000
  let ownerChecks = 0
  let providerRequests = 0
  Date.now = () => now
  globalThis.fetch = async () => { providerRequests += 1; return new Response('[]') }
  const prisma: any = {
    $transaction: async (work: any) => {
      const result = await work({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
          if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
          if (sql.includes('FROM tenant_sync_visit_leases')) {
            ownerChecks += 1
            return [{ generation: owner.generation.toString() }]
          }
          assert.fail(`Unexpected owner query: ${sql}`)
        },
      })
      now = 2_000
      return result
    },
  }
  try {
    const service = new M365ManagementActivityService(prisma, {} as never)
    await assert.rejects(
      () => (service as any).request(
        `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/content`,
        { headers: { Authorization: 'Bearer synthetic-token' } },
        tenant.microsoftTenantId, owner.token, 1_500, owner,
      ),
      M365ActivityDeadlineError,
    )
    assert.equal(ownerChecks, 1)
    assert.equal(providerRequests, 0)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})
