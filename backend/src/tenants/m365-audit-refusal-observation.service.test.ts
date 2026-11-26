import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { M365ManagementActivityService, M365AuditBudgetError } from './m365-management-activity.service.js'
import { projectSyncOutcome } from './sync-outcome-projection.js'
import { parseAttemptEnvelope, qualifiedBudgetRefusal } from './m365-audit-refusal-observation.js'

const tenant = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  microsoftTenantId: '33333333-3333-3333-3333-333333333333',
  connection: {
    connectionMode: 'HAWKVIEW_MANAGED',
    clientId: '44444444-4444-4444-4444-444444444444',
    credentialReference: null,
  },
}
const publisherIdentifier = '55555555-5555-5555-5555-555555555555'
const owner = {
  organizationId: tenant.organizationId, customerTenantId: tenant.id,
  token: '66666666-6666-6666-6666-666666666666', generation: 3n,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
}
const BOUNDARY = new Date('2026-11-27T00:00:00.000Z')
const budgetError = (constraint: any = 'daily_tenant_bytes') =>
  new M365AuditBudgetError('budget reached', BOUNDARY, constraint)

type Call = { method: string; args: readonly unknown[] }

/**
 * Drives the REAL syncTenant -> processContent path. Only the external
 * envelope (provider request, consent, subscription activation, discovery) is
 * stubbed; the attempt mint, the disposition/observation coupling, the terminal
 * write and the clear all execute unchanged.
 */
function harness(options: {
  visitOwner?: typeof owner
  /** What the reservation does: throw a budget error, throw a provider error, or succeed. */
  reservation?: 'budget' | 'provider-retry' | 'ok'
  constraint?: any
  /** Rows the initial PENDING/RETRY -> PROCESSING claim changes. */
  claimCount?: number
  /** Rows the scoped failure disposition changes. */
  dispositionCount?: number
  /** Rows the token compare-and-set claims to have changed. */
  casCount?: number
  pendingContent?: boolean
  failedBacklog?: number
  subscriptionsEnabled?: string[]
  discoveryThrowsBudget?: boolean
  storedState?: Record<string, unknown> | null
  leaseLost?: boolean
} = {}) {
  const calls: Call[] = []
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }) }
  let row: Record<string, unknown> | null = options.storedState === undefined
    ? { status: 'RUNNING', lastAttemptAt: null, lastSuccessfulAt: null, lastErrorCode: null }
    : options.storedState
  const syncState = {
    findUnique: async () => row,
    upsert: async ({ create, update }: any) => {
      record('syncState.upsert', { create, update })
      row = { ...(row ?? {}), ...update }
      return row
    },
    update: async ({ data }: any) => { record('syncState.update', data); row = { ...(row ?? {}), ...data }; return row },
    updateMany: async (args: any) => {
      record('syncState.updateMany', args)
      const count = options.casCount ?? 1
      if (count === 1) row = { ...(row ?? {}), ...args.data }
      return { count }
    },
  }
  const content = {
    id: '77777777-7777-7777-7777-777777777777',
    contentUri: 'https://manage.office.com/api/v1.0/x/activity/feed/audit/blob',
    attemptCount: 0,
  }
  const transactionClient = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('FROM organizations')) return [{ id: tenant.organizationId }]
      if (sql.includes('FROM customer_tenants')) return [{ id: tenant.id }]
      if (sql.includes('FROM tenant_sync_visit_leases')) {
        return options.leaseLost === true ? [] : [{ generation: '3' }]
      }
      return []
    },
    syncState,
    m365ActivityContent: {
      updateMany: async (args: any) => {
        record('content.updateMany', args)
        const claiming = args?.data?.status === 'PROCESSING'
        return { count: claiming ? (options.claimCount ?? 1) : (options.dispositionCount ?? 1) }
      },
      update: async () => undefined,
      deleteMany: async () => ({ count: 0 }),
    },
    m365AuditRecord: { createMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
    changeEvidenceEvent: { createMany: async () => ({ count: 0 }) },
    tenantAuditReconciliationWork: { upsert: async () => undefined },
  }
  const prisma: any = {
    // A real transaction discards its writes when the work throws, so the fake
    // must too -- otherwise a rolled-back write still looks committed here.
    $transaction: async (work: any) => {
      if (Array.isArray(work)) return Promise.all(work)
      const committedCalls = calls.length
      const committedRow = row === null ? null : { ...row }
      try {
        return await work(transactionClient)
      } catch (error) {
        calls.length = committedCalls
        row = committedRow
        throw error
      }
    },
    syncState,
    m365ActivityContent: {
      count: async () => (options.pendingContent === false ? 0 : 1),
      findMany: async () => (options.pendingContent === false ? [] : [content]),
      updateMany: async (args: any) => {
        record('content.updateMany', args)
        const claiming = args?.data?.status === 'PROCESSING'
        return { count: claiming ? (options.claimCount ?? 1) : (options.dispositionCount ?? 1) }
      },
      deleteMany: async () => ({ count: 0 }),
    },
    m365ActivitySubscription: { findMany: async () => [], upsert: async () => undefined },
    m365AuditRecord: { deleteMany: async () => ({ count: 0 }) },
    m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
  }
  const consent: any = {
    getTenantManagementActivityContext: async () => ({ accessToken: 'token', publisherIdentifier }),
  }
  const service = new M365ManagementActivityService(prisma, consent)
  const enabled = new Set(options.subscriptionsEnabled ?? ['Audit.Exchange'])
  ;(service as any).ensureSubscriptions = async () => enabled
  ;(service as any).discoverContent = async () => {
    if (options.discoveryThrowsBudget) throw budgetError(options.constraint)
    return false
  }
  ;(service as any).request = async () => new Response('[]', { status: 200 })
  ;(service as any).reserveDailyUsage = async () => {
    if (options.reservation === 'budget') throw budgetError(options.constraint)
    if (options.reservation === 'provider-retry') throw new Error('Microsoft returned a transient failure.')
  }
  ;(service as any).logger = { warn: () => {}, error: () => {}, log: () => {} }
  // Backlog counts drive the terminal status decision.
  const originalCount = prisma.m365ActivityContent.count
  prisma.m365ActivityContent.count = async (args: any) => {
    const status = args?.where?.status
    if (status === 'FAILED') return options.failedBacklog ?? 0
    if (status === 'PROCESSING') return 0
    if (status === 'RETRY') return 1
    return originalCount(args)
  }
  return {
    calls, service,
    row: () => row,
    envelope: () => parseAttemptEnvelope((row ?? {}).m365AuditAttempt),
    of: (method: string) => calls.filter((call) => call.method === method),
    run: () => service.syncTenant(tenant as never, options.visitOwner as never),
  }
}

const SOURCE = readFileSync(new URL('./m365-management-activity.service.ts', import.meta.url), 'utf8')
const BUNDLE_SOURCE = readFileSync(new URL('./tenant-sync.service.ts', import.meta.url), 'utf8')

// ==========================================================================
// The inner content path -- the common case the outer catch never sees
// ==========================================================================

test('an inner content-budget refusal records a qualified observation and still reports backlog', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget' })
  const changes = await fake.run()
  assert.deepEqual(changes, [], 'the refusal is still swallowed, exactly as released')

  const envelope = fake.envelope()
  assert.ok(envelope?.refusal, 'this attempt carries its refusal')
  assert.equal(envelope.refusal.path, 'content')
  assert.equal(envelope.refusal.constraint, 'daily_tenant_bytes')
  assert.equal(envelope.refusal.retryNotBefore, BOUNDARY.toISOString())
  assert.equal(envelope.refusal.attemptToken, envelope.attemptToken)

  // The terminal outcome is unchanged and PRESERVES the observation.
  const terminal = fake.of('syncState.update').at(-1)!.args[0] as Record<string, unknown>
  assert.equal(terminal.status, 'RUNNING')
  assert.equal(terminal.lastErrorCode, 'm365-audit-backlog')
  assert.equal(terminal.lastSuccessfulAt, undefined, 'success is not advanced')
  assert.ok(fake.envelope()?.refusal, 'the backlog terminal write did not clear it')

  // And a reader qualifies it against the row the scoped query would return.
  const qualified = qualifiedBudgetRefusal({
    resourceType: 'M365_AUDIT',
    status: terminal.status as string,
    lastErrorCode: terminal.lastErrorCode as string,
    lastAttemptAt: (fake.row() as any).lastAttemptAt,
    m365AuditAttempt: (fake.row() as any).m365AuditAttempt,
  }, new Date())
  assert.equal(qualified?.constraint, 'daily_tenant_bytes')
})

test('the observation is written in the SAME transaction as its content disposition', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget' })
  await fake.run()
  const order = fake.calls.map((call) => call.method)
  const disposition = order.lastIndexOf('content.updateMany')
  const cas = order.indexOf('syncState.updateMany')
  assert.ok(disposition >= 0 && cas > disposition,
    'the compare-and-set follows the disposition inside one transaction')
  const casArgs = fake.of('syncState.updateMany')[0]!.args[0] as any
  assert.equal(casArgs.where.organizationId, tenant.organizationId)
  assert.equal(casArgs.where.customerTenantId, tenant.id)
  assert.equal(casArgs.where.resourceType, 'M365_AUDIT')
  assert.deepEqual(casArgs.where.m365AuditAttempt.path, ['attemptToken'])
  assert.ok(casArgs.where.lastAttemptAt instanceof Date, 'scoped to the captured attempt time')
})

test('an ordinary provider retry records no observation at all', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'provider-retry' })
  await fake.run()
  assert.equal(fake.envelope()?.refusal, null, 'no budget detail is fabricated')
  const terminal = fake.of('syncState.update').at(-1)!.args[0] as Record<string, unknown>
  assert.equal(terminal.lastErrorCode, 'm365-audit-backlog', 'the same code as a cost refusal')
  assert.equal(qualifiedBudgetRefusal({
    resourceType: 'M365_AUDIT', status: 'RUNNING', lastErrorCode: 'm365-audit-backlog',
    lastAttemptAt: (fake.row() as any).lastAttemptAt,
    m365AuditAttempt: (fake.row() as any).m365AuditAttempt,
  }, new Date()), null, 'which is exactly why the observation, not the code, carries the meaning')
})

test('an error proving no constraint yields no fabricated detail', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget', constraint: null })
  await fake.run()
  assert.equal(fake.envelope()?.refusal, null)
  assert.deepEqual(fake.of('syncState.updateMany').filter((call) => {
    const data = (call.args[0] as any).data?.m365AuditAttempt
    return data && data.refusal !== null
  }), [])
})

test('the ownerless compatibility path is transactional and token-guarded too', async () => {
  const fake = harness({ reservation: 'budget' })
  await fake.run()
  assert.ok(fake.envelope()?.refusal, 'recorded without a lease, fenced by the token')
  const casArgs = fake.of('syncState.updateMany')[0]!.args[0] as any
  assert.deepEqual(casArgs.where.m365AuditAttempt.path, ['attemptToken'])
})

// ==========================================================================
// Fail-closed: zero-row disposition, zero-row CAS, lost owner
// ==========================================================================

test('an unclaimable blob never reaches the budget path at all', async () => {
  // The released claim already refuses a row it does not own; nothing after it
  // runs, so there is no refusal to record.
  const fake = harness({ visitOwner: owner, reservation: 'budget', claimCount: 0 })
  const changes = await fake.run()
  assert.deepEqual(changes, [])
  assert.equal(fake.envelope()?.refusal, null)
})

test('a zero-row failure disposition rolls back its coupled observation', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget', dispositionCount: 0 })
  await assert.rejects(() => fake.run(), /lease|lost|Lease/i)
  assert.equal(fake.envelope()?.refusal, null, 'no observation survives an unclaimed disposition')
  assert.deepEqual(fake.of('syncState.updateMany').filter((call) =>
    (call.args[0] as any).data?.m365AuditAttempt?.refusal), [])
})

test('a superseded attempt writes nothing and abandons, rather than overwriting a successor', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget', casCount: 0 })
  const changes = await fake.run()
  assert.deepEqual(changes, [], 'the stale worker abandons')
  assert.equal(fake.envelope()?.refusal, null, 'the successor envelope is untouched')
  assert.deepEqual(fake.of('syncState.update'), [],
    'and no terminal status was written by the stale worker')
})

test('a lost lease refuses before any observation', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget', leaseLost: true })
  await assert.rejects(() => fake.run())
  assert.deepEqual(fake.of('syncState.updateMany').filter((call) =>
    (call.args[0] as any).data?.m365AuditAttempt?.refusal), [])
})

// ==========================================================================
// The outer discovery path
// ==========================================================================

test('an outer discovery refusal records its constraint with the unchanged deadline', async () => {
  const fake = harness({
    visitOwner: owner, discoveryThrowsBudget: true, constraint: 'monthly_deployment_bytes',
  })
  const changes = await fake.run()
  assert.deepEqual(changes, [])
  const status = fake.of('syncState.update').at(-1)!.args[0] as Record<string, unknown>
  assert.equal(status.status, 'RUNNING', 'existing state write unchanged')
  assert.equal(status.lastErrorCode, 'm365-audit-budget-exhausted')
  assert.equal(status.consecutiveFailures, 0)
  const envelope = fake.envelope()
  assert.equal(envelope?.refusal?.path, 'discovery')
  assert.equal(envelope?.refusal?.constraint, 'monthly_deployment_bytes')
  assert.equal(envelope?.refusal?.retryNotBefore, BOUNDARY.toISOString(),
    'the released retry boundary is recorded verbatim')
})

test('a superseded outer refusal writes neither status nor observation', async () => {
  const fake = harness({ visitOwner: owner, discoveryThrowsBudget: true, casCount: 0 })
  const changes = await fake.run()
  assert.deepEqual(changes, [])
  assert.deepEqual(fake.of('syncState.update'), [], 'the status write rolled back with the observation')
})

// ==========================================================================
// Lifecycle: attempt identity, clearing, early return
// ==========================================================================

test('each attempt mints a distinct token even when two share an instant', async () => {
  const tokens = new Set<string>()
  for (let index = 0; index < 2; index += 1) {
    const fake = harness({ visitOwner: owner, reservation: 'budget' })
    await fake.run()
    const upsert = fake.of('syncState.upsert')[0]!.args[0] as any
    tokens.add(upsert.update.m365AuditAttempt.attemptToken)
    assert.equal(
      upsert.update.m365AuditAttempt.attemptAt,
      (upsert.update.lastAttemptAt as Date).toISOString(),
      'the envelope attempt time is exactly the value written to lastAttemptAt',
    )
  }
  assert.equal(tokens.size, 2, 'a millisecond clock is not the fence; the token is')
})

test('a new attempt installs a refusal-free envelope, superseding the old observation', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'budget' })
  await fake.run()
  const upsert = fake.of('syncState.upsert')[0]!.args[0] as any
  assert.equal(upsert.update.m365AuditAttempt.refusal, null)
  assert.equal(upsert.create.m365AuditAttempt.refusal, null)
})

test('a terminal success clears this attempt observation, guarded by its own token', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'ok', subscriptionsEnabled: [] })
  await fake.run()
  const terminal = fake.of('syncState.update').at(-1)!.args[0] as Record<string, unknown>
  const clears = fake.of('syncState.updateMany').filter((call) =>
    (call.args[0] as any).data?.m365AuditAttempt?.refusal === null)
  if (terminal.status === 'SUCCEEDED' || terminal.status === 'FAILED') {
    assert.ok(clears.length >= 1, 'a non-backlog terminal state clears the observation')
    const guard = (clears[0]!.args[0] as any).where
    assert.deepEqual(guard.m365AuditAttempt.path, ['attemptToken'])
    assert.ok(guard.lastAttemptAt instanceof Date)
  }
})

test('a non-budget terminal failure clears it as well', async () => {
  const fake = harness({ visitOwner: owner, reservation: 'ok', failedBacklog: 2 })
  await fake.run()
  const terminal = fake.of('syncState.update').at(-1)!.args[0] as Record<string, unknown>
  assert.equal(terminal.status, 'FAILED')
  assert.ok(fake.of('syncState.updateMany').some((call) =>
    (call.args[0] as any).data?.m365AuditAttempt?.refusal === null),
  'the failure path clears the observation')
})

test('the early fresh/no-work return mutates nothing', async () => {
  const fake = harness({
    visitOwner: owner,
    pendingContent: false,
    storedState: {
      status: 'RUNNING', lastSuccessfulAt: new Date(), lastAttemptAt: new Date(),
      lastErrorCode: 'm365-audit-backlog', m365AuditAttempt: { v: 1, attemptToken: 'prior-token', attemptAt: new Date().toISOString(), refusal: null },
    },
  })
  const changes = await fake.run()
  assert.deepEqual(changes, [])
  assert.deepEqual(fake.of('syncState.upsert'), [], 'no attempt was minted')
  assert.deepEqual(fake.of('syncState.updateMany'), [], 'no envelope was touched')
  assert.deepEqual(fake.of('syncState.update'), [])
})

// ==========================================================================
// The reader path, and that it needs no new query
// ==========================================================================

test('the scoped bundle query carries the column and needs no new lookup', () => {
  // The buildBundle sync-state load is an unfiltered findMany, so the new
  // column arrives with the row. A `select` there would silently drop it.
  const load = BUNDLE_SOURCE.indexOf('this.prisma.syncState.findMany({')
  assert.ok(load > 0, 'the scoped load exists')
  const block = BUNDLE_SOURCE.slice(load, load + 260)
  assert.doesNotMatch(block, /select:|omit:/, 'no projection that could drop the column')
  assert.match(block, /organizationId: tenant\.organizationId/)
  assert.match(block, /customerTenantId: tenant\.id/)
  // Exactly one M365_AUDIT projection call, and no new table lookup was added.
  assert.equal(BUNDLE_SOURCE.split("projectSyncOutcome('M365_AUDIT'").length - 1, 1)
  assert.equal(BUNDLE_SOURCE.split('m365AuditAttempt').length - 1, 0,
    'the bundle does not query or reshape the envelope itself')
})

test('the projection exposes the detail for M365_AUDIT and nothing else', () => {
  const attemptAt = new Date('2026-11-26T12:00:00.000Z')
  const now = new Date('2026-11-26T12:00:10.000Z')
  const row = {
    resourceType: 'M365_AUDIT', status: 'RUNNING', lastErrorCode: 'm365-audit-backlog',
    lastAttemptAt: attemptAt, lastSuccessfulAt: null,
    m365AuditAttempt: {
      v: 1, attemptToken: 'aaaa-bbbb', attemptAt: attemptAt.toISOString(),
      refusal: {
        attemptToken: 'aaaa-bbbb', path: 'content', constraint: 'daily_deployment_records',
        observedAt: '2026-11-26T12:00:05.000Z', retryNotBefore: '2026-11-27T00:00:00.000Z',
      },
    },
  }
  const projected = projectSyncOutcome('M365_AUDIT', row as never, now)
  assert.equal(projected.recordedOutcome.kind, 'DEFERRED_WORK_RECORDED', 'existing meaning preserved')
  assert.equal(projected.reasonCode, 'm365-audit-backlog')
  assert.deepEqual(projected.observedBudgetRefusal, {
    path: 'content', constraint: 'daily_deployment_records',
    observedAt: '2026-11-26T12:00:05.000Z', retryNotBefore: '2026-11-27T00:00:00.000Z',
  })
  // A different resource with the same row shape gets no detail and an
  // unchanged response shape.
  const other = projectSyncOutcome('SIGN_INS', { ...row, resourceType: 'SIGN_INS' } as never, now)
  assert.equal('observedBudgetRefusal' in other, false)
  // A legacy null envelope leaves the response exactly as released.
  const legacy = projectSyncOutcome('M365_AUDIT', { ...row, m365AuditAttempt: null } as never, now)
  assert.equal('observedBudgetRefusal' in legacy, false)
  assert.equal(legacy.recordedOutcome.kind, 'DEFERRED_WORK_RECORDED')
  assert.equal(legacy.reasonCode, 'm365-audit-backlog')
})

// ==========================================================================
// Accounting is untouched
// ==========================================================================

test('no budget lock is taken to record an observation', () => {
  const helper = SOURCE.slice(
    SOURCE.indexOf('private async recordBudgetRefusal('),
    SOURCE.indexOf('private async reserveDailyUsage('),
  )
  assert.ok(helper.length > 0)
  assert.doesNotMatch(helper, /pg_advisory_xact_lock/, 'recording needs no shared critical section')
  assert.doesNotMatch(helper, /m365-(daily|monthly)-budget/)
})

test('the released reservation, refund and record accounting are unchanged', () => {
  // Byte reservation still precedes the read and is retained on interruption.
  assert.match(SOURCE, /Reserve the maximum possible body before reading it/)
  assert.match(SOURCE, /Keep the conservative reservation when a stream is interrupted/)
  // Records are still charged inside the accept transaction, only when accepted.
  assert.match(SOURCE, /Charge only records the database actually accepted/)
  assert.match(SOURCE, /\{ records: insertedRecordCount, blobs: 1 \}/)
  // The guarded refund is untouched.
  assert.match(SOURCE, /downloadedBytes: \{ gte: BigInt\(Math\.ceil\(bytes\)\) \}/)
  assert.match(SOURCE, /downloadedBytes: \{ decrement: BigInt\(Math\.ceil\(bytes\)\) \}/)
})

test('the eight closed constraints are derived from the eight released comparisons', () => {
  const decision = SOURCE.slice(SOURCE.indexOf('const exceeded: Record<'), SOURCE.indexOf('if (dailyExceeded || monthlyExceeded)'))
  for (const [name, expression] of [
    ['monthly_tenant_bytes', 'tenantMonthlyBytes + bytes > limits.tenantMonthlyBytes'],
    ['monthly_deployment_bytes', 'deploymentMonthlyBytes + bytes > limits.deploymentMonthlyBytes'],
    ['monthly_tenant_records', 'tenantMonthlyRecords + records > limits.tenantMonthlyRecords'],
    ['monthly_deployment_records', 'deploymentMonthlyRecords + records > limits.deploymentMonthlyRecords'],
    ['daily_tenant_bytes', 'tenantBytes + bytes > limits.tenantBytes'],
    ['daily_deployment_bytes', 'deploymentBytes + bytes > limits.deploymentBytes'],
    ['daily_tenant_records', 'tenantRecords + records > limits.tenantRecords'],
    ['daily_deployment_records', 'deploymentRecords + records > limits.deploymentRecords'],
  ] as const) {
    assert.ok(decision.includes(`${name}: ${expression},`), `${name} keeps its released comparison`)
  }
  // The thrown message and boundary are still derived the released way.
  assert.match(SOURCE, /monthlyExceeded \? nextUtcMonthDate\(now\) : nextUtcUsageDate\(now\)/)
  assert.match(SOURCE, /cost budget is exhausted; ingestion will resume after the next UTC/)
})
