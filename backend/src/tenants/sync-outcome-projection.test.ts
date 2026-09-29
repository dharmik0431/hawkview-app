import assert from 'node:assert/strict'
import test from 'node:test'
import { projectSyncOutcome } from './sync-outcome-projection.js'
import { TenantSyncService } from './tenant-sync.service.js'

const now = new Date('2026-09-29T12:00:00Z')
const state = { status: 'RUNNING', lastAttemptAt: new Date('2026-09-29T11:50:00Z'),
  lastSuccessfulAt: new Date('2026-09-29T11:51:00Z'), lastErrorCode: null as string | null }
const project = (patch = {}, resource = 'SIGN_INS') => projectSyncOutcome(resource, { ...state, ...patch }, now)

for (const source of ['premium-graph', 'non-premium', 'entitlement-unverified']) {
  for (const suffix of ['', '-geolocation-partial']) {
    test(`recognizes exact ${source}${suffix} limited sign-in outcome without claiming execution`, () => {
      const result = project({ lastErrorCode: `sign-ins-${source}-fallback-active${suffix}` })
      assert.equal(result.recordedOutcome.kind, 'LIMITED_COLLECTION_RECORDED')
      assert.equal(result.recordedOutcome.relation, 'RETAINED_OR_CURRENT')
      assert.equal(result.execution, 'UNKNOWN')
    })
  }
}
test('a new sign-in attempt retains its prior qualifier; equal clocks are ambiguous', () => {
  const qualifier = { lastErrorCode: 'sign-ins-non-premium-fallback-active' }
  assert.equal(project({ ...qualifier, lastAttemptAt: new Date('2026-09-29T11:59:00Z') }).recordedOutcome.relation, 'PREDATES_ATTEMPT')
  assert.equal(project({ ...qualifier, lastAttemptAt: state.lastSuccessfulAt }).recordedOutcome.relation, 'RETAINED_OR_CURRENT')
  assert.equal(project({ lastErrorCode: 'sign-ins-audit-subscription-initializing' }).recordedOutcome.relation, 'RETAINED_OR_CURRENT')
})
for (const code of ['m365-audit-backlog', 'm365-audit-budget-exhausted']) {
  test(`${code} denotes recorded deferral, not success or execution`, () => {
    const result = project({ lastErrorCode: code }, 'M365_AUDIT')
    assert.equal(result.recordedOutcome.kind, 'DEFERRED_WORK_RECORDED')
    assert.equal(result.execution, 'UNKNOWN')
  })
}
test('wrong resource, arbitrary codes, suffix injection and message text are not outcome evidence', () => {
  for (const code of ['403', 'token=private-value', 'sign-ins-non-premium-fallback-active-extra']) {
    const result = project({ lastErrorCode: code, lastErrorMessage: 'partial backlog completed' })
    assert.equal(result.recordedOutcome.kind, 'UNKNOWN')
    assert.equal(result.reasonCode, null)
    assert.ok(!JSON.stringify(result).includes(code))
  }
  for (const [resource, code] of [['LICENSES', 'sign-ins-non-premium-fallback-active'], ['SIGN_INS', 'm365-audit-backlog']]) {
    assert.equal(project({ lastErrorCode: code }, resource).reasonCode, null)
  }
})
test('core partial and permission failures cannot become success or opt-out', () => {
  for (const code of ['sign-ins-record-validation-partial', 'MICROSOFT_PERMISSION_REQUIRED', '403']) {
    assert.equal(project({ status: 'FAILED', lastErrorCode: code }).recordedOutcome.kind, 'FAILED')
    assert.equal(project({ lastErrorCode: code }).recordedOutcome.kind, 'UNKNOWN')
  }
})
test('no age proves active execution or a crash; invalid/future clocks are omitted', () => {
  for (const clock of [new Date('2020-01-01Z'), new Date('2026-09-29T11:59:59Z'), null, new Date(NaN), new Date('2030-01-01Z')]) {
    const result = project({ lastAttemptAt: clock })
    assert.equal(result.execution, 'UNKNOWN')
    assert.equal(result.recordedOutcome.kind, 'UNKNOWN')
    if (!clock || !Number.isFinite(clock.getTime()) || clock > now) assert.equal(result.lastAttemptAt, null)
  }
  assert.equal(projectSyncOutcome('SIGN_INS', state, new Date(NaN)).lastAttemptAt, null)
})
test('missing, idle, queued, and terminal states preserve their distinctions', () => {
  assert.equal(projectSyncOutcome('SIGN_INS', undefined, now).recordedOutcome.kind, 'UNKNOWN')
  assert.equal(project({ status: 'IDLE' }).recordedOutcome.kind, 'NOT_STARTED_OR_IDLE')
  for (const status of ['PENDING', 'QUEUED']) assert.equal(project({ status }).recordedOutcome.kind, 'AWAITING_EXECUTION')
  for (const status of ['SUCCEEDED', 'FAILED']) assert.equal(project({ status }).recordedOutcome.kind, status)
})
test('projection does not mutate input, preserve false completeness claims, or copy arbitrary fields', () => {
  const input = Object.freeze({ ...state, completeness: 'PARTIAL', freshness: 'STALE', secret: 'private-value' })
  const result = projectSyncOutcome('SIGN_INS', input, now)
  assert.equal(input.completeness, 'PARTIAL')
  assert.equal(input.freshness, 'STALE')
  assert.ok(!JSON.stringify(result).includes('private-value'))
  assert.ok(!('completeness' in result))
})

// Execute the actual bundle serializer, with scoped read-only storage doubles.
// No collector, provider or database client is invoked.
test('bundle adds projection to core, M365, SharePoint and nested Exchange entries without changing legacy fields', async () => {
  const scope = { organizationId: 'synthetic-org', customerTenantId: 'synthetic-tenant' }
  const rows = [
    { resourceType: 'SIGN_INS', ...state, lastErrorCode: 'sign-ins-non-premium-fallback-active', lastErrorMessage: 'Limited source', consecutiveFailures: 0 },
    { resourceType: 'M365_AUDIT', ...state, lastErrorCode: 'm365-audit-backlog', lastErrorMessage: 'Deferred work', consecutiveFailures: 0 },
    { resourceType: 'LICENSES', ...state, status: 'FAILED', lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED', lastErrorMessage: 'Permission required', consecutiveFailures: 1 },
    { resourceType: 'EXCHANGE_MAILBOX_RULES', ...state, status: 'SUCCEEDED', lastErrorMessage: null, consecutiveFailures: 0 },
  ]
  const scoped = ({ where }: any) => {
    assert.equal(where.organizationId, scope.organizationId)
    assert.equal(where.customerTenantId, scope.customerTenantId)
  }
  const many = { findMany: async (args: any) => { scoped(args); return [] } }
  const prisma = {
    directoryUser: many, directoryGroup: many, tenantLicense: many, tenantDomain: many,
    tenantEntraSnapshot: many, tenantCollectionFieldState: many, signInLog: many,
    directoryAuditLog: many, m365ActivitySubscription: many,
    syncState: { findMany: async (args: any) => { scoped(args); return rows } },
    m365ActivityContent: { groupBy: async (args: any) => { scoped(args); return [] }, findFirst: async (args: any) => { scoped(args); return null } },
    m365AuditDailyUsage: { findFirst: async (args: any) => { scoped(args); return null }, aggregate: async (args: any) => { scoped(args); return { _sum: { downloadedBytes: null, recordsStored: null, blobsProcessed: null } } } },
  }
  const service = new TenantSyncService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  const output = await (service as any).buildBundle({ id: scope.customerTenantId, organizationId: scope.organizationId,
    microsoftTenantId: '11111111-1111-4111-8111-111111111111', displayName: 'Synthetic', primaryDomain: 'example.invalid', status: 'CONNECTED', connection: { lastVerifiedAt: now } })
  const serialized = JSON.parse(JSON.stringify(output.bundle))
  for (const [key, row] of [['signIns', rows[0]], ['m365Audit', rows[1]], ['licenses', rows[2]]] as const) {
    const entry = serialized.sync[key]
    assert.equal(entry.status, row.status.toLowerCase())
    assert.equal(entry.lastSuccessfulAt, row.lastSuccessfulAt.toISOString())
    assert.equal(entry.lastError, row.lastErrorMessage)
    assert.equal(entry.outcomeProjection.resourceType, row.resourceType)
    assert.equal(entry.outcomeProjection.execution, 'UNKNOWN')
  }
  assert.equal(serialized.sync.signIns.outcomeProjection.recordedOutcome.kind, 'LIMITED_COLLECTION_RECORDED')
  assert.equal(serialized.sync.m365Audit.outcomeProjection.recordedOutcome.kind, 'DEFERRED_WORK_RECORDED')
  assert.equal(serialized.sync.licenses.outcomeProjection.recordedOutcome.kind, 'FAILED')
  assert.equal(serialized.sync.sharePointSites.outcomeProjection.recordedOutcome.kind, 'UNKNOWN')
  const entries: any[] = []
  const visit = (node: any) => { if (!node || typeof node !== 'object') return; if ('status' in node && 'lastSuccessfulAt' in node && 'lastError' in node) entries.push(node); for (const value of Object.values(node)) visit(value) }
  visit(serialized.sync)
  visit(serialized.exchange.sync)
  assert.ok(entries.some(entry => entry.outcomeProjection?.resourceType === 'EXCHANGE_MAILBOX_RULES'))
  assert.ok(entries.length >= 15)
  for (const entry of entries) assert.equal(entry.outcomeProjection.version, 1)
  assert.equal(serialized.sync.m365Audit.pollingIsAuthoritative, true)
  assert.deepEqual(serialized.sync.m365Audit.backlog.pending, 0)
})
