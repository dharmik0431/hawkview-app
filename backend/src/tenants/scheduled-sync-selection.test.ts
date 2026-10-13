import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DAILY_INVENTORY_RESOURCES,
  dailyInventoryResourceDueAt,
  requiresDailyInventoryRefresh,
  scheduledSyncTenantWhere,
  selectScheduledTenantWork,
  shouldRunHourlyInventoryRefresh,
  shouldRunTargetedTransientRetry,
  targetedTransientRetryDelayMs,
  HOURLY_INVENTORY_FIRST_RETRY_MS,
  HOURLY_INVENTORY_REFRESH_MS,
  HOURLY_INVENTORY_RESOURCES,
  TARGETED_TRANSIENT_RETRY_RESOURCES,
} from './scheduled-sync-selection.js'

const now = new Date('2026-08-17T16:00:00.000Z')
const dailyCoverage = () => DAILY_INVENTORY_RESOURCES.map(resource => state(resource, 'SUCCEEDED', now, now))

function state(
  resourceType: string,
  status = 'SUCCEEDED',
  lastSuccessfulAt: Date | null = new Date('2026-08-17T15:00:00.000Z'),
  lastAttemptAt = lastSuccessfulAt,
) {
  return { resourceType, status, lastSuccessfulAt, lastAttemptAt }
}

test('does not request a daily inventory while both anchors are current', () => {
  assert.equal(
    requiresDailyInventoryRefresh([...dailyCoverage(), state('LICENSES'), state('DOMAINS')], now),
    false,
  )
})

test('requests a daily inventory when one anchor is stale even if the other is current', () => {
  assert.equal(
    requiresDailyInventoryRefresh(
      [...dailyCoverage(),
        state('LICENSES', 'SUCCEEDED', new Date('2026-08-16T14:00:00.000Z')),
        state('DOMAINS'),
      ],
      now,
    ),
    true,
  )
})

test('waits for a running daily collector instead of scheduling a duplicate run', () => {
  assert.equal(
    requiresDailyInventoryRefresh(
      [...dailyCoverage(), state('LICENSES', 'RUNNING', null, new Date('2026-08-17T15:59:00.000Z')), state('DOMAINS')],
      now,
    ),
    false,
  )
})

test('selects tenants with either missing daily anchor, not only tenants missing both', () => {
  const where = scheduledSyncTenantWhere(now)
  const selectors = (where.AND as Array<{ OR?: unknown }>)[1]?.OR as Array<{
    syncStates?: { none?: { resourceType?: string } }
  }>
  const missingAnchorSelectors = selectors
    .map((selector) => selector.syncStates?.none?.resourceType)
    .filter((resourceType): resourceType is string => Boolean(resourceType))

  assert.equal(missingAnchorSelectors.includes('LICENSES'), true)
  assert.equal(missingAnchorSelectors.includes('DOMAINS'), true)
})

test('excludes a non-expired durable USERS lease before scheduler candidate limiting', () => {
  const where = JSON.stringify(scheduledSyncTenantWhere(now))
  assert.match(where, /RUNNING/)
  assert.match(where, /USERS/)
  assert.match(where, /2026-08-17T15:45:00.000Z/)
})

test('retries only explicitly bounded transient resources before the daily inventory', () => {
  const transient = {
    ...state('SHAREPOINT_SITES', 'FAILED', null, new Date('2026-08-17T15:29:00.000Z')),
    lastErrorCode: '500', lastErrorMessage: 'upstream unavailable', consecutiveFailures: 1,
  }
  assert.equal(shouldRunTargetedTransientRetry(transient, now), true)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, resourceType: 'NAMED_LOCATIONS' }, now), true)
  assert.equal(targetedTransientRetryDelayMs(transient), 30 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, lastErrorCode: '401', lastErrorMessage: 'Unauthorized' }, now), false)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, resourceType: 'NAMED_LOCATIONS', lastErrorCode: '403', lastErrorMessage: 'Forbidden' }, now), false)
  assert.equal(shouldRunTargetedTransientRetry({ ...transient, resourceType: 'USERS' }, now), false)
})

test('a retired Exchange Admin collector can never schedule targeted work', () => {
  const historicalFailure = {
    ...state(
      'EXCHANGE_MAILBOX_CONFIGURATION',
      'FAILED',
      null,
      new Date('2026-08-17T10:00:00.000Z'),
    ),
    lastErrorCode: '403',
    lastErrorMessage: 'Historical Exchange Admin API authorization failure.',
    consecutiveFailures: 20,
  }

  assert.equal(shouldRunTargetedTransientRetry(historicalFailure, now), false)
  // Optional Exchange is a daily candidate only when its existing flag is on.
  assert.match(JSON.stringify(scheduledSyncTenantWhere(now)), /exchangeReadOnlyEnabledAt/)
  assert.deepEqual(
    selectScheduledTenantWork(
      [{
        id: 'retired-exchange-admin-state',
        syncStates: [...dailyCoverage(),
          state('USERS', 'SUCCEEDED', now, now),
          state('LICENSES'),
          state('DOMAINS'),
          historicalFailure,
        ],
      }],
      now,
      25,
    ),
    [],
  )
})

test('targeted retry backs off and the scheduler query excludes known authorization failures', () => {
  const laterFailure = {
    ...state('SHAREPOINT_SITES', 'FAILED', null, new Date('2026-08-17T15:00:00.000Z')),
    lastErrorCode: '500', lastErrorMessage: 'temporary', consecutiveFailures: 4,
  }
  assert.equal(targetedTransientRetryDelayMs(laterFailure), 4 * 60 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry(laterFailure, now), false)
  const where = JSON.stringify(scheduledSyncTenantWhere(now))
  assert.match(where, /SHAREPOINT_SITES/)
  assert.match(where, /NAMED_LOCATIONS/)
  assert.match(where, /401/)
  assert.match(where, /403/)
})

test('uses stable failure codes and cost-aware retry windows', () => {
  const lightTransient = {
    ...state('NAMED_LOCATIONS', 'FAILED', null, new Date('2026-08-17T15:44:00.000Z')),
    lastErrorCode: 'MICROSOFT_TRANSIENT',
    lastErrorMessage: 'Microsoft temporarily could not provide Named Locations data.',
    consecutiveFailures: 1,
  }
  const heavyTransient = {
    ...lightTransient,
    resourceType: 'SHAREPOINT_SITES',
    lastAttemptAt: new Date('2026-08-17T15:31:00.000Z'),
  }

  assert.equal(targetedTransientRetryDelayMs(lightTransient), 15 * 60 * 1000)
  assert.equal(targetedTransientRetryDelayMs(heavyTransient), 30 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry(lightTransient, now), true)
  assert.equal(shouldRunTargetedTransientRetry(heavyTransient, now), false)
  assert.equal(shouldRunTargetedTransientRetry({
    ...lightTransient,
    lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED',
  }, now), false)
  assert.equal(shouldRunTargetedTransientRetry({
    ...lightTransient,
    lastErrorCode: 'MICROSOFT_AUTHENTICATION_REQUIRED',
  }, now), false)
})

test('selects a tenant for an eligible Named Locations retry without forcing full inventory', () => {
  const selected = selectScheduledTenantWork([{
    id: 'named-locations-retry',
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', now, now),
      state('LICENSES'),
      state('DOMAINS'),
      {
        ...state('NAMED_LOCATIONS', 'FAILED', new Date('2026-08-17T10:00:00.000Z'), new Date('2026-08-17T15:29:00.000Z')),
        lastErrorCode: '500',
        lastErrorMessage: 'Microsoft named locations synchronization returned 500.',
        consecutiveFailures: 1,
      },
    ],
  }], now, 25)

  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.tenantId, 'named-locations-retry')
  assert.equal(selected[0]?.fullInventoryDue, false)
})

test('never hot-loops bounded SharePoint capacity failures or invalid retry timestamps', () => {
  const capacity = {
    ...state('SHAREPOINT_SITES', 'FAILED', null, new Date('2026-08-17T12:00:00.000Z')),
    lastErrorCode: 'sharepoint_sites-sync-failed',
    lastErrorMessage: 'SharePoint site-user metadata reached a bounded record limit before completion.',
    consecutiveFailures: 8,
  }
  assert.equal(shouldRunTargetedTransientRetry(capacity, now), false)
  assert.equal(shouldRunTargetedTransientRetry({ ...capacity, lastAttemptAt: new Date('not-a-date') }, now), false)
})

test('ranks due work by durable resource attempt time with a stable tenant tie-break', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    id: `tenant-${String(index).padStart(2, '0')}`,
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', new Date('2026-08-17T15:00:00.000Z')),
      state('LICENSES'), state('DOMAINS'),
    ],
  }))
  const selected = selectScheduledTenantWork(candidates, now, 25)
  assert.equal(selected.length, 25)
  assert.deepEqual(selected.slice(0, 3).map((item) => item.tenantId), ['tenant-00', 'tenant-01', 'tenant-02'])
  // Once the first cohort was attempted, their per-resource timestamp moves
  // forward and the next cohort wins even if CustomerTenant.updatedAt did not.
  const next = selectScheduledTenantWork(candidates.map((candidate, index) => index < 25
    ? { ...candidate, syncStates: [...dailyCoverage(), state('USERS', 'SUCCEEDED', now, now), state('LICENSES'), state('DOMAINS')] }
    : candidate), now, 25)
  assert.equal(next[0]?.tenantId, 'tenant-25')
})

test('does not let authorization, capacity, or future timestamps consume targeted retry slots', () => {
  const retry = (id: string, error: string, lastAttemptAt: Date) => ({
    id,
    syncStates: [...dailyCoverage(), {
      ...state('SHAREPOINT_SITES', 'FAILED', null, lastAttemptAt),
      lastErrorCode: '500', lastErrorMessage: error, consecutiveFailures: 1,
    }, state('LICENSES'), state('DOMAINS'), state('USERS', 'SUCCEEDED', now, now)],
  })
  const selected = selectScheduledTenantWork([
    retry('authorization', '403 forbidden', new Date('2026-08-17T14:00:00.000Z')),
    retry('capacity', 'bounded collection record limit', new Date('2026-08-17T14:00:00.000Z')),
    retry('future', 'temporary', new Date('2026-08-17T18:00:00.000Z')),
    retry('eligible', 'temporary', new Date('2026-08-17T15:00:00.000Z')),
  ], now, 25)
  assert.deepEqual(selected.map((item) => item.tenantId), ['eligible'])
})

test('keeps a 1,000-tenant due population moving after each 25-tenant batch', () => {
  const population = Array.from({ length: 1_000 }, (_, index) => ({
    id: `tenant-${String(index).padStart(4, '0')}`,
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', new Date('2026-08-17T15:00:00.000Z')),
      state('LICENSES'), state('DOMAINS'),
    ],
  }))
  const first = selectScheduledTenantWork(population, now, 25)
  assert.equal(first.length, 25)
  const completed = new Set(first.map((item) => item.tenantId))
  const second = selectScheduledTenantWork(population.map((candidate) => completed.has(candidate.id)
    ? { ...candidate, syncStates: [...dailyCoverage(), state('USERS', 'SUCCEEDED', now, now), state('LICENSES'), state('DOMAINS')] }
    : candidate), now, 25)
  assert.equal(second[0]?.tenantId, 'tenant-0025')
  assert.equal(second.some((item) => completed.has(item.tenantId)), false)
})

// ---------------------------------------------- hourly inventory eligibility

const ago = (ms: number) => new Date(now.getTime() - ms)
const HOUR = HOURLY_INVENTORY_REFRESH_MS

test('hourly inventory eligibility is inclusive at exactly one hour', () => {
  assert.equal(shouldRunHourlyInventoryRefresh(
    state('CONDITIONAL_ACCESS', 'SUCCEEDED', ago(HOUR)), now), true)
  // One millisecond short is not due, so the boundary is pinned on both sides
  // rather than only from the due direction.
  assert.equal(shouldRunHourlyInventoryRefresh(
    state('CONDITIONAL_ACCESS', 'SUCCEEDED', ago(HOUR - 1)), now), false)
  assert.equal(shouldRunHourlyInventoryRefresh(
    state('CONDITIONAL_ACCESS', 'SUCCEEDED', ago(HOUR + 1)), now), true)
})

test('the hourly rule and the candidate query agree on the boundary millisecond', () => {
  // The rule is `elapsed >= H`; the query must therefore use `lte`, not `lt`.
  const where = scheduledSyncTenantWhere(now) as unknown as {
    AND: { OR?: Array<Record<string, unknown>> }[]
  }
  const branches = where.AND[1]!.OR!
  const hourly = branches.find((branch) => {
    const some = (branch as { syncStates?: { some?: Record<string, unknown> } }).syncStates?.some
    return some !== undefined && 'lastSuccessfulAt' in some
      && (some as { lastSuccessfulAt?: Record<string, unknown> }).lastSuccessfulAt?.lte !== undefined
  }) as { syncStates: { some: {
    resourceType: { in: string[] }
    status: { notIn: string[] }
    lastSuccessfulAt: { lte: Date }
  } } } | undefined
  assert.ok(hourly, 'the candidate query must carry an hourly inventory branch')
  const some = hourly!.syncStates.some
  assert.deepEqual([...some.resourceType.in].sort(), [...HOURLY_INVENTORY_RESOURCES].sort())
  assert.deepEqual([...some.status.notIn].sort(), ['FAILED', 'RUNNING'])
  // Exactly `now - H`, so a row on the boundary is included by `lte` just as
  // the pure rule includes it with `>=`.
  assert.equal(some.lastSuccessfulAt.lte.getTime(), now.getTime() - HOUR)
})

test('an unhealthy, missing or impossible timestamp is never hourly due', () => {
  const stale = ago(6 * HOUR)
  // FAILED keeps its own targeted retry schedule and must not take this path.
  assert.equal(shouldRunHourlyInventoryRefresh(state('CONDITIONAL_ACCESS', 'FAILED', stale), now), false)
  // RUNNING must not be duplicated.
  assert.equal(shouldRunHourlyInventoryRefresh(state('CONDITIONAL_ACCESS', 'RUNNING', stale), now), false)
  // Never collected belongs to the initial/daily path, or it would re-attempt
  // on every tick.
  assert.equal(shouldRunHourlyInventoryRefresh(state('CONDITIONAL_ACCESS', 'SUCCEEDED', null), now), false)
  // A future timestamp is an anomaly to report, not an immediate retry signal.
  assert.equal(shouldRunHourlyInventoryRefresh(
    state('CONDITIONAL_ACCESS', 'SUCCEEDED', new Date(now.getTime() + 60_000)), now), false)
  assert.equal(shouldRunHourlyInventoryRefresh(
    state('CONDITIONAL_ACCESS', 'SUCCEEDED', new Date(Number.NaN)), now), false)
  assert.equal(shouldRunHourlyInventoryRefresh(undefined, now), false)
})

test('anchors, heavy collectors and held resources are never hourly due however stale', () => {
  const ancient = ago(30 * 24 * HOUR)
  for (const resource of [
    'LICENSES', 'DOMAINS',
    'GROUPS', 'DEVICES', 'SERVICE_PRINCIPALS', 'APPLICATIONS', 'SHAREPOINT_SITES',
    'DIRECTORY_ROLES',
    'USERS', 'SIGN_INS', 'AUDIT_LOGS', 'M365_AUDIT',
    'EXCHANGE_MAILBOX_RULES', 'EXCHANGE_MAILBOXES', 'AUTH_REGISTRATIONS',
    'SHAREPOINT_USAGE',
  ]) {
    assert.equal(
      shouldRunHourlyInventoryRefresh(state(resource, 'SUCCEEDED', ancient), now),
      false,
      `${resource} must never be hourly due`,
    )
  }
  // And every allowlisted resource IS due at the same staleness, so the case
  // above cannot pass by the rule rejecting everything.
  for (const resource of HOURLY_INVENTORY_RESOURCES) {
    assert.equal(
      shouldRunHourlyInventoryRefresh(state(resource, 'SUCCEEDED', ancient), now),
      true,
      `${resource} must be hourly due`,
    )
  }
})

test('DNS hourly catch-up does not grant targeted failure retry membership', () => {
  assert.equal((HOURLY_INVENTORY_RESOURCES as readonly string[]).includes('DOMAIN_DNS_HEALTH'), true)
  assert.equal((TARGETED_TRANSIENT_RETRY_RESOURCES as readonly string[]).includes('DOMAIN_DNS_HEALTH'), false)
  assert.equal(HOURLY_INVENTORY_RESOURCES.length, 9)
})

test('healthy DNS alone selects incremental work at one hour, not one millisecond before', () => {
  for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
    const states = [...dailyCoverage(), state('USERS', 'SUCCEEDED', now),
      state('LICENSES', 'SUCCEEDED', now), state('DOMAINS', 'SUCCEEDED', now)]
      .map(s => s.resourceType === 'DOMAIN_DNS_HEALTH' ? state(s.resourceType, 'SUCCEEDED', ago(age)) : s)
    const work = selectScheduledTenantWork([{ id: 'dns-only', syncStates: states }], now, 1)
    assert.equal(shouldRunHourlyInventoryRefresh(states.find(s => s.resourceType === 'DOMAIN_DNS_HEALTH'), now), age >= HOUR)
    assert.equal(work.length, age >= HOUR ? 1 : 0)
    if (work.length) assert.equal(work[0]!.fullInventoryDue, false)
  }
})

test('DNS failures retain daily handling without hourly or targeted retry eligibility', () => {
  for (const age of [15 * 60_000, 31 * 60_000, 6 * HOUR, 24 * HOUR - 1, 24 * HOUR]) {
    const dns = { ...state('DOMAIN_DNS_HEALTH', 'FAILED', ago(48 * HOUR), ago(age)), lastErrorCode: 'MICROSOFT_TRANSIENT' }
    assert.equal(shouldRunHourlyInventoryRefresh(dns, now), false)
    assert.equal(shouldRunTargetedTransientRetry(dns, now), false)
    const states = [...dailyCoverage().filter(s => s.resourceType !== 'DOMAIN_DNS_HEALTH'),
      state('USERS', 'SUCCEEDED', now), state('LICENSES', 'SUCCEEDED', now), state('DOMAINS', 'SUCCEEDED', now), dns]
    const work = selectScheduledTenantWork([{ id: 'dns-failed', syncStates: states }], now, 1)
    assert.equal(work.length, age >= 24 * HOUR ? 1 : 0)
    if (work.length) assert.equal(work[0]!.fullInventoryDue, true)
  }
  for (const branch of failedCandidacyBranches(now)) assert.equal(branch.resourceType.in.includes('DOMAIN_DNS_HEALTH'), false)
})

test('DNS running, missing, invalid and future success never enters hourly refresh', () => {
  for (const dns of [state('DOMAIN_DNS_HEALTH', 'RUNNING', ago(6 * HOUR)),
    state('DOMAIN_DNS_HEALTH', 'SUCCEEDED', null),
    state('DOMAIN_DNS_HEALTH', 'SUCCEEDED', new Date(NaN)),
    state('DOMAIN_DNS_HEALTH', 'SUCCEEDED', new Date(now.getTime() + HOUR))]) {
    assert.equal(shouldRunHourlyInventoryRefresh(dns, now), false)
  }
})

test('a tenant is selected for hourly inventory while USERS and both anchors are fresh', () => {
  const fresh = ago(60_000)
  const work = selectScheduledTenantWork([{
    id: 'tenant-hourly',
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', fresh),
      state('LICENSES', 'SUCCEEDED', fresh),
      state('DOMAINS', 'SUCCEEDED', fresh),
      state('NAMED_LOCATIONS', 'SUCCEEDED', ago(2 * HOUR)),
    ],
  }], now, 10)
  assert.equal(work.length, 1)
  assert.equal(work[0]!.tenantId, 'tenant-hourly')
  // The daily clock is untouched: this selection must not pull a full pass in.
  assert.equal(work[0]!.fullInventoryDue, false)
})

test('a fresh allowlisted resource with everything else fresh selects no work', () => {
  const fresh = ago(60_000)
  assert.deepEqual(selectScheduledTenantWork([{
    id: 'tenant-idle',
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', fresh),
      state('LICENSES', 'SUCCEEDED', fresh),
      state('DOMAINS', 'SUCCEEDED', fresh),
      state('NAMED_LOCATIONS', 'SUCCEEDED', ago(HOUR - 60_000)),
    ],
  }], now, 10), [])
})

test('an hourly refresh does not postpone an overdue daily inventory', () => {
  // The trap this plan exists to avoid: hourly work must never advance the
  // timestamps the daily pass reads.
  const states = [
    state('USERS', 'SUCCEEDED', ago(60_000)),
    state('LICENSES', 'SUCCEEDED', ago(26 * HOUR)),
    state('DOMAINS', 'SUCCEEDED', ago(26 * HOUR)),
    // Just refreshed by an hourly pass.
    state('CONDITIONAL_ACCESS', 'SUCCEEDED', ago(1_000)),
  ]
  assert.equal(requiresDailyInventoryRefresh(states, now), true)
  const work = selectScheduledTenantWork([{ id: 'tenant-daily', syncStates: states }], now, 10)
  assert.equal(work.length, 1)
  assert.equal(work[0]!.fullInventoryDue, true)
})

// ------------------------------------- hourly rule beside the failure path

test('a failed allowlisted resource keeps exactly its existing retry schedule', () => {
  // The existing first-failure delay for these resources is 15 minutes, which
  // is SHORTER than the hourly interval. So a failure must not be routed to the
  // hourly rule, and a stale hourly age must not shortcut a longer backoff.
  const fifteen = 15 * 60 * 1000
  assert.equal(targetedTransientRetryDelayMs(
    { ...state('CONDITIONAL_ACCESS', 'FAILED', null, ago(fifteen)), consecutiveFailures: 1 }), fifteen)
  assert.ok(fifteen < HOUR, 'this case only means something while the retry is faster than hourly')

  // Before due: neither rule fires.
  const before = {
    ...state('CONDITIONAL_ACCESS', 'FAILED', ago(2 * HOUR), ago(10 * 60 * 1000)),
    consecutiveFailures: 1,
  }
  assert.equal(shouldRunHourlyInventoryRefresh(before, now), false)
  assert.equal(shouldRunTargetedTransientRetry(before, now), false)

  // Due: the existing targeted retry fires, and the hourly rule still does not.
  const due = {
    ...state('CONDITIONAL_ACCESS', 'FAILED', ago(2 * HOUR), ago(fifteen)),
    consecutiveFailures: 1,
  }
  assert.equal(shouldRunHourlyInventoryRefresh(due, now), false)
  assert.equal(shouldRunTargetedTransientRetry(due, now), true)
})

test('a backoff longer than an hour is not bypassed by hourly age', () => {
  const twoHours = 120 * 60 * 1000
  const fourFailures = {
    ...state('CONDITIONAL_ACCESS', 'FAILED', ago(6 * HOUR), ago(90 * 60 * 1000)),
    consecutiveFailures: 4,
  }
  assert.equal(targetedTransientRetryDelayMs(fourFailures), twoHours)
  // The resource has been unsuccessful for six hours, so the hourly rule would
  // report it due if it applied to FAILED states. It must not.
  assert.equal(shouldRunHourlyInventoryRefresh(fourFailures, now), false)
  assert.equal(shouldRunTargetedTransientRetry(fourFailures, now), false)
  assert.deepEqual(selectScheduledTenantWork([{
    id: 'tenant-backoff',
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', ago(60_000)),
      state('LICENSES', 'SUCCEEDED', ago(60_000)),
      state('DOMAINS', 'SUCCEEDED', ago(60_000)),
      fourFailures,
    ],
  }], now, 10), [])
})

test('the existing targeted retry progression is unchanged', () => {
  const minutes = (value: number) => value * 60 * 1000
  const light = (failures: number) => targetedTransientRetryDelayMs({
    ...state('CONDITIONAL_ACCESS', 'FAILED', null, ago(1)), consecutiveFailures: failures,
  })
  assert.deepEqual([1, 2, 3, 4, 5].map(light), [
    minutes(15), minutes(30), minutes(60), minutes(120), minutes(240),
  ])
  // The six-hour cap holds beyond that, including at the clamped maximum.
  assert.equal(light(6), minutes(360))
  assert.equal(light(8), minutes(360))
  assert.equal(light(99), minutes(360))
})

// ------------------------------- failed-retry candidacy for the seven

/** The two FAILED candidacy branches of the real query, by their own shape. */
function failedCandidacyBranches(at: Date) {
  const where = scheduledSyncTenantWhere(at) as unknown as {
    AND: { OR?: Array<Record<string, unknown>> }[]
  }
  const branches = (where.AND[1]!.OR ?? []).map((branch) =>
    (branch as { syncStates?: { some?: Record<string, unknown> } }).syncStates?.some)
  const failed = branches.filter((some): some is Record<string, unknown> =>
    some !== undefined && some.status === 'FAILED') as Array<{
      resourceType: { in: string[] }
      lastErrorCode: { notIn: string[] }
      lastAttemptAt: { lt?: Date; lte?: Date }
    }>
  return failed
}

test('the selected resources become candidates at their own first-retry delay', () => {
  // The defect this replaces: candidacy waited for the 30-minute base while
  // these resources become due at 15 minutes, so a due retry between the two
  // was invisible whenever USERS and both anchors were fresh.
  assert.equal(HOURLY_INVENTORY_FIRST_RETRY_MS, 15 * 60 * 1000)
  // Derived from the formula, so it cannot drift from the deciding predicate.
  const retryResources = HOURLY_INVENTORY_RESOURCES.filter(resource =>
    (TARGETED_TRANSIENT_RETRY_RESOURCES as readonly string[]).includes(resource))
  for (const resource of retryResources) {
    assert.equal(
      targetedTransientRetryDelayMs({
        ...state(resource, 'FAILED', null, ago(1)), consecutiveFailures: 1,
      }),
      HOURLY_INVENTORY_FIRST_RETRY_MS,
      `${resource} first retry must equal the candidacy bound`,
    )
  }

  const failed = failedCandidacyBranches(now)
  assert.equal(failed.length, 2, 'one branch for the selected seven, one for the rest')
  const selected = failed.find((branch) =>
    branch.resourceType.in.length === retryResources.length)
  assert.ok(selected, 'the query must carry a branch scoped to the selected seven')
  assert.deepEqual([...selected!.resourceType.in].sort(), [...retryResources].sort())
  // Inclusive at exactly the first-retry delay, matching the predicate's `>=`.
  assert.equal(selected!.lastAttemptAt.lte?.getTime(), now.getTime() - HOURLY_INVENTORY_FIRST_RETRY_MS)
  assert.equal(selected!.lastAttemptAt.lt, undefined)
})

test('both failed candidacy branches carry an identical error exclusion list', () => {
  // Compared branch to branch rather than against a copy of the list, so a
  // future edit to one cannot silently diverge from the other.
  const failed = failedCandidacyBranches(now)
  assert.equal(failed.length, 2)
  assert.deepEqual([...failed[0]!.lastErrorCode.notIn].sort(), [...failed[1]!.lastErrorCode.notIn].sort())
  for (const code of ['401', '403', 'HAWKVIEW_CAPACITY_GUARD', 'MICROSOFT_PERMISSION_REQUIRED']) {
    assert.ok(failed[0]!.lastErrorCode.notIn.includes(code), code)
  }
})

test('the other targeted resources keep their existing candidacy bound', () => {
  const failed = failedCandidacyBranches(now)
  const broad = failed.find((branch) =>
    branch.resourceType.in.length === TARGETED_TRANSIENT_RETRY_RESOURCES.length)
  assert.ok(broad, 'the existing broad branch must remain')
  // Unchanged: the 30-minute base, still exclusive.
  assert.equal(broad!.lastAttemptAt.lt?.getTime(), now.getTime() - 30 * 60 * 1000)
  assert.equal(broad!.lastAttemptAt.lte, undefined)
  // And the narrower branch does not reach any heavier resource.
  const selected = failed.find((branch) => branch !== broad)!
  for (const heavier of ['GROUPS', 'DEVICES', 'SERVICE_PRINCIPALS', 'APPLICATIONS', 'SHAREPOINT_SITES']) {
    assert.equal(selected.resourceType.in.includes(heavier), false, heavier)
  }
})

test('a wider coarse candidacy does not loosen the deciding predicate', () => {
  // Two consecutive failures mean a 30-minute delay. Twenty minutes of age now
  // passes the coarse branch, and selection must still refuse it.
  const twoFailures = {
    ...state('CONDITIONAL_ACCESS', 'FAILED', ago(3 * HOUR), ago(20 * 60 * 1000)),
    consecutiveFailures: 2,
  }
  assert.equal(targetedTransientRetryDelayMs(twoFailures), 30 * 60 * 1000)
  assert.equal(shouldRunTargetedTransientRetry(twoFailures, now), false)
  assert.equal(shouldRunHourlyInventoryRefresh(twoFailures, now), false)
  assert.deepEqual(selectScheduledTenantWork([{
    id: 'tenant-two-failures',
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', ago(60_000)),
      state('LICENSES', 'SUCCEEDED', ago(60_000)),
      state('DOMAINS', 'SUCCEEDED', ago(60_000)),
      twoFailures,
    ],
  }], now, 10), [])

  // Past its own 30-minute delay it is selected, by the unchanged predicate.
  const due = { ...twoFailures, lastAttemptAt: ago(31 * 60 * 1000) }
  assert.equal(shouldRunTargetedTransientRetry(due, now), true)
  const work = selectScheduledTenantWork([{
    id: 'tenant-two-failures',
    syncStates: [...dailyCoverage(),
      state('USERS', 'SUCCEEDED', ago(60_000)),
      state('LICENSES', 'SUCCEEDED', ago(60_000)),
      state('DOMAINS', 'SUCCEEDED', ago(60_000)),
      due,
    ],
  }], now, 10)
  assert.equal(work.length, 1)
  assert.equal(work[0]!.fullInventoryDue, false)
})

test('a first failure is selected at exactly fifteen minutes and not before', () => {
  const at = (attemptedAgoMs: number) => {
    const failed = {
      ...state('CONDITIONAL_ACCESS', 'FAILED', ago(3 * HOUR), ago(attemptedAgoMs)),
      consecutiveFailures: 1,
    }
    return {
      predicate: shouldRunTargetedTransientRetry(failed, now),
      selected: selectScheduledTenantWork([{
        id: 'tenant-first-failure',
        syncStates: [...dailyCoverage(),
          state('USERS', 'SUCCEEDED', ago(60_000)),
          state('LICENSES', 'SUCCEEDED', ago(60_000)),
          state('DOMAINS', 'SUCCEEDED', ago(60_000)),
          failed,
        ],
      }], now, 10).length,
    }
  }
  assert.deepEqual(at(HOURLY_INVENTORY_FIRST_RETRY_MS), { predicate: true, selected: 1 })
  assert.deepEqual(at(HOURLY_INVENTORY_FIRST_RETRY_MS - 1), { predicate: false, selected: 0 })
  // And the formerly hidden window is now selectable rather than invisible.
  assert.deepEqual(at(20 * 60 * 1000), { predicate: true, selected: 1 })
})

// New daily-coverage regressions use production inputs directly, including
// intentionally absent rows; existing anchor-only fixtures above are complete.
test('each daily dataset owns its inclusive daily boundary despite fresh anchors', () => {
  for (const resource of DAILY_INVENTORY_RESOURCES) {
    for (const delta of [-1, 0, 1]) {
      const old = new Date(now.getTime() - 24 * HOUR - delta)
      const states = [...dailyCoverage(), state('USERS', 'SUCCEEDED', now), state('LICENSES'), state('DOMAINS'), state(resource, 'SUCCEEDED', old)]
      const result = selectScheduledTenantWork([{ id: resource, syncStates: states }], now, 10)
      assert.equal(result.length, ['DOMAIN_DNS_HEALTH', 'SECURE_SCORES'].includes(resource) || delta >= 0 ? 1 : 0, `${resource} boundary ${delta}`)
      if (result.length) assert.equal(result[0]!.fullInventoryDue, delta >= 0)
    }
  }
})

test('missing daily data is due, but a failed attempt waits a day and preserves targeted policy', () => {
  assert.ok(dailyInventoryResourceDueAt(undefined, now))
  const old = new Date(now.getTime() - 2 * 24 * HOUR)
  for (const status of ['FAILED', 'IDLE']) {
    for (const delta of [-1, 0, 1]) {
      const attempt = new Date(now.getTime() - 24 * HOUR - delta)
      assert.equal(Boolean(dailyInventoryResourceDueAt(state('SHAREPOINT_USAGE', status, status === 'FAILED' ? old : null, attempt), now)), delta >= 0)
    }
  }
  for (const overrides of [
    { status: 'RUNNING' },
    { lastAttemptAt: new Date(now.getTime() + 1) },
    { lastSuccessfulAt: new Date(now.getTime() + 1) },
    { lastAttemptAt: new Date('invalid') },
    { lastSuccessfulAt: new Date('invalid') },
  ]) assert.equal(dailyInventoryResourceDueAt({ ...state('GROUPS', 'SUCCEEDED', old), ...overrides }, now), null)
})

test('missing optional Exchange and held role data cannot force collection', () => {
  const candidate = { id: 'tenant', syncStates: [...dailyCoverage(), state('USERS', 'SUCCEEDED', now), state('LICENSES'), state('DOMAINS')] }
  assert.deepEqual(selectScheduledTenantWork([candidate], now, 1), [])
  assert.equal(selectScheduledTenantWork([{ ...candidate, connection: { exchangeReadOnlyEnabledAt: now } }], now, 1)[0]?.fullInventoryDue, true)
  const staleRole = state('DIRECTORY_ROLES', 'SUCCEEDED', new Date(now.getTime() - 10 * 24 * HOUR))
  assert.deepEqual(selectScheduledTenantWork([{ ...candidate, syncStates: [...candidate.syncStates, staleRole] }], now, 1), [])
  assert.equal(selectScheduledTenantWork([{ ...candidate, syncStates: candidate.syncStates.filter(s => s.resourceType !== 'SECURE_SCORES') }], now, 1)[0]?.fullInventoryDue, true)
})

test('fair ranking uses the overdue non-anchor rather than fresh licence/domain clocks', () => {
  const base = [...dailyCoverage(), state('USERS', 'SUCCEEDED', now), state('LICENSES'), state('DOMAINS')]
  const result = selectScheduledTenantWork([
    { id: 'a-anchor', syncStates: [...base, state('LICENSES', 'SUCCEEDED', new Date(now.getTime() - 25 * HOUR))] },
    { id: 'z-daily', syncStates: [...base, state('SECURE_SCORES', 'SUCCEEDED', new Date(now.getTime() - 48 * HOUR))] },
  ], now, 1)
  assert.equal(result[0]?.tenantId, 'z-daily')
})


test('healthy secure-score alone selects incremental work at its one-hour boundary', () => {
  for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
    const score = state('SECURE_SCORES', 'SUCCEEDED', ago(age))
    const states = [...dailyCoverage().filter(s => s.resourceType !== 'SECURE_SCORES'),
      state('USERS', 'SUCCEEDED', now), state('LICENSES', 'SUCCEEDED', now), state('DOMAINS', 'SUCCEEDED', now), score]
    assert.equal(shouldRunHourlyInventoryRefresh(score, now), age >= HOUR)
    const work = selectScheduledTenantWork([{ id: 'score-only', syncStates: states }], now, 1)
    assert.equal(work.length, age >= HOUR ? 1 : 0)
    if (work.length) assert.equal(work[0]!.fullInventoryDue, false)
  }
})

test('secure-score failure policy excludes retry candidacy and retains its daily opportunity', () => {
  assert.equal((TARGETED_TRANSIENT_RETRY_RESOURCES as readonly string[]).includes('SECURE_SCORES'), false)
  for (const branch of failedCandidacyBranches(now)) assert.equal(branch.resourceType.in.includes('SECURE_SCORES'), false)
  for (const age of [15 * 60_000, 31 * 60_000, 6 * HOUR, 24 * HOUR - 1, 24 * HOUR]) {
    const score = { ...state('SECURE_SCORES', 'FAILED', ago(48 * HOUR), ago(age)), lastErrorCode: 'MICROSOFT_TRANSIENT' }
    assert.equal(shouldRunHourlyInventoryRefresh(score, now), false)
    assert.equal(shouldRunTargetedTransientRetry(score, now), false)
    const states = [...dailyCoverage().filter(s => s.resourceType !== 'SECURE_SCORES'),
      state('USERS', 'SUCCEEDED', now), state('LICENSES', 'SUCCEEDED', now), state('DOMAINS', 'SUCCEEDED', now), score]
    const work = selectScheduledTenantWork([{ id: 'score-failed', syncStates: states }], now, 1)
    assert.equal(work.length, age >= 24 * HOUR ? 1 : 0)
    if (work.length) assert.equal(work[0]!.fullInventoryDue, true)
  }
})

test('secure-score running, missing, invalid and future success never enters hourly refresh', () => {
  for (const score of [state('SECURE_SCORES', 'RUNNING', ago(6 * HOUR)),
    state('SECURE_SCORES', 'SUCCEEDED', null),
    state('SECURE_SCORES', 'SUCCEEDED', new Date(NaN)),
    state('SECURE_SCORES', 'SUCCEEDED', new Date(now.getTime() + HOUR))]) {
    assert.equal(shouldRunHourlyInventoryRefresh(score, now), false)
  }
})
