import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { M365ManagementActivityService, M365AuditBudgetError } from './m365-management-activity.service.js'
import { parseAttemptEnvelope, qualifiedBudgetRefusal } from './sync-outcome-projection.js'

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
/** A frozen clock so attempt times are exactly reproducible. */
const CLOCK = Date.UTC(2026, 10, 26, 12, 0, 0)
/** Relative, so no fixture can expire by being read on a later real-world day. */
const boundaryAfter = (ms: number) => new Date(CLOCK + ms)
const budgetError = (constraint: any = 'daily_tenant_bytes', ms = 12 * 60 * 60 * 1000) =>
  new M365AuditBudgetError('budget reached', boundaryAfter(ms), constraint)

type Row = {
  organizationId: string; customerTenantId: string; resourceType: string
  status: string; lastAttemptAt: Date | null; lastSuccessfulAt: Date | null
  lastErrorCode: string | null; lastErrorMessage: string | null
  consecutiveFailures: number; m365AuditAttempt: unknown
}
type Call = { method: string; args: readonly unknown[] }

/** Tests may build more than one harness; the clock is enabled once each. */
const frozen = new WeakSet<object>()

/** Evaluate the ACTUAL where clause against the stored row, including the JSON
 *  path token filter and exact attempt-time equality. A configured count would
 *  prove nothing about the predicate the production code writes. */
function matches(row: Row | null, where: any): boolean {
  if (!row || !where) return false
  for (const key of ['organizationId', 'customerTenantId', 'resourceType'] as const) {
    if (where[key] !== undefined && where[key] !== row[key]) return false
  }
  if (where.lastAttemptAt !== undefined) {
    const want = where.lastAttemptAt instanceof Date ? where.lastAttemptAt.getTime() : NaN
    const have = row.lastAttemptAt instanceof Date ? row.lastAttemptAt.getTime() : NaN
    if (!Number.isFinite(want) || want !== have) return false
  }
  if (where.m365AuditAttempt !== undefined) {
    const filter = where.m365AuditAttempt
    if (!Array.isArray(filter?.path) || filter.path.length !== 1) return false
    const stored = row.m365AuditAttempt
    const value = stored && typeof stored === 'object'
      ? (stored as Record<string, unknown>)[filter.path[0]] : undefined
    if (value !== filter.equals) return false
  }
  return true
}

function applyData(row: Row, data: any): Row {
  const next: any = { ...row }
  for (const [key, value] of Object.entries(data ?? {})) {
    next[key] = value && typeof value === 'object' && 'increment' in (value as object)
      ? (next[key] ?? 0) + (value as { increment: number }).increment
      : value
  }
  return next as Row
}

const baseRow = (overrides: Partial<Row> = {}): Row => ({
  organizationId: tenant.organizationId, customerTenantId: tenant.id, resourceType: 'M365_AUDIT',
  status: 'RUNNING', lastAttemptAt: null, lastSuccessfulAt: null,
  lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0, m365AuditAttempt: null,
  ...overrides,
})

/**
 * Drives the REAL syncTenant path over a STATEFUL store. Only the provider
 * envelope is stubbed. A successor can be installed at a chosen point so stale
 * terminal and failure transitions are exercised for real.
 */
function harness(context: TestContext, options: {
  visitOwner?: typeof owner
  reservation?: 'budget' | 'provider-retry' | 'ok'
  constraint?: any
  claimCount?: number
  dispositionCount?: number
  pendingContent?: boolean
  failedBacklog?: number
  retryBacklog?: number
  subscriptionsEnabled?: string[]
  discoveryThrows?: 'budget' | 'provider' | null
  /**
   * Install a successor attempt at this point in the real flow.
   * 'content-guard' is the ordering the read-only check could not survive: the
   * successor arrives AFTER this attempt's guard has answered positively and
   * BEFORE its coupled content disposition commits.
   */
  successorDuring?: 'discovery' | 'content' | 'content-guard' | null
  /** One budget constraint per blob, so one attempt can refuse twice. */
  contentConstraints?: any[]
  /** How many pending blobs the attempt finds. */
  blobs?: number
  /** Give the successor the SAME captured time, so only the token differs. */
  successorSameTime?: boolean
  storedRow?: Row | null
  leaseLost?: boolean
} = {}) {
  // One frozen clock per test, however many harnesses that test builds.
  if (!frozen.has(context)) { context.mock.timers.enable({ apis: ['Date'], now: CLOCK }); frozen.add(context) }
  const calls: Call[] = []
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }) }
  const warnings: string[] = []
  let row: Row | null = options.storedRow === undefined ? baseRow() : options.storedRow
  const successorToken = 'successor-token-9999'
  let successorInstalled: Row | null = null
  /**
   * PostgreSQL row-lock semantics, modelled only as far as this correction
   * needs, and modelled by ISSUER because that is the distinction the whole
   * correction turns on:
   *
   *  - a matching UPDATE issued on the enclosing TRANSACTION holds the state
   *    row until that transaction ends;
   *  - the same UPDATE issued on the base client is its own autocommit
   *    transaction, so it releases the row at the end of its own statement;
   *  - a plain SELECT takes no row lock at all.
   *
   * A waiting token install therefore lands after the holder's transaction
   * commits in the first case, and immediately in the other two. Without the
   * issuer distinction, passing the base client instead of the transaction --
   * which type-checks, and re-opens the exact interleaving this guard exists to
   * close -- would be invisible here.
   */
  let lockHolder: 'transaction' | null = null
  const deferredWriters: (() => void)[] = []
  const releaseAndFlush = () => {
    lockHolder = null
    while (deferredWriters.length) deferredWriters.shift()!()
  }
  /** One entry per successful transaction: who owned the state row at its
   *  commit, and whether that transaction ISSUED the failure disposition. A
   *  disposition that matched zero rows still counts as issued, so this answers
   *  "which attempt owned the row when that transaction committed", not
   *  "whether a content row changed". */
  const committedTokens: (string | undefined)[] = []
  const commits: { token: string | undefined; sawDisposition: boolean }[] = []
  const applyInstall = () => {
    // A real concurrent attempt: it rewrites the envelope and (unless we are
    // isolating the token) the captured attempt time too.
    row = applyData(row ?? baseRow(), {
      status: 'RUNNING',
      lastErrorCode: 'm365-audit-backlog',
      lastSuccessfulAt: new Date(CLOCK - 60_000),
      ...(options.successorSameTime ? {} : { lastAttemptAt: new Date(CLOCK + 1) }),
      m365AuditAttempt: {
        v: 1, attemptToken: successorToken,
        attemptAt: new Date(options.successorSameTime ? CLOCK : CLOCK + 1).toISOString(),
        refusal: null,
      },
    })
    successorInstalled = { ...row }
    record('successor.install')
  }
  const installSuccessor = () => {
    if (lockHolder === 'transaction') { deferredWriters.push(applyInstall); return }
    applyInstall()
  }
  /** Did the guard just answer positively for the current attempt? */
  const guardAnswered = (where: any) => options.successorDuring === 'content-guard' &&
    matches(row, where) && where?.m365AuditAttempt?.equals !== successorToken
  const syncStateFor = (issuer: 'transaction' | 'autocommit') => ({
    findUnique: async () => row,
    /**
     * UNLOCKED on purpose. Production no longer reads the row to fence an
     * attempt, but this stays so a control that reverts the guard to the old
     * read-only check still RUNS and fails on an assertion about ordering,
     * rather than dying on a missing method.
     */
    count: async ({ where }: any) => {
      record('syncState.count', { where })
      const answer = matches(row, where) ? 1 : 0
      if (answer === 1 && guardAnswered(where)) installSuccessor()
      return answer
    },
    upsert: async ({ create, update }: any) => {
      record('syncState.upsert', { create, update })
      row = row ? applyData(row, update) : applyData(baseRow(), create)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      record('syncState.updateMany', { where, data, issuer })
      if (!matches(row, where)) return { count: 0 }
      const answered = guardAnswered(where)
      // Held to commit only when the ENCLOSING transaction issued it.
      if (issuer === 'transaction') lockHolder = 'transaction'
      row = applyData(row!, data)
      if (answered) installSuccessor()
      // An autocommit statement releases the row as it ends, so anything that
      // was waiting proceeds now rather than after the caller's transaction.
      if (issuer === 'autocommit') releaseAndFlush()
      return { count: 1 }
    },
  })
  const syncState = syncStateFor('autocommit')
  const contents = Array.from({ length: options.blobs ?? 1 }, (_blob, index) => ({
    id: `7777777${index}-7777-7777-7777-777777777777`,
    contentUri: `https://manage.office.com/api/v1.0/x/activity/feed/audit/blob-${index}`,
    attemptCount: 0,
  }))
  const contentClient = {
    count: async (args: any) => {
      const status = args?.where?.status
      if (status === 'FAILED') return options.failedBacklog ?? 0
      if (status === 'PROCESSING') return 0
      if (status === 'RETRY') return options.retryBacklog ?? 1
      return options.pendingContent === false ? 0 : 1
    },
    findMany: async () => (options.pendingContent === false ? [] : contents),
    updateMany: async (args: any) => {
      const claiming = args?.data?.status === 'PROCESSING'
      const scoped = args?.where?.id !== undefined
      record(
        claiming ? 'content.claim' : scoped ? 'content.disposition' : 'content.recovery',
        args,
      )
      record('content.updateMany', args)
      return { count: claiming ? (options.claimCount ?? 1) : (options.dispositionCount ?? 1) }
    },
    update: async () => undefined,
    deleteMany: async () => ({ count: 0 }),
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
    syncState: syncStateFor('transaction'),
    m365ActivityContent: contentClient,
    m365AuditRecord: { createMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
    changeEvidenceEvent: { createMany: async () => ({ count: 0 }) },
    tenantAuditReconciliationWork: { upsert: async () => undefined },
  }
  const prisma: any = {
    // Rollback is modelled: a throwing transaction discards its row mutations
    // AND its recorded calls, so a rolled-back write cannot look committed.
    $transaction: async (work: any) => {
      if (Array.isArray(work)) return Promise.all(work)
      const committedRow = row === null ? null : { ...row }
      const committedCalls = calls.length
      try {
        const result = await work(transactionClient)
        // Which attempt owned the row at the instant this transaction
        // committed. A disposition that commits while a SUCCESSOR owns it is
        // exactly the stale commit the guard has to make impossible. The
        // disposition flag matters because a run commits several transactions
        // (attempt mint, interrupted recovery, blob claim) before this one, and
        // those would otherwise satisfy an assertion about the disposition.
        const token = (row as any)?.m365AuditAttempt?.attemptToken
        committedTokens.push(token)
        commits.push({
          token,
          sawDisposition: calls.slice(committedCalls)
            .some((call) => call.method === 'content.disposition'),
        })
        return result
      } catch (error) {
        row = committedRow
        calls.length = committedCalls
        throw error
      } finally {
        // This transaction ended, so its row lock is released and any writer
        // that was waiting on it now acts on the committed row.
        releaseAndFlush()
      }
    },
    syncState,
    m365ActivityContent: contentClient,
    m365ActivitySubscription: { findMany: async () => [], upsert: async () => undefined },
    m365AuditRecord: { deleteMany: async () => ({ count: 0 }) },
    m365AuditDailyUsage: { deleteMany: async () => ({ count: 0 }) },
  }
  const consent: any = {
    getTenantManagementActivityContext: async () => ({ accessToken: 'token', publisherIdentifier }),
  }
  const service = new M365ManagementActivityService(prisma, consent)
  ;(service as any).ensureSubscriptions = async () => new Set(options.subscriptionsEnabled ?? ['Audit.Exchange'])
  ;(service as any).discoverContent = async () => {
    if (options.successorDuring === 'discovery') installSuccessor()
    if (options.discoveryThrows === 'budget') throw budgetError(options.constraint)
    if (options.discoveryThrows === 'provider') throw new Error('Microsoft returned a transient failure.')
    return false
  }
  ;(service as any).request = async () => new Response('[]', { status: 200 })
  let reservations = 0
  ;(service as any).reserveDailyUsage = async () => {
    const blob = reservations++
    if (options.successorDuring === 'content' && blob === 0) installSuccessor()
    if (options.contentConstraints) {
      // One refusal per blob, inside ONE attempt: the first can be recordable
      // and a later one unrecordable, which is how an earlier legitimate
      // refusal comes to exist on the row the guard then has to acquire.
      const perBlob = options.contentConstraints
      throw budgetError(perBlob[Math.min(blob, perBlob.length - 1)])
    }
    if (options.reservation === 'budget') throw budgetError(options.constraint)
    if (options.reservation === 'provider-retry') throw new Error('Microsoft returned a transient failure.')
  }
  ;(service as any).logger = {
    warn: (line: string) => { warnings.push(String(line)) },
    error: (line: string) => { warnings.push(String(line)) },
    log: () => {},
  }
  return {
    calls, service,
    row: () => row,
    successor: () => successorInstalled,
    successorToken,
    /** Reason codes the service actually logged, in order. */
    reasonCodes: () => warnings.map((line) => {
      try { return JSON.parse(line).reasonCode as string } catch { return line }
    }),
    /** The owning attempt token at each successful commit, in order. */
    committedTokens: () => [...committedTokens],
    /** Only the commits that carried a content disposition. */
    dispositionCommits: () => commits.filter((commit) => commit.sawDisposition),
    envelope: () => parseAttemptEnvelope((row ?? {}).m365AuditAttempt),
    of: (method: string) => calls.filter((call) => call.method === method),
    attemptTokenFromUpsert: () => {
      const upsert = calls.find((call) => call.method === 'syncState.upsert')
      return (upsert?.args[0] as any)?.update?.m365AuditAttempt?.attemptToken as string | undefined
    },
    run: () => service.syncTenant(tenant as never, options.visitOwner as never),
  }
}

const SOURCE = readFileSync(new URL('./m365-management-activity.service.ts', import.meta.url), 'utf8')

// ==========================================================================
// Behavioural: the attempt fence on every current-attempt state transition
// ==========================================================================

for (const visitOwner of [owner, undefined] as const) {
  const lane = visitOwner ? 'owned' : 'ownerless'

  test(`${lane}: a stale terminal SUCCESS leaves the successor state untouched`, async (context) => {
    const fake = harness(context, {
      visitOwner, reservation: 'ok', pendingContent: false, retryBacklog: 0,
      subscriptionsEnabled: ['Audit.AzureActiveDirectory', 'Audit.Exchange', 'Audit.SharePoint', 'Audit.General'],
      successorDuring: 'discovery', successorSameTime: true,
    })
    const changes = await fake.run()
    assert.deepEqual(changes, [])
    const after = fake.row()!
    const successor = fake.successor()!
    assert.notEqual(after.status, 'SUCCEEDED', 'the stale worker must not mark a success')
    assert.equal(after.status, successor.status)
    assert.equal(after.lastErrorCode, successor.lastErrorCode)
    assert.equal(after.lastSuccessfulAt?.getTime(), successor.lastSuccessfulAt?.getTime(),
      'the successor success clock is not advanced')
    assert.deepEqual(after.m365AuditAttempt, successor.m365AuditAttempt)
    assert.equal(fake.envelope()?.attemptToken, fake.successorToken)
  })

  test(`${lane}: a stale terminal FAILED-backlog leaves the successor state untouched`, async (context) => {
    const fake = harness(context, {
      visitOwner, reservation: 'ok', failedBacklog: 3,
      successorDuring: 'discovery', successorSameTime: true,
    })
    await fake.run()
    const after = fake.row()!
    const successor = fake.successor()!
    assert.notEqual(after.status, 'FAILED')
    assert.equal(after.lastErrorCode, successor.lastErrorCode)
    assert.equal(after.consecutiveFailures, successor.consecutiveFailures,
      'the successor failure counter is not incremented')
    assert.deepEqual(after.m365AuditAttempt, successor.m365AuditAttempt)
  })

  test(`${lane}: a stale ordinary BACKLOG terminal leaves the successor state untouched`, async (context) => {
    const fake = harness(context, {
      visitOwner, reservation: 'provider-retry',
      successorDuring: 'content', successorSameTime: true,
    })
    await fake.run()
    const after = fake.row()!
    const successor = fake.successor()!
    assert.equal(after.lastErrorMessage, successor.lastErrorMessage,
      'the backlog branch is fenced too, so no reason text is replaced')
    assert.deepEqual(after.m365AuditAttempt, successor.m365AuditAttempt)
  })

  test(`${lane}: a stale OUTER budget refusal with a known cap writes nothing`, async (context) => {
    const fake = harness(context, {
      visitOwner, discoveryThrows: 'budget', constraint: 'monthly_deployment_bytes',
      successorDuring: 'discovery', successorSameTime: true,
    })
    const changes = await fake.run()
    assert.deepEqual(changes, [])
    const after = fake.row()!
    const successor = fake.successor()!
    assert.equal(after.lastErrorCode, successor.lastErrorCode)
    assert.notEqual(after.lastErrorCode, 'm365-audit-budget-exhausted')
    assert.deepEqual(after.m365AuditAttempt, successor.m365AuditAttempt)
  })

  test(`${lane}: a stale OUTER budget refusal with NO proven cap also writes nothing`, async (context) => {
    // The fence is unconditional: an unproven cap records no detail, and must
    // not be a licence to write the status against a successor's token.
    const fake = harness(context, {
      visitOwner, discoveryThrows: 'budget', constraint: null,
      successorDuring: 'discovery', successorSameTime: true,
    })
    await fake.run()
    const after = fake.row()!
    const successor = fake.successor()!
    assert.notEqual(after.lastErrorCode, 'm365-audit-budget-exhausted')
    assert.equal(after.lastErrorCode, successor.lastErrorCode)
    assert.deepEqual(after.m365AuditAttempt, successor.m365AuditAttempt)
  })

  test(`${lane}: a stale OUTER non-budget failure writes nothing but still raises`, async (context) => {
    const fake = harness(context, {
      visitOwner, discoveryThrows: 'provider',
      successorDuring: 'discovery', successorSameTime: true,
    })
    await assert.rejects(() => fake.run())
    const after = fake.row()!
    const successor = fake.successor()!
    assert.notEqual(after.status, 'FAILED', 'the successor is not marked failed by a stale worker')
    assert.equal(after.status, successor.status)
    assert.equal(after.consecutiveFailures, successor.consecutiveFailures)
    assert.deepEqual(after.m365AuditAttempt, successor.m365AuditAttempt)
  })
}

// ==========================================================================
// Behavioural: the current attempt's own transitions
// ==========================================================================

test('a current inner content refusal records its detail and keeps the backlog outcome', async (context) => {
  const fake = harness(context, { visitOwner: owner, reservation: 'budget' })
  const changes = await fake.run()
  assert.deepEqual(changes, [], 'still swallowed, exactly as released')
  const after = fake.row()!
  assert.equal(after.status, 'RUNNING')
  assert.equal(after.lastErrorCode, 'm365-audit-backlog')
  assert.equal(after.lastSuccessfulAt, null, 'success is never advanced')
  const envelope = fake.envelope()
  assert.equal(envelope?.refusal?.path, 'content')
  assert.equal(envelope?.refusal?.constraint, 'daily_tenant_bytes')
  assert.equal(envelope?.refusal?.attemptToken, envelope?.attemptToken)
  // The reader qualifies it off the stored row, at a time before the boundary.
  const qualified = qualifiedBudgetRefusal(after as never, new Date(CLOCK + 60_000))
  assert.equal(qualified?.constraint, 'daily_tenant_bytes')
  assert.equal(qualified?.retryNotBefore, boundaryAfter(12 * 60 * 60 * 1000).toISOString())
})

test('a current outer discovery refusal records its cap and the released deadline', async (context) => {
  const fake = harness(context, {
    visitOwner: owner, discoveryThrows: 'budget', constraint: 'monthly_deployment_bytes',
  })
  await fake.run()
  const after = fake.row()!
  assert.equal(after.status, 'RUNNING')
  assert.equal(after.lastErrorCode, 'm365-audit-budget-exhausted')
  assert.equal(fake.envelope()?.refusal?.path, 'discovery')
  assert.equal(fake.envelope()?.refusal?.constraint, 'monthly_deployment_bytes')
  assert.equal(fake.envelope()?.refusal?.retryNotBefore,
    boundaryAfter(12 * 60 * 60 * 1000).toISOString())
})

test('a current outer budget refusal with no proven cap records status and NO detail', async (context) => {
  const fake = harness(context, { visitOwner: owner, discoveryThrows: 'budget', constraint: null })
  await fake.run()
  const after = fake.row()!
  assert.equal(after.lastErrorCode, 'm365-audit-budget-exhausted', 'status still recorded')
  assert.equal(fake.envelope()?.refusal, null, 'and no fabricated detail')
})

test('a current outer non-budget failure records FAILED and clears the observation', async (context) => {
  const fake = harness(context, { visitOwner: owner, reservation: 'budget' })
  await fake.run()
  assert.ok(fake.envelope()?.refusal, 'a refusal exists first')
  const second = harness(context, {
    visitOwner: owner, discoveryThrows: 'provider',
    storedRow: baseRow({
      lastAttemptAt: new Date(CLOCK),
      m365AuditAttempt: fake.row()!.m365AuditAttempt,
    }),
  })
  await assert.rejects(() => second.run())
  assert.equal(second.row()!.status, 'FAILED')
  assert.equal(second.envelope()?.refusal, null, 'a failed state keeps no refusal alive')
})

test('an ordinary provider retry records no detail under the identical error code', async (context) => {
  const fake = harness(context, { visitOwner: owner, reservation: 'provider-retry' })
  await fake.run()
  const after = fake.row()!
  assert.equal(after.lastErrorCode, 'm365-audit-backlog')
  assert.equal(fake.envelope()?.refusal, null)
  assert.equal(qualifiedBudgetRefusal(after as never, new Date(CLOCK + 60_000)), null,
    'which is why the observation, not the code, carries the meaning')
})

test('a terminal success clears this attempt observation', async (context) => {
  // SUCCEEDED needs every content type enabled and nothing blocked at all.
  const fake = harness(context, {
    visitOwner: owner, reservation: 'ok', pendingContent: false, retryBacklog: 0,
    subscriptionsEnabled: ['Audit.AzureActiveDirectory', 'Audit.Exchange', 'Audit.SharePoint', 'Audit.General'],
  })
  await fake.run()
  const after = fake.row()!
  assert.equal(after.status, 'SUCCEEDED')
  assert.ok(after.lastSuccessfulAt instanceof Date)
  assert.equal(fake.envelope()?.refusal, null)
})

test('two attempts at the identical instant have identical captured times and different tokens', async (context) => {
  const tokens: string[] = []
  const times: number[] = []
  for (let index = 0; index < 2; index += 1) {
    const fake = harness(context, { visitOwner: owner, reservation: 'budget' })
    await fake.run()
    const upsert = fake.of('syncState.upsert')[0]!.args[0] as any
    tokens.push(upsert.update.m365AuditAttempt.attemptToken)
    times.push((upsert.update.lastAttemptAt as Date).getTime())
    assert.equal(upsert.update.m365AuditAttempt.attemptAt,
      (upsert.update.lastAttemptAt as Date).toISOString(),
      'the envelope time is exactly the value written to lastAttemptAt')
  }
  assert.equal(times[0], times[1], 'precondition: both attempts captured the SAME instant')
  assert.notEqual(tokens[0], tokens[1], 'so only the token can distinguish them')
})

test('the early fresh/no-work return mutates nothing', async (context) => {
  const prior = {
    v: 1, attemptToken: 'prior-token', attemptAt: new Date(CLOCK - 600_000).toISOString(), refusal: null,
  }
  const fake = harness(context, {
    visitOwner: owner, pendingContent: false,
    storedRow: baseRow({
      lastSuccessfulAt: new Date(CLOCK - 1000), lastAttemptAt: new Date(CLOCK - 600_000),
      lastErrorCode: 'm365-audit-backlog', m365AuditAttempt: prior,
    }),
  })
  await fake.run()
  assert.deepEqual(fake.of('syncState.upsert'), [], 'no attempt was minted')
  assert.deepEqual(fake.of('syncState.updateMany'), [], 'no state transition at all')
  assert.deepEqual(fake.row()!.m365AuditAttempt, prior, 'the prior envelope is intact')
})

// ==========================================================================
// Inner coupling, fail-closed
// ==========================================================================

test('an unclaimable blob never reaches the budget path', async (context) => {
  const fake = harness(context, { visitOwner: owner, reservation: 'budget', claimCount: 0 })
  await fake.run()
  assert.equal(fake.envelope()?.refusal, null)
})

test('a zero-row failure disposition rolls back its coupled observation', async (context) => {
  const fake = harness(context, { visitOwner: owner, reservation: 'budget', dispositionCount: 0 })
  await assert.rejects(() => fake.run())
  assert.equal(fake.envelope()?.refusal, null)
})

test('a stale inner refusal rolls back both the disposition and the observation', async (context) => {
  const fake = harness(context, {
    visitOwner: owner, reservation: 'budget',
    successorDuring: 'content', successorSameTime: true,
  })
  await fake.run()
  const after = fake.row()!
  assert.deepEqual(after.m365AuditAttempt, fake.successor()!.m365AuditAttempt)
  assert.equal(fake.envelope()?.refusal, null)
})

test('a stale inner refusal with NO proven cap matches zero rows and rolls back', async (context) => {
  // The successor is installed before the guard runs, so the guard's first
  // evaluation already matches zero rows. This measures the fail-closed OUTCOME,
  // not the holding property -- holding is witnessed by the content-guard pair
  // below, where the successor arrives after a positive guard.
  const fake = harness(context, {
    visitOwner: owner, reservation: 'budget', constraint: null,
    successorDuring: 'content', successorSameTime: true,
  })
  await fake.run()
  assert.deepEqual(fake.row()!.m365AuditAttempt, fake.successor()!.m365AuditAttempt)
  // Pinning the 'superseded' RESULT, not merely the guard call: if the result
  // were ignored, the coupled transaction would commit a stale RETRY
  // disposition onto the content row while the successor owns the state row.
  assert.deepEqual(fake.dispositionCommits(), [],
    'no disposition committed once the guard reported the attempt superseded')
})

test('a lost lease refuses before any observation', async (context) => {
  const fake = harness(context, { visitOwner: owner, reservation: 'budget', leaseLost: true })
  await assert.rejects(() => fake.run())
  // The attempt upsert itself rolled back, so there is no envelope at all --
  // which is stronger than an envelope carrying no refusal.
  assert.equal(fake.row()!.m365AuditAttempt, null)
  assert.deepEqual(fake.of('syncState.updateMany'), [])
})

// ==========================================================================
// The absent-detail branch: the guard must HOLD the row, not just read it
// ==========================================================================

for (const [label, visitOwner] of [['owned', owner], ['ownerless', undefined]] as const) {
  test(`${label}: a successor arriving after the guard cannot commit a stale disposition`, async (context) => {
    // The ordering a read-only check cannot survive: the successor appears
    // AFTER this attempt's guard has answered positively for its own token and
    // BEFORE the coupled content disposition commits. Equal captured times, so
    // only the token distinguishes the two attempts.
    const fake = harness(context, {
      visitOwner, reservation: 'budget', constraint: null,
      successorDuring: 'content-guard', successorSameTime: true,
    })
    await fake.run()

    // THE POINT, asserted FIRST so a control that reverts the guard fails on
    // this claim and not on some earlier shape check: nothing may commit while
    // the successor owns the row. A plain count answers true and releases
    // immediately, so the successor lands between the check and the commit and
    // this list then contains its token.
    assert.equal(fake.committedTokens().includes(fake.successorToken), false,
      'no transaction committed under the successor token')
    // Attributed to the DISPOSITION's own transaction. A run commits the
    // attempt mint, interrupted recovery and the blob claim first, and in the
    // owned lane those are transactions too, so a whole-run token list would
    // satisfy this assertion no matter what the disposition committed under.
    assert.deepEqual(fake.dispositionCommits(), [
      { token: fake.attemptTokenFromUpsert(), sawDisposition: true },
    ], 'the disposition committed exactly once, under its own attempt')

    // And the row was acquired by WRITING it, with nothing but the attempt time
    // its own fence already required.
    const guardWrites = fake.of('syncState.updateMany').filter((call) => {
      const data = (call.args[0] as { data: Record<string, unknown> }).data
      return Object.keys(data).length === 1 && 'lastAttemptAt' in data
    })
    assert.equal(guardWrites.length, 1, 'the absent-detail branch wrote to acquire the row')
    assert.equal(
      (guardWrites[0].args[0] as any).where.m365AuditAttempt.equals,
      fake.attemptTokenFromUpsert(),
      'and it was fenced on this attempt token, not the successor',
    )

    // The successor is intact afterwards, with no detail invented for it.
    assert.deepEqual(fake.row()!.m365AuditAttempt, fake.successor()!.m365AuditAttempt)
    assert.ok(fake.envelope(), 'the successor envelope still parses')
    assert.equal(fake.envelope()?.refusal, null)
    assert.ok(fake.reasonCodes().includes('ATTEMPT_SUPERSEDED'),
      'and the stale attempt recorded itself as superseded rather than writing state')
  })
}

test('ownerless: a zero-row budget disposition fails closed instead of reaching terminal state', async (context) => {
  // No lease exists to catch this, so the attempt itself must refuse to go on.
  //
  // A successor is installed as well, because that is the state production can
  // actually produce: the only deleter of a content row is the retention sweep
  // inside commitTerminalState, which commits in the same transaction as that
  // run's own token-fenced terminal write -- so a committed delete proves a
  // newer attempt owns the state row. A zero-row disposition here therefore
  // really is supersession, which is what makes the reason code accurate.
  const fake = harness(context, {
    reservation: 'budget', dispositionCount: 0,
    successorDuring: 'content', successorSameTime: true,
  })
  await fake.run()
  assert.equal(fake.of('content.disposition').length, 1,
    'the attempt did reach its failure disposition, so this is a fail-closed path')
  assert.deepEqual(fake.of('syncState.updateMany'), [],
    'an unattributable disposition reaches neither the observation nor terminal state')
  assert.ok(fake.reasonCodes().includes('ATTEMPT_SUPERSEDED'))
  assert.ok(fake.envelope(), 'the successor envelope still parses')
  assert.equal(fake.envelope()?.refusal, null, 'and no refusal was recorded')
})

test('an earlier refusal from the SAME attempt survives acquiring the guard', async (context) => {
  // Two blobs inside ONE attempt: the first proves a cap and records it, the
  // second proves none and therefore only acquires the guard. Taking the guard
  // must not clear what this same attempt legitimately recorded.
  const fake = harness(context, {
    visitOwner: owner, blobs: 2,
    contentConstraints: ['monthly_tenant_records', null],
  })
  await fake.run()
  const envelope = fake.envelope()
  assert.equal(envelope?.refusal?.constraint, 'monthly_tenant_records',
    'the recordable refusal is still on the row after the unrecordable blob')
  assert.equal(envelope?.refusal?.path, 'content')
  assert.equal(envelope?.attemptToken, fake.attemptTokenFromUpsert(),
    'and it still belongs to this attempt')
  // Witness that the guard was actually ACQUIRED for the second blob. Without
  // this, the test passes with the guard deleted outright, because blob 0's
  // envelope survives on its own.
  const guardWrites = fake.of('syncState.updateMany').filter((call) => {
    const data = (call.args[0] as { data: Record<string, unknown> }).data
    return Object.keys(data).length === 1 && 'lastAttemptAt' in data
  })
  assert.equal(guardWrites.length, 1, 'the unrecordable blob acquired the guard')
  assert.equal((guardWrites[0].args[0] as any).issuer, 'transaction',
    'on the coupled transaction, not as an autocommit statement')
})

// ==========================================================================
// STRUCTURAL assertions (source text, not behaviour) -- labelled as such
// ==========================================================================

test('STRUCTURAL: every sync-state transition goes through the fenced writer', () => {
  // Any direct `syncState.update(` would be an unfenced status write.
  assert.equal(SOURCE.split('syncState.update(').length - 1, 0,
    'no unique-key status update remains')
  const writers = [...SOURCE.matchAll(/syncState\.(updateMany|upsert|count)\(/g)].map((m) => m[1])
  assert.deepEqual(writers.sort(), ['updateMany', 'upsert', 'upsert'],
    'exactly one guarded updateMany and the two attempt-installing upserts')
  // No unlocked read may fence an attempt any more: a plain count cannot hold
  // the row, so the absent-detail branch goes through the same writer.
  assert.equal(SOURCE.split('syncState.count(').length - 1, 0,
    'the read-only ownership check is gone')
  assert.equal(SOURCE.split('currentAttemptHolds').length - 1, 0,
    'and so is its helper')
  assert.match(SOURCE, /private async applyCurrentAttemptState\(/)
  assert.match(SOURCE, /private currentAttemptWhere\(/)
  assert.match(SOURCE, /private async holdCurrentAttempt\(/)
  // The guard acquires the row by writing back the value its own fence already
  // requires, so it cannot fabricate or clear anything to take the lock.
  // Ends at the guard's own closing brace, so a neighbouring method's doc
  // comment cannot drift into the window and fail this for the wrong reason.
  const guardStart = SOURCE.indexOf('private async holdCurrentAttempt(')
  const guard = SOURCE.slice(guardStart, SOURCE.indexOf('\n  }\n', guardStart) + 5)
  assert.match(guard, /\{ lastAttemptAt: attempt\.attemptAt \}/)
  assert.equal(/m365AuditAttempt|status:|lastSuccessfulAt|lastErrorCode|consecutiveFailures/.test(guard), false,
    'the guard payload touches no recorded field')
})

test('STRUCTURAL: the absent-detail branch is defensive, not a live production race', () => {
  // The guard's own comment claims this. Measure it, so the claim cannot rot:
  // every production budget error proves a cap, so refusalEnvelope never
  // returns null and the guard branch is unreachable from this file's own
  // throw. The hardening is still required -- the branch is reachable through
  // the constructor's default -- but it closes no live race.
  const constructions = [...SOURCE.matchAll(/new M365AuditBudgetError\(/g)]
  assert.equal(constructions.length, 1, 'exactly one construction in this collector')
  const call = SOURCE.slice(constructions[0].index!, constructions[0].index! + 400)
  assert.match(call, /selectBudgetConstraint\(exceeded\)/,
    'and it always passes a selected constraint, never a null one')
  const before = SOURCE.slice(Math.max(0, constructions[0].index! - 200), constructions[0].index!)
  assert.match(before, /if \(dailyExceeded \|\| monthlyExceeded\) \{/,
    'guarded by one of the eight caps actually being exceeded')
})

test('STRUCTURAL: exactly one deleter of content rows, inside the fenced terminal transition', () => {
  // The ownerless fail-closed attribution ("a zero-row disposition means this
  // attempt was superseded") rests on there being a single deleter, committing
  // with the token fence. If a second deleter appears, that attribution is no
  // longer sound and this test is where it must be reconsidered.
  const deleters = [...SOURCE.matchAll(/m365ActivityContent\.deleteMany\(/g)]
  assert.equal(deleters.length, 1, 'one content deleter')
  const terminalStart = SOURCE.indexOf('const commitTerminalState =')
  assert.ok(terminalStart > 0, 'the terminal transition is still a named closure')
  const fencedWrite = SOURCE.indexOf('applyCurrentAttemptState', terminalStart)
  assert.ok(deleters[0].index! > terminalStart && deleters[0].index! < fencedWrite,
    'the sweep sits inside commitTerminalState, ahead of its fenced state write')
})

test('STRUCTURAL: no budget lock is taken to record', () => {
  const helper = SOURCE.slice(
    SOURCE.indexOf('private currentAttemptWhere('),
    SOURCE.indexOf('private async reserveDailyUsage('),
  )
  assert.ok(helper.length > 0)
  assert.doesNotMatch(helper, /pg_advisory_xact_lock/)
  assert.doesNotMatch(helper, /m365-(daily|monthly)-budget/)
})

test('STRUCTURAL: the released reservation, refund and record accounting are unchanged', () => {
  assert.match(SOURCE, /Reserve the maximum possible body before reading it/)
  assert.match(SOURCE, /Keep the conservative reservation when a stream is interrupted/)
  assert.match(SOURCE, /Charge only records the database actually accepted/)
  assert.match(SOURCE, /\{ records: insertedRecordCount, blobs: 1 \}/)
  assert.match(SOURCE, /downloadedBytes: \{ gte: BigInt\(Math\.ceil\(bytes\)\) \}/)
  assert.match(SOURCE, /downloadedBytes: \{ decrement: BigInt\(Math\.ceil\(bytes\)\) \}/)
})

test('STRUCTURAL: the eight closed caps keep their released comparisons', () => {
  const decision = SOURCE.slice(
    SOURCE.indexOf('const exceeded: Record<'),
    SOURCE.indexOf('if (dailyExceeded || monthlyExceeded)'),
  )
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
    assert.ok(decision.includes(`${name}: ${expression},`), name)
  }
  assert.match(SOURCE, /monthlyExceeded \? nextUtcMonthDate\(now\) : nextUtcUsageDate\(now\)/)
})
