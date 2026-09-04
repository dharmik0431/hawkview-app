import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService, runInSyncMemoryLane } from './tenant-sync.service.js'
import { mailboxScope, mailboxRule } from '../identity-risk/mailbox-risk.test-fixtures.js'
import { MAILBOX_SOURCE_VERSION } from '../identity-risk/mailbox-source-attestation.js'

const tenant = { id: mailboxScope.customerTenantId, organizationId: mailboxScope.organizationId }
test('snapshot and attestation are atomic; legacy/incomplete observations cannot silently retain COMPLETE metadata', async () => {
  let snapshot: any; let attestation: any
  const tx = { $executeRawUnsafe: async () => undefined,
    tenantEntraSnapshot: { findUnique: async () => null, upsert: async ({ create }: any) => { snapshot = create } },
    tenantCollectionFieldState: { upsert: async ({ create }: any) => { attestation = create } } }
  const service = new TenantSyncService({ $transaction: async (work: any) => work(tx) } as any,
    {} as any, {} as any, {} as any, { buildSnapshotDifferenceEvidence: () => [] } as any, {} as any)
  await (service as any).saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', { completeness: 'authoritative_complete', rows: [mailboxRule()] }, undefined, true)
  assert.equal(attestation.state, 'COMPLETE')
  assert.equal(attestation.source, MAILBOX_SOURCE_VERSION)
  assert.match(attestation.correlationId, /^[a-f0-9]{64}$/)
  assert.equal(attestation.lastSuccessfulAt, snapshot.observedAt)
  assert.equal(Array.isArray(snapshot.payload), true)
  await (service as any).saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', { completeness: 'authoritative_complete', rows: [mailboxRule(undefined, { hasError: true })] }, undefined, true)
  assert.equal(attestation.state, 'UNAVAILABLE')
  assert.equal(attestation.correlationId, null)
  await (service as any).saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', { completeness: 'authoritative_complete', rows: [] })
  assert.equal(attestation.state, 'UNAVAILABLE')
  await assert.rejects(() => (service as any).saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', { completeness: 'partial', rows: [] }, undefined, true), /Refusing to advance/)
})

test('actual existing Graph domain request validates tenant identity before attested save', async () => {
  let saved: any[] = []; let url = ''
  const service = new TenantSyncService({ customerTenant: { findFirst: async ({ where }: any) => {
    assert.deepEqual(where, tenant); return { microsoftTenantId: tenant.id }
  } } } as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  ;(service as any).runSnapshotSync = (_t: unknown, _r: unknown, work: () => unknown) => work()
  ;(service as any).saveSnapshot = async (...args: any[]) => { saved = args }
  ;(service as any).fetchGraphPage = async (target: string) => { url = target; return new Response(JSON.stringify({ value: [{ id: tenant.id, verifiedDomains: [{ name: 'tenant.invalid' }] }] })) }
  await (service as any).syncExchangeAcceptedDomains(tenant, 'synthetic-only')
  assert.equal(url, 'https://graph.microsoft.com/v1.0/organization?$select=id,verifiedDomains')
  assert.equal(saved[4], true)
  saved = []
  ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({ value: [{ id: tenant.organizationId, verifiedDomains: [{ name: 'tenant.invalid' }] }] }))
  await assert.rejects(() => (service as any).syncExchangeAcceptedDomains(tenant, 'synthetic-only'), /scope is invalid/)
  assert.equal(saved.length, 0)
})

test('404 and missing directory success retain ordinary collector behavior but cannot attest full risk coverage', async () => {
  for (const [status, directoryCurrent, expected] of [[200, true, true], [404, true, false], [200, false, false]] as const) {
    let riskAttestable: boolean | undefined
    const service = new TenantSyncService({ directoryUser: { findMany: async ({ where }: any) => {
      assert.equal(where.organizationId, tenant.organizationId); return [{ microsoftUserId: 'm', userPrincipalName: 'm@tenant.invalid' }]
    } }, syncState: { findFirst: async () => directoryCurrent ? { status: 'SUCCEEDED', lastSuccessfulAt: new Date(), lastAttemptAt: null } : null } } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any)
    ;(service as any).runSnapshotSync = (_t: unknown, _r: unknown, work: () => unknown) => work()
    ;(service as any).saveSnapshot = async (_t: unknown, _r: unknown, _rows: unknown, _persist: unknown, attest: boolean) => { riskAttestable = attest }
    ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({ value: [mailboxRule()] }), { status })
    await (service as any).syncExchangeMailboxRules(tenant, 'synthetic-only')
    assert.equal(riskAttestable, expected)
  }
})

test('post-sync lazy source read and awaited evaluation stay inside the existing shared memory lane', async () => {
  let release!: () => void; let entered!: () => void; let loaded = 0
  const active = new Promise<void>((resolve) => { entered = resolve })
  const lane = runInSyncMemoryLane(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) })
  await active
  const service = new TenantSyncService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { runTenant: async (request: any) => { assert.equal(Object.values(request.approvedEvaluator.featureFlags).filter(Boolean).length, 1); await request.loadSources() } } as any,
    { load: async () => { loaded++; return undefined } } as any)
  const work = (service as any).runPostSyncIdentityRiskEvaluation(tenant)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(loaded, 0)
  release(); await lane; await work
  assert.equal(loaded, 1)
})
