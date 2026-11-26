import assert from 'node:assert/strict'
import test from 'node:test'
import { M365_ACTIVITY_CONTENT_TYPES, M365AuditBudgetError, M365ManagementActivityService } from './m365-management-activity.service.js'
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

for (const lostAt of ['initial-running', 'interrupted-recovery'] as const) {
  test(`M365 audit visit loss before ${lostAt} cannot write a stale state`, async () => {
    const writes: string[] = []
    let ownerChecks = 0
    let providerCalls = 0
    const transaction: any = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          ownerChecks += 1
          return lostAt === 'initial-running' || ownerChecks === 2
            ? [] : [{ generation: '4' }]
        }
        assert.fail(`Unexpected lease query: ${sql}`)
      },
      syncState: { upsert: async () => { writes.push('RUNNING') }, updateMany: async () => ({ count: 1 }) },
      m365ActivityContent: { updateMany: async () => { writes.push('recovery') } },
    }
    const prisma: any = {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      syncState: {
        findUnique: async () => null,
        upsert: async () => { writes.push('RUNNING') },
        update: async () => { writes.push('FAILED') },
        // A terminal failure clears this attempt observation, token-guarded.
        updateMany: async () => ({ count: 1 }),
      },
      m365ActivityContent: {
        count: async () => 1,
        updateMany: async () => {
          writes.push('recovery')
          assert.fail('lease loss must stop before interrupted-content recovery')
        },
      },
    }
    const consent: any = {
      getTenantManagementActivityContext: async () => {
        providerCalls += 1
        if (lostAt === 'initial-running') assert.fail('lease loss must stop before provider access')
        return { accessToken: 'synthetic-token', publisherIdentifier: owner.token }
      },
    }
    const service = new M365ManagementActivityService(prisma, consent)

    await assert.rejects(() => service.syncTenant(tenant, owner), TenantVisitLeaseLostError)
    assert.deepEqual(writes, lostAt === 'initial-running' ? [] : ['RUNNING'])
    assert.equal(ownerChecks, lostAt === 'initial-running' ? 1 : 2)
    assert.equal(providerCalls, lostAt === 'initial-running' ? 0 : 1)
  })
}

for (const loseAtTerminal of [true, false]) {
  test(`M365 audit terminal writes ${loseAtTerminal ? 'reject a superseded owner' : 'share the live owner transaction'}`, async () => {
    const writes: string[] = []
    let ownerChecks = 0
    let insideTransaction = false
    const transaction: any = {
      $queryRawUnsafe: async (sql: string) => {
        assert.equal(insideTransaction, true)
        if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
        if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
        if (sql.includes('FROM tenant_sync_visit_leases')) {
          ownerChecks += 1
          return loseAtTerminal && ownerChecks === 3 ? [] : [{ generation: '4' }]
        }
        assert.fail(`Unexpected lease query: ${sql}`)
      },
      syncState: {
        updateMany: async () => ({ count: 1 }),
        upsert: async () => { writes.push('tx:RUNNING') },
        update: async () => { writes.push('tx:terminal-state') },
      },
      m365ActivityContent: {
        updateMany: async () => { writes.push('tx:recovery') },
        deleteMany: async () => { writes.push('tx:content-cleanup') },
      },
      m365AuditRecord: { deleteMany: async () => { writes.push('tx:record-cleanup') } },
      m365AuditDailyUsage: { deleteMany: async () => { writes.push('tx:usage-cleanup') } },
    }
    const prisma: any = {
      $transaction: async (work: any) => {
        if (Array.isArray(work)) return Promise.all(work)
        insideTransaction = true
        try { return await work(transaction) } finally { insideTransaction = false }
      },
      syncState: {
        findUnique: async () => null,
        upsert: async () => { writes.push('root:RUNNING') },
        update: async () => { writes.push('root:terminal-state') },
      },
      m365ActivityContent: {
        count: async ({ where }: any) => where.OR ? 1 : 0,
        updateMany: async () => { writes.push('root:recovery') },
        findMany: async () => [],
        deleteMany: async () => { writes.push('root:content-cleanup') },
      },
      m365AuditRecord: { deleteMany: async () => { writes.push('root:record-cleanup') } },
      m365AuditDailyUsage: { deleteMany: async () => { writes.push('root:usage-cleanup') } },
      m365ActivitySubscription: { findMany: async () => [] },
    }
    const consent: any = {
      getTenantManagementActivityContext: async () => ({ accessToken: 'synthetic-token', publisherIdentifier: owner.token }),
    }
    const service = new M365ManagementActivityService(prisma, consent)
    ;(service as any).ensureSubscriptions = async (...args: unknown[]) => {
      assert.equal(args.at(-1), owner)
      return new Set(M365_ACTIVITY_CONTENT_TYPES)
    }
    ;(service as any).discoverContent = async (...args: unknown[]) => { assert.equal(args.at(-1), owner); return false }

    if (loseAtTerminal) {
      await assert.rejects(() => service.syncTenant(tenant, owner), TenantVisitLeaseLostError)
      assert.deepEqual(writes, ['tx:RUNNING', 'tx:recovery'])
    } else {
      await service.syncTenant(tenant, owner)
      assert.deepEqual(writes, [
        'tx:RUNNING', 'tx:recovery', 'tx:record-cleanup',
        'tx:content-cleanup', 'tx:usage-cleanup', 'tx:terminal-state',
      ])
    }
    assert.equal(ownerChecks, 3, 'terminal publication must validate the exact owner')
  })
}

for (const failure of ['budget', 'provider'] as const) {
  for (const loseAtFailure of [true, false]) {
    test(`M365 audit ${failure} catch ${loseAtFailure ? 'rejects stale ownership' : 'writes inside the live owner transaction'}`, async () => {
      const writes: string[] = []
      let ownerChecks = 0
      let insideTransaction = false
      const transaction: any = {
        $queryRawUnsafe: async (sql: string) => {
          assert.equal(insideTransaction, true)
          if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
          if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
          if (sql.includes('FROM tenant_sync_visit_leases')) {
            ownerChecks += 1
            return loseAtFailure && ownerChecks === 3 ? [] : [{ generation: '4' }]
          }
          assert.fail(`Unexpected lease query: ${sql}`)
        },
        syncState: {
          upsert: async () => { writes.push('tx:RUNNING') },
          update: async () => { writes.push('tx:failure') },
        },
        m365ActivityContent: { updateMany: async () => { writes.push('tx:recovery') } },
      }
      const prisma: any = {
        $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
          insideTransaction = true
          try { return await work(transaction) } finally { insideTransaction = false }
        },
        syncState: {
          findUnique: async () => null,
          upsert: async () => { writes.push('root:RUNNING') },
          update: async () => { writes.push('root:failure') },
        },
        m365ActivityContent: {
          count: async () => 1,
          updateMany: async () => { writes.push('root:recovery') },
        },
      }
      const consent: any = {
        getTenantManagementActivityContext: async () => ({ accessToken: 'synthetic-token', publisherIdentifier: owner.token }),
      }
      const service = new M365ManagementActivityService(prisma, consent)
      ;(service as any).ensureSubscriptions = async () => {
        if (failure === 'budget') throw new M365AuditBudgetError('synthetic budget exhaustion')
        throw new Error('synthetic provider failure')
      }

      if (loseAtFailure) {
        await assert.rejects(() => service.syncTenant(tenant, owner), TenantVisitLeaseLostError)
      } else if (failure === 'budget') {
        assert.deepEqual(await service.syncTenant(tenant, owner), [])
      } else {
        await assert.rejects(() => service.syncTenant(tenant, owner), /synthetic provider failure/)
      }
      assert.deepEqual(writes, [
        'tx:RUNNING', 'tx:recovery', ...(loseAtFailure ? [] : ['tx:failure']),
      ])
      assert.equal(ownerChecks, 3, 'failure publication must validate the exact owner')
    })
  }
}

function discoveryFenceHarness(options: { staleAfterBody?: boolean; failCheckpoint?: boolean; staleAfterStart?: boolean } = {}) {
  let live = true
  let state = {
    subscriptions: [] as any[], content: [] as any[],
    checkpoint: { lastSuccessfulPollAt: new Date('2026-11-14T11:00:00Z'), discoveryNextPageUri: null } as any,
  }
  const effects: string[] = []
  const prisma: any = {
    m365ActivitySubscription: {
      findUnique: async () => state.checkpoint,
      findMany: async () => state.subscriptions,
      upsert: async () => assert.fail('owned subscription publication escaped transaction'),
      update: async () => assert.fail('owned checkpoint escaped transaction'),
    },
    m365ActivityContent: { createMany: async () => assert.fail('owned discovered content escaped transaction') },
    $transaction: async (work: any) => {
      const candidate = structuredClone(state)
      const result = await work({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
          if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
          if (sql.includes('FROM tenant_sync_visit_leases')) return live ? [{ generation: owner.generation.toString() }] : []
          assert.fail(sql)
        },
        $executeRawUnsafe: async () => { effects.push('start-lock'); return 0 },
        m365ActivityContent: { createMany: async ({ data }: any) => { candidate.content.push(...data); effects.push('content'); return { count: data.length } } },
        m365ActivitySubscription: {
          findMany: async () => candidate.subscriptions,
          upsert: async ({ where, create, update }: any) => {
            const type = where.customerTenantId_contentType.contentType
            const index = candidate.subscriptions.findIndex(row => row.contentType === type)
            if (index < 0) candidate.subscriptions.push(create)
            else candidate.subscriptions[index] = { ...candidate.subscriptions[index], ...update }
            effects.push(`subscription:${create.status}`)
          },
          update: async ({ data }: any) => {
            if (options.failCheckpoint) throw new Error('synthetic checkpoint failure')
            effects.push('checkpoint'); candidate.checkpoint = { ...candidate.checkpoint, ...data }; return candidate.checkpoint
          },
        },
      })
      state = candidate
      return result
    },
  }
  const service = new M365ManagementActivityService(prisma, {} as never) as any
  let subscriptionMode = false
  service.request = async (url: string, init: RequestInit, _tenant: string, _publisher: string, _deadline: number, actual: unknown) => {
    assert.equal(actual, owner, 'every discovery/subscription attempt must receive the exact owner')
    if (init.method === 'POST') { effects.push('POST'); if (options.staleAfterStart) live = false; return new Response('{}') }
    if (subscriptionMode) return new Response('[]')
    return new Response(JSON.stringify(Array.from({ length: 501 }, (_, index) => ({
      contentId: `blob-${index}`, contentUri: `https://manage.office.com/api/v1.0/${tenant.microsoftTenantId}/activity/feed/audit/${index}`,
    }))))
  }
  service.readMeteredJson = async (_tenant: unknown, response: Response) => {
    const data = await response.json()
    if (options.staleAfterBody) live = false
    return data
  }
  return {
    state: () => state, effects,
    discover: () => service.discoverContent(tenant, 'synthetic', owner.token, new Set(['Audit.Exchange']),
      new Date('2026-11-14T12:00:00Z'), Date.now() + 10000, { remainingBytes: 2 * 1024 * 1024 }, owner),
    subscribe: () => { subscriptionMode = true; return service.ensureSubscriptions(tenant, 'synthetic', owner.token,
      new Date('2026-11-14T12:00:00Z'), Date.now() + 10000, owner) },
  }
}

test('M365 discovery cannot publish content or regress a checkpoint after body completion loses ownership', async () => {
  const f = discoveryFenceHarness({ staleAfterBody: true })
  const before = structuredClone(f.state())
  await assert.rejects(f.discover, TenantVisitLeaseLostError)
  assert.deepEqual(f.state(), before)
  assert.deepEqual(f.effects, [])
})

test('M365 discovery persists every content batch and checkpoint in one exact-owner transaction', async () => {
  const f = discoveryFenceHarness()
  assert.equal(await f.discover(), false)
  assert.equal(f.state().content.length, 501)
  assert.equal(f.state().checkpoint.lastSuccessfulPollAt.toISOString(), '2026-11-14T12:00:00.000Z')
  assert.deepEqual(f.effects, ['content', 'content', 'checkpoint'])
})

test('M365 discovery checkpoint failure rolls back all discovered content batches', async () => {
  const f = discoveryFenceHarness({ failCheckpoint: true })
  const before = structuredClone(f.state())
  await assert.rejects(f.discover, /synthetic checkpoint failure/)
  assert.deepEqual(f.state(), before)
})

test('M365 stale subscription list cannot reserve a start or publish verification', async () => {
  const f = discoveryFenceHarness({ staleAfterBody: true })
  await assert.rejects(f.subscribe, TenantVisitLeaseLostError)
  assert.deepEqual(f.effects, [])
  assert.deepEqual(f.state().subscriptions, [])
})

test('M365 stale subscription-start response preserves its reservation without publishing enabled state', async () => {
  const f = discoveryFenceHarness({ staleAfterStart: true })
  await assert.rejects(f.subscribe, TenantVisitLeaseLostError)
  assert.deepEqual(f.effects, ['start-lock', 'subscription:STARTING', 'POST'])
  assert.equal(f.state().subscriptions.length, 1)
  assert.equal(f.state().subscriptions[0].status, 'STARTING')
})

test('M365 live subscription verification publishes all content types under the same owner', async () => {
  const f = discoveryFenceHarness()
  assert.equal((await f.subscribe()).size, 1)
  assert.equal(f.state().subscriptions.length, M365_ACTIVITY_CONTENT_TYPES.length)
  assert.equal(f.state().subscriptions[0].status, 'ENABLED')
  assert.equal(f.state().subscriptions.filter(row => row.status === 'PENDING').length, 3)
})
