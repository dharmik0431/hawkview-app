import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { SecretStoreService } from '../secrets/secret-store.service.js'
import { PLATFORM_OWNED } from '../secrets/secret-owner.js'
import { MicrosoftConsentService } from './microsoft-consent.service.js'
import { TenantSyncService } from '../tenants/tenant-sync.service.js'
import { managedSyncTestDatabase } from '../tenants/managed-sync.test-fixtures.js'
import { withManagedAuthority } from './managed-connector-authority.js'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'

const envNames = ['SECRET_ENCRYPTION_KEY', 'SECRET_ENCRYPTION_KEY_VERSION', 'SECRET_ENCRYPTION_KEY_PREVIOUS']
const saved = envNames.map(name => process.env[name])
before(() => { process.env.SECRET_ENCRYPTION_KEY = '35'.repeat(32); delete process.env.SECRET_ENCRYPTION_KEY_VERSION; delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS })
after(() => envNames.forEach((name,i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] }))
const copy = <T>(value:T):T => structuredClone(value)

// SQL is simulated; real capture, publication, AES-GCM and sync functions run.
// Physical serialization/rollback proof remains in the separately gated DB suite.
async function fixture() {
  const tenant = { id: randomUUID(), organizationId: randomUUID(), microsoftTenantId: randomUUID(), status: 'ACTIVE', displayName: null, primaryDomain: null,
    connection: { status: 'CONNECTED', connectionMode: 'HAWKVIEW_MANAGED', clientId: null, credentialReference: null } }
  const owner = { customerTenantId: tenant.id, organizationId: tenant.organizationId,
    token: randomUUID(), generation: 4n, expiresAt: new Date('2030-01-01T00:00:00Z') }
  const world = {
    authority: { configurationRevision: randomUUID(), clientId: randomUUID(), homeTenantId: randomUUID(), credentialReference: '',
      operationId: null as string | null, fingerprint: null as string | null, credentialExpiresAt: new Date('2030-01-01T00:00:00Z') as Date | null },
    secrets: [] as any[], revisions: [] as string[], active: false, trace: [] as string[],
    leases: 0, tokens: 0, collectors: [] as string[], sourceWrites: 0, failAt: '' as string, visitLive: true,
  }
  const db:any = managedSyncTestDatabase({
    syncState: {
      findUnique: async () => { world.leases++; return { id:'users',status:'IDLE',lastSuccessfulAt:new Date('2026-10-01'),deltaLink:null } },
      updateMany: async () => ({count:1}), update: async () => {world.sourceWrites++;return {}},
      findMany: async () => [],
    },
    directoryUser: { upsert: async()=>{throw Error('unexpected user')}, updateMany:async()=>({count:0}) },
    tenantConnection: { update: async()=>({}) },
  },tenant)
  db.encryptedSecret = {
    upsert: async ({create}:any) => { const row={id:randomUUID(),legacyReference:null,...create};world.secrets.push(row);return copy(row) },
    findUnique: async ({where}:any) => copy(world.secrets.find(row => where.id ? row.id===where.id : row.legacyReference===where.legacyReference) ?? null),
  }
  const utcQuery = db.$queryRawUnsafe.bind(db), utcExecute=db.$executeRawUnsafe.bind(db)
  db.$queryRawUnsafe=async(sql:string,...v:any[])=>{
    assert.equal(world.active,true)
    if(sql.includes('pg_advisory_xact_lock')) { assert.deepEqual(v,['hawkview:managed-connector:default:authority:v1']);world.trace.push(sql.includes('_shared')?'G-shared':'G-exclusive');return [{locked:1}] }
    if(sql.includes('/* managed:legacy-secret */')) {
      assert.match(sql,/FOR SHARE OF s/)
      assert.deepEqual(v,world.authority.credentialReference.startsWith('encrypted-secret:')?[world.authority.credentialReference.slice(17),null]:[null,world.authority.credentialReference])
      world.trace.push('legacy-secret-lock')
      const row=world.secrets.find(row=>row.id===v[0] || (v[1]!==null && row.legacyReference===v[1]))
      return row?[{...copy(row),credentialExpiresAt:world.authority.credentialExpiresAt}]:[]
    }
    if(sql.includes('FROM platform_microsoft_connectors'))return [copy(world.authority)]
    if(sql.includes('UNION ALL SELECT revision'))return world.secrets.some(s=>s.id===v[0]||s.name===v[1])||world.revisions.includes(v[0])?[{id:v[0]}]:[]
    if(sql.startsWith('SELECT id FROM organizations')) {
      assert.deepEqual(v,[owner.organizationId]);world.trace.push('organization-lock');return [{id:owner.organizationId}]
    }
    if(sql.startsWith('SELECT id FROM customer_tenants')) {
      assert.deepEqual(v,[owner.customerTenantId,owner.organizationId]);world.trace.push('tenant-lock');return [{id:owner.customerTenantId}]
    }
    if(sql.includes('FROM tenant_sync_visit_leases')) {
      assert.match(sql,/expires_at > clock_timestamp\(\) FOR SHARE/)
      assert.deepEqual(v,[owner.customerTenantId,owner.organizationId,owner.token,'4'])
      world.trace.push('owner-lock');return world.visitLive?[{generation:'4'}]:[]
    }
    return utcQuery(sql,...v)
  }
  db.$executeRawUnsafe=async(sql:string,...v:any[])=>{
    assert.equal(world.active,true)
    if(sql.startsWith('INSERT INTO managed_connector_authority_revisions')){if(!world.revisions.includes(v[0]))world.revisions.push(v[0]);return 1}
    if(sql.startsWith('INSERT INTO encrypted_secrets')){
      world.trace.push('insert-immutable')
      world.secrets.push(copy({id:v[0],name:v[1],ciphertext:v[2],initializationVector:v[3],authenticationTag:v[4],keyVersion:v[5],legacyReference:null}))
      if(world.failAt==='secret')throw Error('injected secret write failure')
      return 1
    }
    if(sql.startsWith('INSERT INTO platform_microsoft_connectors')){
      world.trace.push('publish')
      Object.assign(world.authority,{clientId:v[0],homeTenantId:v[1],credentialReference:v[2],credentialExpiresAt:v[3]===null?null:new Date(v[3]),configurationRevision:v[4],operationId:v[5],fingerprint:v[6]})
      return 1
    }
    return utcExecute(sql,...v)
  }
  db.$transaction=async(work:any)=>{
    assert.equal(world.active,false,'only the real outer transaction may enter the database')
    const before=copy({authority:world.authority,secrets:world.secrets,revisions:world.revisions})
    world.active=true
    try {const value=await work(db);if(world.failAt==='commit'&&world.trace.includes('publish'))throw Error('injected commit failure');return value}
    catch(error){Object.assign(world,before);throw error}finally{world.active=false}
  }
  const secret=new SecretStoreService(db)
  world.authority.credentialReference=await secret.store('hawkview-microsoft-connector-client-secret','synthetic-existing-secret',PLATFORM_OWNED)
  world.revisions.push(world.authority.configurationRevision) // actual additive migration shape
  const consent:any=new MicrosoftConsentService(db,secret)
  consent.getTenantAccessToken=()=>{throw Error('mutable credential fallback forbidden')}
  consent.requestAccessToken=async(tenantId:string,credentials:any)=>{
    assert.equal(world.active,false,'provider must remain outside locks');assert.equal(tenantId,tenant.microsoftTenantId)
    assert.equal(credentials.clientId,world.authority.clientId);assert.equal(credentials.clientSecret,'synthetic-existing-secret')
    world.tokens++;return {accessToken:'synthetic-token'}
  }
  const sync:any=new TenantSyncService(db,consent,{} as any,{resolveIncident:async()=>{},publishIncident:async()=>{throw Error('unexpected notification')}} as any,{} as any,{syncTenant:async()=>[]} as any)
  sync.logger={log(){},warn(){},error(){}}
  sync.fetchGraphPage=async()=>Response.json({value:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/users/delta?synthetic'})
  for(const method of ['syncSignInLogs','syncDirectoryAuditLogs','syncM365AuditActivity'])sync[method]=async()=>{world.collectors.push(method)}
  sync.refreshCollectionFieldStates=async()=>{}
  return {world,db,secret,consent,tenant,owner,
    run:()=>sync.syncConnectedTenant(tenant,false,{incrementalOnly:true,includeBundle:false}),
    runOwned:()=>sync.syncConnectedTenantWithinMemoryLane(tenant,false,{incrementalOnly:true,includeBundle:false,visitOwner:owner})}
}

test('actual owned sync rejects stale legacy promotion before immutable writes, resource claims or provider calls',async()=>{
  const f=await fixture();f.world.visitLive=false
  const before=copy({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions})
  await assert.rejects(f.runOwned,(error:unknown)=>error instanceof TenantVisitLeaseLostError)
  assert.deepEqual({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions},before)
  assert.equal(f.world.tokens,0);assert.equal(f.world.leases,0);assert.equal(f.world.sourceWrites,0)
  assert.deepEqual(f.world.collectors,[])
  assert.deepEqual(f.world.trace.slice(-4),['G-exclusive','organization-lock','tenant-lock','owner-lock'])
  assert.equal(f.world.trace.includes('legacy-secret-lock'),false)
})

test('live owned promotion holds global, organization, tenant and owner order through immutable publication',async()=>{
  const f=await fixture()
  await f.consent.upgradeLegacyManagedConnector(f.owner)
  assert.deepEqual(f.world.trace.slice(0,5),['G-exclusive','organization-lock','tenant-lock','owner-lock','legacy-secret-lock'])
  assert.ok(f.world.trace.indexOf('owner-lock')<f.world.trace.indexOf('insert-immutable'))
  assert.ok(f.world.trace.indexOf('insert-immutable')<f.world.trace.indexOf('publish'))
  const before=copy({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions})
  f.world.visitLive=false
  await assert.rejects(f.consent.upgradeLegacyManagedConnector(f.owner),(error:unknown)=>error instanceof TenantVisitLeaseLostError)
  assert.deepEqual({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions},before)
})

for(const failure of ['secret','commit'])test(`owned promotion rolls back all publication state after ${failure} failure`,async()=>{
  const f=await fixture();f.world.failAt=failure
  const before=copy({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions})
  await assert.rejects(f.consent.upgradeLegacyManagedConnector(f.owner),/injected/)
  assert.deepEqual({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions},before)
  assert.ok(f.world.trace.includes('owner-lock'))
})

test('legacy managed authority from additive migration reaches actual sync only after immutable promotion',async()=>{
  const f=await fixture(),before=copy(f.world.authority),oldSecret=copy(f.world.secrets[0])
  assert.notEqual(before.credentialReference,`encrypted-secret:${before.configurationRevision}`)
  const result=await f.run()
  assert.equal(result.status,'SUCCEEDED');assert.equal(f.world.leases,1);assert.equal(f.world.tokens,1)
  assert.deepEqual(f.world.collectors,['syncSignInLogs','syncDirectoryAuditLogs','syncM365AuditActivity'])
  assert.notEqual(f.world.authority.configurationRevision,before.configurationRevision)
  assert.equal(f.world.authority.credentialReference,`encrypted-secret:${f.world.authority.configurationRevision}`)
  assert.equal(f.world.authority.clientId,before.clientId);assert.equal(f.world.authority.homeTenantId,before.homeTenantId)
  assert.deepEqual(f.world.authority.credentialExpiresAt,before.credentialExpiresAt)
  assert.deepEqual(f.world.secrets[0],oldSecret)
  assert.equal(await f.secret.access(f.world.authority.credentialReference),'synthetic-existing-secret')
  assert.ok(f.world.trace.indexOf('G-exclusive')<f.world.trace.indexOf('legacy-secret-lock'))
  assert.ok(f.world.trace.indexOf('legacy-secret-lock')<f.world.trace.indexOf('publish'))
  assert.deepEqual(await withManagedAuthority(f.db,before.configurationRevision,async()=>{throw Error('old authority retained')}),{status:'superseded'})
})

test('an already promoted authority is reused without another credential or revision write',async()=>{
  const f=await fixture();await f.consent.upgradeLegacyManagedConnector()
  const before=copy({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions})
  f.world.trace=[]
  await f.run()
  assert.equal(f.world.tokens,1);assert.equal(f.world.leases,1)
  assert.deepEqual({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions},before)
  assert.equal(f.world.trace.includes('G-exclusive'),false)
})

test('a migrated legacy external reference uses only the encrypted database row',async()=>{
  const f=await fixture(),reference='projects/synthetic/secrets/connector/versions/latest'
  f.world.secrets[0].legacyReference=reference;f.world.authority.credentialReference=reference
  assert.equal((await f.run()).status,'SUCCEEDED');assert.equal(f.world.tokens,1)
  assert.equal(await f.secret.access(f.world.authority.credentialReference),'synthetic-existing-secret')
})

for (const failure of ['missing','aad','key','published-mismatch','immutable-mismatch','secret','commit'] as const) {
  test(`legacy promotion ${failure} fails closed before sync/provider and preserves authority`,async()=>{
    const f=await fixture()
    if(failure==='missing')f.world.secrets=[]
    if(failure==='aad')f.world.secrets[0].name='different-aad'
    if(failure==='key')f.world.secrets[0].keyVersion=2
    if(failure==='published-mismatch'){f.world.authority.operationId=randomUUID();f.world.authority.fingerprint='a'.repeat(64)}
    if(failure==='immutable-mismatch')f.world.secrets[0].name='hawkview-managed-revision:'+randomUUID()
    if(failure==='secret'||failure==='commit')f.world.failAt=failure
    const before=copy({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions})
    await assert.rejects(f.run)
    assert.equal(f.world.tokens,0);assert.equal(f.world.leases,0);assert.equal(f.world.sourceWrites,0)
    assert.deepEqual(f.world.collectors,[])
    assert.deepEqual({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions},before)
  })
}

test('a second upgrade caller cannot overwrite an already published immutable winner',async()=>{
  const f=await fixture();await f.consent.upgradeLegacyManagedConnector()
  const before=copy({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions})
  await f.consent.upgradeLegacyManagedConnector()
  assert.deepEqual({authority:f.world.authority,secrets:f.world.secrets,revisions:f.world.revisions},before)
})
