import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { TenantsService } from './tenants.service.js'
import { TenantsController } from './tenants.controller.js'
import { readDirectoryRoleControl, setDirectoryRoleControl, completeRoleAttempt, finishRoleAttempt,
  DIRECTORY_ROLE_RECEIPT_SCOPE, DIRECTORY_ROLE_REVOKED_SCOPE } from './directory-role-receipt-store.js'
import { prepareDirectoryRoles } from './directory-role-collection-validation.js'

// Existing SQL-boundary testing pattern. This exercises the actual service/store;
// it does not substitute for PostgreSQL lock/constraint acceptance.
class ControlDatabase {
  who = { customerTenantId: randomUUID(), organizationId: randomUUID(), microsoftTenantId: randomUUID() }
  authority: any = { configurationRevision: randomUUID(), clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: '' }
  tenant = { status: 'ACTIVE' }
  connection: any = { id: randomUUID(), incarnation: randomUUID(), mode: 'HAWKVIEW_MANAGED', status: 'CONNECTED' }
  state: any = { id: randomUUID(), role_scope_incarnation: randomUUID(), role_scope_version: DIRECTORY_ROLE_RECEIPT_SCOPE,
    role_attempt_id: randomUUID(), role_attempt_outcome: 'RUNNING', role_complete_id: randomUUID(), role_complete_digest: 'retained', role_complete_count: 2 }
  snapshot = ['retained snapshot']; evidence = ['retained evidence']
  writes: string[] = []; order: string[] = []; active = false; deleted = false
  role = 'MSP_OWNER'; disabled = false; sameOrg = true; remote = 0
  constructor() { this.authority.credentialReference = 'encrypted-secret:' + this.authority.configurationRevision }
  saved() { return structuredClone({ authority: this.authority, tenant: this.tenant, connection: this.connection, state: this.state, snapshot: this.snapshot, evidence: this.evidence, deleted: this.deleted }) }
  user = { findUnique: async (args: any) => ({ disabledAt: this.disabled ? new Date() : null,
    memberships: args.select.memberships.where.role.in.includes(this.role)
      ? [{ organizationId: this.sameOrg ? this.who.organizationId : randomUUID(), organization: { onboardingCompletedAt: new Date() } }] : [] }) }
  customerTenant = { findFirst: async (args: any) => !this.deleted && args.where.id === this.who.customerTenantId && args.where.organizationId.in.includes(this.who.organizationId)
    ? { id: this.who.customerTenantId, organizationId: this.who.organizationId, microsoftTenantId: this.who.microsoftTenantId,
      status: this.tenant.status, connection: this.connection ? { status: this.connection.status, connectionMode: this.connection.mode, credentialReference: 'global-secret-reference' } : null } : null }
  async $transaction(work: any) {
    assert.equal(this.active,false); const before = this.saved(); this.active = true
    try { return await work(this) } catch (error) { Object.assign(this,before); throw error } finally { this.active = false }
  }
  async $queryRawUnsafe(sql: string, ...v: any[]) {
    if (sql.includes('pg_advisory')) { this.order.push('G'); return [] }
    if (sql.includes('platform_microsoft_connectors')) return this.authority ? [structuredClone(this.authority)] : []
    if (sql.includes('FROM customer_tenants')) {
      this.order.push('T'); assert.deepEqual(v,[this.who.customerTenantId,this.who.organizationId,this.who.microsoftTenantId])
      return this.deleted || (sql.includes("status='ACTIVE'") && this.tenant.status !== 'ACTIVE') ? [] : [structuredClone(this.tenant)]
    }
    if (sql.includes('FROM tenant_connections')) {
      this.order.push('C'); assert.deepEqual(v,[this.who.customerTenantId,this.who.organizationId])
      return !this.connection || (sql.includes("status='CONNECTED'") && this.connection.status !== 'CONNECTED') ? [] : [structuredClone(this.connection)]
    }
    if (sql.includes('FROM sync_states')) { this.order.push('R'); assert.deepEqual(v,[this.who.customerTenantId,this.who.organizationId]); return this.state ? [structuredClone(this.state)] : [] }
    throw Error('unexpected query: '+sql)
  }
  async $executeRawUnsafe(sql: string, ...v: any[]) {
    this.writes.push(sql)
    if (sql.includes('INSERT INTO sync_states')) { this.state ??= { id: v[0], role_scope_incarnation: null, role_scope_version: null }; return 1 }
    if (sql.includes('directory-control:revoke')) {
      assert.deepEqual(v.slice(0,2),[this.who.customerTenantId,this.who.organizationId])
      Object.assign(this.state,{ role_scope_version:v[2],role_scope_incarnation:v[3],status:'IDLE' })
    } else if (sql.includes('SET role_scope_version=')) {
      assert.equal(v[2],this.state.id); Object.assign(this.state,{role_scope_version:v[0],role_scope_incarnation:v[1],status:'IDLE'})
    } else if (sql.includes('UPDATE tenant_connections SET collection_incarnation=')) {
      assert.equal(v[1],this.connection.id); this.connection.incarnation = v[0]
    } else if (sql.includes('directory-control:disconnect-connection')) {
      if (this.connection) { this.connection.incarnation=v[2];this.connection.status='REVOKED' }
    } else if (sql.includes('directory-control:disconnect')) this.tenant.status='DISCONNECTED'
    else if (sql.includes('directory-control:delete')) this.deleted=true
    else throw Error('unexpected write: '+sql)
    if (sql.includes('UPDATE sync_states')) for (const match of sql.matchAll(/(role_attempt_\w+)=NULL/g)) this.state[match[1]]=null
    return 1
  }
}
const identity = { subject: 'control-owner' } as any
function fixture() {
  const db=new ControlDatabase()
  const noRemote=new Proxy({}, {get:()=>()=>{ db.remote++; throw Error('unexpected provider/notification call') }})
  const service=new TenantsService(db as any,noRemote as any,noRemote as any)
  const controller=new TenantsController(service,{} as any)
  return {db,service, read:()=>controller.getDirectoryRoleControl({auth:identity} as any,db.who.customerTenantId),
    set:(body:unknown)=>controller.setDirectoryRoleControl({auth:identity} as any,db.who.customerTenantId,body)}
}
test('Owner/Admin control revokes, enables a fresh scope and retains all completed evidence without fetching',async()=>{
  for(const role of ['MSP_OWNER','MSP_ADMIN']) {
    const f=fixture();f.db.role=role;const before=f.db.saved(),control=await f.read()
    assert.equal(control.enabled,true)
    const disabled=await f.set({enabled:false,expected:control.expected})
    assert.equal(f.db.state.role_scope_version,'directory-role-assignments/revoked-v1')
    assert.equal(f.db.state.role_scope_incarnation,disabled.expected.scopeIncarnation)
    assert.equal((await f.read()).enabled,false)
    assert.equal(disabled.expected.scopeVersion,DIRECTORY_ROLE_REVOKED_SCOPE)
    assert.notEqual(disabled.expected.scopeIncarnation,control.expected.scopeIncarnation)
    assert.equal(f.db.state.role_attempt_id,null)
    const enabled=await f.set({enabled:true,expected:disabled.expected})
    assert.equal(enabled.expected.scopeVersion,DIRECTORY_ROLE_RECEIPT_SCOPE)
    assert.notEqual(enabled.expected.scopeIncarnation,disabled.expected.scopeIncarnation)
    assert.equal(f.db.state.role_complete_id,before.state.role_complete_id)
    assert.equal(f.db.state.role_complete_digest,before.state.role_complete_digest)
    assert.deepEqual(f.db.snapshot,before.snapshot);assert.deepEqual(f.db.evidence,before.evidence);assert.equal(f.db.remote,0)
    assert.deepEqual(f.db.order.slice(0,4),['G','T','C','R'])
  }
})
for(const condition of ['scope-absent','state-absent','connection-absent','suspended','revoked','missing-config','legacy-credential'] as const) {
  test(`revoke is available with ${condition} and never clears the scope pair`,async()=>{
    const f=fixture()
    if(condition==='scope-absent') f.db.state.role_scope_incarnation=f.db.state.role_scope_version=null
    if(condition==='state-absent') f.db.state=null
    if(condition==='connection-absent') f.db.connection=null
    if(condition==='suspended') { f.db.tenant.status='SUSPENDED';f.db.connection.status='ERROR' }
    if(condition==='revoked') { f.db.tenant.status='DISCONNECTED';f.db.connection.status='REVOKED' }
    if(condition==='missing-config') f.db.authority=null
    if(condition==='legacy-credential') f.db.authority.credentialReference='legacy'
    const result=await f.set({enabled:false,expected:(await f.read()).expected})
    assert.equal(result.enabled,false);assert.equal(result.expected.scopeVersion,DIRECTORY_ROLE_REVOKED_SCOPE)
    assert.match(result.expected.scopeIncarnation!,/^[a-f0-9-]{36}$/);assert.equal(f.db.remote,0)
    if(!['scope-absent','state-absent'].includes(condition)) await assert.rejects(f.set({enabled:true,expected:result.expected}),ConflictException)
  })
}
test('stale G/C/S or scope version, repeated request and bad shape cannot mutate control',async()=>{
  for(const field of ['configurationRevision','connectionIncarnation','scopeIncarnation','scopeVersion'] as const) {
    const f=fixture(),expected={...(await f.read()).expected};expected[field]=field==='scopeVersion'?'other':randomUUID()
    const before=f.db.saved();await assert.rejects(f.set({enabled:false,expected}),ConflictException)
    assert.deepEqual(f.db.saved(),before);assert.equal(f.db.writes.length,0)
  }
  const f=fixture(),expected=(await f.read()).expected
  await f.set({enabled:false,expected});const count=f.db.writes.length
  await assert.rejects(f.set({enabled:false,expected}),ConflictException);assert.equal(f.db.writes.length,count)
  await assert.rejects(f.set({enabled:false,expected:{}}),BadRequestException)
})
test('non-admin, disabled and cross-org callers cannot read or mutate control',async()=>{
  for(const mode of ['reader','technician','disabled','cross-org']) {
    const f=fixture()
    if(mode==='reader') f.db.role='MSP_VIEWER'
    if(mode==='technician') f.db.role='MSP_TECHNICIAN'
    if(mode==='disabled') f.db.disabled=true
    if(mode==='cross-org') f.db.sameOrg=false
    await assert.rejects(f.read(),mode==='disabled'?ForbiddenException:NotFoundException)
    await assert.rejects(f.set({enabled:false,expected:{}}))
    assert.equal(f.db.writes.length,0);assert.deepEqual(f.db.order,[])
  }
})
test('one absent-state enable wins; stale retry leaves no additional writes',async()=>{
  const f=fixture();f.db.state=null;f.db.connection.incarnation=null
  const expected=(await f.read()).expected
  const enabled=await f.set({enabled:true,expected});assert.equal(enabled.enabled,true)
  assert.ok(enabled.expected.connectionIncarnation);assert.ok(enabled.expected.scopeIncarnation)
  const count=f.db.writes.length
  await assert.rejects(f.set({enabled:true,expected}),ConflictException);assert.equal(f.db.writes.length,count)
})
test('revocation rejects delayed COMPLETE/FAILED/PARTIAL with unchanged history',async()=>{
  const f=fixture(),expected=(await f.read()).expected
  const attempt={...f.db.who,configurationRevision:expected.configurationRevision!,connectionIncarnation:expected.connectionIncarnation!,
    scopeIncarnation:expected.scopeIncarnation!,scopeVersion:expected.scopeVersion!,attemptId:f.db.state.role_attempt_id}
  await f.set({enabled:false,expected});const before=f.db.saved(),count=f.db.writes.length
  assert.equal((await completeRoleAttempt(f.db as any,attempt,prepareDirectoryRoles([]),()=>[])).status,'rejected')
  for(const outcome of ['FAILED','PARTIAL'] as const) assert.equal((await finishRoleAttempt(f.db as any,attempt,outcome)).status,'rejected')
  assert.deepEqual(f.db.saved(),before);assert.equal(f.db.writes.length,count)
})
test('managed tenant removal requires confirmation, revokes first, deletes atomically and never deletes a global secret',async()=>{
  const f=fixture()
  await assert.rejects(f.service.removeTenantForIdentity(identity,f.db.who.customerTenantId,{}),BadRequestException)
  const result=await f.service.removeTenantForIdentity(identity,f.db.who.customerTenantId,{confirmMicrosoftTenantId:f.db.who.microsoftTenantId})
  assert.equal(result.removed,true);assert.equal(result.credentialRemoved,false);assert.equal(f.db.remote,0);assert.equal(f.db.deleted,true)
  assert.equal(f.db.state.role_scope_version,DIRECTORY_ROLE_REVOKED_SCOPE)
  assert.ok(f.db.writes.findIndex(q=>q.includes('directory-control:revoke')) < f.db.writes.findIndex(q=>q.includes('directory-control:delete')))
  assert.equal((await readDirectoryRoleControl(f.db as any,f.db.who)).status,'rejected')
})

test('customer-managed replacement refuses a managed tenant before preparation and again after a concurrent mode change',async()=>{
  for(const race of [false,true]) {
    const f=fixture(),db:any=f.db,service:any=f.service
    db.tenant.status='PENDING';db.connection.status='ERROR';db.connection.mode=race?'CUSTOMER_MANAGED':'HAWKVIEW_MANAGED';db.state=null
    db.customerTenant.findUnique=async()=>structuredClone({id:db.who.customerTenantId,organizationId:db.who.organizationId,
      status:db.tenant.status,connection:{status:db.connection.status,connectionMode:db.connection.mode}})
    service.microsoftConsent={prepareCustomerManagedConnection:async()=>{db.remote++;db.connection.mode='HAWKVIEW_MANAGED';return {displayName:'prepared',primaryDomain:null,credentialReference:'prepared-reference',grantedPermissions:[]}}}
    db.customerTenant.update=()=>{throw Error('must not overwrite a managed connection')}
    await assert.rejects(service.createForIdentity(identity,{microsoftTenantId:db.who.microsoftTenantId,connectionMode:'CUSTOMER_MANAGED',clientId:randomUUID(),clientSecret:'synthetic-value-only'}),ConflictException)
    assert.equal(db.remote,race?1:0);assert.equal(db.connection.mode,'HAWKVIEW_MANAGED');assert.equal(db.writes.length,0)
  }
})
