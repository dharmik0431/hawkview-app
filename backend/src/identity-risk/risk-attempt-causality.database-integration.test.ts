import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { IdentityRiskService } from './identity-risk.service.js'
import { IdentityRiskEvaluatorService } from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { RiskGlobalWorkStore } from './risk-global-work-store.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { WrappedRiskPseudonymProvider } from './pilot-pseudonym-provider.js'
import { MailboxRiskProjector, MAILBOX_FIRST_SLICE_FLAGS } from './mailbox-risk-projector.service.js'
import { MAILBOX_SOURCE_RESOURCES, MAILBOX_SOURCE_VERSION, mailboxSourceDigest, sourceAttestationKey } from './mailbox-source-attestation.js'
import { approvedIdentitySignalDetectors } from './identity-risk-approved-evaluator.adapter.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'
import { enforceRiskUtcTransaction } from './risk-utc-session.js'
import { lockGlobalRiskAttempt, completeGlobalRiskAttempt } from './risk-attempt-causality.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const deadline = () => Date.now()+6_000
async function fixture(work: (f: any) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  const prisma = new PrismaService(); const client = new pg.Client({ connectionString: url.toString() })
  await prisma.$connect(); await client.connect()
  const environment = `causal-${randomUUID().slice(0,8)}`
  const config = { HAWKVIEW_IDENTITY_RISK_MODE:'shadow', HAWKVIEW_IDENTITY_RISK_ROLLOUT:'global',
    HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:environment,
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:undefined, SECRET_ENCRYPTION_KEY:'73'.repeat(32) }
  const prior = Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]))
  for(const[k,v]of Object.entries(config)){if(v===undefined)delete process.env[k];else process.env[k]=v}
  const scopes: any[] = []; const users: string[] = []
  const store = new RiskGlobalWorkStore(); const keys = new WrappedRiskKeyStore()
  const observedAt = new Date(Date.now()-5_000)
  try {
    for(let i=0;i<2;i++) {
      const scope: any = { organizationId:randomUUID(),customerTenantId:randomUUID(),environment }
      scopes.push(scope)
      await prisma.organization.create({data:{id:scope.organizationId,name:'Synthetic causal scope',slug:`causal-${scope.organizationId}`}})
      await prisma.customerTenant.create({data:{id:scope.customerTenantId,organizationId:scope.organizationId,
        microsoftTenantId:randomUUID(),displayName:'Synthetic tenant',status:'ACTIVE'}})
      await prisma.tenantConnection.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,status:'CONNECTED'}})
      const userId=randomUUID();users.push(userId)
      scope.identity={subject:userId,email:`${userId}@synthetic.invalid`}
      await prisma.user.create({data:{id:userId,authProviderUserId:userId,email:scope.identity.email,
        memberships:{create:{organizationId:scope.organizationId,role:'MSP_OWNER',status:'ACTIVE'}}}})
      await keys.ensureVersion({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,environment},deadline())
      await prisma.$transaction(async tx=>{
        await enforceRiskUtcTransaction(tx)
        for(const resource of MAILBOX_SOURCE_RESOURCES){
          const payload=resource==='EXCHANGE_MAILBOX_RULES'?[]:[{domain:'synthetic.invalid'}]
          await tx.tenantEntraSnapshot.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:resource,payload,observedAt}})
          await tx.tenantCollectionFieldState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,
            fieldKey:sourceAttestationKey(resource),state:'COMPLETE',source:MAILBOX_SOURCE_VERSION,
            correlationId:mailboxSourceDigest(scope,resource,observedAt,payload),lastSuccessfulAt:observedAt}})
          await tx.syncState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,
            resourceType:resource,status:'SUCCEEDED',lastAttemptAt:observedAt,lastSuccessfulAt:observedAt}})
        }
      })
    }
    const projector=new MailboxRiskProjector(new WrappedRiskPseudonymProvider(keys))
    const begin=async(scope:any)=>{
      const lease=await store.claimCycle(deadline());assert.ok(lease)
      const attempt=await store.recordAttempt(scope,lease,deadline())
      await store.releaseCycle(lease,deadline())
      return attempt
    }
    const makeRequest=(scope:any,globalAttemptId:string,appNow:Date)=>({
      organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,globalAttemptId,evaluationAt:appNow,windowStart:new Date(appNow.getTime()-86_400_000),windowEnd:appNow,
      executionDeadlineAt:Date.now()+15_000,engineVersion:IDENTITY_RISK_ENGINE_VERSION,catalogVersion:IDENTITY_RISK_CATALOG_VERSION,
      loadSources:()=>projector.load({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId},appNow),detectors:approvedIdentitySignalDetectors({readiness:'READY',featureFlags:MAILBOX_FIRST_SLICE_FLAGS})})
    const service=new IdentityRiskService(prisma)
    await work({prisma,client,scopes,store,begin,makeRequest,service,environment})
  } finally {
    await client.query('ROLLBACK')
    for(const scope of scopes)await prisma.organization.deleteMany({where:{id:scope.organizationId}})
    await prisma.user.deleteMany({where:{id:{in:users}}})
    await client.query('DELETE FROM identity_risk_scheduler_cursors WHERE environment=$1',[environment])
    await prisma.$disconnect();await client.end()
    for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v}
  }
}

test('causal success survives DB ahead/behind/ties; later lower/equal-time failed attempts never retain a clean zero', {skip:!enabled,timeout:30_000},()=>fixture(async({prisma,client,scopes,begin,makeRequest,service}:any)=>{
  const scope=scopes[0]
  for(const skew of [-500,0,500]){
    const attempt=await begin(scope);const appNow=new Date()
    // Deliberately skew the durable DB event relative to the evaluator's app
    // clock. Causality must depend on neither this timestamp nor a grace window.
    const dbAt=new Date(appNow.getTime()+skew)
    await client.query('UPDATE identity_risk_operational_events SET created_at=$2 WHERE id=$1',[attempt,dbAt])
    const evaluator=new IdentityRiskEvaluatorService(prisma,new IdentityRiskSafetyService(prisma),{now:()=>appNow})
    const request=makeRequest(scope,attempt,appNow)
    assert.equal((await evaluator.evaluate(request)).status,'COMPLETED')
    let result=await service.summary(scope.identity,scope.customerTenantId)
    assert.equal(result.status,'AVAILABLE');assert.equal(result.capability,'FULL')
    assert.equal(result.counts.openFindings.value,0);assert.equal(result.counts.openFindings.exact,true)
    const linked=await prisma.identityRiskAttemptHead.findUnique({where:{organizationId_customerTenantId_environment:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,environment:scope.environment}}})
    assert.equal(linked.attemptId,attempt);assert.ok(linked.completedRunId)
    assert.equal((await (service as any).latestRun({id:scope.customerTenantId,organizationId:scope.organizationId},new Date())).id,linked.completedRunId)
    assert.equal((await evaluator.evaluate(request)).status,'REPLAYED','same attempt replay preserves binding')
    for(const laterOffset of [-500,0]){
      const pending=await begin(scope)
      await client.query('UPDATE identity_risk_operational_events SET created_at=$2 WHERE id=$1',[pending,new Date(appNow.getTime()+laterOffset)])
      result=await service.summary(scope.identity,scope.customerTenantId)
      assert.equal(result.status,'ERROR');assert.equal(result.counts.openFindings.exact,false)
      // Same source/window can be authoritatively replayed into the new attempt,
      // but an old attempt cannot certify this pending head.
      await assert.rejects(()=>evaluator.evaluate({...request,executionDeadlineAt:Date.now()+10_000}),/ATTEMPT_UNAVAILABLE/)
      assert.equal((await evaluator.evaluate({...request,globalAttemptId:pending,executionDeadlineAt:Date.now()+10_000})).status,'REPLAYED')
      assert.equal((await service.summary(scope.identity,scope.customerTenantId)).status,'AVAILABLE')
    }
  }
}))

test('out-of-order completion/retry is scoped and cannot overwrite a newer attempt or another MSP', {skip:!enabled,timeout:30_000},()=>fixture(async({prisma,scopes,store,begin,makeRequest,service}:any)=>{
  const [a,b]=scopes
  const old=await begin(a); const now=new Date();const evaluator=new IdentityRiskEvaluatorService(prisma,new IdentityRiskSafetyService(prisma),{now:()=>now})
  const request=makeRequest(a,old,now)
  // Exercise an actual already-claimed run, not only a worker delayed before
  // claim. A newer head must prevent this old run's final persistence too.
  const source=await request.loadSources();assert.equal(source.capability,'FULL')
  const oldLease=randomUUID();const oldRunKey=randomUUID();const expiresAt=new Date(now.getTime()+3_600_000)
  const claimed=await (evaluator as any).claimRun({request,runKey:oldRunKey,leaseToken:oldLease,
    platformNow:now,expiresAt,capability:'FULL',watermarkHash:'a'.repeat(64),sourceContentHash:'b'.repeat(64),
    pseudonymKeyVersionId:source.pseudonymKeyVersionId,sourceObservedAt:source.sourceObservedAt,mailboxAttestations:source.mailboxAttestations})
  assert.ok(claimed.id)
  let entered!:()=>void;let release!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve})
  const gate=new Promise<void>(resolve=>{release=resolve})
  const pending=evaluator.evaluate({...request,loadSources:async()=>{const batch=await request.loadSources();entered();await gate;return batch}})
    .then(()=>false,()=>true)
  try{
    await started
    const newer=await begin(a)
    await evaluator.evaluate({...request,globalAttemptId:newer})
    await assert.rejects(()=>(evaluator as any).persistCompletedRun({request,runId:claimed.id,runKey:oldRunKey,
      leaseToken:oldLease,platformNow:now,expiresAt,capability:'FULL',aggregates:[],matches:[],
      pseudonymKeyVersionId:source.pseudonymKeyVersionId,mailboxAttestations:source.mailboxAttestations}),/ATTEMPT_UNAVAILABLE/)
    assert.equal((await prisma.identityRiskEvaluationRun.findUnique({where:{id:claimed.id}})).status,'RUNNING')
    release();assert.equal(await pending,true,'older evaluation must not complete after newer attempt')
    assert.equal((await service.summary(a.identity,a.customerTenantId)).status,'AVAILABLE')
    const head=await prisma.identityRiskAttemptHead.findUnique({where:{organizationId_customerTenantId_environment:{organizationId:a.organizationId,customerTenantId:a.customerTenantId,environment:a.environment}}})
    assert.equal(head.attemptId,newer)
    // A different historical success may have a later application timestamp.
    // It must never displace the successful run selected by the causal head.
    const current=await prisma.identityRiskEvaluationRun.findUnique({where:{id:head.completedRunId}})
    const historicalId=randomUUID()
    await prisma.identityRiskEvaluationRun.create({data:{...current,id:historicalId,runKey:randomUUID(),completedAt:new Date(now.getTime()+60_000)}})
    assert.equal((await (service as any).latestRun({id:a.customerTenantId,organizationId:a.organizationId},new Date())).id,head.completedRunId)
    await assert.rejects(()=>prisma.$transaction(async(tx:any)=>{
      await lockGlobalRiskAttempt(tx,request)
      await completeGlobalRiskAttempt(tx,request,head.completedRunId)
    }),/ATTEMPT_UNAVAILABLE/)
    const bAttempt=await begin(b)
    await evaluator.evaluate(makeRequest(b,bAttempt,now))
    await assert.rejects(()=>service.summary(a.identity,b.customerTenantId),/Tenant access denied/)
    const next=await begin(a)
    await assert.rejects(()=>prisma.$transaction(async(tx:any)=>{
      const foreign=makeRequest(a,next,now);await lockGlobalRiskAttempt(tx,foreign)
      const bHead=await tx.identityRiskAttemptHead.findUnique({where:{organizationId_customerTenantId_environment:{organizationId:b.organizationId,customerTenantId:b.customerTenantId,environment:b.environment}}})
      await completeGlobalRiskAttempt(tx,foreign,bHead.completedRunId)
    }),/ATTEMPT_UNAVAILABLE/)
    assert.equal((await service.summary(a.identity,a.customerTenantId)).status,'ERROR')
    assert.equal((await service.summary(b.identity,b.customerTenantId)).status,'AVAILABLE')
    // A recordAttempt retry within the same lease must preserve a linked success.
    const lease=await store.claimCycle(deadline());assert.ok(lease)
    const retry=await store.recordAttempt(a,lease,deadline())
    await evaluator.evaluate(makeRequest(a,retry,now))
    assert.equal(await store.recordAttempt(a,lease,deadline()),retry)
    assert.equal((await service.summary(a.identity,a.customerTenantId)).status,'AVAILABLE')
    await store.releaseCycle(lease,deadline())
    await assert.rejects(()=>store.recordAttempt(a,lease,deadline()),/SOURCE_UNAVAILABLE/)
  }finally{release();await pending}
}))
