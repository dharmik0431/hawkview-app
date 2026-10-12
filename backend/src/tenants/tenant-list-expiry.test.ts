import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantsService } from './tenants.service.js'

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
    customerTenantId: tenant, organizationId: org, microsoftAuditId: id,
    eventDateTime: date(event), expiresAt: date(expiry), ingestedAt: date(-2000),
    activityDisplayName: 'Update authentication method', category: 'UserManagement',
    operationType: 'Update', result: 'success',
    initiatedBy: { user: { userPrincipalName: '[REDACTED]' } },
    targetResources: [{ type: 'authenticationMethod', displayName: id }],
  }
}
type Audit = ReturnType<typeof audit>
function tenant(id: string, org = 'org-a') {
  return {
    id, microsoftTenantId: `microsoft-${id}`, displayName: id, primaryDomain: null,
    status: 'ACTIVE', organization: { id: org, name: org, slug: org },
    connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED',
      consentedPermissions: [], lastVerifiedAt: NOW, lastErrorCode: null },
    tenantLicenses: [], syncStates: [], entraSnapshots: [],
    collectionFieldStates: [], m365ActivitySubscriptions: [],
  }
}
function fixture(rows: Audit[], options: { account?: string; tenants?: ReturnType<typeof tenant>[]; organizations?: string[] } = {}) {
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
    directoryAuditLog: { findMany: async (query: any) => {
      queries.push(query)
      const { where, orderBy, take, select } = query
      assert.deepEqual(orderBy, { eventDateTime: 'desc' })
      assert.deepEqual(Object.keys(select).sort(), ['activityDisplayName', 'category', 'customerTenantId',
        'eventDateTime', 'initiatedBy', 'microsoftAuditId', 'operationType', 'result', 'targetResources'].sort())
      // Query-sensitive: omission, inclusive expiry and post-take filtering
      // change the actual service output instead of just changing spy metadata.
      return rows.filter(r => where.organizationId.in.includes(r.organizationId)
          && where.customerTenantId.in.includes(r.customerTenantId)
          && r.eventDateTime >= where.eventDateTime.gte)
        .filter(r => !where.expiresAt || (where.expiresAt.gt
          ? r.expiresAt > where.expiresAt.gt : r.expiresAt >= where.expiresAt.gte))
        .sort((a, b) => b.eventDateTime.getTime() - a.eventDateTime.getTime())
        .slice(0, take)
        .map(r => Object.fromEntries(Object.keys(select).map(k => [k, (r as any)[k]])))
    } },
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

test('tenant list expiry: expired rows cannot crowd eligible attention out of take500', async () => {
  const rows = [...Array.from({ length: 501 }, (_, i) => audit(`expired-${i}`, -1, -i)),
    audit('equal', 0, -600), audit('eligible-newer', 1, -700), audit('eligible-older', 2, -800)]
  const f = fixture(rows)
  const result = await read(f)
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-eligible-newer', 'audit-auth-eligible-older'])
  assert.deepEqual(auditKeys(f.writes[0].payload), auditKeys(result.tenants[0]!))
})

test('tenant list expiry: global500 cap, event order, label dedup and max3 remain', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => audit(`first-${i}`, 1, -i))
  rows.push(audit('beyond-global-cap', 1, -600, 'b'))
  // An exact duplicate label still picks the newer evidence, not another item.
  rows[1] = { ...rows[1]!, targetResources: rows[0]!.targetResources }
  const f = fixture(rows.reverse(), { tenants: [tenant('b'), tenant('a')] })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(t => t.id), ['a', 'b'])
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-first-0', 'audit-auth-first-2', 'audit-auth-first-3'])
  assert.deepEqual(auditKeys(result.tenants[1]!), [], 'the cap is shared, not500 per tenant')
})

test('tenant list expiry: multiple authorized organizations and foreign/unselected isolation', async () => {
  const f = fixture([audit('a', 1), audit('b', 1, -1000, 'b', 'org-b'),
    audit('foreign', 1, 0, 'foreign', 'org-foreign'), audit('unselected', 1, 0, 'unselected')], {
    organizations: ['org-a', 'org-b'], tenants: [tenant('b', 'org-b'), tenant('a'), tenant('foreign', 'org-foreign')],
  })
  const result = await read(f)
  assert.deepEqual(result.tenants.map(t => [t.id, auditKeys(t)]), [
    ['a', ['audit-auth-a']], ['b', ['audit-auth-b']],
  ])
  assert.deepEqual(f.writes.map(w => [w.organizationId, w.customerTenantId]), [['org-a', 'a'], ['org-b', 'b']])
})

test('tenant list expiry: event window and expiry share one query clock', async () => {
  const f = fixture([audit('shared', 1, -DAY)])
  let calls = 0
  const result = await f.service.listForIdentity(identity, { now: () => date(calls++ * 2) })
  assert.deepEqual(auditKeys(result.tenants[0]!), ['audit-auth-shared'])
  assert.equal(calls, 1)
  assert.equal(f.queries[0].where.eventDateTime.gte.getTime(), NOW.getTime() - DAY)
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
  f.previous.set('a', { overallStatus: 'CRITICAL', payload: previous.payload, evaluatedAt: date(-1) })
  await read(f)
  assert.equal(f.writes.length, 1, 'different eligible status retains existing create decision')
  assert.equal(f.writes[0].overallStatus, 'ATTENTION')
  assert.deepEqual(auditKeys(f.writes[0].payload), ['audit-auth-eligible'])
})
