import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { publishManagedAuthority, type AuthorityDatabase, type AuthorityTransaction } from './managed-connector-authority.js'
import { issueConsentOperation, claimConsentOperation, finishConsentOperation, CONSENT_CLOCK_SQL,
  CONSENT_ENTRY_PREDICATE, CONSENT_FINAL_PREDICATE, type ConsentOperationKey, type ClaimedConsent } from './consent-operation-store.js'
const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
const success = { outcome:'SUCCEEDED' as const,displayName:'Synthetic tenant',primaryDomain:'fixture.invalid',grantedPermissions:['Directory.Read.All'] }
const failure = { outcome:'FAILED' as const,code:'CONSENT_DENIED' as const }
function gate<T=void>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve} }
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex')

test('consent core composes actual Prisma transactions', {skip,timeout:90000},async t=>{
  const url=assertDisposableTestDatabase()
  const pool=new pg.Pool({connectionString:url.toString(),max:8}),observer=await pool.connect()
  const schema='consent_core_'+randomUUID().replaceAll('-','')
  const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:url.toString(),max:8,options:'-c timezone=America/New_York'},{schema})})
  await observer.query(`CREATE SCHEMA ${schema}`);await observer.query(`SET search_path TO ${schema},public`)
  for(const name of ['customer_tenants','tenant_connections','sync_states','microsoft_consent_attempts',
    'platform_microsoft_connectors','encrypted_secrets','managed_connector_authority_revisions'])
    await observer.query(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`)
  const host=(hook?:(sql:string,pid:number)=>Promise<void>,beforeCommit?:()=>Promise<void>,entered?:(pid:number)=>void):AuthorityDatabase=>({
    async $transaction<T>(work:(tx:AuthorityTransaction)=>Promise<T>) {
      return prisma.$transaction(async actual=>{
        await actual.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`)
        await actual.$executeRawUnsafe("SET LOCAL statement_timeout='8s'")
        const [{pid}]=await actual.$queryRawUnsafe<{pid:number}[]>('SELECT pg_backend_pid() AS pid');entered?.(pid)
        const tx:AuthorityTransaction={
          async $queryRawUnsafe<T>(sql:string,...values:any[]):Promise<T>{const r=await actual.$queryRawUnsafe<T>(sql,...values);await hook?.(sql,pid);return r},
          async $executeRawUnsafe(sql:string,...values:any[]):Promise<number>{const r=await actual.$executeRawUnsafe(sql,...values);await hook?.(sql,pid);return r},
        }
        const result=await work(tx);await beforeCommit?.();return result
      },{isolationLevel:'ReadCommitted',maxWait:10000,timeout:15000})
    },
  })
  const db=host(),organizationId=randomUUID(),customerTenantId=randomUUID(),microsoftTenantId=randomUUID()
  const who={organizationId,customerTenantId,flow:'EXISTING_TENANT' as const}
  let revision=randomUUID()
  const publication=(next:string)=>({expectedRevision:revision,revision:next,operationId:randomUUID(),clientId:randomUUID(),homeTenantId:randomUUID(),credentialExpiresAt:null,
    sealed:{ciphertext:Buffer.from('synthetic'),initializationVector:Buffer.alloc(12),authenticationTag:Buffer.alloc(16),keyVersion:1}})
  const connection=async()=>(await observer.query('SELECT * FROM tenant_connections WHERE customer_tenant_id=$1',[customerTenantId])).rows[0]
  const operation=async(id:string)=>(await observer.query('SELECT * FROM microsoft_consent_attempts WHERE id=$1',[id])).rows[0]
  const authority=async()=>({c:await connection(),t:(await observer.query('SELECT * FROM customer_tenants ORDER BY id')).rows,r:(await observer.query('SELECT * FROM sync_states ORDER BY id')).rows})
  const snapshot=async()=>({a:await authority(),o:(await observer.query('SELECT * FROM microsoft_consent_attempts ORDER BY id')).rows})
  const issueInput=async()=>({...who,microsoftTenantId,configurationRevision:revision,expectedConnectionIncarnation:(await connection()).collection_incarnation as string|null,stateHash:hash()})
  const issue=async(database=db)=>{const r=await issueConsentOperation(database,await issueInput());assert.equal(r.status,'issued');if(r.status!=='issued')throw Error('issue');return r}
  const claim=async(k:ConsentOperationKey,database=db)=>{const r=await claimConsentOperation(database,k);assert.equal(r.status,'claimed');if(r.status!=='claimed')throw Error('claim');return r.context}
  const ready=async()=>claim((await issue()).operation)
  const waitBlocked=async(pid:number)=>{
    const end=Date.now()+4000
    while(Date.now()<end){if((await observer.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])).rows[0].n>0)return;await new Promise(r=>setTimeout(r,5))}
    assert.fail('expected blocked backend '+pid)
  }
  // Shift the entire trusted time tuple; preserve the fixed durations enforced by the migration.
  const expireFinal=async(id:string,client=observer)=>client.query(`WITH s AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS d)
    UPDATE microsoft_consent_attempts SET created_at=d-interval '7 minutes',expires_at=d+interval '8 minutes',
    operation_claimed_at=d-interval '6 minutes',consumed_at=d-interval '6 minutes',operation_final_deadline=d-interval '1 minute'
    FROM s WHERE id=$1`,[id])
  try {
    await observer.query("INSERT INTO customer_tenants(id,organization_id,microsoft_tenant_id,status,updated_at) VALUES($1,$2,$3,'ACTIVE',now())",[customerTenantId,organizationId,microsoftTenantId])
    await observer.query("INSERT INTO tenant_connections(id,organization_id,customer_tenant_id,status,updated_at) VALUES($1,$2,$3,'CONNECTED',now())",[randomUUID(),organizationId,customerTenantId])
    await observer.query("INSERT INTO sync_states(id,organization_id,customer_tenant_id,resource_type,updated_at) VALUES($1,$2,$3,'DIRECTORY_ROLES',now())",[randomUUID(),organizationId,customerTenantId])
    assert.equal((await publishManagedAuthority(db,{...publication(revision),expectedRevision:null})).status,'published')
    await t.test('issuance stores exact context, rotates connection and invalidates only running role fields',async()=>{
      const oldScope=randomUUID(),oldConnection=randomUUID(),attempt=randomUUID()
      await observer.query(`UPDATE sync_states SET role_scope_version=1,role_scope_incarnation=$1,role_complete_id=$2,
        role_complete_connection=$3,role_complete_configuration=$4,role_complete_scope=$1,role_complete_scope_version=1,
        role_complete_microsoft_tenant_id=$5,role_complete_checked_at=date_trunc('milliseconds',now()),role_complete_digest=$6,role_complete_count=0`,
        [oldScope,attempt,oldConnection,revision,microsoftTenantId,hash()])
      await observer.query(`UPDATE sync_states SET role_attempt_id=$1,role_attempt_connection=$2,role_attempt_configuration=$3,
        role_attempt_scope=role_scope_incarnation,role_attempt_started_at=date_trunc('milliseconds',now()),
        role_attempt_expires_at=now()+interval '5 minutes',role_attempt_outcome='RUNNING',status='RUNNING'`,[randomUUID(),oldConnection,revision])
      const prior=await authority(),r=await issue(),o=await operation(r.operation.operationId),after=await authority()
      assert.equal(o.operation_version,1);assert.equal(o.operation_state,'ISSUED');assert.equal(o.expected_configuration,revision)
      assert.equal(o.expected_connection,r.connectionIncarnation);assert.equal(o.expected_microsoft_tenant,microsoftTenantId)
      assert.equal(o.expected_credential_reference,'encrypted-secret:'+revision)
      assert.equal(after.c.status,'PENDING_CONSENT');assert.notEqual(after.c.collection_incarnation,prior.c.collection_incarnation)
      assert.equal(after.r[0].role_complete_id,attempt);assert.equal(after.r[0].role_attempt_id,null)
      assert.equal(+o.expires_at- +o.created_at,900000)
      const typed=await prisma.microsoftConsentAttempt.findUnique({where:{id:o.id}});assert.equal(typed?.operationVersion,1)
    })
    await t.test('concurrent issuance accepts one expected incarnation; nonce collision does not rotate',async()=>{
      const input=await issueInput(),results=await Promise.all([issueConsentOperation(db,input),issueConsentOperation(db,{...input,stateHash:hash()})])
      assert.equal(results.filter(r=>r.status==='issued').length,1)
      const winner=results.find(r=>r.status==='issued')!;if(winner.status!=='issued')throw Error('issue')
      const before=await snapshot();assert.deepEqual(await issueConsentOperation(db,{...await issueInput(),stateHash:winner.operation.stateHash}),{status:'rejected',reason:'CONFLICT'})
      assert.deepEqual(await snapshot(),before)
    })
    await t.test('claim race has one owner; duplicate cannot refresh deadline; stored context is returned',async()=>{
      const r=await issue(),results=await Promise.all([claimConsentOperation(db,r.operation),claimConsentOperation(db,r.operation)])
      assert.equal(results.filter(r=>r.status==='claimed').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason==='BUSY').length,1)
      const o=await operation(r.operation.operationId),before=await snapshot();assert.equal(+o.operation_final_deadline- +o.operation_claimed_at,300000)
      assert.deepEqual(await claimConsentOperation(db,r.operation),{status:'rejected',reason:'BUSY'});assert.deepEqual(await snapshot(),before)
      const winner=results.find(r=>r.status==='claimed')!;if(winner.status!=='claimed')throw Error('claim')
      assert.equal(winner.context.configurationRevision,revision);assert.equal(winner.context.connectionIncarnation,r.connectionIncarnation)
    })
    await t.test('scope, nonce, operation and claim substitutions leave every row unchanged',async()=>{
      const a=await ready(),before=await snapshot()
      for(const wrong of [{...a,organizationId:randomUUID()},{...a,customerTenantId:randomUUID()},{...a,stateHash:hash()},{...a,operationId:randomUUID()}]) {
        assert.equal((await claimConsentOperation(db,wrong)).status,'rejected');assert.equal((await finishConsentOperation(db,wrong,success)).status,'rejected')
      }
      assert.deepEqual(await finishConsentOperation(db,{...a,claimId:randomUUID()},failure),{status:'rejected',reason:'UNTRUSTED'})
      assert.deepEqual(await snapshot(),before)
    })
    await t.test('entry expiry and near-expiry claim use independent final deadline',async()=>{
      const r=await issue()
      await observer.query("WITH s AS (SELECT date_trunc('milliseconds',clock_timestamp()-interval '16 minutes') AS d) UPDATE microsoft_consent_attempts SET created_at=d,expires_at=d+interval '15 minutes' FROM s WHERE id=$1",[r.operation.operationId])
      const before=await authority(),expired=await claimConsentOperation(db,r.operation);assert.equal(expired.status,'terminal');if(expired.status==='terminal')assert.equal(expired.result.state,'EXPIRED');assert.deepEqual(await authority(),before)
      const b=await issue();await observer.query("WITH s AS (SELECT date_trunc('milliseconds',clock_timestamp()-interval '14 minutes 59 seconds') AS d) UPDATE microsoft_consent_attempts SET created_at=d,expires_at=d+interval '15 minutes' FROM s WHERE id=$1",[b.operation.operationId])
      const claimed=await claim(b.operation),o=await operation(b.operation.operationId)
      assert.equal(+claimed.finalDeadline- +claimed.claimedAt,300000);assert.ok(+claimed.finalDeadline>+o.expires_at);assert.equal(claimed.finalDeadline.toISOString(),o.operation_final_deadline.toISOString())
      assert.equal((await prisma.$queryRawUnsafe<{zone:string}[]>("SELECT current_setting('TimeZone') AS zone"))[0].zone,'America/New_York')
      assert.equal((await finishConsentOperation(db,claimed,success)).status,'applied')
    })
    for(const value of [success,failure])await t.test('terminal '+value.outcome+' atomically rotates and replays without overwriting newer state',async()=>{
      const a=await ready(),first=await finishConsentOperation(db,a,value);assert.equal(first.status,'applied')
      const c=await connection();assert.equal(c.status,value.outcome==='SUCCEEDED'?'CONNECTED':'ERROR');assert.notEqual(c.collection_incarnation,a.connectionIncarnation)
      const b=await ready(),before=await snapshot();assert.equal((await finishConsentOperation(db,a,value)).status,'replayed');assert.deepEqual(await snapshot(),before)
      assert.equal((await finishConsentOperation(db,a,value.outcome==='SUCCEEDED'?failure:success)).status,'rejected');assert.deepEqual(await snapshot(),before)
      assert.equal((await finishConsentOperation(db,b,success)).status,'applied')
    })
    await t.test('competing terminal outcomes have one commit and no last-writer overwrite',async()=>{
      const a=await ready(),r=await Promise.all([finishConsentOperation(db,a,success),finishConsentOperation(db,a,failure)])
      assert.equal(r.filter(x=>x.status==='applied').length,1);assert.equal(r.filter(x=>x.status==='rejected'&&x.reason==='CONFLICT').length,1)
    })
    for(const value of [success,failure])for(const mutation of ['connection','status','configuration','mode','client','home','credential','tenant','revoked'])await t.test('stale '+value.outcome+' after '+mutation+' preserves newer authority',async()=>{
      const a=await ready()
      if(mutation==='configuration'){const next=randomUUID();assert.equal((await publishManagedAuthority(db,publication(next))).status,'published');revision=next}
      if(mutation==='connection')await observer.query("UPDATE tenant_connections SET collection_incarnation=$1",[randomUUID()])
      if(mutation==='status')await observer.query("UPDATE tenant_connections SET status='CONNECTED'")
      if(mutation==='mode')await observer.query("UPDATE tenant_connections SET connection_mode='CUSTOMER_MANAGED',client_id=gen_random_uuid(),credential_reference='synthetic-customer'")
      if(mutation==='revoked')await observer.query("UPDATE tenant_connections SET status='REVOKED'")
      if(mutation==='tenant')await observer.query("UPDATE customer_tenants SET microsoft_tenant_id=$1",[randomUUID()])
      const global=(await observer.query('SELECT * FROM platform_microsoft_connectors')).rows[0]
      if(mutation==='client')await observer.query('UPDATE platform_microsoft_connectors SET client_id=$1',[randomUUID()])
      if(mutation==='home')await observer.query('UPDATE platform_microsoft_connectors SET home_tenant_id=$1',[randomUUID()])
      if(mutation==='credential')await observer.query("UPDATE platform_microsoft_connectors SET credential_reference='legacy-fixture'")
      const before=await authority();assert.equal((await finishConsentOperation(db,a,value)).status,'superseded');assert.deepEqual(await authority(),before)
      assert.equal((await operation(a.operationId)).operation_state,'SUPERSEDED')
      await observer.query("UPDATE tenant_connections SET connection_mode='HAWKVIEW_MANAGED',status='CONNECTED'")
      await observer.query('UPDATE customer_tenants SET microsoft_tenant_id=$1',[microsoftTenantId])
      await observer.query('UPDATE platform_microsoft_connectors SET client_id=$1,home_tenant_id=$2,credential_reference=$3',[global.client_id,global.home_tenant_id,global.credential_reference])
    })
    await t.test('issuance rejects customer managed, disconnected, stale revision and mutable legacy secret',async()=>{
      const input=await issueInput();await observer.query("UPDATE tenant_connections SET connection_mode='CUSTOMER_MANAGED',client_id=gen_random_uuid(),credential_reference='synthetic-customer'");let before=await snapshot()
      assert.equal((await issueConsentOperation(db,input)).status,'rejected');assert.deepEqual(await snapshot(),before)
      await observer.query("UPDATE tenant_connections SET connection_mode='HAWKVIEW_MANAGED'");await observer.query("UPDATE customer_tenants SET status='DISCONNECTED'");before=await snapshot()
      assert.equal((await issueConsentOperation(db,input)).status,'rejected');assert.deepEqual(await snapshot(),before)
      await observer.query("UPDATE customer_tenants SET status='ACTIVE'");before=await snapshot()
      assert.equal((await issueConsentOperation(db,{...input,configurationRevision:randomUUID()})).status,'rejected');assert.deepEqual(await snapshot(),before)
      await observer.query("UPDATE platform_microsoft_connectors SET credential_reference='legacy-fixture'");before=await snapshot()
      assert.deepEqual(await issueConsentOperation(db,input),{status:'rejected',reason:'UNTRUSTED'});assert.deepEqual(await snapshot(),before)
      await observer.query('UPDATE platform_microsoft_connectors SET credential_reference=$1',['encrypted-secret:'+revision])
    })
    for(const phase of ['issue','finish'] as const)for(const point of ['operation','connection','roles','tenant','commit']) {
      if(phase==='issue'&&point==='tenant')continue
      await t.test(phase+' rollback after '+point+' leaves complete observer snapshot intact',async()=>{
        const a=phase==='finish'?await ready():null,input=await issueInput(),before=await snapshot()
        let commits=0
        const fail=async()=>{throw Error('injected '+point)}
        const broken=host(async sql=>{
          if((point==='operation'&&((phase==='issue'&&sql.includes('INSERT INTO microsoft_consent_attempts'))||(phase==='finish'&&sql.includes('SET operation_state=$2'))))||
            (point==='connection'&&sql.includes('UPDATE tenant_connections'))||(point==='roles'&&sql.includes('UPDATE sync_states'))||(point==='tenant'&&sql.includes('UPDATE customer_tenants')))await fail()
        },point==='commit'?async()=>{commits++;if(phase==='issue'||commits===2)await fail()}:undefined)
        await assert.rejects(a?finishConsentOperation(broken,a,success):issueConsentOperation(broken,input),/injected/);assert.deepEqual(await snapshot(),before)
      })
    }
    await t.test('observer cannot see partial terminal writes; caller result is copied before waiting',async()=>{
      const a=await ready(),before=await snapshot(),entered=gate(),release=gate();let commits=0
      const prepared={...success,grantedPermissions:[...success.grantedPermissions]},original=a.claimId
      const pending=finishConsentOperation(host(undefined,async()=>{commits++;if(commits===2){entered.resolve();await release.promise}}),a,prepared)
      await entered.promise
      try { assert.deepEqual(await snapshot(),before);prepared.displayName='mutated';prepared.grantedPermissions.push('Injected.Permission');a.claimId=randomUUID() }
      finally {release.resolve()}
      assert.equal((await pending).status,'applied');assert.equal((await operation(a.operationId)).operation_claim_id,original)
      assert.equal((await authority()).t[0].display_name,success.displayName);assert.deepEqual((await connection()).consented_permissions,success.grantedPermissions)
    })
    await t.test('raw deadline predicates reject equality and submillisecond overrun',async()=>{
      for(const predicate of [CONSENT_ENTRY_PREDICATE,CONSENT_FINAL_PREDICATE])for(const fraction of ['001000','001500'])for(const delta of [-1,0,1]) {
        const q=await observer.query(`SELECT (${predicate}) AS live FROM (SELECT '2030-01-01T00:00:00.${fraction}Z'::timestamptz + $1::integer * interval '1 microsecond' AS sampled_at,
          '2030-01-01T00:00:00.${fraction}Z'::timestamptz AS expires_at,'2030-01-01T00:00:00.${fraction}Z'::timestamptz AS operation_final_deadline) s`,[delta])
        assert.equal(q.rows[0].live,delta===-1)
      }
      assert.ok(CONSENT_CLOCK_SQL.includes(CONSENT_ENTRY_PREDICATE));assert.ok(CONSENT_CLOCK_SQL.includes(CONSENT_FINAL_PREDICATE))
    })
    for(const point of ['G','T','C','R','O'])await t.test('final clock occurs after actual '+point+' lock wait',async()=>{
      const a=await ready(),client=await pool.connect(),pid=gate<number>();let seen=false,transactions=0
      // Fixed duration with a near-future deadline; all values originate in one sampled DB instant.
      await observer.query(`WITH s AS (SELECT date_trunc('milliseconds',clock_timestamp()+interval '250 milliseconds') AS d)
        UPDATE microsoft_consent_attempts SET created_at=d-interval '6 minutes',expires_at=d+interval '9 minutes',
        operation_claimed_at=d-interval '5 minutes',consumed_at=d-interval '5 minutes',operation_final_deadline=d FROM s WHERE id=$1`,[a.operationId])
      try {
        await client.query('BEGIN');await client.query(`SET LOCAL search_path TO ${schema},public`)
        if(point==='G')await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['hawkview:managed-connector:default:authority:v1'])
        if(point==='T')await client.query('SELECT id FROM customer_tenants FOR UPDATE')
        if(point==='C')await client.query('SELECT id FROM tenant_connections FOR UPDATE')
        if(point==='R')await client.query('SELECT id FROM sync_states FOR UPDATE')
        if(point==='O')await client.query('SELECT id FROM microsoft_consent_attempts WHERE id=$1 FOR UPDATE',[a.operationId])
        const before=await authority(),pending=finishConsentOperation(host(async(sql,p)=>{if(!seen&&sql.includes('pg_advisory_xact_lock_shared')){seen=true;pid.resolve(p)}},undefined,p=>{transactions++;if(point==='G'&&transactions===2&&!seen){seen=true;pid.resolve(p)}}),a,success)
        // Observe the authority transaction, after the separate initial context read.
        await waitBlocked(await pid.promise)
        const end=Date.now()+4000;let due=false
        while(Date.now()<end){due=(await observer.query('SELECT clock_timestamp()>=operation_final_deadline AS due FROM microsoft_consent_attempts WHERE id=$1',[a.operationId])).rows[0].due;if(due)break;await new Promise(r=>setTimeout(r,5))}
        assert.ok(due);await client.query('COMMIT');assert.equal((await pending).status,'expired');assert.deepEqual(await authority(),before)
      }finally{await client.query('ROLLBACK');client.release()}
    })
    await t.test('entry clock occurs after operation row wait and claim holds no global lock',async()=>{
      const r=await issue(),client=await pool.connect(),pid=gate<number>()
      try {
        await client.query('BEGIN');await client.query(`SET LOCAL search_path TO ${schema},public`)
        await client.query('SELECT id FROM microsoft_consent_attempts WHERE id=$1 FOR UPDATE',[r.operation.operationId])
        const pending=claimConsentOperation(host(undefined,undefined,pid.resolve),r.operation)
        await waitBlocked(await pid.promise)
        const next=randomUUID();assert.equal((await publishManagedAuthority(db,publication(next))).status,'published');revision=next
        await client.query("WITH s AS (SELECT date_trunc('milliseconds',clock_timestamp()-interval '16 minutes') AS d) UPDATE microsoft_consent_attempts SET created_at=d,expires_at=d+interval '15 minutes' FROM s WHERE id=$1",[r.operation.operationId])
        await client.query('COMMIT');const expired=await pending;assert.equal(expired.status,'terminal');if(expired.status==='terminal')assert.equal(expired.result.state,'EXPIRED')
      }finally{await client.query('ROLLBACK');client.release()}
    })
    await t.test('configuration short circuit terminalizes only owned operation in O-only transaction',async()=>{
      const a=await ready(),next=randomUUID();await publishManagedAuthority(db,publication(next));revision=next
      const traces:string[][]=[];const tracked:AuthorityDatabase={$transaction:async(work,options)=>{
        const list:string[]=[];traces.push(list);return host(async sql=>{list.push(sql)}).$transaction(work,options)
      }}
      const before=await authority();assert.equal((await finishConsentOperation(tracked,a,failure)).status,'superseded');assert.deepEqual(await authority(),before)
      assert.equal(traces.length,3);assert.ok(traces[1].some(s=>s.includes('pg_advisory_xact_lock_shared')))
      assert.ok(traces[2].some(s=>s.includes('FOR UPDATE')));assert.ok(traces[2].every(s=>!s.includes('pg_advisory')&&!s.includes('tenant_connections')&&!s.includes('sync_states')))
    })
    await t.test('expired claimed operation cannot be completed or expired by another claim owner',async()=>{
      const a=await ready();await expireFinal(a.operationId);const before=await snapshot()
      assert.deepEqual(await finishConsentOperation(db,{...a,claimId:randomUUID()},failure),{status:'rejected',reason:'UNTRUSTED'});assert.deepEqual(await snapshot(),before)
      assert.equal((await finishConsentOperation(db,a,failure)).status,'expired');assert.deepEqual(await authority(),before.a)
    })
    await t.test('legacy attempts remain untrusted even with success-looking old fields; direct impossible tuples reject',async()=>{
      const id=randomUUID(),stateHash=hash();await observer.query(`INSERT INTO microsoft_consent_attempts(id,organization_id,customer_tenant_id,flow,state_hash,expires_at,consumed_at,result_code)
        VALUES($1,$2,$3,'EXISTING_TENANT',$4,now()+interval '1 hour',now(),'CONNECTED')`,[id,organizationId,customerTenantId,stateHash])
      const before=await snapshot();assert.deepEqual(await claimConsentOperation(db,{...who,operationId:id,stateHash}),{status:'rejected',reason:'UNTRUSTED'});assert.deepEqual(await snapshot(),before)
      const a=await ready()
      for(const change of ["operation_version=NULL","expected_client_id=NULL","operation_claim_id=NULL","operation_final_deadline=operation_final_deadline+interval '1 millisecond'","operation_state='SUCCEEDED'","expected_credential_reference='mutable'","flow='DISCOVER_TENANT'","consumed_at=NULL"])
        await assert.rejects(observer.query(`UPDATE microsoft_consent_attempts SET ${change} WHERE id=$1`,[a.operationId]),/consent_operation_shape/)
    })
  }finally{await prisma.$disconnect();await observer.query(`DROP SCHEMA ${schema} CASCADE`);observer.release();await pool.end()}
})

test('additive migration preserves legacy rows, unique nonce and rolls back atomically', {skip,timeout:30000},async()=>{
  const url=assertDisposableTestDatabase(),client=new pg.Client({connectionString:url.toString()}),schema='consent_upgrade_'+randomUUID().replaceAll('-','')
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`)
    await client.query('CREATE TABLE microsoft_consent_attempts (LIKE public.microsoft_consent_attempts INCLUDING ALL)')
    const added=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND (column_name LIKE 'operation_%' OR column_name LIKE 'expected_%')",[schema])).rows
    for(const c of added)await client.query(`ALTER TABLE microsoft_consent_attempts DROP COLUMN ${c.column_name} CASCADE`)
    const org=randomUUID(),tenant=randomUUID()
    for(const code of [null,'CONNECTED','CONSENT_DENIED'])await client.query(`INSERT INTO microsoft_consent_attempts(id,organization_id,customer_tenant_id,flow,state_hash,expires_at,consumed_at,result_code)
      VALUES($1,$2,$3,'EXISTING_TENANT',$4,now()-interval '1 minute',CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,$5)`,[randomUUID(),org,tenant,hash(),code])
    const before=(await client.query('SELECT * FROM microsoft_consent_attempts ORDER BY id')).rows
    const migration=await readFile(new URL('../../prisma/migrations/20261003020000_consent_operation_core/migration.sql',import.meta.url),'utf8')
    await client.query(migration.replace('COMMIT;','ROLLBACK;'))
    assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND column_name='operation_version'",[schema])).rows[0].n,0)
    await client.query(migration)
    const after=(await client.query('SELECT * FROM microsoft_consent_attempts ORDER BY id')).rows
    assert.deepEqual(after.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!added.some(c=>c.column_name===key)))),before)
    for(const row of after)for(const c of added)assert.equal(row[c.column_name],null)
    await assert.rejects(client.query(`INSERT INTO microsoft_consent_attempts(id,organization_id,customer_tenant_id,flow,state_hash,expires_at) VALUES($1,$2,$3,'EXISTING_TENANT',$4,now())`,[randomUUID(),org,tenant,before[0].state_hash]),/unique/)
    const constraints=(await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.microsoft_consent_attempts'::regclass")).rows.map(r=>r.definition).join('\n')
    assert.match(constraints,/FOREIGN KEY \(customer_tenant_id, organization_id\)/);assert.match((await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='microsoft_consent_attempts'")).rows.map(r=>r.indexdef).join('\n'),/UNIQUE INDEX[^\n]+\(state_hash\)/)
  }finally{await client.query('ROLLBACK');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end()}
})
