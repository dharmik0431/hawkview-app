import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { WrappedRiskPseudonymProvider, createPilotPseudonymProvider } from './pilot-pseudonym-provider.js'
import { MailboxRiskProjector, MAILBOX_FIRST_SLICE_FLAGS } from './mailbox-risk-projector.service.js'
import { MailboxInvestigationResolver } from './mailbox-investigation-resolver.js'
import { IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { mailboxRule } from './mailbox-risk.test-fixtures.js'
import { MAILBOX_SOURCE_RESOURCES, MAILBOX_SOURCE_VERSION, mailboxSourceDigest, sourceAttestationKey } from './mailbox-source-attestation.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'
import { approvedIdentitySignalDetectors } from './identity-risk-approved-evaluator.adapter.js'

test('wrapped pilot real DB races, constraints, collection-to-finding-to-mailbox, rotation/revocation/deletion/replay',
  { skip:process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS!=='1',timeout:45000 },async()=>{
    const url=new URL(process.env.DATABASE_URL??'')
    assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Disposable local database only')
    const client=new pg.Client({connectionString:url.toString()});await client.connect()
    const prisma=new PrismaService();await prisma.$connect()
    const scope={organizationId:randomUUID(),customerTenantId:randomUUID(),environment:'synthetic'}
    const config={HAWKVIEW_IDENTITY_RISK_MODE:'shadow',HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:scope.environment,HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-pilot-v1',
      SECRET_ENCRYPTION_KEY:'52'.repeat(32),HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:JSON.stringify({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,expiresAt:new Date(Date.now()+3600000).toISOString()})}
    const previous=Object.fromEntries(Object.keys(config).map(name=>[name,process.env[name]]));Object.assign(process.env,config)
    const store=new WrappedRiskKeyStore();const provider=new WrappedRiskPseudonymProvider(store)
    const deadline=()=>Date.now()+15000
    try {
      await prisma.organization.create({data:{id:scope.organizationId,name:'Synthetic wrapped pilot',slug:`synthetic-${scope.organizationId}`}})
      await prisma.customerTenant.create({data:{id:scope.customerTenantId,organizationId:scope.organizationId,microsoftTenantId:randomUUID(),displayName:'Synthetic mailbox pilot'}})
      // Finish all callers before assertions/fixture cleanup, including failures.
      const outcomes=await Promise.allSettled(Array.from({length:4},()=>store.createVersion(scope,randomUUID(),deadline())))
      assert.ok(outcomes.every(result=>result.status==='fulfilled'),'Every concurrent caller must reload the winner')
      const keys=outcomes.map(result=>{assert.equal(result.status,'fulfilled');return result.value})
      assert.equal(new Set(keys.map(k=>k.id)).size,1,'Concurrent losers reload committed winner, not overwrite')
      const key=keys[0]!
      assert.equal((await client.query('SELECT count(*) FROM identity_risk_wrapped_keys WHERE key_version_id=$1',[key.id])).rows[0].count,'1')
      const original=(await client.query('SELECT * FROM identity_risk_wrapped_keys WHERE key_version_id=$1',[key.id])).rows[0]
      await assert.rejects(()=>client.query('UPDATE identity_risk_wrapped_keys SET ciphertext=$2 WHERE key_version_id=$1',[key.id,Buffer.alloc(32)]),/immutable/)
      const session=await provider.pin(key,deadline());const mailboxId=randomUUID()
      const subjectId=await session.reference('mailbox',[mailboxId]);session.close?.()
      await assert.rejects(()=>store.ciphertext({...key,organizationId:randomUUID()},deadline()),/KEY_UNAVAILABLE/)
      const now=new Date();const rules=[mailboxRule(undefined,{mailboxUserId:mailboxId})]
      for(const resource of MAILBOX_SOURCE_RESOURCES){
        const payload=resource==='EXCHANGE_MAILBOX_RULES'?rules:[{domain:'tenant.invalid'}]
        await prisma.tenantEntraSnapshot.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:resource,payload:payload as never,observedAt:now}})
        await prisma.tenantCollectionFieldState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,fieldKey:sourceAttestationKey(resource),state:'COMPLETE',source:MAILBOX_SOURCE_VERSION,correlationId:mailboxSourceDigest(scope,resource,now,payload),lastSuccessfulAt:now}})
        await prisma.syncState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:resource,status:'SUCCEEDED',lastAttemptAt:now,lastSuccessfulAt:now}})
      }
      await prisma.tenantEntraSnapshot.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:'EXCHANGE_MAILBOXES',payload:[{id:mailboxId,mail:'synthetic@tenant.invalid'}],observedAt:now}})
      await prisma.syncState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:'EXCHANGE_MAILBOXES',status:'SUCCEEDED',lastAttemptAt:now,lastSuccessfulAt:now}})
      const batch=await new MailboxRiskProjector(createPilotPseudonymProvider()).load({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId},now)
      assert.equal(batch.capability,'FULL');assert.equal(batch.pseudonymKeyVersionId,key.id)
      const result=await new IdentityRiskEvaluatorService(prisma,new IdentityRiskSafetyService(prisma),{now:()=>now}).evaluate({...scope,evaluationAt:now,windowStart:new Date(now.getTime()-86400000),windowEnd:now,
        engineVersion:IDENTITY_RISK_ENGINE_VERSION,catalogVersion:IDENTITY_RISK_CATALOG_VERSION,loadSources:async()=>batch,detectors:approvedIdentitySignalDetectors({readiness:'READY',featureFlags:MAILBOX_FIRST_SLICE_FLAGS})})
      assert.equal(result.status,'COMPLETED')
      assert.equal(await prisma.identityRiskFinding.count({where:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId}}),1)
      const resolver=new MailboxInvestigationResolver(createPilotPseudonymProvider())
      const finding={subjectId,pseudonymKeyVersionId:key.id,sourceObservedAt:now}
      assert.deepEqual(await resolver.resolve(scope,finding,now),{status:'AVAILABLE',mailboxId,label:'synthetic@tenant.invalid',observedAt:now.toISOString()})
      assert.equal((await resolver.resolve({...scope,organizationId:randomUUID()},finding,now)).status,'UNAVAILABLE')
      assert.equal((await resolver.resolve(scope,finding,new Date(now.getTime()+36*3600000+1))).status,'UNAVAILABLE')
      await store.retireOrDestroy(key,false,deadline())
      await assert.rejects(()=>provider.pin(key,deadline()),/KEY_UNAVAILABLE/)
      await assert.rejects(()=>client.query("UPDATE identity_risk_pseudonym_key_versions SET status='ACTIVE' WHERE id=$1",[key.id]),/cannot be reactivated/)
      const rotated=await store.createVersion(scope,randomUUID(),deadline())
      assert.notEqual(rotated.id,key.id)
      const newSession=await provider.pin(rotated,deadline());assert.notEqual(await newSession.reference('mailbox',[mailboxId]),subjectId);newSession.close?.()
      assert.equal((await resolver.resolve(scope,finding,now)).status,'UNAVAILABLE','Old finding is never silently reidentified with rotated key')
      await store.retireOrDestroy(key,true,deadline())
      await assert.rejects(()=>client.query('INSERT INTO identity_risk_wrapped_keys(key_version_id,name,ciphertext,iv,tag) VALUES($1,$2,$3,$4,$5)',[key.id,original.name,original.ciphertext,original.iv,original.tag]),/scope unavailable/)
      assert.equal((await client.query('SELECT destroyed_at FROM identity_risk_pseudonym_key_versions WHERE id=$1',[key.id])).rows[0].destroyed_at instanceof Date,true)
      const evidence=await client.query('SELECT kind,correlation_id,expires_at,bucket FROM identity_risk_key_events WHERE key_version_id=$1',[key.id])
      assert.ok(evidence.rows.some(r=>r.kind==='DESTROYED'))
      assert.ok(evidence.rows.every(r=>r.expires_at.getTime()-r.bucket.getTime()===90*86400000))
      assert.doesNotMatch(JSON.stringify(evidence.rows),/synthetic@tenant|ciphertext|SECRET_ENCRYPTION_KEY/)
      await client.query(`INSERT INTO identity_risk_key_events(key_version_id,kind,bucket,correlation_id,expires_at)
        VALUES($1,'SESSION_FAILED',date_trunc('minute',CURRENT_TIMESTAMP)-INTERVAL '91 days',$2,date_trunc('minute',CURRENT_TIMESTAMP)-INTERVAL '1 day')`,[key.id,randomUUID()])
      assert.equal(await store.pruneExpired(scope,deadline()),1,'Expired evidence pruned even for retired/destroyed version')
      await assert.rejects(()=>store.pruneExpired({...scope,customerTenantId:randomUUID()},deadline()),/KEY_UNAVAILABLE/)
      assert.ok((await client.query('SELECT kind FROM identity_risk_key_events WHERE key_version_id=$1',[key.id])).rows.length>0,'Unexpired events retained')
      // Bounds are DB-enforced, not only application validation.
      await assert.rejects(()=>client.query('INSERT INTO identity_risk_wrapped_keys(key_version_id,name,ciphertext,iv,tag) VALUES($1,$2,$3,$4,$5)',[rotated.id,'arbitrary-ref',Buffer.alloc(31),Buffer.alloc(12),Buffer.alloc(16)]))
      delete process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE
      assert.equal(createPilotPseudonymProvider().configured,false)
    } finally {
      await prisma.organization.deleteMany({where:{id:scope.organizationId}})
      await prisma.$disconnect();await client.end()
      for(const[name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value}
    }
  })

test('older BEGIN can reload a later-started committed winner without accepting future activation',
  {skip:process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS!=='1',timeout:30000},async()=>{
    const url=new URL(process.env.DATABASE_URL??'')
    assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Disposable local database only')
    const client=new pg.Client({connectionString:url.toString()});await client.connect()
    const prisma=new PrismaService();await prisma.$connect()
    const scope={organizationId:randomUUID(),customerTenantId:randomUUID(),environment:'synthetic'}
    const config={HAWKVIEW_IDENTITY_RISK_MODE:'shadow',HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:scope.environment,
      HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-pilot-v1',SECRET_ENCRYPTION_KEY:'52'.repeat(32),
      HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:JSON.stringify({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,
        expiresAt:new Date(Date.now()+3600000).toISOString()})}
    const previous=Object.fromEntries(Object.keys(config).map(name=>[name,process.env[name]]));Object.assign(process.env,config)
    const originalQuery=pg.Client.prototype.query
    let releaseOlder!:()=>void;let markPaused!:()=>void
    const resume=new Promise<void>(resolve=>{releaseOlder=resolve})
    const paused=new Promise<void>(resolve=>{markPaused=resolve})
    let intercepted=false;let olderStarted=''
    const pending:Array<Promise<unknown>>=[]
    try{
      await prisma.organization.create({data:{id:scope.organizationId,name:'Synthetic activation race',slug:`synthetic-${scope.organizationId}`}})
      await prisma.customerTenant.create({data:{id:scope.customerTenantId,organizationId:scope.organizationId,
        microsoftTenantId:randomUUID(),displayName:'Synthetic activation race'}})
      const scopeLock=`risk-key:${scope.environment}:${scope.organizationId}:${scope.customerTenantId}`
      pg.Client.prototype.query=function(this:pg.Client,...args:unknown[]){
        if(!intercepted&&args[0]==='SELECT pg_advisory_xact_lock(hashtext($1))'&&Array.isArray(args[1])&&args[1][0]===scopeLock){
          intercepted=true
          return (async()=>{
            const clock=await Reflect.apply(originalQuery,this,['SELECT CURRENT_TIMESTAMP::text AS started'])
            olderStarted=clock.rows[0].started
            markPaused();await resume
            return Reflect.apply(originalQuery,this,args)
          })()
        }
        return Reflect.apply(originalQuery,this,args)
      } as typeof originalQuery
      const store=new WrappedRiskKeyStore()
      const older=store.createVersion(scope,randomUUID(),Date.now()+15000);pending.push(older)
      // Reject-safe join releases the barrier even if setup fails before pausing.
      await Promise.race([paused,older.then(()=>{throw new Error('Expected older transaction barrier')})])
      const newer=store.createVersion(scope,randomUUID(),Date.now()+15000);pending.push(newer)
      const winner=await newer
      const clockOrder=await client.query('SELECT activated_at>$2::timestamptz AS later FROM identity_risk_pseudonym_key_versions WHERE id=$1',[winner.id,olderStarted])
      assert.equal(clockOrder.rows[0].later,true,'Winner transaction started after waiting caller')
      releaseOlder()
      const results=await Promise.allSettled([older,newer])
      assert.ok(results.every(result=>result.status==='fulfilled'),'Both transaction orderings must load the same active key')
      const keys=results.map(result=>{assert.equal(result.status,'fulfilled');return result.value})
      assert.equal(keys[0].id,keys[1].id)
      assert.equal((await client.query('SELECT count(*) FROM identity_risk_pseudonym_key_versions WHERE customer_tenant_id=$1',[scope.customerTenantId])).rows[0].count,'1')
      assert.equal((await client.query('SELECT count(*) FROM identity_risk_wrapped_keys WHERE key_version_id=$1',[winner.id])).rows[0].count,'1')
      await client.query("UPDATE identity_risk_pseudonym_key_versions SET activated_at=statement_timestamp()+INTERVAL '5 minutes' WHERE id=$1",[winner.id])
      await assert.rejects(()=>store.createVersion(scope,randomUUID(),Date.now()+15000),/KEY_UNAVAILABLE/)
      await client.query('UPDATE identity_risk_pseudonym_key_versions SET activated_at=statement_timestamp() WHERE id=$1',[winner.id])
      assert.equal((await store.createVersion(scope,randomUUID(),Date.now()+15000)).id,winner.id)
    }finally{
      releaseOlder()
      await Promise.allSettled(pending)
      pg.Client.prototype.query=originalQuery
      await prisma.organization.deleteMany({where:{id:scope.organizationId}})
      await prisma.$disconnect();await client.end()
      for(const[name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value}
    }
  })
