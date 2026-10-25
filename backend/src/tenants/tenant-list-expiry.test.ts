import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantsService } from './tenants.service.js'
import { TENANT_HEALTH_RESOURCE_REGISTRY } from './tenant-health.js'
import { TENANT_DIRECTORY_AUDIT_LIMIT } from './tenant-directory-audit-reader.js'

const NOW = new Date('2026-10-12T01:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const date = (offset: number) => new Date(NOW.getTime() + offset)
const identity = { subject: 'list-owner' } as never
const consent = {
  getRequiredPermissions: () => [],
  getAccessContract: () => ({ connectionRequiredPermissions: [], capabilities: [] }),
}

// Defensive stored states, not production observations. With correctly ordered
// event <= ingestion and six-month ingestion expiry, an expired row cannot be
// in the recent24h window. These deliberately pin the independent saved field.
function audit(id: string, expiry: number, event = -1000, tenant = 'a', org = 'org-a') {
  return {
    id, customerTenantId: tenant, organizationId: org, microsoftAuditId: id,
    eventDateTime: date(event), expiresAt: date(expiry), ingestedAt: date(-2000),
    activityDisplayName: 'Update authentication method', category: 'UserManagement',
    operationType: 'Update', result: 'success',
    initiatedBy: { user: { userPrincipalName: '[REDACTED]' } },
    targetResources: [{ type: 'authenticationMethod', displayName: id }],
  }
}
type Audit = ReturnType<typeof audit>
type SyncStateFixture = {
  resourceType: string; status: string; lastAttemptAt: Date; lastSuccessfulAt: Date
  lastErrorCode: string | null; lastErrorMessage: string | null; consecutiveFailures: number
}
function tenant(id: string, org = 'org-a') {
  return {
    id, microsoftTenantId: `microsoft-${id}`, displayName: id, primaryDomain: null,
    status: 'ACTIVE', organization: { id: org, name: org, slug: org },
    connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED',
      consentedPermissions: [], lastVerifiedAt: NOW, lastErrorCode: null },
    tenantLicenses: [], syncStates: [] as SyncStateFixture[], entraSnapshots: [],
    collectionFieldStates: [], m365ActivitySubscriptions: [],
  }
}
function healthyTenant(id: string) {
  return { ...tenant(id), syncStates: TENANT_HEALTH_RESOURCE_REGISTRY.map(({ resourceType }) => ({
    resourceType, status: 'SUCCEEDED', lastAttemptAt: NOW, lastSuccessfulAt: NOW,
    lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
  })) }
}
function fixture(rows: Audit[], options: { account?: string; tenants?: ReturnType<typeof tenant>[]; organizations?: string[]; auditReadError?: boolean; omitCoverageTenant?: string } = {}) {
  const writes: any[] = []
  const previous = new Map<string, any>()
  const queries: any[] = []
  const tenants = options.tenants ?? [tenant('a')]
  const prisma: any = {
    user: { findUnique: async ({ where, select }: any) => {
      assert.equal(where.authProviderUserId, 'list-owner')
      assert.deepEqual(select.memberships.where, { status: 'ACTIVE', organization: { status: 'ACTIVE' } })
      return options.account === 'missing' ? null : {
        disabledAt: options.account === 'disabled' ? NOW : null,
        memberships: options.account === 'nonmember' ? [] :
          (options.organizations ?? ['org-a']).map(organizationId => ({ organizationId })),
      }
    } },
    customerTenant: { findMany: async ({ where, orderBy }: any) => {
      assert.deepEqual(orderBy, [{ displayName: 'asc' }, { microsoftTenantId: 'asc' }])
      return tenants.filter(t => where.organizationId.in.includes(t.organization.id))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    } },
    $queryRaw: async (query: any) => {
      const [pairJson, since, asOf, take] = query.values
      const sql = query.strings.join('?')
      const pairs = JSON.parse(pairJson) as Array<{ organization_id: string; customer_tenant_id: string }>
      queries.push({ pairs, since, asOf, take, sql })
      if (options.auditReadError) throw new Error('synthetic audit read timeout')
      assert.match(sql, /LEFT JOIN LATERAL/)
      assert.match(sql, /organization_id = requested\.organization_id/)
      assert.match(sql, /customer_tenant_id = requested\.customer_tenant_id/)
      assert.match(sql, /event_date_time >= \?/)
      assert.match(sql, /expires_at > \?/)
      assert.match(sql, /ORDER BY event_date_time DESC, id DESC\s+LIMIT \?/)
      assert.match(sql, /ORDER BY requested\.organization_id, requested\.customer_tenant_id,\s+audit\.event_date_time DESC NULLS LAST, audit\.id DESC NULLS LAST/)
      // This fake executes the bound query's per-pair eligibility, ordering,
      // and LEFT JOIN semantics. The physical CI case proves PostgreSQL syntax.
      return pairs.flatMap<any>(pair => {
        if (pair.customer_tenant_id === options.omitCoverageTenant) return []
        const matching = rows.filter(r => r.organizationId === pair.organization_id &&
          r.customerTenantId === pair.customer_tenant_id &&
          r.eventDateTime >= since && r.expiresAt > asOf)
          .sort((a, b) => b.eventDateTime.getTime() - a.eventDateTime.getTime() || b.id.localeCompare(a.id))
          .slice(0, take)
        return matching.length ? matching.map(r => ({
          organizationId: pair.organization_id, customerTenantId: pair.customer_tenant_id,
          eventId: r.id, microsoftAuditId: r.microsoftAuditId, eventDateTime: r.eventDateTime,
          activityDisplayName: r.activityDisplayName, category: r.category,
          operationType: r.operationType, result: r.result,
          initiatedBy: r.initiatedBy, targetResources: r.targetResources,
        })) : [{ organizationId: pair.organization_id,
          customerTenantId: pair.customer_tenant_id, eventId: null }]
      })
    },
    tenantHealthSnapshot: {
      findFirst: async ({ where }: any) => previous.get(where.customerTenantId) ?? null,
      create: async ({ data }: any) => { writes.push(data); return data },
    },
  }
  const service = new TenantsService(prisma, consent as never, {} as never)
  ;(service as any).logger = { debug() {}, warn() {} }
  return { service, writes, previous, queries, rows }
}
const auditKeys = (value: { attention: { key: string }[] }) =>
  value.attention.filter(a => a.key.startsWith('audit-')).map(a => a.key)
const read = (f: ReturnType<typeof fixture>) => f.service.listForIdentity(identity, { now: () => NOW })

test('tenant list expiry: strict boundary, event window, presentation and snapshot payload', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network prohibited') })
  const f = fixture([audit('expired', -1, -100), audit('equal', 0, -200), audit('eligible', 1, -300),
    audit('outside-window', 1, -DAY - 1), audit('window-boundary', 1, -DAY)])
  const result = await read(f)
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-eligible', 'audit-auth-window-boundary'])
  assert.equal(f.writes.length, 1)
  assert.deepEqual(auditKeys(f.writes[0].payload), auditKeys(result.tenants[0]!))
  const finding = result.tenants[0]!.attention.find(a => a.key === 'audit-auth-eligible')!
  assert.equal(finding.severity, 'high')
  assert.equal(finding.detectedAt, date(-300).toISOString())
  assert.match(finding.why, /\[REDACTED\]/)
  assert.match(finding.actionUrl, /^\/what-changed\?tenantId=a&from=/)
  assert.equal('expiresAt' in finding, false)
  assert.equal('raw' in finding, false)
})

test('tenant list expiry: expired rows cannot crowd eligible attention out of the per-tenant cap', async () => {
  const rows = [...Array.from({ length: TENANT_DIRECTORY_AUDIT_LIMIT + 1 }, (_, i) => audit(`expired-${i}`, -1, -i)),
    audit('equal', 0, -600), audit('eligible-newer', 1, -700), audit('eligible-older', 2, -800)]
  const f = fixture(rows)
  const result = await read(f)
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-eligible-newer', 'audit-auth-eligible-older'])
  assert.deepEqual(auditKeys(f.writes[0].payload), auditKeys(result.tenants[0]!))
})

test('tenant list expiry: a capped tenant does not cap a quiet tenant', async () => {
  const rows = Array.from({ length: TENANT_DIRECTORY_AUDIT_LIMIT + 1 }, (_, i) => audit(`first-${i}`, 1, -i))
  rows.push(audit('quiet', 1, -600, 'b'))
  // An exact duplicate label still picks the newer evidence, not another item.
  rows[1] = { ...rows[1]!, targetResources: rows[0]!.targetResources }
  const f = fixture(rows.reverse(), { tenants: [tenant('b'), tenant('a')] })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(t => t.id), ['a', 'b'])
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-first-0', 'audit-auth-first-2', 'audit-auth-first-3'])
  assert.deepEqual(auditKeys(result.tenants[1]!), ['audit-auth-quiet'])
  assert.equal(f.queries[0].take, TENANT_DIRECTORY_AUDIT_LIMIT + 1)
  assert.equal(result.tenants[0]!.tenantHealth.security.directoryAuditRead.status, 'CAPPED')
  assert.equal(result.tenants[1]!.tenantHealth.security.directoryAuditRead.status, 'COMPLETE')
  assert.equal(result.tenants[1]!.tenantHealth.security.directoryAuditRead.eligibleEventCount, 1)
})

test('tenant list expiry: exact per-tenant cap is complete; one extra saves unknown health', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const benign = (id: string, event: number) => ({
    ...audit(id, 1, event), activityDisplayName: 'Read directory configuration',
    operationType: 'Read', targetResources: [],
  })
  const f = fixture(Array.from({ length: TENANT_DIRECTORY_AUDIT_LIMIT }, (_, i) => benign(`event-${i}`, -i)),
    { tenants: [healthyTenant('a')] })
  const complete = (await read(f)).tenants[0]!
  assert.equal(complete.tenantHealth.security.directoryAuditRead.status, 'COMPLETE')
  assert.equal(complete.tenantHealth.security.directoryAuditRead.eligibleEventCount, TENANT_DIRECTORY_AUDIT_LIMIT)
  assert.equal(complete.tenantHealth.overallStatus, 'HEALTHY')
  assert.equal(f.writes[0].overallStatus, 'HEALTHY')

  f.previous.set('a', { overallStatus: 'HEALTHY', payload: f.writes[0].payload,
    evaluatedAt: date(-1) })
  f.writes.length = 0
  f.rows.push(benign('overflow', -600))
  const capped = (await read(f)).tenants[0]!
  assert.equal(capped.tenantHealth.security.directoryAuditRead.status, 'CAPPED')
  assert.equal(capped.tenantHealth.security.directoryAuditRead.eligibleEventCount, null)
  assert.equal(capped.tenantHealth.security.status, 'UNKNOWN')
  assert.equal(capped.tenantHealth.overallStatus, 'UNKNOWN')
  assert.equal(f.writes.length, 1, 'a fresh healthy snapshot cannot hide the coverage change')
  assert.equal(f.writes[0].overallStatus, 'UNKNOWN')
  assert.equal(f.writes[0].payload.security.directoryAuditRead.status, 'CAPPED')
  assert.deepEqual(f.queries.map(query => query.take), [TENANT_DIRECTORY_AUDIT_LIMIT + 1, TENANT_DIRECTORY_AUDIT_LIMIT + 1])
})

test('tenant list expiry: noisy tenant cannot hide a quiet tenant critical finding or saved snapshot', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const noisyRows = Array.from({ length: TENANT_DIRECTORY_AUDIT_LIMIT + 1 }, (_, i) => ({
    ...audit(`noisy-${i}`, 1, -i, 'noisy'),
    activityDisplayName: 'Read directory configuration', operationType: 'Read',
    targetResources: [],
  }))
  const quietCritical = { ...audit('quiet-critical', 1, -600, 'quiet'),
    activityDisplayName: 'Disable conditional access policy', category: 'Policy',
    targetResources: [{ type: 'conditionalAccessPolicy', displayName: 'Require MFA' }] }
  const f = fixture([...noisyRows, quietCritical], { tenants: [healthyTenant('noisy'), healthyTenant('quiet')] })
  const completeQuiet = (f.service as any).mapTenant(healthyTenant('quiet'), [], 'COMPLETE')
  assert.equal(completeQuiet.tenantHealth.overallStatus, 'HEALTHY', 'all other evidence would have allowed a false healthy result')

  const result = await read(f)
  const quiet = result.tenants.find(tenant => tenant.id === 'quiet')!
  assert.deepEqual(auditKeys(quiet), ['audit-ca-quiet-critical'])
  assert.equal(quiet.tenantHealth.security.status, 'CRITICAL')
  assert.equal(quiet.tenantHealth.security.directoryAuditRead.status, 'COMPLETE')
  assert.equal(quiet.tenantHealth.security.directoryAuditRead.eligibleEventCount, 1)
  assert.notEqual(quiet.tenantHealth.overallStatus, 'HEALTHY')
  const savedQuiet = f.writes.find(write => write.customerTenantId === 'quiet')!
  assert.ok(savedQuiet)
  assert.notEqual(savedQuiet.overallStatus, 'HEALTHY')
  assert.deepEqual(auditKeys(savedQuiet.payload), ['audit-ca-quiet-critical'])
  assert.equal(savedQuiet.payload.security.directoryAuditRead.eligibleEventCount, 1)
  assert.equal(f.queries.length, 1, 'a large tenant list does not fan out per tenant')
})

test('tenant mapping without an audit read does not claim an authoritative empty window', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture([], { tenants: [healthyTenant('a')] })
  const mapped = (f.service as any).mapTenant(healthyTenant('a'))
  assert.equal(mapped.tenantHealth.security.directoryAuditRead.status, 'NOT_READ')
  assert.equal(mapped.tenantHealth.security.directoryAuditRead.eligibleEventCount, null)
  assert.notEqual(mapped.tenantHealth.security.status, 'HEALTHY')
  assert.notEqual(mapped.tenantHealth.overallStatus, 'HEALTHY')
})

test('tenant list expiry: multiple authorized organizations and foreign/unselected isolation', async () => {
  const f = fixture([audit('a', 1), audit('b', 1, -1000, 'b', 'org-b'),
    audit('foreign', 1, 0, 'foreign', 'org-foreign'), audit('cross-org', 1, 0, 'a', 'org-foreign'),
    audit('unselected', 1, 0, 'unselected')], {
    organizations: ['org-a', 'org-b'], tenants: [tenant('b', 'org-b'), tenant('a'), tenant('foreign', 'org-foreign')],
  })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(t => [t.id, auditKeys(t)]), [
    ['a', ['audit-auth-a']], ['b', ['audit-auth-b']],
  ])
  assert.deepEqual(f.writes.map(w => [w.organizationId, w.customerTenantId]), [['org-a', 'a'], ['org-b', 'b']])
  assert.deepEqual(f.queries[0].pairs, [
    { organization_id: 'org-a', customer_tenant_id: 'a' },
    { organization_id: 'org-b', customer_tenant_id: 'b' },
  ])
})

test('tenant list expiry: empty eligible tenant has complete coverage', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture([audit('expired', -1)], { tenants: [healthyTenant('a'), healthyTenant('b')] })
  const result = await read(f)
  for (const mapped of result.tenants) {
    assert.equal(mapped.tenantHealth.security.directoryAuditRead.status, 'COMPLETE')
    assert.equal(mapped.tenantHealth.security.directoryAuditRead.eligibleEventCount, 0)
  }
})

test('tenant list expiry: audit read failure cannot save healthy coverage', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture([audit('unread-critical', 1)], {
    tenants: [healthyTenant('a'), healthyTenant('b')], auditReadError: true,
  })
  const result = await read(f)
  assert.equal(f.queries.length, 1)
  for (const mapped of result.tenants) {
    assert.equal(mapped.tenantHealth.security.directoryAuditRead.status, 'NOT_READ')
    assert.equal(mapped.tenantHealth.security.directoryAuditRead.eligibleEventCount, null)
    assert.notEqual(mapped.tenantHealth.overallStatus, 'HEALTHY')
  }
  assert.deepEqual(f.writes.map(write => write.payload.security.directoryAuditRead.status), ['NOT_READ', 'NOT_READ'])
})

test('tenant list expiry: missing tenant coverage witness fails the whole read closed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture([audit('observed', 1)], {
    tenants: [healthyTenant('a'), healthyTenant('b')], omitCoverageTenant: 'b',
  })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(mapped => mapped.tenantHealth.security.directoryAuditRead.status),
    ['NOT_READ', 'NOT_READ'])
  assert.deepEqual(f.writes.map(write => write.payload.security.directoryAuditRead.status),
    ['NOT_READ', 'NOT_READ'])
})

test('tenant list expiry: event window and expiry share one query clock', async () => {
  const f = fixture([audit('shared', 1, -DAY)])
  let calls = 0
  const result = await f.service.listForIdentity(identity, { now: () => date(calls++ * 2) })
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-shared'])
  assert.equal(calls, 1)
  assert.equal(f.queries[0].since.getTime(), NOW.getTime() - DAY)
  assert.equal(f.queries[0].asOf.getTime(), NOW.getTime())
})

test('tenant list expiry: normal caller uses platform time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = fixture([audit('equal', 0), audit('eligible', 1)])
  assert.deepEqual(auditKeys((await f.service.listForIdentity(identity)).tenants[0]!), ['audit-auth-eligible'])
})

for (const account of ['missing', 'disabled', 'nonmember']) {
  test(`tenant list expiry: ${account} cannot read audit rows or write snapshots`, async () => {
    const f = fixture([audit('eligible', 1)], { account })
    if (account === 'nonmember') assert.deepEqual(await read(f), { tenants: [] })
    else await assert.rejects(read(f), /account setup|disabled/)
    assert.equal(f.queries.length, 0)
    assert.equal(f.writes.length, 0)
  })
}

test('tenant list expiry: existing conditional snapshot decision uses eligible health', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const expired = { ...audit('expired-critical', -1, -100), activityDisplayName: 'Disable conditional access policy' }
  const f = fixture([expired, audit('eligible', 1, -200)])
  const first = (await read(f)).tenants[0]!
  assert.equal(first.tenantHealth.overallStatus, 'ATTENTION')
  const previous = f.writes[0]
  assert.equal(f.writes.length, 1)
  f.previous.set('a', { overallStatus: previous.overallStatus, payload: previous.payload, evaluatedAt: date(-1) })
  f.writes.length = 0
  await read(f)
  assert.equal(f.writes.length, 0, 'same eligible status/signature within15minutes skips snapshot')
  f.rows.push(...Array.from({ length: TENANT_DIRECTORY_AUDIT_LIMIT }, (_, i) => ({
    ...audit(`benign-${i}`, 1, -300 - i), activityDisplayName: 'Read directory configuration',
    operationType: 'Read', targetResources: [],
  })))
  await read(f)
  assert.equal(f.writes.length, 1, 'audit read coverage transition persists despite the same overall status')
  assert.equal(f.writes[0].overallStatus, 'ATTENTION')
  assert.equal(f.writes[0].payload.security.directoryAuditRead.status, 'CAPPED')
  f.writes.length = 0
  f.previous.set('a', { overallStatus: 'CRITICAL', payload: previous.payload, evaluatedAt: date(-1) })
  await read(f)
  assert.equal(f.writes.length, 1, 'different eligible status retains existing create decision')
  assert.equal(f.writes[0].overallStatus, 'ATTENTION')
  assert.deepEqual(auditKeys(f.writes[0].payload), ['audit-auth-eligible'])
})
