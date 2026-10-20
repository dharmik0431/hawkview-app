import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Resolver } from 'node:dns/promises'
import { managedSyncTestDatabase, managedSyncTestToken } from './managed-sync.test-fixtures.js'
import { HOURLY_INVENTORY_RESOURCES } from './scheduled-sync-selection.js'
import { TenantSyncService } from './tenant-sync.service.js'

/**
 * Hourly inventory dispatch, observed through the ACTUAL incremental
 * orchestration rather than a rebuilt module list. The real
 * `syncConnectedTenant` incremental branch runs against synthetic
 * dependencies, and every assertion is made on the URLs recorded at the
 * `globalThis.fetch` and DNS resolver boundaries — so work is only observed if the real
 * selection, module map and collector all actually ran.
 *
 * No local or live database and no provider call: `fetch` is replaced for the
 * duration of each case, DNS methods are mocked, and both are restored in `finally`.
 */

const ENDPOINT = {
  conditionalAccess: 'conditionalAccess/policies',
  namedLocations: 'conditionalAccess/namedLocations',
  authMethodPolicies: 'policies/authenticationMethodsPolicy',
  authStrengths: 'policies/authenticationStrengthPolicies',
  securityDefaults: 'identitySecurityDefaultsEnforcementPolicy',
  sharePointSettings: 'admin/sharepoint/settings',
  organization: 'organization?$select=id,displayName',
  secureScore: 'security/secureScores?$top=1',
  riskyUsers: 'identityProtection/riskyUsers',
  licenses: 'subscribedSkus',
  domains: 'organization?$select=displayName,verifiedDomains',
  // Excluded resources, asserted absent.
  directoryRoles: 'roleManagement/directory/roleAssignments',
} as const

const MINUTE = 60 * 1000
const CURRENT_SCORE_URL = 'https://graph.microsoft.com/v1.0/security/secureScores?$top=1'
const currentScore = { id: 'current-score', createdDateTime: '2020-01-01T00:00:00Z', currentScore: 45, maxScore: 100 }

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
type Write = { model: string; method: string; data: unknown; where?: unknown }

function syntheticModel(name: string, writes: Write[]) {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, method: string) => async (args: { data?: unknown; update?: unknown; create?: unknown; where?: unknown } = {}) => {
      if (method === 'findMany') return []
      if (method === 'count') return 0
      if (method === 'aggregate') return {}
      if (method === 'groupBy') return []
      if (method === 'updateMany' || method === 'deleteMany') {
        writes.push({ model: name, method, data: args?.data ?? args?.update ?? args?.create, where: args?.where })
        return { count: 1 }
      }
      if (method === 'create' || method === 'update' || method === 'upsert') {
        writes.push({ model: name, method, data: args?.data ?? args?.update ?? args?.create, where: args?.where })
        return { id: `${name}-1`, consecutiveFailures: 1 }
      }
      return null
    },
  })
}

function syntheticDatabase(states: SyntheticState[]) {
  const writes: Write[] = []
  const resourceReads: string[][] = []
  const domainReads: unknown[] = []
  const models = new Map<string, unknown>()
  const syncState = {
    // Two different reads hit this model in one visit. The targeted/hourly
    // selection filters by resourceType; the end-of-visit outcome read filters
    // by lastAttemptAt. Answering them identically would let an outcome read
    // re-trigger dispatch reasoning, so they are distinguished here.
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {}
      if ('resourceType' in where) {
        const resources = (where.resourceType as { in: string[] }).in
        resourceReads.push([...resources])
        return states.filter(state => resources.includes(state.resourceType))
      }
      return []
    },
    // No existing USERS lease row, so the lease is created and the delta link
    // is absent. The visit therefore runs a full user collection, which is
    // part of the work it performs unconditionally.
    findUnique: async () => null,
    updateMany: async (args: { data?: unknown; where?: unknown }) => {
      writes.push({ model: 'syncState', method: 'updateMany', data: args?.data, where: args?.where })
      return { count: 1 }
    },
    update: async (args: { data?: unknown; where?: unknown }) => {
      writes.push({ model: 'syncState', method: 'update', data: args?.data, where: args?.where })
      return { id: 'state-1', consecutiveFailures: 1 }
    },
    upsert: async (args: { create?: unknown; update?: unknown; where?: unknown }) => {
      writes.push({ model: 'syncState', method: 'upsert', data: args?.update ?? args?.create, where: args?.where })
      return { id: 'state-1', consecutiveFailures: 1 }
    },
    create: async (args: { data?: unknown; where?: unknown }) => {
      writes.push({ model: 'syncState', method: 'create', data: args?.data, where: args?.where })
      return { id: 'state-1' }
    },
  }
  const base = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      if (key === 'syncState') return syncState
      if (key === 'tenantDomain') return new Proxy(syntheticModel('tenantDomain', writes), {
        get: (model, method: string) => method === 'findMany'
          ? async (args: unknown) => {
            domainReads.push(args)
            return [{ name: 'tenant.example' }]
          }
          : Reflect.get(model, method),
      })
      if (key === 'then') return undefined
      if (!models.has(key)) models.set(key, syntheticModel(key, writes))
      return models.get(key)
    },
    set: (target, key: string, value: unknown) => { target[key] = value; return true },
    has: () => true,
  })
  const database = managedSyncTestDatabase(base as { tenantConnection: { update: (args: unknown) => Promise<unknown> } }, tenant())
  const executeUtc = database.$executeRawUnsafe
  // Synthetic snapshot transaction only; assert the exact existing lock call.
  database.$executeRawUnsafe = async (sql: string, ...values: unknown[]) => {
    if (sql === 'SELECT pg_advisory_xact_lock(hashtext($1))') {
      assert.equal(values.length, 1)
      assert.ok(String(values[0]).startsWith('hawkview:snapshot:tenant-1:'))
      return 0
    }
    return executeUtc(sql)
  }
  return { database, writes, resourceReads, domainReads }
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
  const { database, writes, resourceReads, domainReads } = syntheticDatabase(states)
  const dnsCalls: string[] = []
  // Fully synthetic DNS for every visit, including the all-allowlist case.
  // These are the only lookup methods used by the existing DNS collector.
  const txt = mock.method(Resolver.prototype, 'resolveTxt', async (name: string) => {
    dnsCalls.push(`TXT ${name}`)
    return [[name.startsWith('_dmarc.') ? 'v=DMARC1; p=reject' : 'v=spf1 -all']]
  })
  const cname = mock.method(Resolver.prototype, 'resolveCname', async (name: string) => {
    dnsCalls.push(`CNAME ${name}`)
    return ['dkim.example']
  })
  const cancel = mock.method(Resolver.prototype, 'cancel', () => undefined)
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    const response = respond?.(url)
    if (response) return response
    if (url === CURRENT_SCORE_URL) return graphPage({ value: [currentScore] })
    return graphPage({
      value: [],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=new',
    })
  }) as typeof fetch
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
    const result = await (service as unknown as {
      syncConnectedTenant: (t: unknown, b: boolean, o: unknown) => Promise<{ status: string }>
    }).syncConnectedTenant(tenant(), true, { incrementalOnly: true, includeBundle: false })
    return { urls, writes, result, resourceReads, domainReads, dnsCalls }
  } finally {
    globalThis.fetch = originalFetch
    txt.mock.restore()
    cname.mock.restore()
    cancel.mock.restore()
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

test('an abandoned clean organization RUNNING row reaches the real incremental collector once', async () => {
  const running = { ...healthy('ORGANIZATION_CONFIGURATION', 2 * 60 * MINUTE),
    status: 'RUNNING', lastErrorCode: null, lastErrorMessage: null }
  const { urls, writes } = await runIncrementalVisit([running], url =>
    url.includes(ENDPOINT.organization)
      ? graphPage({ value: [{ id: tenant().microsoftTenantId, displayName: 'Synthetic Tenant' }] })
      : undefined)
  assert.equal(requested(urls, ENDPOINT.organization), 1)
  assert.deepEqual(writes.filter(w => w.model === 'syncState' && writtenResource(w) === 'ORGANIZATION_CONFIGURATION')
    .map(w => (w.data as { status: string }).status), ['RUNNING', 'SUCCEEDED'])
})

test('every allowlisted resource is reachable through the real module map', async () => {
  const { urls, dnsCalls } = await runIncrementalVisit(
    HOURLY_INVENTORY_RESOURCES.map((resource) => healthy(resource, 2 * 60 * MINUTE)),
  )
  for (const fragment of [
    ENDPOINT.organization, ENDPOINT.authMethodPolicies, ENDPOINT.securityDefaults,
    ENDPOINT.sharePointSettings, ENDPOINT.conditionalAccess, ENDPOINT.authStrengths,
    ENDPOINT.namedLocations, ENDPOINT.secureScore, ENDPOINT.riskyUsers,
    ENDPOINT.licenses, ENDPOINT.domains,
  ]) {
    assert.equal(requested(urls, fragment), 1, `${fragment} must be requested exactly once`)
  }
  assert.equal(dnsCalls.length, 4, 'DNS must also run once through its existing collector')
})

test('healthy hourly anchors run their existing bounded collectors and persist recognized rows', async () => {
  const states = [healthy('LICENSES', 61 * MINUTE), healthy('DOMAINS', 61 * MINUTE)]
  const before = structuredClone(states)
  const license = { skuId: 'sku-a', skuPartNumber: 'SYNTHETIC', consumedUnits: 2,
    prepaidUnits: { enabled: 10 }, servicePlans: [] }
  const domains = [{ name: 'new.example', isDefault: true, isInitial: false }]
  const { urls, writes, resourceReads, dnsCalls } = await runIncrementalVisit(states, url => {
    if (url.endsWith('/subscribedSkus')) return graphPage({ value: [license] })
    if (url.endsWith('/organization?$select=displayName,verifiedDomains')) {
      return graphPage({ value: [{ displayName: 'Synthetic Tenant', verifiedDomains: domains }] })
    }
    return undefined
  })
  assert.ok(resourceReads[0]!.includes('LICENSES') && resourceReads[0]!.includes('DOMAINS'))
  assert.equal(requested(urls, ENDPOINT.licenses), 1)
  assert.equal(requested(urls, ENDPOINT.domains), 1)
  assert.ok(writes.some(w => w.model === 'tenantLicense' && w.method === 'upsert'))
  assert.ok(writes.some(w => w.model === 'tenantDomain' && w.method === 'upsert'))
  assert.ok(writes.some(w => w.model === 'customerTenant' && w.method === 'update'))
  for (const resource of ['LICENSES', 'DOMAINS']) {
    assert.deepEqual(writes.filter(w => w.model === 'syncState' && writtenResource(w) === resource)
      .map(w => (w.data as { status: string }).status), ['RUNNING', 'SUCCEEDED'])
    assert.equal(writes.filter(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) === resource).length, 1)
  }
  assert.equal(writes.some(w => writtenResource(w) === 'DIRECTORY_ROLES'), false)
  assert.deepEqual(dnsCalls, [], 'DNS has its own clock and is not bundled into anchor dispatch')
  assert.ok(urls.some(url => /\/users/.test(url)), 'normal coupled user work remains')
  assert.deepEqual(states, before)
})

test('fresh, in-flight, undated and authorization-failed anchors do not use hourly dispatch', async () => {
  for (const resource of ['LICENSES', 'DOMAINS']) {
    for (const row of [healthy(resource, 5 * MINUTE),
      { ...healthy(resource, 2 * 60 * MINUTE), status: 'RUNNING', lastAttemptAt: new Date() },
      { ...healthy(resource, 2 * 60 * MINUTE), lastSuccessfulAt: null },
      { ...healthy(resource, 2 * 60 * MINUTE), lastSuccessfulAt: new Date(Date.now() + 60 * MINUTE) },
      { ...healthy(resource, 2 * 60 * MINUTE), status: 'FAILED', lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED' }]) {
      const { urls, writes } = await runIncrementalVisit([row])
      assert.equal(requested(urls, resource === 'LICENSES' ? ENDPOINT.licenses : ENDPOINT.domains), 0)
      assert.equal(writes.some(w => writtenResource(w) === resource), false)
    }
  }
})

test('stale excluded resources are never collected by an incremental visit', async () => {
  const stale = 30 * 24 * 60 * MINUTE
  const { urls } = await runIncrementalVisit([
    healthy('DIRECTORY_ROLES', stale),
    healthy('GROUPS', stale),
    healthy('DEVICES', stale),
    healthy('SERVICE_PRINCIPALS', stale),
    healthy('APPLICATIONS', stale),
    healthy('SHAREPOINT_SITES', stale),
    healthy('EXCHANGE_MAILBOX_RULES', stale),
    healthy('EXCHANGE_MAILBOXES', stale),
    healthy('AUTH_REGISTRATIONS', stale),
  ])
  assert.equal(requested(urls, ENDPOINT.directoryRoles), 0)
  assert.equal(requested(urls, 'riskyUsers'), 0)
  assert.equal(requested(urls, 'mailboxSettings'), 0)
  assert.equal(requested(urls, 'secureScore'), 0)
  assert.equal(requested(urls, '/devices'), 0)
  assert.equal(requested(urls, '/servicePrincipals'), 0)
  assert.equal(requested(urls, '/applications'), 0)
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

const writtenResource = (write: Write) =>
  (write.where as { customerTenantId_resourceType?: { resourceType?: string } } | undefined)
    ?.customerTenantId_resourceType?.resourceType

test('hourly DNS is selected through the real resource filter before dispatch', async () => {
  const { resourceReads, domainReads } = await runIncrementalVisit([healthy('DOMAIN_DNS_HEALTH', 61 * MINUTE)])
  assert.equal(resourceReads.length, 1)
  assert.ok(resourceReads[0]!.includes('DOMAIN_DNS_HEALTH'), 'dispatch query must include hourly-only DNS, independently of retry membership')
  assert.equal(new Set(resourceReads[0]).size, resourceReads[0]!.length, 'union must be deduplicated')
  assert.equal(domainReads.length, 1, 'existing DNS collector must read stored domains exactly once')
  assert.deepEqual(domainReads[0], {
    where: { organizationId: 'org-1', customerTenantId: 'tenant-1' },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { name: true }, take: 1001,
  })
})

test('hourly DNS persists its real collector result once without advancing anchors', async () => {
  // Five-minute anchors are fresh, so this case isolates DOMAIN_DNS_HEALTH hourly dispatch.
  const states = [healthy('DOMAIN_DNS_HEALTH', 61 * MINUTE), healthy('LICENSES', 5 * MINUTE), healthy('DOMAINS', 5 * MINUTE)]
  const before = structuredClone(states)
  const { dnsCalls, writes, urls } = await runIncrementalVisit(states)
  assert.deepEqual(dnsCalls.sort(), [
    'TXT tenant.example', 'TXT _dmarc.tenant.example',
    'CNAME selector1._domainkey.tenant.example', 'CNAME selector2._domainkey.tenant.example',
  ].sort())
  const snapshots = writes.filter(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) === 'DOMAIN_DNS_HEALTH')
  assert.equal(snapshots.length, 1, 'snapshot write proves collector completion rather than merely invocation')
  const payload = (snapshots[0]!.data as { payload: { domain: string; spf: { status: string }; dmarc: { status: string }; dkim: { status: string } }[] }).payload
  assert.equal(payload.length, 1)
  assert.equal(payload[0]!.domain, 'tenant.example')
  assert.equal(payload[0]!.spf.status, 'healthy')
  assert.equal(payload[0]!.dkim.status, 'healthy')
  assert.equal(payload[0]!.dmarc.status, 'healthy')
  const dnsStates = writes.filter(w => w.model === 'syncState' && writtenResource(w) === 'DOMAIN_DNS_HEALTH')
  assert.deepEqual(dnsStates.map(w => (w.data as { status: string }).status), ['RUNNING', 'SUCCEEDED'])
  assert.ok((dnsStates[1]!.data as { lastSuccessfulAt: Date }).lastSuccessfulAt instanceof Date)
  assert.equal(writes.some(w => ['LICENSES', 'DOMAINS'].includes(writtenResource(w) ?? '')), false)
  assert.deepEqual(states, before, 'fixture input clocks are not mutated')
  assert.equal(writes.some(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) !== 'DOMAIN_DNS_HEALTH'), false)
  for (const fragment of Object.values(ENDPOINT)) assert.equal(requested(urls, fragment), 0, fragment)
  assert.ok(urls.some(url => /\/users/.test(url)), 'coupled users work remains')
})

test('fresh, failed or in-flight DNS never dispatches through hourly or targeted retries', async () => {
  for (const dns of [healthy('DOMAIN_DNS_HEALTH', 5 * MINUTE),
    { ...healthy('DOMAIN_DNS_HEALTH', 6 * 60 * MINUTE), status: 'RUNNING', lastAttemptAt: new Date() },
    { ...healthy('DOMAIN_DNS_HEALTH', 6 * 60 * MINUTE), status: 'FAILED', lastAttemptAt: new Date(Date.now() - 31 * MINUTE), lastErrorCode: 'MICROSOFT_TRANSIENT' }]) {
    const { dnsCalls, domainReads, writes } = await runIncrementalVisit([dns])
    assert.deepEqual(dnsCalls, [])
    assert.deepEqual(domainReads, [])
    assert.equal(writes.some(w => writtenResource(w) === 'DOMAIN_DNS_HEALTH'), false)
  }
})


test('hourly secure-score reaches the real resource-state query independently of its map', async () => {
  const { resourceReads } = await runIncrementalVisit([healthy('SECURE_SCORES', 61 * MINUTE)])
  assert.equal(resourceReads.length, 1)
  assert.ok(resourceReads[0]!.includes('SECURE_SCORES'), 'hourly-only score must enter the actual state filter')
  assert.equal(new Set(resourceReads[0]).size, resourceReads[0]!.length)
})

test('hourly secure-score persists the existing current-score collector once without advancing anchors', async () => {
  // Five-minute anchors are fresh, so this case isolates SECURE_SCORES hourly dispatch.
  const states = [healthy('SECURE_SCORES', 61 * MINUTE), healthy('LICENSES', 5 * MINUTE), healthy('DOMAINS', 5 * MINUTE)]
  const before = structuredClone(states)
  const { urls, writes, dnsCalls, domainReads } = await runIncrementalVisit(states, url =>
    url === CURRENT_SCORE_URL ? graphPage({ value: [currentScore],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/security/secureScores?$skiptoken=unused',
    }) : undefined)
  assert.deepEqual(urls.filter(url => url.includes('/security/secureScores')), [CURRENT_SCORE_URL],
    'current-score query runs once and does not fetch history or continuation')
  const snapshots = writes.filter(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) === 'SECURE_SCORES')
  assert.equal(snapshots.length, 1, 'a persisted result is required, not just a request')
  assert.deepEqual((snapshots[0]!.data as { payload: unknown }).payload, [currentScore])
  const scoreStates = writes.filter(w => w.model === 'syncState' && writtenResource(w) === 'SECURE_SCORES')
  assert.deepEqual(scoreStates.map(w => (w.data as { status: string }).status), ['RUNNING', 'SUCCEEDED'])
  assert.ok((scoreStates[1]!.data as { lastSuccessfulAt: Date }).lastSuccessfulAt instanceof Date)
  assert.equal(writes.some(w => ['LICENSES', 'DOMAINS'].includes(writtenResource(w) ?? '')), false)
  assert.equal(writes.some(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) !== 'SECURE_SCORES'), false)
  assert.deepEqual(states, before)
  assert.deepEqual(dnsCalls, [])
  assert.deepEqual(domainReads, [])
  assert.ok(urls.some(url => /\/users/.test(url)), 'coupled users work remains')
})

test('fresh, failed, in-flight or undated secure-score never dispatches hourly or as a targeted retry', async () => {
  for (const score of [healthy('SECURE_SCORES', 5 * MINUTE),
    { ...healthy('SECURE_SCORES', 6 * 60 * MINUTE), status: 'RUNNING', lastAttemptAt: new Date() },
    { ...healthy('SECURE_SCORES', 6 * 60 * MINUTE), status: 'FAILED', lastAttemptAt: new Date(Date.now() - 31 * MINUTE), lastErrorCode: 'MICROSOFT_TRANSIENT' },
    { ...healthy('SECURE_SCORES', 6 * 60 * MINUTE), lastSuccessfulAt: null },
    { ...healthy('SECURE_SCORES', 6 * 60 * MINUTE), lastSuccessfulAt: new Date(NaN) },
    { ...healthy('SECURE_SCORES', 6 * 60 * MINUTE), lastSuccessfulAt: new Date(Date.now() + 60 * MINUTE) }]) {
    const { urls, writes } = await runIncrementalVisit([score])
    assert.equal(requested(urls, '/security/secureScores'), 0)
    assert.equal(writes.some(w => writtenResource(w) === 'SECURE_SCORES'), false)
  }
})


const RISK_URL = 'https://graph.microsoft.com/v1.0/identityProtection/riskyUsers?$select=id,userPrincipalName,riskLevel,riskState,riskDetail,riskLastUpdatedDateTime'

test('hourly risky users persist the existing paged collector without advancing anchors', async () => {
  // Five-minute anchors are fresh, so this case isolates RISKY_USERS hourly dispatch.
  const states = [healthy('RISKY_USERS', 61 * MINUTE), healthy('LICENSES', 5 * MINUTE), healthy('DOMAINS', 5 * MINUTE)]
  const before = structuredClone(states)
  const continuation = 'https://graph.microsoft.com/v1.0/identityProtection/riskyUsers?$skiptoken=synthetic'
  const riskRows = [
    { id: 'risk-1', userPrincipalName: 'first@example.invalid', riskLevel: 'medium', riskState: 'atRisk' },
    { id: 'risk-2', userPrincipalName: 'second@example.invalid', riskLevel: 'low', riskState: 'remediated' },
  ]
  const { urls, writes, resourceReads, dnsCalls } = await runIncrementalVisit(states, url => {
    if (url === RISK_URL) return graphPage({ value: [riskRows[0]], '@odata.nextLink': continuation })
    if (url === continuation) return graphPage({ value: [riskRows[1]] })
    return undefined
  })
  assert.ok(resourceReads[0]!.includes('RISKY_USERS'), 'actual filtered state read includes risk')
  assert.deepEqual(urls.filter(url => url.includes('/identityProtection/riskyUsers')), [RISK_URL, continuation])
  const snapshots = writes.filter(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) === 'RISKY_USERS')
  assert.equal(snapshots.length, 1)
  assert.deepEqual((snapshots[0]!.data as { payload: unknown }).payload, riskRows)
  const riskStates = writes.filter(w => w.model === 'syncState' && writtenResource(w) === 'RISKY_USERS')
  assert.deepEqual(riskStates.map(w => (w.data as { status: string }).status), ['RUNNING', 'SUCCEEDED'])
  assert.ok((riskStates[1]!.data as { lastSuccessfulAt: Date }).lastSuccessfulAt instanceof Date)
  assert.equal(writes.some(w => ['LICENSES', 'DOMAINS', 'DIRECTORY_ROLES'].includes(writtenResource(w) ?? '')), false)
  assert.equal(writes.some(w => w.model === 'tenantEntraSnapshot' && writtenResource(w) !== 'RISKY_USERS'), false)
  assert.deepEqual(states, before)
  assert.deepEqual(dnsCalls, [])
  assert.ok(urls.some(url => /\/users/.test(url)), 'coupled users work remains')
})

test('risky users preserve blocked and undated dispatch controls', async () => {
  for (const risk of [healthy('RISKY_USERS', 5 * MINUTE),
    { ...healthy('RISKY_USERS', 6 * 60 * MINUTE), status: 'RUNNING', lastAttemptAt: new Date() },
    { ...healthy('RISKY_USERS', 6 * 60 * MINUTE), lastSuccessfulAt: null },
    { ...healthy('RISKY_USERS', 6 * 60 * MINUTE), lastSuccessfulAt: new Date(NaN) },
    { ...healthy('RISKY_USERS', 6 * 60 * MINUTE), lastSuccessfulAt: new Date(Date.now() + 60 * MINUTE) },
    ...['MICROSOFT_PERMISSION_REQUIRED', 'HAWKVIEW_CAPACITY_GUARD', 'MICROSOFT_TRANSIENT'].map(lastErrorCode => ({
      ...healthy('RISKY_USERS', 6 * 60 * MINUTE), status: 'FAILED', lastAttemptAt: new Date(Date.now() - 90 * MINUTE),
      consecutiveFailures: 4, lastErrorCode,
    }))]) {
    const { urls, writes } = await runIncrementalVisit([risk])
    assert.equal(requested(urls, ENDPOINT.riskyUsers), 0)
    assert.equal(writes.some(w => writtenResource(w) === 'RISKY_USERS'), false)
  }
})

test('risky users still retry once on an independently admitted visit after existing backoff', async () => {
  const { urls } = await runIncrementalVisit([{
    ...healthy('RISKY_USERS', 6 * 60 * MINUTE), status: 'FAILED',
    lastAttemptAt: new Date(Date.now() - 16 * MINUTE), consecutiveFailures: 1, lastErrorCode: 'MICROSOFT_TRANSIENT',
  }])
  assert.equal(requested(urls, ENDPOINT.riskyUsers), 1)
})
