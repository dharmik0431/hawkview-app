import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService, claimTenantUsersLease } from './tenant-sync.service.js'
import { selectScheduledTenantWork } from './scheduled-sync-selection.js'
import { advanceScheduledSyncPosition } from './scheduled-sync-position.js'

// Adapted from the independent frozen repeated-tick reproduction. Query and
// persistence boundaries are doubles; this is not physical SQL/CAS evidence.
const start = Date.parse('2026-09-28T02:00:00Z')
const minute = 60_000
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, condition]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every(w => matches(row, w))
    if (key === 'OR') return condition.some((w: any) => matches(row, w))
    if (key === 'syncStates') return Object.entries(condition).every(([op, sub]) =>
      op === 'some' ? row.syncStates.some((r: any) => matches(r, sub)) :
        op === 'none' && !row.syncStates.some((r: any) => matches(r, sub)))
    const value = row[key]
    if (condition instanceof Date) return +value === +condition
    if (condition === null || typeof condition !== 'object') return value === condition
    return Object.entries(condition).every(([op, rhs]: [string, any]) => {
      if (op === 'lt') return value !== null && +value < +rhs
      if (op === 'gt') return value !== null && +value > +rhs
      if (op === 'in') return rhs.includes(value)
      if (op === 'notIn') return value !== null && !rhs.includes(value)
      if (op === 'not') return value !== rhs
      return matches(value, { [op]: rhs })
    })
  })
}
function tenant(i: number, age = 86_400_000): any {
  return { id: String(i).padStart(5, '0'), organizationId: 'synthetic-org', microsoftTenantId: `synthetic-${i}`,
    scheduledSyncPosition: 0n, status: 'ACTIVE', connection: { status: 'CONNECTED' },
    syncStates: ['USERS', 'LICENSES', 'DOMAINS'].map(resourceType => ({
      id: `${resourceType}-${i}`, resourceType, status: 'SUCCEEDED',
      lastAttemptAt: new Date(start - (resourceType === 'USERS' ? age : 0)),
      lastSuccessfulAt: new Date(start - (resourceType === 'USERS' ? age : 0)),
      lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    })) }
}
function fixture(rows: any[], options: { fail?: boolean; preLeaseFailure?: boolean; loseLease?: string } = {}) {
  let sequence = rows.reduce((max, row) => row.scheduledSyncPosition > max ? row.scheduledSyncPosition : max, 0n)
  const calls: string[] = [], positions: string[] = []
  let scans = 0, returned = 0, failPosition = false
  let afterPosition: (() => void) | undefined
  const db: any = {
    customerTenant: { findMany: async (query: any) => {
      scans++
      assert.deepEqual(query.orderBy, [{ scheduledSyncPosition: 'asc' }, { id: 'asc' }])
      assert.ok(Number.isInteger(query.take) && query.take >= 1 && query.take <= 1000)
      const selected = rows.filter(row => matches(row, query.where)).sort((a, b) =>
        a.scheduledSyncPosition < b.scheduledSyncPosition ? -1 : a.scheduledSyncPosition > b.scheduledSyncPosition ? 1 : a.id.localeCompare(b.id)).slice(0, query.take)
      returned += selected.length
      return structuredClone(selected)
    } },
    $executeRaw: async (sql: any) => {
      if (failPosition) throw new Error('synthetic position write failure')
      assert.match(sql.sql, /SET scheduled_sync_position = nextval\('scheduled_sync_position_seq'\)/)
      assert.match(sql.sql, /organization_id = \?::uuid/)
      const [id, organizationId, oldPosition] = sql.values
      const row = rows.find(r => r.id === id && r.organizationId === organizationId)
      if (!row || row.scheduledSyncPosition !== oldPosition) return 0
      row.scheduledSyncPosition = ++sequence
      positions.push(id)
      afterPosition?.()
      return 1
    },
    syncState: {
      findUnique: async ({ where }: any) => structuredClone(rows.find(r => r.id === where.customerTenantId_resourceType.customerTenantId)?.syncStates[0]),
      updateMany: async ({ where, data }: any) => {
        const state = rows.flatMap(r => r.syncStates).find(s => s.id === where.id)
        if (!matches(state, where)) return { count: 0 }
        Object.assign(state, data); return { count: 1 }
      },
    },
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [{ timezone: 'UTC' }],
    $transaction: async (work: any) => work(db),
  }
  function service() {
    const value: any = new TenantSyncService(db, {} as any, {} as any, {} as any, {} as any, {} as any)
    value.logger = { log() {}, warn() {} }
    value.runPostSyncIdentityRiskEvaluation = async () => undefined
    value.syncConnectedTenant = async (row: any) => {
      calls.push(row.id)
      if (options.preLeaseFailure) throw new Error('synthetic pre-lease failure')
      const state = rows.find(r => r.id === row.id).syncStates[0]
      if (options.loseLease === row.id) { state.status = 'RUNNING'; state.lastAttemptAt = new Date() }
      const claim = await claimTenantUsersLease(db, row)
      if (!claim.claimed) return { status: 'SKIPPED', failedResources: [] }
      state.status = options.fail ? 'FAILED' : 'SUCCEEDED'
      if (!options.fail) state.lastSuccessfulAt = new Date()
      return { status: state.status, failedResources: options.fail ? ['USERS'] : [] }
    }
    return value as TenantSyncService
  }
  return { db, calls, positions, service, stats: () => ({ scans, returned }),
    failPosition: () => { failPosition = true }, afterPosition: (fn: () => void) => { afterPosition = fn } }
}

test('durable fairness across retries, cap boundaries, restarts and eligibility rejection', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const saved = { batch: process.env.SCHEDULED_SYNC_BATCH_SIZE, scan: process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT }
  const fetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Network forbidden') }
  try {
    for (const [count, batch, scan] of [[2, 1, 2], [3, 1, 2], [1000, 10, 1000], [1001, 1, 1000], [1001, 10, 1000], [1027, 25, 1000]]) {
      process.env.SCHEDULED_SYNC_BATCH_SIZE = String(batch); process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = String(scan)
      const rows = Array.from({ length: count }, (_, i) => tenant(i + 1))
      rows[0].syncStates[0].lastSuccessfulAt = new Date(start - 30 * 86_400_000)
      const oldSuccess = rows.map(r => +r.syncStates[0].lastSuccessfulAt)
      const f = fixture(rows, { fail: true })
      for (let tick = 0; tick < Math.ceil(count / batch); tick++) {
        t.mock.timers.setTime(start + tick * 5 * minute)
        await f.service().syncDueTenants(Date.now() + 240_000) // fresh instance every tick
      }
      assert.equal(new Set(f.calls).size, count, `${count} tenants each reach actual USERS claim despite failures`)
      assert.deepEqual(rows.map(r => +r.syncStates[0].lastSuccessfulAt), oldSuccess)
      assert.ok(f.stats().returned <= f.stats().scans * scan)
    }
    // Keep USERS current while broad targeted predicates admit a permanent
    // message-based rejection and a not-yet-due exponential retry.
    t.mock.timers.setTime(start)
    process.env.SCHEDULED_SYNC_BATCH_SIZE = '1'; process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = '1000'
    const rejected = Array.from({ length: 1000 }, (_, i) => {
      const row = tenant(i + 1, 0)
      row.syncStates.push({ ...row.syncStates[0], id: `retry-${i}`, resourceType: 'SHAREPOINT_SITES', status: 'FAILED',
        lastAttemptAt: new Date(start - 31 * minute), lastErrorCode: '500',
        lastErrorMessage: i % 2 ? 'permission required' : 'temporary', consecutiveFailures: 8 })
      return row
    })
    const f = fixture([...rejected, tenant(1001)], { fail: true })
    await f.service().syncDueTenants(start + 240_000)
    assert.equal(f.calls.length, 0); assert.equal(f.positions.length, 1000)
    await f.service().syncDueTenants(start + 240_000)
    assert.deepEqual(f.calls, ['01001']); assert.equal(f.stats().scans, 2)
  } finally {
    globalThis.fetch = fetch
    if (saved.batch === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE; else process.env.SCHEDULED_SYNC_BATCH_SIZE = saved.batch
    if (saved.scan === undefined) delete process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT; else process.env.SCHEDULED_SYNC_CANDIDATE_SCAN_LIMIT = saved.scan
  }
})

test('position CAS fences stale scans, scopes organizations, survives pre-lease failure and overlaps', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const f = fixture([tenant(1), tenant(2)])
  const first = tenant(1)
  assert.equal(await advanceScheduledSyncPosition(f.db, { ...first, organizationId: 'foreign' }), false)
  const claims = await Promise.all([advanceScheduledSyncPosition(f.db, first), advanceScheduledSyncPosition(f.db, first)])
  assert.deepEqual(claims, [true, false])
  assert.equal(await advanceScheduledSyncPosition(f.db, first), false)
  const many = fixture(Array.from({ length: 30 }, (_, i) => tenant(i + 1)), { fail: true })
  await Promise.all([many.service().syncDueTenants(), many.service().syncDueTenants()])
  assert.equal(many.calls.length, 20); assert.equal(new Set(many.calls).size, 20)
  const failed = fixture([tenant(1), tenant(2)], { preLeaseFailure: true })
  const before = process.env.SCHEDULED_SYNC_BATCH_SIZE; process.env.SCHEDULED_SYNC_BATCH_SIZE = '1'
  try {
    await failed.service().syncDueTenants(); await failed.service().syncDueTenants()
    assert.deepEqual(failed.calls, ['00001', '00002'])
  } finally { if (before === undefined) delete process.env.SCHEDULED_SYNC_BATCH_SIZE; else process.env.SCHEDULED_SYNC_BATCH_SIZE = before }
})

test('deadline preserves unexamined positions; advance-before-admission interruption recovers next lap; write failure fails closed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const rows = [tenant(1), tenant(2)], f = fixture(rows)
  await f.service().syncDueTenants(start)
  assert.deepEqual(f.stats(), { scans: 0, returned: 0 })
  f.afterPosition(() => t.mock.timers.setTime(start + 240_000))
  await f.service().syncDueTenants(start + 240_000)
  assert.deepEqual(f.calls, []); assert.ok(rows[0].scheduledSyncPosition > 0n); assert.equal(rows[1].scheduledSyncPosition, 0n)
  f.afterPosition(() => {})
  await f.service().syncDueTenants(start + 480_000)
  assert.deepEqual(f.calls, ['00002', '00001'])
  // Interruption after false positives must not mark the unseen tail.
  t.mock.timers.setTime(start)
  const rejected = Array.from({ length: 6 }, (_, i) => {
    const row = tenant(i + 1, 0)
    row.syncStates.push({ ...row.syncStates[0], resourceType: 'SHAREPOINT_SITES', status: 'FAILED',
      lastAttemptAt: new Date(start - 31 * minute), lastErrorCode: '500',
      lastErrorMessage: 'permission required', consecutiveFailures: 8 })
    return row
  })
  const partial = fixture([...rejected, tenant(7)])
  partial.afterPosition(() => { if (partial.positions.length === 3) t.mock.timers.setTime(start + 240_000) })
  await partial.service().syncDueTenants(start + 240_000)
  assert.equal(partial.positions.length, 3); assert.deepEqual(partial.calls, [])
  assert.ok(rejected.slice(3).every(row => row.scheduledSyncPosition === 0n))
  partial.afterPosition(() => {})
  await partial.service().syncDueTenants(start + 480_000)
  assert.deepEqual(partial.calls, ['00007'])
  const broken = fixture([tenant(1)]); broken.failPosition()
  await assert.rejects(broken.service().syncDueTenants(), /position write failure/)
  assert.deepEqual(broken.calls, []); assert.deepEqual(broken.positions, [])
})

test('lease exclusion, CAS loser continuation, expired leases, insertion and complete recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const leased = Array.from({ length: 1000 }, (_, i) => {
    const row = tenant(i + 1); row.syncStates[0].status = 'RUNNING'; row.syncStates[0].lastAttemptAt = new Date(start); return row
  })
  const f = fixture([...leased, tenant(1001)])
  await f.service().syncDueTenants(); assert.deepEqual(f.calls, ['01001']); assert.equal(f.stats().returned, 1)
  const race = fixture([tenant(1), tenant(2)], { loseLease: '00001' })
  const result = await race.service().syncDueTenants(); assert.equal(result.skipped, 1); assert.equal(result.succeeded, 1)
  const expired = tenant(1); expired.syncStates[0].status = 'RUNNING'; expired.syncStates[0].lastAttemptAt = new Date(start - 16 * minute)
  const oldSuccess = +expired.syncStates[0].lastSuccessfulAt
  const recovered = fixture([expired]); await recovered.service().syncDueTenants()
  assert.equal(expired.syncStates[0].status, 'SUCCEEDED'); assert.ok(+expired.syncStates[0].lastSuccessfulAt > oldSuccess)
  const rows = [tenant(1)]; const inserted = fixture(rows, { fail: true }); await inserted.service().syncDueTenants()
  rows.push(tenant(2)); await inserted.service().syncDueTenants()
  assert.equal(inserted.calls[1], '00002', 'new default-zero tenant gets first opportunity ahead of retried peer')
})

test('pure ranking yields after failed USERS attempt while preserving old successes and daily eligibility', () => {
  const old = tenant(1, 30 * 86_400_000), waiting = tenant(2, 60 * minute)
  old.syncStates[0].status = 'FAILED'; old.syncStates[0].lastAttemptAt = new Date(start)
  old.syncStates[1].lastSuccessfulAt = new Date(start - 30 * 86_400_000)
  old.syncStates[1].lastAttemptAt = new Date(start - 2 * 60 * minute)
  const work = selectScheduledTenantWork([old, waiting], new Date(start), 2)
  assert.deepEqual(work.map(w => w.tenantId), ['00002', '00001'])
  assert.equal(work[1].fullInventoryDue, true)
  assert.equal(+old.syncStates[0].lastSuccessfulAt, start - 30 * 86_400_000)
})
