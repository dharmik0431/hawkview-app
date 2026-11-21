import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { deriveAuditReconciliationResources } from './audit-change-reconciliation.js'
import { requiresDailyInventoryRefresh } from './scheduled-sync-selection.js'

// Explicit existing daily population: this regression can also run against the
// parent source, which does not export the new guard list.
const DAILY = ['GROUPS', 'AUTH_REGISTRATIONS', 'DEVICES', 'SERVICE_PRINCIPALS',
  'APPLICATIONS', 'SECURE_SCORES', 'RISKY_USERS', 'SHAREPOINT_SITES', 'SHAREPOINT_USAGE',
  'EXCHANGE_MAILBOXES', 'EXCHANGE_MAILBOX_SETTINGS', 'EXCHANGE_MAILBOX_USAGE',
  'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOX_RULES', 'DOMAIN_DNS_HEALTH']
const NOW = new Date('2026-10-12T12:00:00Z')
const HOUR = 3_600_000
const tenant = { id: 'synthetic-tenant', organizationId: 'synthetic-org', status: 'ACTIVE',
  microsoftTenantId: 'synthetic-microsoft', connection: { status: 'CONNECTED', exchangeReadOnlyEnabledAt: null } }
const state = (resourceType: string, age = 60_000) => ({ resourceType, status: 'SUCCEEDED',
  lastAttemptAt: new Date(NOW.getTime() - age), lastSuccessfulAt: new Date(NOW.getTime() - age),
  lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 })

function fixture() {
  const rows = new Map<string, any>([...DAILY, 'USERS', 'LICENSES', 'DOMAINS'].map(r => [r, state(r)]))
  const query: any[] = []
  const syncState = {
    upsert: async ({ where, create, update }: any) => {
      const key = where.customerTenantId_resourceType.resourceType
      const old = rows.get(key)
      const next = old ? { ...old, ...update } : { ...create, lastSuccessfulAt: null, consecutiveFailures: 0 }
      rows.set(key, next)
      return next
    },
    update: async ({ where, data }: any) => {
      const key = where.customerTenantId_resourceType.resourceType
      assert.ok(rows.has(key), 'failed collection must update the row created at entry')
      const next = { ...rows.get(key), ...data }
      if (data.consecutiveFailures?.increment) next.consecutiveFailures = rows.get(key).consecutiveFailures + data.consecutiveFailures.increment
      rows.set(key, next)
      return next
    },
  }
  let cursor = { scopeKey: 'TENANT_SYNC', afterTenantId: null as string | null, revision: 0 }
  const prisma: any = { syncState,
    scheduledSyncCursor: {
      createMany: async () => ({ count: 1 }),
      findUnique: async () => ({ ...cursor }),
      updateMany: async ({ where, data }: any) => {
        if (where.revision !== cursor.revision) return { count: 0 }
        cursor = { ...cursor, afterTenantId: data.afterTenantId, revision: cursor.revision + 1 }
        return { count: 1 }
      },
    },
    tenantDomain: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    customerTenant: { update: async () => tenant, findMany: async (args: any) => {
      query.push(args)
      const idRange = args.where.AND[1]?.id
      if (idRange?.gt && tenant.id <= idRange.gt) return []
      if (idRange?.lte && tenant.id > idRange.lte) return []
      const included = new Set(args.select.syncStates.where.resourceType.in)
      return [{ ...tenant, syncStates: [...rows.values()].filter(r => included.has(r.resourceType)) }]
    } },
  }
  prisma.$transaction = async (work: any) => work(prisma)
  const service: any = new TenantSyncService(prisma, {} as never, {} as never,
    { resolveIncident: async () => {}, publishIncident: async () => {} } as never, {} as never, {} as never)
  service.logger = { log() {}, warn() {}, error() {} }
  service.saveSnapshot = async () => {}
  service.fetchGraphPage = async (url: string) => Response.json(url.includes('subscribedSkus')
    ? { value: [] } : { value: [{ id: tenant.microsoftTenantId, displayName: 'Synthetic', verifiedDomains: [{ name: 'synthetic.example', isDefault: true, isInitial: false }] }] })
  service.runPostSyncIdentityRiskEvaluation = async () => {}
  return { service, rows, query }
}

test('real audit refresh of both anchors cannot hide existing overdue daily data from scheduler dispatch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed') })
  const { service, rows, query } = fixture()
  rows.set('USERS', state('USERS', 6 * 60_000))
  rows.set('LICENSES', state('LICENSES', 26 * HOUR))
  rows.set('DOMAINS', state('DOMAINS', 26 * HOUR))
  rows.set('SECURE_SCORES', state('SECURE_SCORES', 25 * HOUR))
  assert.equal(requiresDailyInventoryRefresh([...rows.values()], NOW), true)
  const overdue = structuredClone(rows.get('SECURE_SCORES'))
  const resources = deriveAuditReconciliationResources([
    { activityDisplayName: 'Change user license' }, { activityDisplayName: 'Update verified domain' },
  ])
  assert.ok(resources.includes('LICENSES') && resources.includes('DOMAINS'))
  await service.reconcileDirectoryAuditResources(tenant, 'synthetic-token', resources)
  for (const r of ['LICENSES', 'DOMAINS']) {
    assert.equal(rows.get(r).status, 'SUCCEEDED')
    assert.equal(rows.get(r).lastSuccessfulAt.getTime(), NOW.getTime(), `${r} was genuinely refreshed`)
  }
  assert.deepEqual(rows.get('SECURE_SCORES'), overdue, 'existing stale row was not missing or touched by audit')
  const dispatches: any[] = []
  service.syncConnectedTenant = async (_tenant: unknown, _busy: boolean, options: unknown) => {
    dispatches.push(options)
    return { status: 'SUCCEEDED', failedResources: [] }
  }
  await service.syncDueTenants()
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0].incrementalOnly, false, 'fresh event anchors must not suppress overdue daily inventory')
  assert.ok(query[0].select.syncStates.where.resourceType.in.includes('SECURE_SCORES'))
  rows.set('SECURE_SCORES', state('SECURE_SCORES'))
  assert.equal(requiresDailyInventoryRefresh([...rows.values()], NOW), false, 'only the existing stale daily row forced full mode')
})

test('real failing daily collector creates a failure row and does not recur as missing each tick', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed') })
  const { service, rows } = fixture()
  rows.delete('DOMAIN_DNS_HEALTH')
  assert.equal(requiresDailyInventoryRefresh([...rows.values()], NOW), true)
  await assert.rejects(service.syncDomainDnsHealth(tenant), /could not safely refresh domain dns health/)
  assert.equal(rows.get('DOMAIN_DNS_HEALTH').status, 'FAILED')
  assert.equal(rows.get('DOMAIN_DNS_HEALTH').lastAttemptAt.getTime(), NOW.getTime())
  assert.equal(requiresDailyInventoryRefresh([...rows.values()], NOW), false)
})


test('scheduled twenty-minute rollout uses one interval for database selection and actual full dispatch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed') })
  const original = process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
  try {
    for (const scenario of [
      { flag: undefined, ageMinutes: 20, expected: null },
      { flag: 'false', ageMinutes: 20, expected: null },
      { flag: 'TRUE', ageMinutes: 20, expected: null },
      { flag: 'true', ageMinutes: 19, expected: null },
      { flag: 'true', ageMinutes: 20, expected: 'FULL' },
      { flag: 'true', ageMinutes: 21, expected: 'FULL' },
    ]) {
      if (scenario.flag === undefined) delete process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
      else process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = scenario.flag
      const { service, rows, query } = fixture()
      rows.set('GROUPS', state('GROUPS', scenario.ageMinutes * 60_000))
      const dispatches: any[] = []
      service.syncConnectedTenant = async (_tenant: unknown, _busy: boolean, options: unknown) => {
        dispatches.push(options)
        return { status: 'SUCCEEDED', failedResources: [] }
      }
      const result = await service.syncDueTenants()
      assert.equal(result.succeeded, scenario.expected ? 1 : 0, JSON.stringify(scenario))
      assert.equal(dispatches.length, scenario.expected ? 1 : 0)
      if (scenario.expected) assert.deepEqual(dispatches[0], {
        incrementalOnly: false, includeBundle: false, evaluateRiskAfterSync: process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT === undefined, forceFullUsers: true, preserveInventoryFailureCooldowns: true,
      })
      const queryText = JSON.stringify(query[0].where)
      if (scenario.flag === 'true') assert.match(queryText, /2026-10-12T11:40:00.000Z/)
      else assert.doesNotMatch(queryText, /2026-10-12T11:40:00.000Z/)
      assert.match(queryText, /2026-10-11T12:00:00.000Z/, 'the existing failed-resource daily guard is retained')
    }
  } finally {
    if (original === undefined) delete process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
    else process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = original
  }
})

test('twenty-minute rollout keeps between-inventory users incremental and failure-only cooldown unchanged', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const original = process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
  process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = 'true'
  try {
    const { service, rows } = fixture()
    rows.set('AUTH_REGISTRATIONS', { ...state('AUTH_REGISTRATIONS', 20 * 60_000), status: 'FAILED' })
    const dispatches: any[] = []
    service.syncConnectedTenant = async (_tenant: unknown, _busy: boolean, options: unknown) => {
      dispatches.push(options)
      return { status: 'SUCCEEDED', failedResources: [] }
    }
    assert.equal((await service.syncDueTenants()).succeeded, 0, 'a failure alone must not become a twenty-minute retry')
    rows.set('USERS', state('USERS', 6 * 60_000))
    assert.equal((await service.syncDueTenants()).succeeded, 1)
    assert.deepEqual(dispatches, [{ incrementalOnly: true, includeBundle: false, evaluateRiskAfterSync: process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT === undefined, forceFullUsers: false, preserveInventoryFailureCooldowns: false }])
  } finally {
    if (original === undefined) delete process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED
    else process.env.HAWKVIEW_FULL_SYNC_20_MINUTES_ENABLED = original
  }
})
