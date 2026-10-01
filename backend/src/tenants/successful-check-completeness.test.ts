import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { utcTestDatabase } from '../identity-risk/risk-utc.test-fixtures.js'
import { TenantSyncService } from './tenant-sync.service.js'
const originalFetch = globalThis.fetch
before(() => { globalThis.fetch = async () => { throw new Error('Real network forbidden in completeness tests') } })
after(() => { globalThis.fetch = originalFetch })
const tenant = { id: 'tenant-a', organizationId: 'org-a', microsoftTenantId: 'ms-a', status: 'ACTIVE', displayName: null, primaryDomain: null, connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null } }
const prior = new Date('2020-01-01Z'), checkpoint = 'https://graph.microsoft.com/users/delta?old', next = 'https://graph.microsoft.com/users/delta?new'
function fixture(source: string, pages: any[]) {
  const state: any = { id: 'state', status: 'SUCCEEDED', lastSuccessfulAt: prior, deltaLink: checkpoint }
  const writes: string[] = []; let requests = 0
  const update = async (a: any) => { assert.equal(a.where.customerTenantId_resourceType.customerTenantId, tenant.id); assert.equal(a.where.customerTenantId_resourceType.resourceType, source); Object.assign(state, a.data); return state }
  const db = utcTestDatabase({
    syncState: { findUnique: async () => ({ ...state }), updateMany: async (a: any) => { Object.assign(state, a.data); return { count: 1 } }, update,
      upsert: async (a: any) => { assert.equal(a.create.organizationId, tenant.organizationId); return update({ ...a, data: a.update }) }, findMany: async () => [] },
    directoryUser: { upsert: async (a: any) => { assert.equal(a.create.organizationId, tenant.organizationId); assert.equal(a.create.customerTenantId, tenant.id); writes.push('user'); return {} }, updateMany: async (a: any) => { assert.equal(a.where.customerTenantId, tenant.id); writes.push('tombstone'); return { count: 1 } } },
    tenantConnection: { update: async (a: any) => { assert.equal(a.where.customerTenantId_organizationId.organizationId, tenant.organizationId); writes.push('connection'); return {} } },
    directoryAuditLog: { findFirst: async () => null, findMany: async () => [], createMany: async (a: any) => { for (const r of a.data) { assert.equal(r.organizationId, tenant.organizationId); assert.equal(r.customerTenantId, tenant.id) } writes.push('audit'); return { count: a.data.length } }, deleteMany: async () => { writes.push('prune'); return { count: 0 } } },
  })
  const service: any = new TenantSyncService(db as any, { getTenantAccessToken: async () => 'synthetic' } as any, {} as any, { resolveIncident: async () => {}, publishIncident: async () => {} } as any, { projectDirectoryAudits: async () => {}, pruneExpired: async () => {} } as any, { syncTenant: async () => [] } as any)
  service.logger = { log() {}, warn() {}, error() {} }
  service.fetchGraphPage = async () => { const p = pages[requests++]; if (p instanceof Error) throw p; assert.notEqual(p, undefined); return new Response(JSON.stringify(p)) }
  for (const m of ['syncSignInLogs','syncM365AuditActivity','refreshCollectionFieldStates','reconcileDirectoryAuditResources']) service[m] = async () => {}
  if (source === 'USERS') service.syncDirectoryAuditLogs = async () => {}
  return { state, writes, requests: () => requests, run: () => source === 'USERS' ? service.syncConnectedTenant(tenant, false, { incrementalOnly: true, includeBundle: false }) : service.syncDirectoryAuditLogs(tenant, 'synthetic', false) }
}
const audit = { id: 'event-a', activityDateTime: '2024-01-01T12:00:00Z', activityDisplayName: 'Synthetic' }
for (const source of ['USERS','AUDIT_LOGS']) {
  const page = (value: any[]) => ({ value, ...(source === 'USERS' ? { '@odata.deltaLink': next } : {}) })
  test(`${source} completed empty verifies`, async () => { const f = fixture(source,[page([])]); await f.run(); assert.equal(f.state.status,'SUCCEEDED'); assert.ok(f.state.lastSuccessfulAt > prior); assert.equal(f.requests(),1); assert.equal(f.writes.some(w=>['user','audit','tombstone'].includes(w)),false) })
  const bad = source === 'USERS' ? [{}, {id:7}, {id:''}, {id:'  '}, null] : [{...audit,id:undefined},{...audit,id:''},{...audit,activityDateTime:'invalid'},{...audit,activityDisplayName:null},null]
  for (const [i,row] of bad.entries()) for (const mixed of [false,true]) test(`${source} invalid${i} mixed${mixed} rejects before writes`, async () => {
    const f=fixture(source,[page(mixed?[source==='USERS'?{id:'valid'}:audit,row]:[row])]); await assert.rejects(f.run); assert.equal(f.state.status,'FAILED'); assert.equal(f.state.lastSuccessfulAt,prior); assert.equal(f.state.deltaLink,checkpoint); assert.deepEqual(f.writes,[])
  })
  test(`${source} later page failure preserves state`, async () => { const f=fixture(source,[{value:[source==='USERS'?{id:'valid'}:audit],'@odata.nextLink':'https://graph.microsoft.com/next'},new Error('synthetic page failure')]); await assert.rejects(f.run); assert.equal(f.requests(),2); assert.equal(f.state.lastSuccessfulAt,prior); assert.equal(f.state.deltaLink,checkpoint); assert.deepEqual(f.writes,[]) })
}
test('USERS sparse fields and tombstone succeed',async()=>{const f=fixture('USERS',[{value:[{id:'u'},{id:'d','@removed':{reason:'deleted'}}],'@odata.deltaLink':next}]);await f.run();assert.equal(f.state.status,'SUCCEEDED');assert.equal(f.state.deltaLink,next);assert.deepEqual(f.writes,['user','tombstone','connection'])})
test('audit optional fields and historical timestamp succeed',async()=>{const f=fixture('AUDIT_LOGS',[{value:[audit]}]);await f.run();assert.equal(f.state.status,'SUCCEEDED');assert.deepEqual(f.writes,['audit','prune'])})
test('USERS missing final checkpoint fails',async()=>{const f=fixture('USERS',[{value:[]}]);await assert.rejects(f.run);assert.equal(f.state.lastSuccessfulAt,prior);assert.equal(f.state.deltaLink,checkpoint);assert.deepEqual(f.writes,[])})
