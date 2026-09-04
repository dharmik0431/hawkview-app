import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceRiskUtcTransaction, requiresRiskUtcSnapshot } from './risk-utc-session.js'
import { IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'
import { TenantSyncService, claimTenantUsersLease, runInSyncMemoryLane, tryInSyncMemoryLane } from '../tenants/tenant-sync.service.js'

test('explicit memory-lane requests are reentrant but refuse busy work without queueing', async () => {
  let entered!: () => void; let release!: () => void; let competingCalls = 0
  const started = new Promise<void>((resolve) => { entered = resolve })
  const held = runInSyncMemoryLane(async () => {
    assert.equal(await tryInSyncMemoryLane(async () => 'nested'), 'nested')
    entered()
    await new Promise<void>((resolve) => { release = resolve })
  })
  await started
  try {
    assert.equal(await tryInSyncMemoryLane(async () => { competingCalls++; return 'unexpected' }), undefined)
    assert.equal(competingCalls, 0)
  } finally { release(); await held }
  assert.equal(await tryInSyncMemoryLane(async () => 'available'), 'available')
  assert.equal(competingCalls, 0, 'declined requests must not run later')
})

test('UTC is set transaction-locally and independently verified before evidence IO', async () => {
  const calls: string[] = []
  await enforceRiskUtcTransaction({
    $executeRawUnsafe: async (sql: string) => { calls.push(sql); return 0 },
    $queryRawUnsafe: async (sql: string) => { calls.push(sql); return [{ timezone: 'UTC' }] },
  } as any)
  assert.deepEqual(calls, ["SET LOCAL TIME ZONE 'UTC'", "SELECT current_setting('TimeZone') AS timezone"])
  for (const value of [[], [{ timezone: 'America/New_York' }], [{ timezone: 'UTC' }, { timezone: 'UTC' }], null]) {
    await assert.rejects(enforceRiskUtcTransaction({ $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async () => value } as any), /^Error: IDENTITY_RISK_UTC_UNAVAILABLE$/)
  }
  for (const method of ['$executeRawUnsafe', '$queryRawUnsafe']) {
    await assert.rejects(enforceRiskUtcTransaction({ $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async () => [{ timezone: 'UTC' }],
      [method]: async () => { throw new Error('password=synthetic-secret') } } as any),
    /^Error: IDENTITY_RISK_UTC_UNAVAILABLE$/)
  }
})

test('snapshot UTC scope is closed and independent of shadow activation', () => {
  for (const value of ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOXES']) assert.equal(requiresRiskUtcSnapshot(value), true)
  for (const value of ['', 'GROUPS', 'SHAREPOINT_SITES', 'EXCHANGE_MAILBOX_USAGE', 'EXCHANGE_MAILBOX_CONFIGURATION']) assert.equal(requiresRiskUtcSnapshot(value), false)
})

test('USERS lease fails before freshness reads or writes when transaction UTC cannot be verified', async () => {
  let accessed = false
  const transaction = { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [{ timezone: 'America/New_York' }],
    get syncState() { accessed = true; throw new Error('Unexpected lease IO') } }
  await assert.rejects(claimTenantUsersLease({ $transaction: async (work: any) => work(transaction) },
    { id: 'synthetic-tenant', organizationId: 'synthetic-org' }), /^Error: IDENTITY_RISK_UTC_UNAVAILABLE$/)
  assert.equal(accessed, false)
})

test('failed UTC assertion blocks evaluator claim and persistence before safety or result IO', async () => {
  const transaction = new Proxy({ $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [{ timezone: 'Asia/Kolkata' }] }, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target]
      throw new Error('Evidence IO occurred before UTC verification')
    },
  })
  const evaluator = new IdentityRiskEvaluatorService({ $transaction: (work: any) => work(transaction) } as any, {} as any)
  await assert.rejects((evaluator as any).claimRun({ platformNow: new Date() }), /IDENTITY_RISK_UTC_UNAVAILABLE/)
  await assert.rejects((evaluator as any).persistCompletedRun({}), /IDENTITY_RISK_UTC_UNAVAILABLE/)
})

test('mailbox snapshot/attestation and SyncState fail closed before any write if UTC cannot be verified', async () => {
  let writes = 0; let collectionCalls = 0
  const tx = { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [{ timezone: 'Asia/Kolkata' }],
    tenantEntraSnapshot: { findUnique: async () => { writes++; return null }, upsert: async () => { writes++ } },
    syncState: { upsert: async () => { writes++ } } }
  const service = new TenantSyncService({ $transaction: (work: any) => work(tx) } as any,
    {} as any, {} as any, {} as any, { buildSnapshotDifferenceEvidence: () => [] } as any, {} as any)
  const tenant = { id: 'synthetic-tenant', organizationId: 'synthetic-org' }
  for (const resource of ['EXCHANGE_MAILBOX_RULES', 'EXCHANGE_ACCEPTED_DOMAINS', 'EXCHANGE_MAILBOXES']) {
    await assert.rejects((service as any).saveSnapshot(tenant, resource, { completeness: 'authoritative_complete', rows: [] }), /IDENTITY_RISK_UTC_UNAVAILABLE/)
    await assert.rejects((service as any).runSnapshotSync(tenant, resource, async () => { collectionCalls++ }), /IDENTITY_RISK_UTC_UNAVAILABLE/)
  }
  assert.equal(writes, 0)
  assert.equal(collectionCalls, 0)
})

test('scoped SyncState success/failure callbacks execute only inside verified UTC transactions', async () => {
  let verified = false; let transactions = 0
  const statuses: string[] = []
  const tx = { $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => { verified = true; return [{ timezone: 'UTC' }] },
    syncState: {
      upsert: async ({ create }: any) => { assert.ok(verified); statuses.push(create.status); return { lastSuccessfulAt: null } },
      update: async ({ data }: any) => { assert.ok(verified); statuses.push(data.status); return { consecutiveFailures: 1 } },
    } }
  const service = new TenantSyncService({ $transaction: async (work: any) => {
    transactions++; verified = false; return work(tx)
  } } as any, {} as any, {} as any,
  { resolveIncident: async () => {}, publishIncident: async () => {} } as any, {} as any, {} as any)
  const tenant = { id: 'synthetic-tenant', organizationId: 'synthetic-org' }
  await (service as any).runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_RULES', async () => {})
  assert.deepEqual(statuses, ['RUNNING', 'SUCCEEDED'])
  assert.equal(transactions, 2)
  await assert.rejects((service as any).runSnapshotSync(tenant, 'EXCHANGE_MAILBOX_RULES', async () => { throw new Error('synthetic collection failure') }))
  assert.deepEqual(statuses, ['RUNNING', 'SUCCEEDED', 'RUNNING', 'FAILED'])
  assert.equal(transactions, 4)
})
