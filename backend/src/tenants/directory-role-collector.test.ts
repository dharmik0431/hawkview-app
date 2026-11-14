import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { collectDirectoryRoles, DIRECTORY_ROLE_URL } from './directory-role-collector.js'
import { TenantVisitLeaseLostError } from './tenant-visit-lease-error.js'
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
  const owner = { organizationId: who.organizationId, customerTenantId: who.customerTenantId,
    token: randomUUID(), generation: 1n, expiresAt: new Date(Date.now() + 300_000) }
  const auditWork = { requestedRevision: 2n, completedRevision: 0n }
  let visitGeneration = owner.generation
  let active = true, available = true, locked = false, live = true
  const writes: string[] = [], queries: string[] = [], requested: string[] = []
  const transactionQueries: string[][] = []
  let legacy = 0, tokens = 0
  const tx = {
    async $queryRawUnsafe(sql: string, ...args: any[]) {
      queries.push(sql)
      transactionQueries.at(-1)!.push(sql)
      if (sql.includes('FROM organizations')) return [{ id: who.organizationId }]
      if (sql.includes('FROM tenant_sync_visit_leases')) return args[2] === owner.token && args[3] === visitGeneration.toString()
        ? [{ generation: visitGeneration.toString() }] : []
      if (sql.includes('pg_advisory')) return [{ locked: 1 }]
      if (sql.includes('FROM platform_microsoft_connectors')) return available ? [{ ...authority }] : []
      if (sql.includes('FROM customer_tenants')) {
        if (args[1] !== who.organizationId || (args.length > 2 && args[2] !== who.microsoftTenantId)) return []
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
      if (sql.includes('UPDATE tenant_audit_reconciliation_work')) {
        const revision = BigInt(p[2])
        if (auditWork.requestedRevision !== revision || auditWork.completedRevision >= revision) return 0
        auditWork.completedRevision = revision
      }
      if (sql.includes('SET role_attempt_id=')) Object.assign(state, { role_attempt_id: p[0], role_attempt_connection: p[1], role_attempt_configuration: p[2], role_attempt_scope: p[3], role_attempt_outcome: 'RUNNING' })
      if (sql.includes('SET role_attempt_outcome=$1')) state.role_attempt_outcome = p[0]
      if (sql.includes("SET role_attempt_outcome='COMPLETE'")) state.role_attempt_outcome = 'COMPLETE'
      return 1
    },
  }
  const db: AuthorityDatabase = { async $transaction(work) {
    assert.equal(locked, false); locked = true; transactionQueries.push([])
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
  return { who, authority, connection, state, writes, queries, requested, deps, owner, transactionQueries, auditWork,
    takeOver: () => { visitGeneration++ },
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
test('unconfigured managed source fails closed; customer-managed compatibility remains untrusted', async () => {
  for (const mode of ['HAWKVIEW_MANAGED', 'CUSTOMER_MANAGED']) {
    const f = fixture(); f.state.role_scope_version = f.state.role_scope_incarnation = null; f.connection.mode = mode; f.unavailable()
    assert.equal((await collectDirectoryRoles(f.who, f.deps)).status, mode === 'CUSTOMER_MANAGED' ? 'legacy' : 'rejected')
    assert.deepEqual(f.counts(), { legacy: mode === 'CUSTOMER_MANAGED' ? 1 : 0, tokens: 0 }); assert.equal(f.writes.length, 0)
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


test('owned managed role claim and publication lock authority then visit before connection and role writes', async () => {
  const f = fixture()
  const result = await collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner })
  assert.equal(result.status, 'committed')
  assert.equal(f.transactionQueries.length, 2, 'capture/claim and publication are separate transactions')
  for (const queries of f.transactionQueries) {
    const index = (text: string) => queries.findIndex(sql => sql.includes(text))
    assert.ok(index('platform_microsoft_connectors') >= 0)
    assert.ok(index('platform_microsoft_connectors') < index('FROM organizations'))
    assert.ok(index('FROM organizations') < index('FROM customer_tenants'))
    assert.ok(index('FROM customer_tenants') < index('FROM tenant_sync_visit_leases'))
    assert.ok(index('FROM tenant_sync_visit_leases') < index('FROM tenant_connections'))
    assert.ok(index('FROM tenant_sync_visit_leases') < index('SELECT * FROM sync_states'))
  }
  assert.equal(f.writes.filter(sql => sql.includes("role_attempt_outcome='COMPLETE'")).length, 1)
})

test('lost visit before managed role capture refuses provider and every role write', async () => {
  const f = fixture(); f.takeOver()
  await assert.rejects(collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner }), TenantVisitLeaseLostError)
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.counts(), { legacy: 0, tokens: 0 })
  assert.equal(f.queries.some(sql => sql.includes('FROM tenant_connections')), false)
})

test('takeover during managed role collection prevents stale success, partial and failed terminal writes', async () => {
  for (const outcome of ['success', 'partial', 'failure'] as const) {
    const f = fixture()
    f.deps.fetchPage = async () => {
      f.takeOver()
      if (outcome === 'failure') throw new Error('synthetic provider failure')
      return Response.json({ value: outcome === 'partial' ? [{}] : [] })
    }
    await assert.rejects(collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner }), TenantVisitLeaseLostError)
    assert.equal(f.writes.length, 1, 'only the original claim; no old-owner terminal, snapshot or evidence')
    assert.equal(f.state.role_attempt_outcome, 'RUNNING')
    assert.equal(f.counts().legacy, 0)
    const successor = await collectDirectoryRoles(f.who, { ...f.deps, visitOwner: { ...f.owner, generation: 2n } })
    assert.equal(successor.status, 'rejected', 'a live role attempt remains busy until its own recovery contract permits a claim')
  }
})

test('owned role-OFF still refuses collection without a write or provider call', async () => {
  const f = fixture(); f.state.role_scope_version = 'directory-role-assignments/revoked-v1'
  const result = await collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner })
  assert.deepEqual(result, { status: 'rejected', reason: 'UNAVAILABLE' })
  assert.equal(f.writes.length, 0)
  assert.deepEqual(f.counts(), { legacy: 0, tokens: 0 })
})

test('collector propagates a lost-visit error without converting it into a role failure', async () => {
  const f = fixture()
  f.deps.fetchPage = async () => { throw new TenantVisitLeaseLostError() }
  await assert.rejects(collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner }), TenantVisitLeaseLostError)
  assert.equal(f.writes.length, 1)
  assert.equal(f.transactionQueries.length, 1, 'no failure transaction is started after explicit visit loss')
})


test('managed role audit acknowledgement follows authoritative publication and preserves newer requests', async () => {
  for (const requested of [2n, 3n]) {
    const f = fixture(); f.auditWork.requestedRevision = requested
    const result = await collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner, auditRequestedRevision: 2n })
    assert.equal(result.status, 'committed')
    assert.equal(f.auditWork.completedRevision, requested === 2n ? 2n : 0n)
    const roleCompletion = f.writes.findIndex(sql => sql.includes("role_attempt_outcome='COMPLETE'"))
    const acknowledgement = f.writes.findIndex(sql => sql.includes('UPDATE tenant_audit_reconciliation_work'))
    assert.ok(roleCompletion >= 0 && acknowledgement > roleCompletion)
  }
})

test('partial, qualified, failed and revoked role sources leave audit work pending', async () => {
  for (const failure of ['malformed', '206', 'warning', 'provider', 'revoked'] as const) {
    const f = fixture()
    if (failure === 'revoked') f.state.role_scope_version = 'directory-role-assignments/revoked-v1'
    f.deps.fetchPage = async () => {
      if (failure === 'provider') throw new Error('synthetic provider failure')
      return Response.json({ value: failure === 'malformed' ? [{}] : [] },
        { status: failure === '206' ? 206 : 200, headers: failure === 'warning' ? { warning: '199 Qualified result' } : {} })
    }
    const result = await collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner, auditRequestedRevision: 2n })
    assert.notEqual(result.status, 'committed')
    assert.equal(f.auditWork.completedRevision, 0n)
    assert.equal(f.writes.some(sql => sql.includes('UPDATE tenant_audit_reconciliation_work')), false)
  }
})

test('invalid role audit requests reject before capture or provider work', async () => {
  for (const revision of [0n, -1n, 9223372036854775808n, '2'] as const) {
    const f = fixture()
    await assert.rejects(collectDirectoryRoles(f.who, { ...f.deps, visitOwner: f.owner,
      auditRequestedRevision: revision as bigint }), /SNAPSHOT_RECEIPT_INVALID/)
    assert.equal(f.queries.length, 0)
    assert.deepEqual(f.counts(), { legacy: 0, tokens: 0 })
  }
  const f = fixture()
  await assert.rejects(collectDirectoryRoles(f.who, { ...f.deps, auditRequestedRevision: 2n }), /SNAPSHOT_RECEIPT_INVALID/)
  assert.equal(f.queries.length, 0)
})
