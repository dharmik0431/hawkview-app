import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Resolver } from 'node:dns/promises'
import { managedSyncTestDatabase, managedSyncTestToken } from './managed-sync.test-fixtures.js'
import {
  DAILY_INVENTORY_ANCHORS,
  HOURLY_INVENTORY_REFRESH_MS,
  HOURLY_INVENTORY_RESOURCES,
  TWENTY_MINUTE_INVENTORY_REFRESH_MS,
  dailyInventoryResourceDueAt,
  dailyInventoryResources,
  requiresDailyInventoryRefresh,
  scheduledSyncTenantWhere,
  selectScheduledTenantWork,
  shouldCollectInventoryInTwentyMinuteFullPass,
  shouldRunHourlyInventoryRefresh,
  shouldRunTargetedTransientRetry,
} from './scheduled-sync-selection.js'
import { TenantSyncService } from './tenant-sync.service.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'

/**
 * A bulk inventory collector displaced mid-attempt leaves a CLEAN RUNNING row:
 * `runSnapshotSync` writes `status: RUNNING` with a fresh `lastAttemptAt` and
 * clears `lastErrorCode`/`lastErrorMessage` before calling the collector, so a
 * process that never reaches a terminal write leaves no error marker behind.
 *
 * This file is the synthetic reproduction of that state for GROUPS with NO
 * pending audit-reconciliation row and NO new directory-audit event -- the one
 * shape the durable audit replay cannot reach. It covers the candidate query,
 * the pure selection rules and the ACTUAL dispatch through the real
 * `syncConnectedTenant` full-inventory branch, because selection without
 * eligibility would leave the row unreachable whenever every other inventory
 * stays fresh, and eligibility without dispatch would prove nothing collected.
 *
 * LIMIT OF THIS FIXTURE: it does NOT prove successful materialization. The
 * synthetic Prisma double cannot carry the real GROUPS relationship pipeline
 * (snapshot, membership and change-evidence writes in one transaction), so the
 * recovered attempt reaches a concrete FAILED terminal here. That is still
 * decisive for the defect -- a FAILED row is governed by the EXISTING failure
 * cooldowns, so the row has provably escaped the permanently excluded shape --
 * but the SUCCEEDED terminal, the persisted snapshot and the restored
 * memberships are asserted only by the registered physical witness in
 * `tenant-visit-audit-atomic.database-integration.test.ts`, against the real
 * schema and the real collector.
 *
 * No local or live database and no provider call: `fetch` is replaced for the
 * duration of each visit, `Date` is frozen so the service and the fixtures
 * share one instant, DNS resolution is mocked, and all are restored in
 * `finally`. The lease SQL is answered in memory and is not evidence of
 * database locking behaviour.
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** One instant for the pure rules AND for the real visits, which read their
 *  own `new Date()`. A fixed fixture against a live clock would drift into or
 *  out of the one-hour delay depending on the hour the suite runs. */
const now = new Date('2026-11-21T20:00:00Z')
const ago = (ms: number) => new Date(now.getTime() - ms)
const TWENTY = TWENTY_MINUTE_INVENTORY_REFRESH_MS

type SyntheticState = {
  resourceType: string
  status: string
  lastAttemptAt: Date | null
  lastSuccessfulAt: Date | null
  lastErrorCode?: string | null
  lastErrorMessage?: string | null
  consecutiveFailures?: number
}

const clean = (resourceType: string, overrides: Partial<SyntheticState> = {}): SyntheticState => ({
  resourceType, status: 'SUCCEEDED', lastAttemptAt: ago(MINUTE), lastSuccessfulAt: ago(MINUTE),
  lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0, ...overrides,
})

/** The interrupted attempt: RUNNING, an old attempt clock, an earlier success
 *  and no recorded error of any kind. */
const abandonedGroups = (overrides: Partial<SyntheticState> = {}): SyntheticState => clean('GROUPS', {
  status: 'RUNNING', lastAttemptAt: ago(26 * HOUR), lastSuccessfulAt: ago(27 * HOUR), ...overrides,
})

/**
 * Every daily resource, both anchors and USERS fresh. This is the case that
 * matters: other inventories can stay current through targeted events and
 * hourly catch-up, so nothing but the interrupted row is ever in question and
 * no unrelated pass arrives to carry it.
 */
function freshTenantStates(groups: SyntheticState): SyntheticState[] {
  return [
    ...dailyInventoryResources(true)
      .filter(resource => resource !== 'GROUPS')
      .map(resource => clean(resource)),
    ...DAILY_INVENTORY_ANCHORS.map(resource => clean(resource)),
    clean('USERS'),
    groups,
  ]
}

const candidate = (groups: SyntheticState) =>
  [{ id: 'tenant-1', syncStates: freshTenantStates(groups) }]

test('an interrupted clean GROUPS attempt is invisible to every pre-existing automatic rule', () => {
  const groups = abandonedGroups()

  // The full-pass clock excludes RUNNING outright, so the row cannot make its
  // own tenant due for the one pass that could re-dispatch it.
  assert.equal(dailyInventoryResourceDueAt(groups, now), null)
  assert.equal(dailyInventoryResourceDueAt(groups, now, TWENTY), null)

  // The incremental branch selects from the targeted-retry and hourly unions.
  // GROUPS is in the targeted set but that rule requires FAILED; the hourly
  // rule is the only RUNNING recovery and its allowlist excludes GROUPS.
  assert.equal(shouldRunTargetedTransientRetry(groups, now), false)
  assert.equal(shouldRunHourlyInventoryRefresh(groups, now), false)
  assert.equal((HOURLY_INVENTORY_RESOURCES as readonly string[]).includes('GROUPS'), false)

  // Ungated, with every other inventory fresh: no pass is due and the tenant
  // is not selected at all, so the row is permanently unreachable. This is the
  // defect, asserted as the pre-existing behaviour it is -- not as policy.
  assert.equal(requiresDailyInventoryRefresh(freshTenantStates(groups), now, true, TWENTY), false)
  assert.deepEqual(selectScheduledTenantWork(candidate(groups), now, 10, TWENTY), [])
})

test('the owned full20 scheduler selects the tenant AND marks it a full inventory pass', () => {
  const groups = abandonedGroups()
  assert.equal(
    requiresDailyInventoryRefresh(freshTenantStates(groups), now, true, TWENTY, true), true,
    'an incremental visit can never dispatch GROUPS, so the pass itself must become due',
  )
  const work = selectScheduledTenantWork(candidate(groups), now, 10, TWENTY, true)
  assert.equal(work.length, 1)
  assert.equal(work[0].tenantId, 'tenant-1')
  assert.equal(work[0].fullInventoryDue, true)
  assert.equal(
    work[0].dueAt.getTime(), ago(26 * HOUR).getTime(),
    'ranked by the interrupted attempt clock, not ahead of genuinely older work',
  )

  // The same delay, clock and clean-row rules as the dispatch gate.
  for (const [overrides, selected] of [
    [{ lastAttemptAt: ago(HOURLY_INVENTORY_REFRESH_MS) }, true],
    [{ lastAttemptAt: ago(HOURLY_INVENTORY_REFRESH_MS - 1) }, false],
    [{ lastSuccessfulAt: null }, true],
    [{ lastErrorCode: 'MICROSOFT_TRANSIENT' }, false],
    [{ lastErrorMessage: 'partial collection' }, false],
    [{ lastAttemptAt: null }, false],
    [{ lastAttemptAt: new Date(NaN) }, false],
    [{ lastAttemptAt: new Date(now.getTime() + 1) }, false],
    [{ lastSuccessfulAt: new Date(now.getTime() + 1) }, false],
  ] as Array<[Partial<SyntheticState>, boolean]>) {
    const states = freshTenantStates(abandonedGroups(overrides))
    assert.equal(
      requiresDailyInventoryRefresh(states, now, true, TWENTY, true), selected, JSON.stringify(overrides),
    )
    assert.equal(
      selectScheduledTenantWork([{ id: 'tenant-1', syncStates: states }], now, 10, TWENTY, true).length,
      selected ? 1 : 0, JSON.stringify(overrides),
    )
  }
})

test('the candidate query admits the interrupted row only under the gate, changing no existing branch', () => {
  type Where = { AND: Array<{ OR?: unknown[] }> }
  const branches = (where: unknown) => ((where as Where).AND[1].OR ?? []) as Array<Record<string, any>>
  const running = (where: unknown) =>
    branches(where).filter(branch => branch?.syncStates?.some?.status === 'RUNNING')

  const ungated = scheduledSyncTenantWhere(now, TWENTY)
  const gated = scheduledSyncTenantWhere(now, TWENTY, true)
  // The pre-existing query already has an hourly RUNNING branch, so key on the
  // resource set: GROUPS is the resource with no pre-existing RUNNING recovery.
  assert.deepEqual(
    running(ungated).filter(branch =>
      (branch.syncStates.some.resourceType.in as string[]).includes('GROUPS')), [],
    'no pre-existing branch admits an abandoned GROUPS row',
  )
  assert.equal(branches(gated).length, branches(ungated).length + 2,
    'exactly two new branches: the plain set, and Exchange behind its own gate')
  assert.deepEqual(
    branches(gated).slice(2), branches(ungated),
    'the gate rewrites none of the existing predicates',
  )
  assert.deepEqual(scheduledSyncTenantWhere(now, TWENTY, false), ungated)

  const [branch, ...extra] = running(gated).filter(candidate =>
    (candidate.syncStates.some.resourceType.in as string[]).includes('GROUPS'))
  assert.deepEqual(extra, [])
  const some = branch.syncStates.some
  const admitted = some.resourceType.in as string[]
  assert.ok(admitted.includes('GROUPS'))
  // Candidacy must never be narrower than the rule that finally decides.
  assert.equal(
    some.lastAttemptAt.lte.getTime(), now.getTime() - HOURLY_INVENTORY_REFRESH_MS,
    'inclusive at exactly the pure rule boundary millisecond',
  )
  assert.equal(some.lastErrorCode, null)
  assert.equal(some.lastErrorMessage, null)
  // Resources whose RUNNING row carries its own meaning, or that already have
  // hourly RUNNING recovery, must not be admitted here.
  for (const excluded of ['USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT', ...HOURLY_INVENTORY_RESOURCES]) {
    assert.equal(admitted.includes(excluded), false, excluded)
  }
  // Every bulk daily resource without hourly coverage is admitted, so a
  // resource added to the daily pass cannot silently lose recovery -- except
  // EXCHANGE_MAILBOX_CONFIGURATION, which must stay behind its own gate.
  for (const resource of dailyInventoryResources(false)) {
    assert.equal(
      admitted.includes(resource),
      !(HOURLY_INVENTORY_RESOURCES as readonly string[]).includes(resource), resource,
    )
  }
  assert.equal(admitted.includes('EXCHANGE_MAILBOX_CONFIGURATION'), false,
    'an old configuration row must not schedule a tenant with Exchange read-only disabled')

  // That resource is admitted only inside the existing connection gate.
  const exchangeBranch = branches(gated).find(candidate => Array.isArray(candidate.AND) &&
    candidate.AND[1]?.syncStates?.some?.status === 'RUNNING')!
  assert.deepEqual(exchangeBranch.AND[0], { connection: { exchangeReadOnlyEnabledAt: { not: null } } })
  assert.deepEqual(exchangeBranch.AND[1].syncStates.some.resourceType.in,
    ['EXCHANGE_MAILBOX_CONFIGURATION'])
  assert.equal(exchangeBranch.AND[1].syncStates.some.lastAttemptAt.lte.getTime(),
    now.getTime() - HOURLY_INVENTORY_REFRESH_MS)
})

test('EXCHANGE_MAILBOX_CONFIGURATION recovery preserves the existing Exchange read-only gate', () => {
  const emc = abandonedGroups({ resourceType: 'EXCHANGE_MAILBOX_CONFIGURATION' })
  // The dispatch gate.
  assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(emc, now, true, false), false)
  assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(emc, now, true, true), true)
  assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(emc, now, false, true), false,
    'ownerless behaviour is unchanged for this resource too')

  // Pure eligibility and due ranking.
  const states = [
    ...freshTenantStates(clean('GROUPS'))
      .filter(state => state.resourceType !== 'EXCHANGE_MAILBOX_CONFIGURATION'),
    emc,
  ]
  assert.equal(requiresDailyInventoryRefresh(states, now, false, TWENTY, true), false,
    'a disabled tenant must not be made due by an old configuration row')
  assert.equal(requiresDailyInventoryRefresh(states, now, true, TWENTY, true), true)
  assert.deepEqual(selectScheduledTenantWork(
    [{ id: 'tenant-1', syncStates: states, connection: { exchangeReadOnlyEnabledAt: null } }],
    now, 10, TWENTY, true), [])
  const enabled = selectScheduledTenantWork(
    [{ id: 'tenant-1', syncStates: states,
      connection: { exchangeReadOnlyEnabledAt: new Date('2026-01-01T00:00:00Z') } }],
    now, 10, TWENTY, true)
  assert.equal(enabled.length, 1)
  assert.equal(enabled[0].fullInventoryDue, true)
  assert.equal(enabled[0].dueAt.getTime(), ago(26 * HOUR).getTime(),
    'ranked by the interrupted attempt clock')
})

test('an owned full inventory pass recovers an interrupted clean bulk attempt after the existing one-hour delay', () => {
  // Exchange read-only enabled throughout, so every daily resource is in
  // scope here; the gate itself has its own case.
  const recover = (state: SyntheticState) =>
    shouldCollectInventoryInTwentyMinuteFullPass(state, now, true, true)

  assert.equal(recover(abandonedGroups()), true)
  assert.equal(
    recover(abandonedGroups({ lastAttemptAt: ago(HOURLY_INVENTORY_REFRESH_MS) })), true,
    'inclusive at exactly the existing one-hour stale-attempt delay',
  )
  assert.equal(
    recover(abandonedGroups({ lastAttemptAt: ago(HOURLY_INVENTORY_REFRESH_MS - 1) })), false,
    'a still-plausible in-flight attempt must not be re-dispatched',
  )
  // A first run that never succeeded still uses its own old attempt clock.
  assert.equal(recover(abandonedGroups({ lastSuccessfulAt: null })), true)

  // Ownerless behaviour is unchanged: without a fenced visit nothing
  // establishes that the displaced collector has stopped writing.
  assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(abandonedGroups(), now), false)

  // A recorded error is existing policy's signal, not an abandoned attempt.
  for (const marker of [
    { lastErrorCode: 'MICROSOFT_TRANSIENT' },
    { lastErrorCode: 'COLLECTION_INITIALIZING' },
    { lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED' },
    { lastErrorMessage: 'partial collection' },
  ]) assert.equal(recover(abandonedGroups(marker)), false, JSON.stringify(marker))

  // Fresh and invalid clocks on either column.
  for (const lastAttemptAt of [null, new Date(NaN), new Date(now.getTime() + 1), now]) {
    assert.equal(recover(abandonedGroups({ lastAttemptAt })), false, String(lastAttemptAt))
  }
  for (const lastSuccessfulAt of [new Date(NaN), new Date(now.getTime() + 1)]) {
    assert.equal(recover(abandonedGroups({ lastSuccessfulAt })), false, String(lastSuccessfulAt))
  }

  // Every bulk inventory resource without hourly RUNNING recovery is covered;
  // the resources whose RUNNING row carries its own meaning are not.
  for (const resource of dailyInventoryResources(true)) {
    const state = abandonedGroups({ resourceType: resource })
    assert.equal(recover(state),
      !(HOURLY_INVENTORY_RESOURCES as readonly string[]).includes(resource) ||
        shouldRunHourlyInventoryRefresh(state, now), resource)
  }
  for (const resource of ['USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT']) {
    assert.equal(recover(abandonedGroups({ resourceType: resource })), false,
      `${resource} RUNNING is the lease or a retained fallback marker, never an abandoned attempt`)
  }
})

test('existing failure and partial cooldowns keep their exact owned full-pass behaviour', () => {
  const failed = (age: number, code: string) => clean('GROUPS', {
    status: 'FAILED', lastSuccessfulAt: ago(2 * DAY), lastAttemptAt: ago(age),
    lastErrorCode: code, consecutiveFailures: 1,
  })
  for (const [age, code, expected] of [
    [30 * MINUTE, '500', true], [30 * MINUTE - 1, '500', false],
    [HOUR, '403', false], [23 * HOUR, '403', false], [DAY, '403', true],
    [HOUR, 'HAWKVIEW_CAPACITY_GUARD', false],
  ] as const) {
    assert.equal(
      shouldCollectInventoryInTwentyMinuteFullPass(failed(age, code), now, true), expected,
      `${code} at ${age}ms must keep its existing cooldown under an owned pass`,
    )
    assert.equal(
      shouldCollectInventoryInTwentyMinuteFullPass(failed(age, code), now, true),
      shouldCollectInventoryInTwentyMinuteFullPass(failed(age, code), now),
      'recovery must not change any non-RUNNING outcome',
    )
  }
  // Healthy and unknown inventory are unchanged in both modes.
  for (const state of [clean('GROUPS'), undefined]) {
    assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(state, now, true), true)
    assert.equal(shouldCollectInventoryInTwentyMinuteFullPass(state, now), true)
  }
})

/* ---------- actual selection and dispatch through the real full pass ---------- */

const GROUPS_URL = 'https://graph.microsoft.com/v1.0/groups?'
const GRAPH_GROUP_ID = '99999999-9999-4999-8999-999999999999'
const GRAPH_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function tenant() {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    organizationId: '77777777-7777-4777-8777-777777777777',
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Tenant', primaryDomain: 'tenant.example', status: 'ACTIVE',
    connection: {
      status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED',
      clientId: null, credentialReference: null, lastVerifiedAt: null,
      exchangeReadOnlyEnabledAt: null,
    },
  }
}

const owner = {
  customerTenantId: tenant().id, organizationId: tenant().organizationId,
  token: '88888888-8888-4888-8888-888888888888', generation: 7n,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
}

/** Collector bookkeeping this test does not assert is answered permissively,
 *  so each case stands on the recorded provider requests and status writes. */
function syntheticModel(name: string) {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, method: string) => async () => {
      if (method === 'findMany' || method === 'groupBy') return []
      if (method === 'count') return 0
      if (method === 'aggregate') return {}
      if (method === 'updateMany' || method === 'deleteMany') return { count: 0 }
      if (method === 'create' || method === 'update' || method === 'upsert') {
        return { id: `${name}-1`, consecutiveFailures: 1 }
      }
      return null
    },
  })
}

type StatusWrite = { resourceType: unknown; status: unknown; lastAttemptAt?: unknown }

function syntheticDatabase(states: SyntheticState[], leaseHeld: boolean) {
  const statusWrites: StatusWrite[] = []
  const models = new Map<string, unknown>()
  const record = (args: any, data: any) => {
    statusWrites.push({
      resourceType: args?.where?.customerTenantId_resourceType?.resourceType,
      status: data?.status,
      lastAttemptAt: data?.lastAttemptAt,
    })
  }
  const syncState = {
    // The full-inventory branch reads the cooldown states with `notIn`; the
    // end-of-visit outcome read filters by `lastAttemptAt`. Answering them
    // identically would let an outcome read re-trigger dispatch reasoning.
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {}
      const resourceType = where.resourceType as { in?: string[]; notIn?: string[] } | undefined
      if (resourceType?.notIn) return states.filter(s => !resourceType.notIn!.includes(s.resourceType))
      if (resourceType?.in) return states.filter(s => resourceType.in!.includes(s.resourceType))
      return []
    },
    // No existing USERS lease row, so the lease is created by this visit.
    findUnique: async () => null,
    updateMany: async () => ({ count: 1 }),
    update: async (args: { data?: any; where?: any }) => {
      record(args, args?.data)
      return { id: 'state-1', consecutiveFailures: 1 }
    },
    upsert: async (args: { update?: any; where?: any }) => {
      record(args, args?.update)
      return { id: 'state-1', consecutiveFailures: 1, lastSuccessfulAt: null }
    },
    create: async () => ({ id: 'state-1' }),
  }
  const base = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      if (key === 'syncState') return syncState
      if (key === 'tenantDomain') return new Proxy(syntheticModel('tenantDomain'), {
        get: (model, method: string) => method === 'findMany'
          ? async () => [{ name: 'tenant.example' }]
          : Reflect.get(model, method),
      })
      // The real GROUPS collector resolves memberships against persisted
      // directory rows; an owner-bearing collection cannot complete without
      // them, so a SUCCEEDED terminal would be unreachable.
      if (key === 'directoryUser') return new Proxy(syntheticModel('directoryUser'), {
        get: (model, method: string) => method === 'findMany'
          ? async () => [{ id: 'user-row', microsoftUserId: GRAPH_USER_ID }]
          : Reflect.get(model, method),
      })
      if (key === 'directoryGroup') return new Proxy(syntheticModel('directoryGroup'), {
        get: (model, method: string) => method === 'findMany'
          ? async () => [{ id: 'group-row', microsoftGroupId: GRAPH_GROUP_ID }]
          : Reflect.get(model, method),
      })
      if (key === 'then') return undefined
      if (!models.has(key)) models.set(key, syntheticModel(key))
      return models.get(key)
    },
    set: (target, key: string, value: unknown) => { target[key] = value; return true },
    has: () => true,
  })
  const database = managedSyncTestDatabase(
    base as { tenantConnection: { update: (args: unknown) => Promise<unknown> } }, tenant(),
  )
  const utcQuery = database.$queryRawUnsafe
  // In-memory answers for the existing owner fence only. This is not evidence
  // of row locking: it decides whether the owned code path believes it still
  // holds the lease, nothing more.
  database.$queryRawUnsafe = (async (sql: string, ...values: unknown[]) => {
    if (sql.includes('FROM organizations')) return [{ id: owner.organizationId }]
    if (sql.includes('FROM customer_tenants WHERE id=')) return [{ id: owner.customerTenantId }]
    if (sql.includes('FROM tenant_sync_visit_leases')) return leaseHeld ? [{ generation: '7' }] : []
    return utcQuery(sql, ...values)
  }) as typeof database.$queryRawUnsafe
  const executeUtc = database.$executeRawUnsafe
  database.$executeRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql === 'SELECT pg_advisory_xact_lock(hashtext($1))') {
      assert.equal(values.length, 1)
      assert.ok(String(values[0]).startsWith(`hawkview:snapshot:${tenant().id}:`))
      return 0
    }
    return executeUtc(sql)
  }
  return { database, statusWrites }
}

/** Runs ONE real full-inventory visit and returns every requested URL. */
async function runFullInventoryVisit(
  states: SyntheticState[],
  visitOwner?: typeof owner,
  leaseHeld = true,
) {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  const { database, statusWrites } = syntheticDatabase(states, leaseHeld)
  const txt = mock.method(Resolver.prototype, 'resolveTxt', async () => [['v=spf1 -all']])
  const cname = mock.method(Resolver.prototype, 'resolveCname', async () => ['dkim.example'])
  const cancel = mock.method(Resolver.prototype, 'cancel', () => undefined)
  // Freeze ONLY Date, so the visit's own `new Date()` is the fixture instant.
  // Timers are left real: a faked timer would change collector behaviour.
  mock.timers.enable({ apis: ['Date'], now: now.getTime() })
  const page = (value: unknown[], extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ value, ...extra }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    // An owner-bearing GROUPS collection rejects an incomplete page, so this
    // resource is answered in full. Every other collector is answered
    // generically: this case stands on the GROUPS requests and status writes.
    if (url.includes(`/groups/${GRAPH_GROUP_ID}/owners?`)) {
      return page([{ id: GRAPH_USER_ID, displayName: 'Owner' }])
    }
    if (url.includes(`/groups/${GRAPH_GROUP_ID}/members?`)) return page([{ id: GRAPH_USER_ID }])
    if (url.startsWith(GROUPS_URL)) {
      return page([{ id: GRAPH_GROUP_ID, displayName: 'Synthetic group', securityEnabled: true }])
    }
    return page([], {
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=new',
    })
  }) as typeof fetch
  let error: unknown
  try {
    const service = new TenantSyncService(
      database as never,
      { getCapturedManagedAccessToken: managedSyncTestToken(tenant()) } as never,
      {} as never,
      { resolveIncident: async () => undefined, publishIncident: async () => undefined } as never,
      { buildSnapshotDifferenceEvidence: () => [] } as never,
      { syncTenant: async () => [] } as never,
    )
    ;(service as unknown as { logger: unknown }).logger = { log() {}, warn() {}, error() {} }
    ;(service as unknown as { markConnectionUnavailable: unknown }).markConnectionUnavailable = async () => undefined
    await (service as unknown as {
      syncConnectedTenant: (t: unknown, b: boolean, o: unknown) => Promise<{ status: string }>
    }).syncConnectedTenant(tenant(), true, {
      incrementalOnly: false, includeBundle: false, forceFullUsers: true,
      preserveInventoryFailureCooldowns: true, visitOwner,
    })
  } catch (caught) {
    error = caught
  } finally {
    globalThis.fetch = originalFetch
    mock.timers.reset()
    txt.mock.restore()
    cname.mock.restore()
    cancel.mock.restore()
  }
  return { urls, statusWrites, error }
}

const groupsRequests = (urls: string[]) => urls.filter(url => url.startsWith(GROUPS_URL)).length
const groupsStatuses = (writes: StatusWrite[]) =>
  writes.filter(write => write.resourceType === 'GROUPS').map(write => write.status)

test('the real owned full pass dispatches the interrupted GROUPS collector and leaves the RUNNING shape', async () => {
  const { urls, statusWrites, error } = await runFullInventoryVisit(
    freshTenantStates(abandonedGroups()), owner,
  )
  assert.equal(error, undefined)
  assert.equal(groupsRequests(urls), 1,
    'the recovered attempt must reach the actual GROUPS collector exactly once')

  // A recovery is an ordinary collection: the attempt marker, then exactly one
  // terminal write. Which terminal it is depends on the collector's own
  // outcome, and THAT is asserted against the real schema in the registered
  // physical witness; what matters here is that the row cannot stay in the
  // permanently excluded shape and cannot re-dispatch on the next tick.
  const groupsWrites = statusWrites.filter(write => write.resourceType === 'GROUPS')
  assert.equal(groupsWrites.length, 2, 'the attempt marker and exactly one terminal write')
  assert.equal(groupsWrites[0].status, 'RUNNING')
  // A concrete allowed terminal, never merely "not RUNNING": an absent status
  // would satisfy an inequality while proving nothing was written. SUCCEEDED
  // is the production outcome; FAILED is this fixture's known synthetic one,
  // and both hand the row back to existing policy instead of stranding it.
  assert.ok(
    ['SUCCEEDED', 'FAILED'].includes(groupsWrites[1].status as string),
    `the row must reach a concrete terminal, got ${String(groupsWrites[1].status)}`,
  )
  const rewritten = groupsWrites[0].lastAttemptAt as Date
  assert.equal(rewritten.getTime(), now.getTime(), 'the attempt clock is rewritten before collecting')
  assert.equal(
    shouldCollectInventoryInTwentyMinuteFullPass(
      { ...abandonedGroups(), lastAttemptAt: rewritten }, now, true, false), false,
    'the rewritten clock closes the gate again: no five-minute re-dispatch loop',
  )
})

test('the real full pass leaves the interrupted attempt alone without a fenced visit owner', async () => {
  const { urls, statusWrites, error } = await runFullInventoryVisit(freshTenantStates(abandonedGroups()))
  assert.equal(error, undefined)
  assert.equal(groupsRequests(urls), 0, 'ownerless behaviour is unchanged')
  assert.deepEqual(groupsStatuses(statusWrites), [])
})

test('a stale visit owner cannot recover the interrupted attempt', async () => {
  const { urls, statusWrites, error } = await runFullInventoryVisit(
    freshTenantStates(abandonedGroups()), owner, false,
  )
  assert.ok(error instanceof TenantVisitLeaseLostError, `unexpected outcome: ${String(error)}`)
  assert.equal(groupsRequests(urls), 0, 'a displaced owner must make no GROUPS provider request')
  assert.equal(groupsStatuses(statusWrites).includes('SUCCEEDED'), false)
  assert.equal(groupsStatuses(statusWrites).includes('FAILED'), false,
    'losing the lease is not a collection failure and must not be recorded as one')
})

test('the real owned full pass does not re-dispatch a recent or error-bearing GROUPS attempt', async () => {
  for (const overrides of [
    { lastAttemptAt: ago(MINUTE) },
    { lastAttemptAt: ago(HOURLY_INVENTORY_REFRESH_MS - 1) },
    { lastErrorCode: 'MICROSOFT_TRANSIENT' },
    { lastErrorCode: 'COLLECTION_INITIALIZING' },
    { lastErrorMessage: 'partial collection' },
    { lastAttemptAt: new Date(now.getTime() + HOUR) },
    { lastSuccessfulAt: new Date(now.getTime() + HOUR) },
  ]) {
    const { urls, statusWrites, error } = await runFullInventoryVisit(
      freshTenantStates(abandonedGroups(overrides)), owner,
    )
    assert.equal(error, undefined, JSON.stringify(overrides))
    assert.equal(groupsRequests(urls), 0, JSON.stringify(overrides))
    assert.deepEqual(groupsStatuses(statusWrites), [], JSON.stringify(overrides))
  }
})

test('the real owned full pass still collects healthy GROUPS and still honours a failed cooldown', async () => {
  const healthy = await runFullInventoryVisit(freshTenantStates(clean('GROUPS')), owner)
  assert.equal(groupsRequests(healthy.urls), 1, 'healthy inventory collection is unchanged')
  assert.equal(groupsStatuses(healthy.statusWrites).length, 2)
  assert.equal(groupsStatuses(healthy.statusWrites)[0], 'RUNNING')
  assert.ok(['SUCCEEDED', 'FAILED'].includes(groupsStatuses(healthy.statusWrites)[1] as string))
  const cooling = await runFullInventoryVisit(freshTenantStates(clean('GROUPS', {
    status: 'FAILED', lastAttemptAt: ago(MINUTE), lastSuccessfulAt: ago(2 * DAY),
    lastErrorCode: '403', consecutiveFailures: 1,
  })), owner)
  assert.equal(groupsRequests(cooling.urls), 0, 'an existing failure cooldown is unchanged')
  assert.deepEqual(groupsStatuses(cooling.statusWrites), [])
})
