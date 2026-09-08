import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { mailboxScope, mailboxRule } from '../identity-risk/mailbox-risk.test-fixtures.js'
import { MAILBOX_SOURCE_VERSION } from '../identity-risk/mailbox-source-attestation.js'

const tenant = { id: mailboxScope.customerTenantId, organizationId: mailboxScope.organizationId }
const freshDirectory = () => ({ status: 'SUCCEEDED', lastSuccessfulAt: new Date(), lastAttemptAt: null })

// Real collector -> real saveSnapshot, with synthetic Graph responses and an
// in-memory atomic transaction. No provider/network/database or real user data.
function fixture() {
  const state: any = { directory: freshDirectory(), snapshot: null, attestation: null,
    pages: [{ status: 200, rules: [mailboxRule()] }], users: 1, page: 0, failAttestation: false }
  let pending: any = null
  const database: any = {
    $queryRawUnsafe: async (sql: string) => { assert.equal(sql, "SELECT current_setting('TimeZone') AS timezone"); return [{ timezone: 'UTC' }] },
    $executeRawUnsafe: async (sql: string, lock?: string) => {
      assert.ok(sql === "SET LOCAL TIME ZONE 'UTC'" || sql === 'SELECT pg_advisory_xact_lock(hashtext($1))')
      if (lock) assert.equal(lock, `hawkview:snapshot:${tenant.id}:EXCHANGE_MAILBOX_RULES`)
    },
    directoryUser: { findMany: async ({ where, select }: any) => {
      assert.deepEqual(where, { customerTenantId: tenant.id, organizationId: tenant.organizationId, deletedAt: null })
      assert.deepEqual(select, { microsoftUserId: true, userPrincipalName: true })
      return Array.from({ length: state.users }, (_, index) => ({ microsoftUserId: `synthetic-${index}`, userPrincipalName: `synthetic-${index}@fixture.invalid` }))
    } },
    syncState: { findFirst: async ({ where, select }: any) => {
      assert.deepEqual(where, { ...{ organizationId: tenant.organizationId, customerTenantId: tenant.id }, resourceType: 'USERS' })
      assert.deepEqual(select, { status: true, lastSuccessfulAt: true, lastAttemptAt: true })
      return state.directory
    } },
    tenantEntraSnapshot: {
      findUnique: async ({ where }: any) => {
        assert.deepEqual(where, { customerTenantId_resourceType: { customerTenantId: tenant.id, resourceType: 'EXCHANGE_MAILBOX_RULES' } })
        return state.snapshot
      },
      upsert: async ({ create, update }: any) => {
        assert.ok(pending); assert.equal(create.organizationId, tenant.organizationId)
        assert.equal(create.customerTenantId, tenant.id)
        pending.snapshot = state.snapshot ? { ...state.snapshot, ...update } : create
      },
    },
    tenantCollectionFieldState: { upsert: async ({ where, create, update }: any) => {
      assert.ok(pending)
      assert.deepEqual(where, { customerTenantId_fieldKey: { customerTenantId: tenant.id, fieldKey: 'identity-risk/v1/EXCHANGE_MAILBOX_RULES' } })
      assert.equal(create.organizationId, tenant.organizationId); assert.equal(create.customerTenantId, tenant.id)
      assert.deepEqual(create, update)
      if (state.failAttestation) throw new Error('synthetic write refusal')
      pending.attestation = create
    } },
    $transaction: async (work: (tx: any) => Promise<unknown>) => {
      assert.equal(pending, null)
      pending = { snapshot: state.snapshot, attestation: state.attestation }
      try { const result = await work(database); Object.assign(state, pending); return result }
      finally { pending = null }
    },
  }
  const service = new TenantSyncService(database, {} as any, {} as any, {} as any,
    { buildSnapshotDifferenceEvidence: () => [] } as any, {} as any)
  // Only the external sync envelope is stubbed; collector, projection, digest,
  // attestation upsert, UTC and snapshot transaction paths execute unchanged.
  ;(service as any).runSnapshotSync = (_t: unknown, _r: unknown, work: () => unknown) => work()
  ;(service as any).fetchGraphPage = async (_url: string, _token: string, _label: string, options: any) => {
    assert.deepEqual(options.acceptedStatuses, [404])
    const page = state.pages[state.page++]
    assert.ok(page, 'Unexpected synthetic Graph request')
    if (page.error) throw new Error(page.error)
    return new Response(JSON.stringify({ value: page.rules }), { status: page.status })
  }
  return { state, service, run: async () => {
    state.page = 0
    await (service as any).syncExchangeMailboxRules(tenant, 'synthetic-only')
    assert.equal(state.attestation.lastAttemptAt.getTime(), state.snapshot.observedAt.getTime())
    assert.equal(state.attestation.source, MAILBOX_SOURCE_VERSION)
    assert.equal(state.attestation.message, null); assert.equal(state.attestation.endpoint, null)
    return state.attestation
  } }
}

function unavailable(row: any, reason: string) {
  assert.equal(row.state, 'UNAVAILABLE'); assert.equal(row.reasonCode, reason)
  assert.equal(row.correlationId, null); assert.equal(row.lastSuccessfulAt, null)
  assert.equal(row.isStale, true)
  assert.ok(!JSON.stringify(row).includes('fixture.invalid'))
  assert.ok(!JSON.stringify(row).includes('PRIVATE_SYNTHETIC'))
}

for (const [name, directory, reason] of [
  ['missing', () => null, 'DIRECTORY_SYNC_MISSING'],
  ['failed', () => ({ ...freshDirectory(), status: 'FAILED' }), 'DIRECTORY_SYNC_NOT_SUCCEEDED'],
  ['unknown', () => ({ ...freshDirectory(), status: 'PRIVATE_SYNTHETIC_UNKNOWN' }), 'DIRECTORY_SYNC_NOT_SUCCEEDED'],
  ['undated', () => ({ ...freshDirectory(), lastSuccessfulAt: null }), 'DIRECTORY_SYNC_UNDATED'],
  ['stale', () => ({ ...freshDirectory(), lastSuccessfulAt: new Date(Date.now() - 37 * 3600000) }), 'DIRECTORY_SYNC_STALE'],
  ['newer attempt', () => ({ status: 'SUCCEEDED', lastSuccessfulAt: new Date(Date.now() - 10000), lastAttemptAt: new Date() }), 'DIRECTORY_SYNC_NEWER_ATTEMPT'],
] as const) test(`collector-to-save: ${name} directory prerequisite has a closed reason`, async () => {
  const f = fixture(); f.state.directory = directory(); unavailable(await f.run(), reason)
})

test('collector-to-save: accepted404 refuses risk coverage, even with an arbitrary response body', async () => {
  const f = fixture(); f.state.pages = [{ status: 404, rules: ['PRIVATE_SYNTHETIC_BODY'] }]
  unavailable(await f.run(), 'RULE_ENDPOINT_NOT_FOUND')
})

test('collector-to-save: invalid rule, duplicate rule and unknown rule fields remain untrusted', async () => {
  for (const rules of [[mailboxRule(undefined, { hasError: true })], [mailboxRule(), mailboxRule()],
    [mailboxRule(undefined, { hasError: undefined })], [mailboxRule(undefined, { actions: { forwardTo: [{ emailAddress: { address: 'PRIVATE_SYNTHETIC_BAD_ADDRESS' } }] } })]]) {
    const f = fixture(); f.state.pages = [{ status: 200, rules }]
    unavailable(await f.run(), 'RULE_VALIDATION_UNATTESTABLE')
  }
})

test('documented priority: directory status before date, stale before newer attempt, all before404/validation', async () => {
  for (const [directory, reason] of [
    [{ status: 'FAILED', lastSuccessfulAt: null, lastAttemptAt: new Date() }, 'DIRECTORY_SYNC_NOT_SUCCEEDED'],
    [{ status: 'SUCCEEDED', lastSuccessfulAt: null, lastAttemptAt: new Date() }, 'DIRECTORY_SYNC_UNDATED'],
    [{ status: 'SUCCEEDED', lastSuccessfulAt: new Date(Date.now() - 37 * 3600000), lastAttemptAt: new Date() }, 'DIRECTORY_SYNC_STALE'],
    [null, 'DIRECTORY_SYNC_MISSING'],
  ] as const) {
    const f = fixture(); f.state.directory = directory; f.state.users = 2
    f.state.pages = [{ status: 200, rules: [mailboxRule(undefined, { hasError: true })] }, { status: 404, rules: [] }]
    unavailable(await f.run(), reason)
  }
})

test('404 outranks validation refusal regardless of mailbox order', async () => {
  for (const reverse of [false, true]) {
    const f = fixture(); f.state.users = 2
    f.state.pages = [{ status: 200, rules: [mailboxRule(undefined, { hasError: true })] }, { status: 404, rules: [] }]
    if (reverse) f.state.pages.reverse()
    unavailable(await f.run(), 'RULE_ENDPOINT_NOT_FOUND')
  }
})

test('complete valid and complete-empty collection attest; subsequent failure clears COMPLETE atomically', async () => {
  for (const rules of [[mailboxRule()], []]) {
    const f = fixture(); f.state.pages = [{ status: 200, rules }]
    const good = await f.run()
    assert.equal(good.state, 'COMPLETE'); assert.equal(good.reasonCode, 'ATTESTED_COMPLETE')
    assert.match(good.correlationId, /^[a-f0-9]{64}$/); assert.equal(good.isStale, false)
    assert.equal(good.lastSuccessfulAt.getTime(), f.state.snapshot.observedAt.getTime())
    f.state.pages = [{ status: 404, rules: [] }]
    unavailable(await f.run(), 'RULE_ENDPOINT_NOT_FOUND')
  }
})

test('legacy callers and untyped arbitrary reason text retain safe generic fallback', async () => {
  const f = fixture()
  for (const reason of [undefined, 'PRIVATE_SYNTHETIC_PROVIDER_TEXT']) {
    await (f.service as any).saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', { completeness: 'authoritative_complete', rows: [] }, undefined, false, reason)
    unavailable(f.state.attestation, 'SOURCE_NOT_ATTESTED')
  }
})

test('failed attestation write cannot publish new snapshot or replace prior provenance', async () => {
  const f = fixture(); await f.run()
  const beforeSnapshot = f.state.snapshot; const beforeAttestation = f.state.attestation
  f.state.failAttestation = true; f.state.pages = [{ status: 404, rules: [] }]
  await assert.rejects(f.run, /synthetic write refusal/)
  assert.equal(f.state.snapshot, beforeSnapshot); assert.equal(f.state.attestation, beforeAttestation)
})

test('foreign baseline, partial collection and thrown provider failure cannot write attestations', async () => {
  const f = fixture()
  f.state.snapshot = { organizationId: 'foreign-synthetic', payload: [] }
  await assert.rejects(f.run, /organization mismatch/); assert.equal(f.state.attestation, null)
  f.state.snapshot = null
  await assert.rejects(() => (f.service as any).saveSnapshot(tenant, 'EXCHANGE_MAILBOX_RULES', { completeness: 'partial_or_unknown', rows: [] }, undefined, true), /Refusing to advance/)
  assert.equal(f.state.snapshot, null); assert.equal(f.state.attestation, null)
  f.state.pages = [{ error: 'PRIVATE_SYNTHETIC_PROVIDER_EXCEPTION' }]
  await assert.rejects(f.run)
  assert.equal(f.state.snapshot, null); assert.equal(f.state.attestation, null)
})
