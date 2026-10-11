import assert from 'node:assert/strict'
import test from 'node:test'
import { managedSyncTestDatabase, managedSyncTestToken } from './managed-sync.test-fixtures.js'
import { HOURLY_INVENTORY_RESOURCES, TARGETED_TRANSIENT_RETRY_RESOURCES } from './scheduled-sync-selection.js'
import { TenantSyncService } from './tenant-sync.service.js'

/**
 * Hourly inventory dispatch, observed through the ACTUAL incremental
 * orchestration rather than a rebuilt module list. The real
 * `syncConnectedTenant` incremental branch runs against synthetic
 * dependencies, and every assertion is made on the URLs recorded at the
 * `globalThis.fetch` boundary — so a request is only observed if the real
 * selection, module map and collector all actually ran.
 *
 * No local or live database and no provider call: `fetch` is replaced for the
 * duration of each case and restored in `finally`.
 */

const ENDPOINT = {
  conditionalAccess: 'conditionalAccess/policies',
  namedLocations: 'conditionalAccess/namedLocations',
  authMethodPolicies: 'policies/authenticationMethodsPolicy',
  authStrengths: 'policies/authenticationStrengthPolicies',
  securityDefaults: 'identitySecurityDefaultsEnforcementPolicy',
  sharePointSettings: 'admin/sharepoint/settings',
  organization: 'v1.0/organization',
  // Excluded resources, asserted absent.
  licenses: 'subscribedSkus',
  directoryRoles: 'roleManagement/directory/roleAssignments',
} as const

const MINUTE = 60 * 1000

function tenant() {
  return {
    id: 'tenant-1',
    organizationId: 'org-1',
    microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Tenant',
    primaryDomain: 'tenant.example',
    status: 'ACTIVE',
    connection: {
      status: 'CONNECTED',
      connectionMode: 'HAWKVIEW_MANAGED',
      clientId: null,
      credentialReference: null,
      lastVerifiedAt: null,
    },
  }
}

type SyntheticState = {
  resourceType: string
  status: string
  lastSuccessfulAt: Date | null
  lastAttemptAt: Date | null
  consecutiveFailures?: number
  lastErrorCode?: string | null
  lastErrorMessage?: string | null
}

/** Collector bookkeeping this test does not assert is answered permissively,
 *  so the case stands on the recorded requests rather than on the double. */
function syntheticModel(name: string, writes: { model: string; method: string; data: unknown }[]) {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, method: string) => async (args: { data?: unknown } = {}) => {
      if (method === 'findMany') return []
      if (method === 'count') return 0
      if (method === 'aggregate') return {}
      if (method === 'groupBy') return []
      if (method === 'updateMany' || method === 'deleteMany') {
        writes.push({ model: name, method, data: args?.data })
        return { count: 1 }
      }
      if (method === 'create' || method === 'update' || method === 'upsert') {
        writes.push({ model: name, method, data: args?.data })
        return { id: `${name}-1`, consecutiveFailures: 1 }
      }
      return null
    },
  })
}

function syntheticDatabase(states: SyntheticState[]) {
  const writes: { model: string; method: string; data: unknown }[] = []
  const models = new Map<string, unknown>()
  const syncState = {
    // Two different reads hit this model in one visit. The targeted/hourly
    // selection filters by resourceType; the end-of-visit outcome read filters
    // by lastAttemptAt. Answering them identically would let an outcome read
    // re-trigger dispatch reasoning, so they are distinguished here.
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {}
      if ('resourceType' in where) return states
      return []
    },
    // No existing USERS lease row, so the lease is created and the delta link
    // is absent. The visit therefore runs a full user collection, which is
    // part of the work it performs unconditionally.
    findUnique: async () => null,
    updateMany: async (args: { data?: unknown }) => {
      writes.push({ model: 'syncState', method: 'updateMany', data: args?.data })
      return { count: 1 }
    },
    update: async (args: { data?: unknown }) => {
      writes.push({ model: 'syncState', method: 'update', data: args?.data })
      return { id: 'state-1', consecutiveFailures: 1 }
    },
    upsert: async (args: { create?: unknown; update?: unknown }) => {
      writes.push({ model: 'syncState', method: 'upsert', data: args?.update ?? args?.create })
      return { id: 'state-1', consecutiveFailures: 1 }
    },
    create: async (args: { data?: unknown }) => {
      writes.push({ model: 'syncState', method: 'create', data: args?.data })
      return { id: 'state-1' }
    },
  }
  const base = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      if (key === 'syncState') return syncState
      if (key === 'then') return undefined
      if (!models.has(key)) models.set(key, syntheticModel(key, writes))
      return models.get(key)
    },
    set: (target, key: string, value: unknown) => { target[key] = value; return true },
    has: () => true,
  })
  return { database: managedSyncTestDatabase(base as never, tenant() as never), writes }
}

function graphPage(body: unknown = { value: [] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Runs ONE real incremental visit and returns every requested URL. */
async function runIncrementalVisit(
  states: SyntheticState[],
  respond?: (url: string) => Response | undefined,
) {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  const { database, writes } = syntheticDatabase(states)
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    return respond?.(url) ?? graphPage({
      value: [],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=new',
    })
  }) as typeof fetch
  try {
    const service = new TenantSyncService(
      database as never,
      { getCapturedManagedAccessToken: managedSyncTestToken(tenant()) } as never,
      {} as never,
      {} as never,
      {} as never,
      { syncTenant: async () => [] } as never,
    )
    ;(service as unknown as { logger: unknown }).logger = { log() {}, warn() {}, error() {} }
    ;(service as unknown as { markConnectionUnavailable: unknown }).markConnectionUnavailable = async () => undefined
    const result = await (service as unknown as {
      syncConnectedTenant: (t: unknown, b: boolean, o: unknown) => Promise<{ status: string }>
    }).syncConnectedTenant(tenant(), true, { incrementalOnly: true, includeBundle: false })
    return { urls, writes, result }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const requested = (urls: string[], fragment: string) =>
  urls.filter((url) => url.includes(fragment)).length

const healthy = (resourceType: string, ageMs: number): SyntheticState => ({
  resourceType,
  status: 'SUCCEEDED',
  lastSuccessfulAt: new Date(Date.now() - ageMs),
  lastAttemptAt: new Date(Date.now() - ageMs),
})

// ------------------------------------------------------------------ dispatch

test('an hourly-due resource is collected exactly once by the real incremental visit', async () => {
  const { urls, result } = await runIncrementalVisit([healthy('CONDITIONAL_ACCESS', 61 * MINUTE)])
  // Exactly one request for the selected endpoint, from a one-page successful
  // response with no retry.
  assert.equal(requested(urls, ENDPOINT.conditionalAccess), 1)
  // Distinguished from the visit's other work, which happens unconditionally
  // and is NOT part of the selected-module bound: the user collection runs
  // whether or not any inventory resource was due.
  assert.ok(urls.some((url) => /\/users/.test(url)), 'the visit performs its own user collection')
  assert.ok(urls.length > 1, 'the selected module is one request among the visit total')
  assert.equal(result.status === 'SUCCEEDED' || result.status === 'PARTIAL', true)
})

test('a fresh resource is not collected, so the request above came from the hourly rule', async () => {
  // The control for the case above. Same visit, same unconditional work, one
  // resource five minutes old instead of sixty-one.
  const { urls } = await runIncrementalVisit([healthy('CONDITIONAL_ACCESS', 5 * MINUTE)])
  assert.equal(requested(urls, ENDPOINT.conditionalAccess), 0)
  assert.ok(urls.some((url) => /\/users/.test(url)), 'the visit still performs its own user collection')
})

test('every allowlisted resource is reachable through the real module map', async () => {
  const { urls } = await runIncrementalVisit(
    HOURLY_INVENTORY_RESOURCES.map((resource) => healthy(resource, 2 * 60 * MINUTE)),
  )
  for (const fragment of [
    ENDPOINT.organization, ENDPOINT.authMethodPolicies, ENDPOINT.securityDefaults,
    ENDPOINT.sharePointSettings, ENDPOINT.conditionalAccess, ENDPOINT.authStrengths,
    ENDPOINT.namedLocations,
  ]) {
    assert.equal(requested(urls, fragment), 1, `${fragment} must be requested exactly once`)
  }
})

test('stale excluded resources are never collected by an incremental visit', async () => {
  const stale = 30 * 24 * 60 * MINUTE
  const { urls } = await runIncrementalVisit([
    healthy('LICENSES', stale),
    healthy('DOMAINS', stale),
    healthy('DIRECTORY_ROLES', stale),
    healthy('GROUPS', stale),
    healthy('DEVICES', stale),
    healthy('SERVICE_PRINCIPALS', stale),
    healthy('APPLICATIONS', stale),
    healthy('SHAREPOINT_SITES', stale),
    healthy('RISKY_USERS', stale),
    healthy('EXCHANGE_MAILBOX_RULES', stale),
    healthy('EXCHANGE_MAILBOXES', stale),
    healthy('AUTH_REGISTRATIONS', stale),
    healthy('SECURE_SCORES', stale),
  ])
  assert.equal(requested(urls, ENDPOINT.licenses), 0)
  assert.equal(requested(urls, ENDPOINT.directoryRoles), 0)
  assert.equal(requested(urls, 'riskyUsers'), 0)
  assert.equal(requested(urls, 'mailboxSettings'), 0)
  assert.equal(requested(urls, 'secureScore'), 0)
  assert.equal(requested(urls, '/devices'), 0)
  assert.equal(requested(urls, '/servicePrincipals'), 0)
  assert.equal(requested(urls, '/applications'), 0)
  // The anchors are refreshed by the daily pass, which this visit is not.
  assert.equal(requested(urls, ENDPOINT.conditionalAccess), 0)
})

test('one state cannot contribute two modules to a single visit', async () => {
  // The two rules are mutually exclusive by construction, since the targeted
  // rule requires FAILED and the hourly rule excludes it. A FAILED state that
  // is also hourly-stale must still produce exactly one request.
  const { urls } = await runIncrementalVisit([{
    resourceType: 'CONDITIONAL_ACCESS',
    status: 'FAILED',
    lastSuccessfulAt: new Date(Date.now() - 6 * 60 * MINUTE),
    lastAttemptAt: new Date(Date.now() - 16 * MINUTE),
    consecutiveFailures: 1,
    lastErrorCode: 'MICROSOFT_TRANSIENT',
  }])
  assert.equal(requested(urls, ENDPOINT.conditionalAccess), 1)
})

// --------------------------------------------- the failure path, preserved

test('a first throttle records the existing failure state and does not take a faster path', async () => {
  const throttled = await runIncrementalVisit(
    [healthy('CONDITIONAL_ACCESS', 61 * MINUTE)],
    (url) => url.includes(ENDPOINT.conditionalAccess)
      ? new Response(JSON.stringify({ error: { code: 'activityLimitReached' } }), {
        status: 429, headers: { 'retry-after': '1', 'request-id': 'req-throttle' },
      })
      : undefined,
  )
  assert.ok(requested(throttled.urls, ENDPOINT.conditionalAccess) >= 1)
  const failure = throttled.writes
    .filter((write) => write.model === 'syncState')
    .map((write) => write.data as { status?: string; lastErrorCode?: string })
    .filter((data) => data?.status === 'FAILED')
  assert.ok(failure.length >= 1, 'the throttled collector must record a FAILED resource state')
  assert.ok(
    failure.some((data) => data.lastErrorCode === 'MICROSOFT_THROTTLED'),
    'the recorded failure must carry the existing throttle code',
  )
})

test('a failed resource waits for its existing retry delay and is not refreshed hourly', async () => {
  const failed = (attemptedMinutesAgo: number, consecutiveFailures: number): SyntheticState => ({
    resourceType: 'CONDITIONAL_ACCESS',
    status: 'FAILED',
    // Unsuccessful for six hours, so the hourly rule would report it due if it
    // applied to FAILED states.
    lastSuccessfulAt: new Date(Date.now() - 6 * 60 * MINUTE),
    lastAttemptAt: new Date(Date.now() - attemptedMinutesAgo * MINUTE),
    consecutiveFailures,
    lastErrorCode: 'MICROSOFT_THROTTLED',
  })

  // The visit takes its own real-clock `now`, which advances by milliseconds
  // between building these fixtures and evaluating the predicate. Exact
  // millisecond boundaries are therefore pinned in the fixed-clock selection
  // and physical tests; this case uses values on either side of the boundary
  // with a margin far larger than a visit takes.

  // Before the existing 15-minute delay: no request at all.
  const early = await runIncrementalVisit([failed(14, 1)])
  assert.equal(requested(early.urls, ENDPOINT.conditionalAccess), 0)
  assert.ok(early.urls.some((url) => /\/users/.test(url)),
    'the visit still performs its own work, so the absence above is about this resource')

  // At the existing 15-minute delay: exactly the existing retry, not an hourly
  // refresh. This is the assertion a blanket "no request after an hour" broke.
  const due = await runIncrementalVisit([failed(15, 1)])
  assert.equal(requested(due.urls, ENDPOINT.conditionalAccess), 1)

  // A backoff longer than an hour is not shortcut by hourly staleness:
  // four consecutive failures means a two-hour delay, and ninety minutes have
  // passed.
  const backedOff = await runIncrementalVisit([failed(90, 4)])
  assert.equal(requested(backedOff.urls, ENDPOINT.conditionalAccess), 0)

  // And a higher counter that now passes the widened coarse candidacy is still
  // refused at dispatch until its own longer delay: two failures mean thirty
  // minutes, and twenty have passed.
  const coarseOnly = await runIncrementalVisit([failed(20, 2)])
  assert.equal(requested(coarseOnly.urls, ENDPOINT.conditionalAccess), 0)
  const pastItsDelay = await runIncrementalVisit([failed(31, 2)])
  assert.equal(requested(pastItsDelay.urls, ENDPOINT.conditionalAccess), 1)
})

test('the allowlist stays inside the set the dispatch query selects', async () => {
  // The visit reads TARGETED_TRANSIENT_RETRY_RESOURCES only, so an allowlist
  // member outside that set would never be dispatched at all.
  for (const resource of HOURLY_INVENTORY_RESOURCES) {
    assert.ok(
      (TARGETED_TRANSIENT_RETRY_RESOURCES as readonly string[]).includes(resource),
      `${resource} must be inside the dispatch query's resource set`,
    )
  }
})
