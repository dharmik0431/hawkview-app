import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'

const NOW = new Date('2026-10-11T12:00:00.000Z')
const date = (offset: number) => new Date(NOW.getTime() + offset)
const ORG = 'bundle-org', TENANT = 'bundle-tenant', USER = 'bundle-user'
const identity = { subject: 'bundle-owner' } as never

function row(id: string, expiry: number, event = -1000) {
  return {
    id, microsoftSignInId: id, microsoftAuditId: id,
    organizationId: ORG, customerTenantId: TENANT, userId: USER,
    eventDateTime: date(event), expiresAt: date(expiry), ingestedAt: date(-2000),
    userDisplayName: 'Stored name', userPrincipalName: 'user@example.invalid',
    ipAddress: '192.0.2.1', statusErrorCode: '0', appDisplayName: 'Stored app',
    location: { countryOrRegion: 'ZZ', city: 'Fixture city' },
    riskLevel: 'low', raw: { secret: '[REDACTED]' },
    activityDisplayName: 'Stored audit', category: 'UserManagement', result: 'success',
    initiatedBy: { user: { displayName: '[REDACTED]' } },
    targetResources: [{ id: 'stored-target' }], additionalDetails: [],
  }
}
type Row = ReturnType<typeof row>

function fixture(signIns: Row[], audits: Row[], account = 'active') {
  let logReads = 0
  const query = (rows: Row[]) => ({ findMany: async ({ where, orderBy, take }: any) => {
    logReads++
    assert.deepEqual(orderBy, { eventDateTime: 'desc' })
    assert.equal(take, 5000)
    // Behave like the database, so removing/moving eligibility changes output.
    return rows.filter(r => r.organizationId === where.organizationId && r.customerTenantId === where.customerTenantId)
      .filter(r => !where.expiresAt || (where.expiresAt.gt ? r.expiresAt > where.expiresAt.gt : r.expiresAt >= where.expiresAt.gte))
      .sort((a, b) => b.eventDateTime.getTime() - a.eventDateTime.getTime()).slice(0, take)
  } })
  const many = (rows: any[] = []) => ({ findMany: async () => rows })
  const prisma: any = {
    user: { findUnique: async ({ where, select }: any) => {
      assert.equal(where.authProviderUserId, 'bundle-owner')
      assert.deepEqual(select.memberships.where, { status: 'ACTIVE', organization: { status: 'ACTIVE' } })
      return account === 'missing' ? null : { disabledAt: account === 'disabled' ? NOW : null,
        memberships: account === 'nonmember' ? [] : [{ organizationId: ORG }] }
    } },
    customerTenant: { findFirst: async ({ where }: any) =>
      where.id === TENANT && where.organizationId.in.includes(ORG)
        ? { id: TENANT, organizationId: ORG, microsoftTenantId: 'microsoft-tenant', status: 'ACTIVE', connection: null }
        : null },
    directoryUser: many([{ id: 'local-user', microsoftUserId: USER, displayName: 'Stored name',
      userPrincipalName: 'user@example.invalid', userType: 'Member', accountEnabled: true,
      assignedLicenseSkuIds: [], groupMemberships: [] }]),
    directoryGroup: many(), tenantLicense: many(), tenantDomain: many(), syncState: many(),
    tenantEntraSnapshot: many(), tenantCollectionFieldState: many(), m365ActivitySubscription: many(),
    signInLog: query(signIns), directoryAuditLog: query(audits),
    m365ActivityContent: { groupBy: async () => [], findFirst: async () => null },
    m365AuditDailyUsage: { findFirst: async () => null, aggregate: async () => ({ _sum: {} }) },
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never)
  return { service, logReads: () => logReads }
}

test('tenant bundle expiry: strict boundary, scope, presentation and derived last login', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network prohibited') })
  const rows = [row('expired', -1, -100), row('equal', 0, -200), row('eligible', 1, -300),
    { ...row('foreign', 1), organizationId: 'foreign' }, { ...row('other-tenant', 1), customerTenantId: 'other' }]
  const { service } = fixture(rows, rows)
  const { bundle } = await service.getBundleForIdentity(identity, TENANT, { now: () => NOW })
  assert.deepEqual(bundle.signIns.map(r => r.id), ['eligible'], 'sign-in strict expiry and scope')
  assert.deepEqual(bundle.auditLogs.map(r => r.id), ['eligible'], 'audit strict expiry and scope')
  assert.equal(bundle.users[0]!.lastLogin, date(-300).toISOString(), 'derived login uses eligible rows')
  assert.equal(bundle.signIns[0]!.ipAddress, '192.0.2.1')
  assert.equal(bundle.signIns[0]!.appDisplayName, 'Stored app')
  assert.equal(bundle.signIns[0]!.city, 'Fixture city')
  assert.deepEqual(bundle.auditLogs[0]!.initiatedBy, rows[2]!.initiatedBy)
  assert.deepEqual(bundle.auditLogs[0]!.targetResources, rows[2]!.targetResources)
  assert.equal('raw' in bundle.signIns[0]!, false)
  assert.equal('expiresAt' in bundle.auditLogs[0]!, false)
  assert.deepEqual(bundle.logRetention, { months: 6, displayedRecordLimit: 5000 })
})

test('tenant bundle expiry: expired rows cannot crowd eligible rows out of either cap', async () => {
  const rows = [...Array.from({ length: 5001 }, (_, i) => row(`expired-${i}`, -1, -i)),
    row('eligible-newer', 1, -6000), row('eligible-older', 2, -7000)]
  const { service } = fixture(rows, rows)
  const { bundle } = await service.getBundleForIdentity(identity, TENANT, { now: () => NOW })
  assert.deepEqual(bundle.signIns.map(r => r.id), ['eligible-newer', 'eligible-older'], 'sign-in eligibility before cap')
  assert.deepEqual(bundle.auditLogs.map(r => r.id), ['eligible-newer', 'eligible-older'], 'audit eligibility before cap')
})

test('tenant bundle expiry: eligible ordering and both 5000 limits remain unchanged', async () => {
  const rows = Array.from({ length: 5002 }, (_, i) => row(`eligible-${i}`, 1, -i))
  const { service } = fixture([...rows].reverse(), [...rows].reverse())
  const { bundle } = await service.getBundleForIdentity(identity, TENANT, { now: () => NOW })
  const expected = rows.slice(0, 5000).map(r => r.id)
  assert.deepEqual(bundle.signIns.map(r => r.id), expected)
  assert.deepEqual(bundle.auditLogs.map(r => r.id), expected)
})

test('tenant bundle expiry: both queries share the first clock capture', async () => {
  let calls = 0
  const { service } = fixture([row('shared-sign-in', 1)], [row('shared-audit', 1)])
  const { bundle } = await service.getBundleForIdentity(identity, TENANT, { now: () => date(calls++ * 2) })
  assert.deepEqual(bundle.signIns.map(r => r.id), ['shared-sign-in'])
  assert.deepEqual(bundle.auditLogs.map(r => r.id), ['shared-audit'], 'audit does not recapture a later clock')
  assert.equal(calls, 1)
})

test('tenant bundle expiry: ordinary caller uses server time without a clock option', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const rows = [row('equal', 0), row('eligible', 1)]
  const { service } = fixture(rows, rows)
  const { bundle } = await service.getBundleForIdentity(identity, TENANT)
  assert.deepEqual(bundle.signIns.map(r => r.id), ['eligible'])
  assert.deepEqual(bundle.auditLogs.map(r => r.id), ['eligible'])
})

for (const account of ['disabled', 'missing', 'nonmember']) {
  test(`tenant bundle expiry: ${account} caller is refused before log reads`, async () => {
    const f = fixture([row('eligible', 1)], [row('eligible', 1)], account)
    await assert.rejects(f.service.getBundleForIdentity(identity, TENANT, { now: () => NOW }), /cannot access|not found/)
    assert.equal(f.logReads(), 0)
  })
}
test('tenant bundle expiry: foreign tenant is refused before log reads', async () => {
  const f = fixture([row('eligible', 1)], [row('eligible', 1)])
  await assert.rejects(f.service.getBundleForIdentity(identity, 'foreign-tenant', { now: () => NOW }), /not found/)
  assert.equal(f.logReads(), 0)
})
