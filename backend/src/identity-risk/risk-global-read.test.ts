import assert from 'node:assert/strict'
import test from 'node:test'
import { IdentityRiskService } from './identity-risk.service.js'
import { IDENTITY_RISK_CATALOG_VERSION, IDENTITY_RISK_ENGINE_VERSION } from './identity-risk.contract.js'

const orgA='11111111-1111-4111-8111-111111111111'; const orgB='22222222-2222-4222-8222-222222222222'
const tenantA='33333333-3333-4333-8333-333333333333'; const tenantB='44444444-4444-4444-8444-444444444444'
const identity=(subject:string)=>({subject,email:'synthetic@tenant.invalid'})
async function globalTest(work:()=>Promise<void>) {
  const config={HAWKVIEW_IDENTITY_RISK_MODE:'shadow',HAWKVIEW_IDENTITY_RISK_ROLLOUT:'global',HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:'synthetic',HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-v1',HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:undefined}
  const previous=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]))
  for(const[k,v]of Object.entries(config)){if(v===undefined)delete process.env[k];else process.env[k]=v}
  try{await work()}finally{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
}
function serviceFixture(options:{ failedAttempt?:boolean; revoked?:boolean; noRun?:boolean; noHead?:boolean; capability?:string; stale?:boolean }={}) {
  const now=new Date();let reads=0
  const models={
    $executeRawUnsafe:async()=>0,$queryRawUnsafe:async(sql:string,organizationId:string,customerTenantId:string,environment:string)=>{
      if(sql.includes('identity_risk_attempt_heads')){
        assert.equal(organizationId,customerTenantId===tenantA?orgA:orgB);assert.equal(environment,'synthetic')
        return options.noHead?[]:[{completedRunId:options.failedAttempt?null:'run'}]
      }
      return [{timezone:'UTC'}]
    },
    user:{findUnique:async({where}:any)=>({disabledAt:null,memberships:[{organizationId:where.authProviderUserId==='a'?orgA:orgB,role:'MSP_OWNER'}]})},
    customerTenant:{findFirst:async({where}:any)=>{
      const organizationId=where.id===tenantA?orgA:orgB
      return where.organizationId.in.includes(organizationId)?{id:where.id,organizationId}:null
    }},
    identityRiskOperationalControl:{findMany:async()=>[]},
    identityRiskOperationalEvent:{findFirst:async()=>{throw new Error('Attempt timestamps must never order success')}},
    identityRiskPseudonymKeyVersion:{findFirst:async({where}:any)=>{assert.equal(where.environment,'synthetic');assert.equal(where.status,'ACTIVE');assert.equal(where.destroyedAt,null);return options.revoked?null:{id:'key'}}},
    identityRiskEvaluationRun:{findFirst:async({where}:any)=>{
      reads++;assert.equal(where.organizationId,where.customerTenantId===tenantA?orgA:orgB)
      if(!options.failedAttempt)assert.equal(where.id,'run','success must select the causally linked run')
      return options.noRun?null:{id:'run',engineVersion:IDENTITY_RISK_ENGINE_VERSION,catalogVersion:IDENTITY_RISK_CATALOG_VERSION,
        capability:options.capability??'FULL',completedAt:now,sourceObservedAt:new Date(now.getTime()-(options.stale?37*3_600_000:1_000)),pseudonymKeyVersionId:'key'}
    }},
    identityRiskRuleCoverage:{findMany:async()=>[{ruleId:'HV-ID-MBX-001.v1',matchedCount:0,suppressedCount:0,notMatchedCount:1,notEvaluatedCount:0}]},
    identityRiskFinding:{count:async()=>0,findMany:async()=>[]},
  }
  return {service:new IdentityRiskService({...models,$transaction:async(work:any)=>work(models)} as any),reads:()=>reads}
}
test('global mailbox availability is the same for both MSPs without premium/plan input; foreign scope denied before risk reads',()=>globalTest(async()=>{
  const f=serviceFixture()
  for(const[subject,id]of [['a',tenantA],['b',tenantB]] as const){
    const result=await f.service.summary(identity(subject),id)
    assert.equal(result.status,'AVAILABLE');assert.equal(result.counts.notMatchedResults.value,1)
  }
  const before=f.reads();await assert.rejects(()=>f.service.summary(identity('a'),tenantB),/Tenant access denied/)
  assert.equal(f.reads(),before)
}))
test('new failed/pending attempt or revoked key cannot leave an old zero-match result looking current',()=>globalTest(async()=>{
  for(const options of [{failedAttempt:true},{revoked:true}]){
    const result=await serviceFixture(options).service.summary(identity('a'),tenantA)
    assert.equal(result.status,'ERROR');assert.equal(result.capability,'UNAVAILABLE')
    assert.equal(result.counts.openFindings.exact,false)
  }
}))
test('missing evidence, stale evidence, and OFF remain truthful with no manual pilot scope',()=>globalTest(async()=>{
  assert.equal((await serviceFixture({noRun:true}).service.summary(identity('a'),tenantA)).status,'NOT_EVALUATED')
  const unlinked=serviceFixture({noHead:true});assert.equal((await unlinked.service.summary(identity('a'),tenantA)).status,'NOT_EVALUATED');assert.equal(unlinked.reads(),0)
  assert.equal((await serviceFixture({stale:true}).service.summary(identity('a'),tenantA)).status,'STALE')
  assert.equal((await serviceFixture({capability:'UNAVAILABLE'}).service.summary(identity('a'),tenantA)).status,'NOT_EVALUATED')
  process.env.HAWKVIEW_IDENTITY_RISK_MODE='off'
  const f=serviceFixture();assert.equal((await f.service.summary(identity('a'),tenantA)).status,'UNAVAILABLE');assert.equal(f.reads(),0)
}))
