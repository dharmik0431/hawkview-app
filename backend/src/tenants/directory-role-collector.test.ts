import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { collectDirectoryRoles, DIRECTORY_ROLE_URL } from './directory-role-collector.js'
import { DIRECTORY_ROLE_RECEIPT_SCOPE } from './directory-role-receipt-store.js'
import type { AuthorityDatabase, ManagedAuthority } from '../microsoft/managed-connector-authority.js'
import { readBoundedResponseText } from './tenant-sync.service.js'

// SQL-boundary model runs real capture/claim/terminal primitives. Not a DB proof.
function fixture() {
  const who = { organizationId: randomUUID(), customerTenantId: randomUUID(), microsoftTenantId: randomUUID() }
  const authority = { configurationRevision: randomUUID(), clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: '' }
  authority.credentialReference = 'encrypted-secret:' + authority.configurationRevision
  const connection = { id: randomUUID(), status: 'CONNECTED', mode: 'HAWKVIEW_MANAGED', incarnation: randomUUID() }
  const state: any = { id: randomUUID(), role_scope_version: DIRECTORY_ROLE_RECEIPT_SCOPE, role_scope_incarnation: randomUUID(),
    role_attempt_outcome: null, role_complete_id: null }
  let active = true, available = true, locked = false, live = true
  const writes: string[] = [], queries: string[] = [], requested: string[] = []
  let legacy = 0, tokens = 0
  const tx = {
    async $queryRawUnsafe(sql: string, ...args: any[]) {
      queries.push(sql)
      if (sql.includes('pg_advisory')) return [{ locked: 1 }]
      if (sql.includes('FROM platform_microsoft_connectors')) return available ? [{ ...authority }] : []
      if (sql.includes('FROM customer_tenants')) {
        if (args[1] !== who.organizationId || args[2] !== who.microsoftTenantId) return []
        return sql.includes("status='ACTIVE'") && !active ? [] : [{ id: who.customerTenantId, status: active ? 'ACTIVE' : 'DISCONNECTED' }]
      }
      if (sql.includes('FROM tenant_connections')) return sql.includes("status='CONNECTED'") && connection.status !== 'CONNECTED' ? [] : [{ ...connection }]
      if (sql.includes('SELECT * FROM sync_states')) return [{ ...state }]
      if (sql.includes('WITH sample AS MATERIALIZED')) return [{ checkedAt: new Date(), live }]
      if (sql.includes('FROM tenant_entra_snapshots')) return []
      throw Error('unexpected query: ' + sql)
    },
    async $executeRawUnsafe(sql: string, ...p: any[]) {
      writes.push(sql)
      if (sql.includes('SET role_attempt_id=')) Object.assign(state, { role_attempt_id: p[0], role_attempt_connection: p[1], role_attempt_configuration: p[2], role_attempt_scope: p[3], role_attempt_outcome: 'RUNNING' })
      if (sql.includes('SET role_attempt_outcome=$1')) state.role_attempt_outcome = p[0]
      if (sql.includes("SET role_attempt_outcome='COMPLETE'")) state.role_attempt_outcome = 'COMPLETE'
      return 1
    },
  }
  const db: AuthorityDatabase = { async $transaction(work) {
    assert.equal(locked, false); locked = true
    try { return await work(tx as any) } finally { locked = false }
  } }
  const deps = { db,
    token: async (captured: ManagedAuthority, tenant: string, _deadline: number) => {
      assert.equal(locked, false); assert.equal(tenant, who.microsoftTenantId)
      assert.deepEqual(captured, authority); tokens++; return 'captured-token'
    },
    fetchPage: async (url: string, token: string, _deadline: number): Promise<Response> => {
      assert.equal(locked, false); assert.equal(token, 'captured-token'); requested.push(url)
      return Response.json({ value: [] })
    },
    read: async (response: Response, _max: number, _message: string, _deadline: number) => response.text(),
    buildDifference: () => [], legacy: async () => { legacy++ },
  }
  return { who, authority, connection, state, writes, queries, requested, deps,
    counts: () => ({ legacy, tokens }), unavailable: () => { available = false },
    inactive: () => { active = false }, expire: () => { live = false } }
}
test('capture locks G/T/C/R and empty collection commits once without legacy effects', async () => {
  const f = fixture(), result = await collectDirectoryRoles(f.who, f.deps)
  assert.equal(result.status, 'committed')
  assert.deepEqual(f.counts(), { legacy: 0, tokens: 1 })
  assert.deepEqual(f.requested, [DIRECTORY_ROLE_URL])
  const q = f.queries.join('\n')
  assert.ok(q.indexOf('platform_microsoft_connectors') < q.indexOf('customer_tenants'))
  assert.ok(q.indexOf('customer_tenants') < q.indexOf('tenant_connections'))
  assert.ok(q.indexOf('tenant_connections') < q.indexOf('sync_states'))
  assert.equal(f.writes.filter(q => q.includes('INSERT INTO tenant_entra_snapshots')).length, 1)
})
test('never-activated managed and customer-managed retain legacy; unavailable activated never falls back', async () => {
  for (const mode of ['HAWKVIEW_MANAGED', 'CUSTOMER_MANAGED']) {
    const f = fixture(); f.state.role_scope_version = f.state.role_scope_incarnation = null; f.connection.mode = mode; f.unavailable()
    assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'legacy')
    assert.deepEqual(f.counts(), { legacy: 1, tokens: 0 }); assert.equal(f.writes.length, 0)
  }
  for (const change of [(f: ReturnType<typeof fixture>) => f.unavailable(), (f: ReturnType<typeof fixture>) => f.inactive(),
    (f: ReturnType<typeof fixture>) => { f.connection.status = 'REVOKED' },
    (f: ReturnType<typeof fixture>) => { f.connection.mode = 'CUSTOMER_MANAGED' },
    (f: ReturnType<typeof fixture>) => { f.state.role_scope_version = 'other' }]) {
    const f = fixture(); change(f)
    assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'rejected')
    assert.deepEqual(f.counts(), { legacy: 0, tokens: 0 }); assert.equal(f.writes.length, 0)
  }
})
test('changed G, C or S during provider success and failure has no stale terminal effects', async () => {
  for (const target of ['G', 'C', 'S']) for (const failure of [false, true]) {
    const f = fixture()
    f.deps.fetchPage = async () => {
      if (target === 'G') f.authority.configurationRevision = randomUUID()
      if (target === 'C') f.connection.incarnation = randomUUID()
      if (target === 'S') f.state.role_scope_incarnation = randomUUID()
      if (failure) throw Error('late failure')
      return Response.json({ value: [] })
    }
    assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'rejected')
    assert.equal(f.writes.length, 1, 'only initial claim; no stale terminal/snapshot/evidence')
    assert.equal(f.counts().legacy, 0)
  }
})
test('expired, malformed, cyclic or cross-resource pages never publish COMPLETE', async () => {
  for (const page of [{ value: [{}] }, { value: [], '@odata.nextLink': DIRECTORY_ROLE_URL },
    { value: [], '@odata.nextLink': 'https://evil.example/v1.0/roleManagement/directory/roleAssignments' },
    { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users' }, { value: [], '@odata.nextLink': '' }]) {
    const f = fixture(); f.deps.fetchPage = async () => Response.json(page)
    assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'partial')
    assert.equal(f.writes.some(q => q.includes('INSERT INTO')), false); assert.equal(f.counts().legacy, 0)
  }
  const f = fixture(); f.deps.fetchPage = async () => { f.expire(); return Response.json({ value: [] }) }
  assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'expired')
  assert.equal(f.writes.some(q => q.includes('INSERT INTO')), false)
})
test('token failure is fenced, wrong organization rejects and busy attempt never calls provider', async () => {
  const f = fixture(); f.deps.token = async () => { throw Error('credential failed') }
  assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'failed')
  assert.equal(f.counts().legacy, 0)
  const g = fixture()
  assert.equal((await collectDirectoryRoles({ ...g.who, organizationId: randomUUID() }, g.deps)).status, 'rejected')
  assert.equal(g.writes.length, 0)
  g.state.role_attempt_outcome = 'RUNNING'; g.state.role_attempt_configuration = g.authority.configurationRevision
  assert.deepEqual(await collectDirectoryRoles(g.who, g.deps), { status: 'rejected', reason: 'BUSY' })
  assert.deepEqual(g.counts(), { legacy: 0, tokens: 0 })
})

test('fresh G reuses durable S after an old attempt loses authority', async () => {
  const f = fixture(), scope = f.state.role_scope_incarnation
  f.deps.fetchPage = async () => {
    f.authority.configurationRevision = randomUUID()
    f.authority.credentialReference = 'encrypted-secret:' + f.authority.configurationRevision
    return Response.json({ value: [] })
  }
  assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, 'rejected')
  f.deps.fetchPage = async () => Response.json({ value: [] })
  const fresh = await collectDirectoryRoles(f.who, f.deps)
  assert.equal(fresh.status, 'committed')
  if (fresh.status !== 'committed') throw Error('expected receipt')
  assert.equal(fresh.receipt.scopeIncarnation, scope)
  assert.equal(fresh.receipt.configurationRevision, f.authority.configurationRevision)
})

test('bounded multipage complete projects rows; page/count/stream limits refuse publication', async () => {
  const guid = randomUUID(), role = (id: string) => ({ id, principalId: guid, roleDefinitionId: guid,
    directoryScopeId: '/', roleDefinition: { id: guid, displayName: 'Role' } })
  const f = fixture(); let page = 0
  f.deps.fetchPage = async () => Response.json(++page === 1
    ? { value: [role('a')], '@odata.nextLink': DIRECTORY_ROLE_URL + '&$skiptoken=two' }
    : { value: [role('b')] })
  const result = await collectDirectoryRoles(f.who, f.deps)
  assert.equal(result.status, 'committed')
  if (result.status === 'committed') assert.equal(result.receipt.rowCount, 2)
  assert.equal(page, 2)
  const g = fixture(); let requests = 0
  g.deps.fetchPage = async () => Response.json({ value: [], '@odata.nextLink': DIRECTORY_ROLE_URL + '&$skiptoken=' + ++requests })
  assert.equal((await collectDirectoryRoles(g.who, g.deps)).status, 'partial'); assert.equal(requests, 100)
  const h = fixture(); h.deps.read = readBoundedResponseText
  h.deps.fetchPage = async () => new Response('x'.repeat(180001))
  assert.equal((await collectDirectoryRoles(h.who, h.deps)).status, 'failed')
  assert.equal(h.writes.some(q => q.includes('INSERT INTO')), false)
})

test('evidence/commit failure propagates without a second terminal write or fallback', async () => {
  const f = fixture(); f.deps.buildDifference = () => { throw Error('evidence failure') }
  await assert.rejects(collectDirectoryRoles(f.who, f.deps), /evidence failure/)
  assert.equal(f.writes.length, 1)
  assert.equal(f.counts().legacy, 0)
})
