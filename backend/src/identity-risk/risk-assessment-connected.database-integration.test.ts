import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { IdentityRiskService } from './identity-risk.service.js'
import { IdentityRiskEvaluatorService, IdentityRiskEvaluationScheduler } from './identity-risk-evaluator.service.js'
import { IdentityRiskSafetyService } from './identity-risk-safety.service.js'
import { RiskGlobalWorkStore } from './risk-global-work-store.js'
import { WrappedRiskKeyStore } from './wrapped-risk-key-store.js'
import { WrappedRiskPseudonymProvider } from './pilot-pseudonym-provider.js'
import { MailboxRiskProjector } from './mailbox-risk-projector.service.js'
import { RiskAssessmentProjector } from './risk-assessment-projector.service.js'
import { RiskAssessmentReader } from './risk-assessment-reader.service.js'
import { persistAuthenticationRecords } from './authentication-ingestion-integrity.js'
import { persistCompletedAuthenticationWindow } from './authentication-window-collector.js'
import { loadAssessmentProtection } from './risk-assessment-protection-loader.js'
import { TenantSyncService } from '../tenants/tenant-sync.service.js'
import { mailboxSourceDigest, sourceAttestationKey, MAILBOX_SOURCE_VERSION } from './mailbox-source-attestation.js'
import { mailboxRule } from './mailbox-risk.test-fixtures.js'
import { IDENTITY_RISK_ENGINE_VERSION, IDENTITY_RISK_CATALOG_VERSION } from './identity-risk.contract.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const deadline = () => Date.now()+6000
async function fixture(work:(f:any)=>Promise<void>, audit=false, complete=true) {
  const url=new URL(process.env.DATABASE_URL??'')
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Disposable loopback DB only')
  assert.match(url.pathname,/test|qa|^\/hawkview_ci$/i,'Explicit test/QA or repository CI database only')
  const prisma=new PrismaService(),client=new pg.Client({connectionString:url.toString()})
  await prisma.$connect();await client.connect()
  const environment=`connected-${randomUUID().slice(0,8)}`
  const configuration={HAWKVIEW_IDENTITY_RISK_MODE:'shadow',HAWKVIEW_IDENTITY_RISK_ROLLOUT:'global',
    HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-v1',HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:environment,
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:undefined,SECRET_ENCRYPTION_KEY:'73'.repeat(32)}
  const prior=Object.fromEntries(Object.keys(configuration).map(key=>[key,process.env[key]]))
  for(const[key,value]of Object.entries(configuration)){if(value===undefined)delete process.env[key];else process.env[key]=value}
  const scopes:any[]=[],ownerIds:string[]=[]
  const store=new RiskGlobalWorkStore(),keys=new WrappedRiskKeyStore()
  const base=new Date(Date.now()-10_000),old=new Date(base.getTime()-60_000)
  try {
    for(let index=0;index<2;index++) {
      const scope={organizationId:randomUUID(),customerTenantId:randomUUID(),microsoftTenantId:randomUUID(),environment,
        humanId:randomUUID(),appId:randomUUID(),identity:{subject:randomUUID()},upn:`synthetic-${index}@fixture.invalid`}
      scopes.push(scope);ownerIds.push(scope.identity.subject)
      await prisma.organization.create({data:{id:scope.organizationId,name:'Synthetic connected scope',slug:`connected-${scope.organizationId}`}})
      await prisma.customerTenant.create({data:{id:scope.customerTenantId,organizationId:scope.organizationId,microsoftTenantId:scope.microsoftTenantId,displayName:'Synthetic tenant',status:'ACTIVE'}})
      await prisma.tenantConnection.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,status:'CONNECTED'}})
      await prisma.user.create({data:{id:scope.identity.subject,authProviderUserId:scope.identity.subject,email:`${scope.identity.subject}@fixture.invalid`,
        memberships:{create:{organizationId:scope.organizationId,role:'MSP_OWNER',status:'ACTIVE'}}}})
      await prisma.directoryUser.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,microsoftUserId:scope.humanId,
        displayName:'Synthetic human',userPrincipalName:scope.upn,userType:'Member',lastSeenAt:old,updatedAt:old}})
      await keys.ensureVersion({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,environment},deadline())
      for(const resourceType of ['USERS','APPLICATIONS','SECURITY_DEFAULTS'] as const) {
        const payload=resourceType==='APPLICATIONS'?[{appId:scope.appId,displayName:'Synthetic application'}]:resourceType==='SECURITY_DEFAULTS'?[{isEnabled:true}]:[]
        await prisma.tenantEntraSnapshot.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType,payload,observedAt:old,updatedAt:old}})
        await prisma.syncState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType,status:'SUCCEEDED',lastAttemptAt:old,lastSuccessfulAt:base,updatedAt:base}})
      }
    }
    const [scope]=scopes
    const record=(id:string,index:number,success=false,overrides:any={})=>{
      const eventDateTime=new Date(base.getTime()-(success?30_000:(10-index)*60_000))
      const graph={id,createdDateTime:eventDateTime.toISOString(),userId:scope.humanId,appId:scope.appId,ipAddress:'192.0.2.10',isInteractive:true,status:{errorCode:success?0:50126}}
      const sts={Id:id,CreationTime:eventDateTime.toISOString(),OrganizationId:scope.microsoftTenantId,UserId:scope.upn,UserType:0,ApplicationId:scope.appId,
        RecordType:15,Operation:success?'UserLoggedIn':'UserLoginFailed',ErrorCode:success?'0':'50126',ActorIpAddress:'192.0.2.10'}
      return {organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,microsoftSignInId:audit?`management:${id}`:id,eventDateTime,
        raw:audit?{hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:{...sts,...overrides}}:{...graph,...overrides},
        riskLevel:'high',ingestedAt:base,expiresAt:new Date(base.getTime()+90*86_400_000)}
    }
    const records=Array.from({length:10},(_,i)=>record(`failure-${i}`,i));records.push(record('success',0,true))
    await persistAuthenticationRecords(prisma,scope,records)
    if(complete)await persistCompletedAuthenticationWindow(prisma,scope,audit?'M365_AUDIT_STS':'GRAPH_SIGN_INS',new Date(base.getTime()-86_400_000),base,true)
    const collectedAt=new Date()
    await prisma.syncState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:'SIGN_INS',
      status:audit?'RUNNING':'SUCCEEDED',lastErrorCode:audit?'sign-ins-non-premium-fallback-active':null,lastAttemptAt:base,lastSuccessfulAt:collectedAt}})
    const provider=new WrappedRiskPseudonymProvider(keys),projector=new RiskAssessmentProjector(provider,new MailboxRiskProjector(provider))
    const reader=new RiskAssessmentReader(provider),service=new IdentityRiskService(prisma,undefined,reader)
    // Integration gate uses the actual browser adapter, not a second synthetic
    // DTO fixture. Dynamic test-only import keeps frontend outside backend tsc.
    const adapterUrl=new URL('../../../lib/identity-risk/adapter.ts',import.meta.url).href
    const {adaptRiskAssessmentResponse}=await import(adapterUrl)
    const readAssessment=reader.read.bind(reader)
    reader.read=async(...args:Parameters<typeof reader.read>)=>{
      const value=await readAssessment(...args)
      assert.ok(adaptRiskAssessmentResponse(value,args[2].getTime()),'Real persisted assessment must pass the production frontend contract')
      return value
    }
    const begin=async()=>{const lease=await store.claimCycle(deadline());assert.ok(lease);try{return await store.recordAttempt(scope,lease,deadline())}finally{await store.releaseCycle(lease,deadline())}}
    const evaluate=async(mutate?:(batch:any)=>Promise<void>, evaluationAt=new Date())=>{
      const globalAttemptId=await begin()
      const evaluator=new IdentityRiskEvaluatorService(prisma,new IdentityRiskSafetyService(prisma),{now:()=>evaluationAt})
      let internalFailure: unknown
      for (const method of ['runDetectors','persistCompletedRun']) {
        const original=(evaluator as any)[method].bind(evaluator)
        ;(evaluator as any)[method]=async(...args:any[])=>{try{return await original(...args)}catch(error){internalFailure=error;throw error}}
      }
      const scheduler=new IdentityRiskEvaluationScheduler(evaluator)
      const batch=await projector.load({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId},evaluationAt,Date.now()+25_000)
      assert.deepEqual(Object.keys(batch.context).sort(),['catalogVersion','customerTenantId','engineVersion','evaluationAt','organizationId'])
      assert.ok(batch.sourceObservedAt instanceof Date || batch.capability==='UNAVAILABLE', `source clock absent for ${batch.capability}; readiness=${batch.assessment?.rules.map(rule=>rule.status).join(',')}`)
      assert.equal(batch.context.evaluationAt.getTime(),evaluationAt.getTime())
      if(mutate)await mutate(batch)
      const result=await scheduler.runAssessmentTenant({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,globalAttemptId,evaluationAt,
        windowStart:new Date(evaluationAt.getTime()-86_400_000),windowEnd:evaluationAt,executionDeadlineAt:Date.now()+20_000,
        engineVersion:IDENTITY_RISK_ENGINE_VERSION,catalogVersion:IDENTITY_RISK_CATALOG_VERSION,loadSources:async()=>batch}).catch(error=>{throw internalFailure??error})
      return {result,batch}
    }
    await work({prisma,client,scopes,scope,record,records,base,projector,reader,service,evaluate})
  }finally{
    await client.query('ROLLBACK')
    for(const scope of scopes)await prisma.organization.deleteMany({where:{id:scope.organizationId}})
    if(ownerIds.length)await prisma.user.deleteMany({where:{id:{in:ownerIds}}})
    await client.query('DELETE FROM identity_risk_scheduler_cursors WHERE environment=$1',[environment])
    await prisma.$disconnect();await client.end()
    for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value}
  }
}

for(const audit of [false,true]) for(const complete of [false,true])test(`connected ${audit?'STS non-P2':'Graph'} ${complete?'complete':'partial'} source -> evaluator -> persistence -> authorized GET`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  const {result,batch}=await f.evaluate()
  assert.equal(result.status,'COMPLETED')
  assert.equal(batch.assessment.subjects.length,1)
  assert.deepEqual(batch.assessment.subjects[0].findings.map((finding:any)=>finding.ruleId).sort(),['HV-ID-AUTH-005.v2','HV-ID-AUTH-010.v1'])
  assert.equal(batch.assessment.rules[2].status,'WAITING','Mailbox failure does not veto A/B')
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.version,1);assert.equal(dto.schemaVersion,'hawkview-risk-assessment/v1');assert.equal(dto.meta.capability,'PARTIAL')
  assert.equal(dto.users.length,1);assert.equal(dto.users[0].label,f.scope.upn);assert.equal(dto.users[0].priority,'MEDIUM')
  assert.equal(dto.users[0].findings.length,2);assert.ok(dto.users[0].findings.every((finding:any)=>finding.activityState==='CURRENT'))
  assert.equal(dto.users[0].findings[0].application.label,'Synthetic application')
  assert.equal(dto.users[0].protection.securityDefaults.state,'ENABLED')
  const stored=await f.prisma.identityRiskMatchedResult.findMany({where:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId}})
  assert.ok(stored.length>=2)
  const serialized=JSON.stringify(stored.map((row:any)=>row.evidence))
  for(const privateValue of [f.scope.upn,f.scope.humanId,f.scope.appId,'192.0.2.10'])assert.ok(!serialized.includes(privateValue),'Stored evidence is opaque')
  assert.ok((await f.prisma.signInLog.findMany({where:{customerTenantId:f.scope.customerTenantId}})).every((row:any)=>row.riskLevel==='high'),'Microsoft risk is unchanged')
  await assert.rejects(()=>f.service.assessment(f.scopes[1].identity,f.scope.customerTenantId),/Tenant access denied/)
  const protection=await loadAssessmentProtection(f.scopes[1],[f.scope.humanId],new Date(),deadline())
  assert.equal(protection.get(f.scope.humanId)?.securityDefaults.state,'UNKNOWN')
},audit,complete))

test('stored conflicts are sticky, exclude witnesses, preserve Microsoft risk and never certify a clean negative',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await f.evaluate()
  const conflicting=f.record('failure-9',9,false,{status:{errorCode:0}})
  assert.equal((await persistAuthenticationRecords(f.prisma,f.scope,[conflicting])).hasConflicts,true)
  assert.equal((await persistAuthenticationRecords(f.prisma,f.scope,[f.records[9]])).hasConflicts,true)
  const old=await f.prisma.signInLog.findFirst({where:{customerTenantId:f.scope.customerTenantId,microsoftSignInId:'failure-9'}})
  assert.equal(old.raw.status.errorCode,50126);assert.equal(old.raw.hawkviewAuthenticationIntegrity,'CONFLICT');assert.equal(old.riskLevel,'high')
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.sources.find((source:any)=>source.source==='GRAPH_SIGN_INS').status,'PARTIAL')
  const a=dto.users.flatMap((user:any)=>user.findings).filter((finding:any)=>finding.ruleId==='HV-ID-AUTH-010.v1')
  assert.ok(a.every((finding:any)=>finding.activityState!=='CURRENT'),'Disputed threshold cannot remain current')
  assert.ok(dto.rules.every((rule:any)=>rule.status!=='READY'),'Conflicting evidence cannot establish a clean complete negative')
}))

for(const change of ['row-insert','row-conflict','source-swap','directory-generation'] as const)test(`commit revalidates ${change} after actual source load`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await assert.rejects(()=>f.evaluate(async()=>{
    if(change==='row-insert')await persistAuthenticationRecords(f.prisma,f.scope,[f.record('late-event',5)])
    else if(change==='row-conflict')await persistAuthenticationRecords(f.prisma,f.scope,[f.record('failure-1',1,false,{status:{errorCode:0}})])
    else await f.prisma.syncState.updateMany({where:{customerTenantId:f.scope.customerTenantId,organizationId:f.scope.organizationId,resourceType:change==='source-swap'?'SIGN_INS':'USERS'},
      data:change==='source-swap'?{status:'RUNNING',lastErrorCode:'sign-ins-non-premium-fallback-active'}:{status:'RUNNING',lastAttemptAt:new Date()}})
  }),/IDENTITY_RISK_SOURCE_UNAVAILABLE/)
  assert.equal(await f.prisma.identityRiskFinding.count({where:{customerTenantId:f.scope.customerTenantId}}),0,'Refused evaluation writes no finding')
}))

test('actual window writer refuses older generations and incomplete chains without overwriting latest proof',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  const where={customerTenantId_resourceType:{customerTenantId:f.scope.customerTenantId,resourceType:'SIGN_INS' as const}}
  const before=await f.prisma.tenantEntraSnapshot.findUnique({where})
  await assert.rejects(()=>persistCompletedAuthenticationWindow(f.prisma,f.scope,'GRAPH_SIGN_INS',new Date(f.base.getTime()-3600_000),new Date(f.base.getTime()-1),true),/SUPERSEDED/)
  await assert.rejects(()=>persistCompletedAuthenticationWindow(f.prisma,f.scope,'GRAPH_SIGN_INS',f.base,new Date(),false),/INCOMPLETE/)
  assert.deepEqual(await f.prisma.tenantEntraSnapshot.findUnique({where}),before)
}))

test('actual Graph collector persists conflict gaps without hiding unrelated intact positive evidence',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  const anotherApp=randomUUID()
  const unaffected=Array.from({length:10},(_,i)=>f.record(`unrelated-${i}`,i,false,{appId:anotherApp}))
  const service=new TenantSyncService(f.prisma,{} as any,{} as any,{resolveIncident:async()=>{},publishIncident:async()=>{}} as any,{pruneExpired:async()=>{}} as any,{} as any)
  ;(service as any).signInEntitlement=async()=> 'PREMIUM'
  ;(service as any).fetchGraphCollection=async()=>[f.record('failure-9',9,false,{status:{errorCode:0}}),...unaffected].map(row=>row.raw)
  await (service as any).syncSignInLogs({id:f.scope.customerTenantId,organizationId:f.scope.organizationId,microsoftTenantId:f.scope.microsoftTenantId},'synthetic-unused')
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.sources.find((source:any)=>source.source==='GRAPH_SIGN_INS').status,'PARTIAL')
  assert.ok(dto.users.flatMap((user:any)=>user.findings).some((finding:any)=>finding.ruleId==='HV-ID-AUTH-010.v1'&&finding.activityState==='CURRENT'),'Intact independent application witness remains visible')
  const snapshot=await f.prisma.tenantEntraSnapshot.findFirst({where:{customerTenantId:f.scope.customerTenantId,resourceType:'SIGN_INS'}})
  assert.equal(snapshot.payload.paginationComplete,true,'Complete page chain is a distinct fact from conflict-free evidence')
}))

test('actual audit page rejects applicable malformed login before filtering or publishing a successful window',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  const before=await f.prisma.tenantEntraSnapshot.findFirst({where:{customerTenantId:f.scope.customerTenantId,resourceType:'SIGN_INS'}})
  const target={id:f.scope.customerTenantId,organizationId:f.scope.organizationId,microsoftTenantId:f.scope.microsoftTenantId}
  const service=new TenantSyncService(f.prisma,{getTenantManagementActivityContext:async()=>({accessToken:'synthetic',publisherIdentifier:f.scope.microsoftTenantId})} as any,{} as any,
    {resolveIncident:async()=>{},publishIncident:async()=>{}} as any,{pruneExpired:async()=>{}} as any,{} as any)
  ;(service as any).signInEntitlement=async()=> 'NON_PREMIUM'
  ;(service as any).fetchGraphCollection=async()=>{throw new Error('Authentication_RequestFromNonPremiumTenantOrB2CTenant')}
  const payloads=[[{contentType:'Audit.AzureActiveDirectory',status:'enabled'}],[{contentUri:`https://manage.office.com/api/v1.0/${f.scope.microsoftTenantId}/activity/feed/audit/content`}],
    [{RecordType:15,Id:null,CreationTime:f.base.toISOString(),Operation:'UserLoginFailed'}]]
  let calls=0
  ;(service as any).fetchGraphPage=async()=>new Response(JSON.stringify(payloads[calls++]))
  await assert.rejects(()=>(service as any).syncSignInLogs(target,'synthetic-unused'))
  const state=await f.prisma.syncState.findFirst({where:{customerTenantId:f.scope.customerTenantId,resourceType:'SIGN_INS'}})
  assert.equal(state.status,'FAILED');assert.deepEqual(await f.prisma.tenantEntraSnapshot.findFirst({where:{customerTenantId:f.scope.customerTenantId,resourceType:'SIGN_INS'}}),before)
}))

test('persisted lifecycle ages to HISTORY without replay renewal, resolution claims or Microsoft-risk changes',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await f.evaluate()
  const before=await f.prisma.identityRiskFinding.findMany({where:{customerTenantId:f.scope.customerTenantId},orderBy:{id:'asc'}})
  const later=new Date(Date.now()+20*60_000)
  await f.evaluate(undefined,later)
  const after=await f.prisma.identityRiskFinding.findMany({where:{customerTenantId:f.scope.customerTenantId},orderBy:{id:'asc'}})
  assert.equal(after.length,before.length)
  for(let index=0;index<after.length;index++){
    assert.equal(after[index].state,'EXPIRED');assert.equal(after[index].observedAt.getTime(),before[index].observedAt.getTime())
    assert.equal(after[index].expiresAt.getTime(),before[index].expiresAt.getTime())
    assert.equal(after[index].expiresAt.getTime()-after[index].observedAt.getTime(),90*86_400_000)
  }
  const run=await f.prisma.identityRiskEvaluationRun.findFirst({where:{customerTenantId:f.scope.customerTenantId,status:'COMPLETED'},orderBy:{completedAt:'desc'}})
  const dto=await f.reader.read({organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId},run,later,true)
  assert.equal(dto.users[0].priority,null);assert.ok(dto.users[0].findings.every((finding:any)=>finding.activityState==='HISTORICAL'))
}))

test('real protection SQL proves named applicable CA separately from unregistered/disabled legacy MFA',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  const stamp=f.base,group=randomUUID(),role=randomUUID(),policyId=randomUUID()
  const policy={id:policyId,displayName:'Synthetic active role MFA',state:'enabled',conditions:{users:{includeRoles:[role]},applications:{includeApplications:['All']}},grantControls:{operator:'OR',builtInControls:['mfa']}}
  for(const [resourceType,payload]of Object.entries({CONDITIONAL_ACCESS:[policy],AUTHENTICATION_STRENGTHS:[],DIRECTORY_ROLES:[{principalId:group,roleDefinition:{templateId:role}}],
    AUTH_REGISTRATIONS:[{id:f.scope.humanId,isMfaRegistered:false,perUserMfaState:'disabled',conditionalAccessContext:{membershipComplete:true,transitiveGroupIds:[group],observedAt:stamp.toISOString()}}]})){
    await f.prisma.tenantEntraSnapshot.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType,payload,observedAt:stamp,updatedAt:stamp}})
    await f.prisma.syncState.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType,status:'SUCCEEDED',lastSuccessfulAt:stamp,updatedAt:stamp}})
  }
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId),protection=dto.users[0].protection
  assert.equal(protection.registration.state,'NOT_REGISTERED');assert.equal(protection.legacyPerUserMfa.state,'DISABLED')
  assert.equal(protection.conditionalAccess.status,'COVERED_BY_CONDITIONAL_ACCESS');assert.equal(protection.conditionalAccess.policies[0].id,policyId)
  assert.equal(dto.users[0].priority,'MEDIUM','Present protection does not lower suspicious activity priority')
  assert.ok(dto.users[0].findings.every((finding:any)=>finding.eventProtection==='NOT_REPORTED'),'Current policy is not historical event MFA')
  await f.prisma.syncState.updateMany({where:{customerTenantId:f.scope.customerTenantId,resourceType:'DIRECTORY_ROLES'},data:{status:'FAILED'}})
  const unavailable=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(unavailable.users[0].protection.conditionalAccess.status,'UNKNOWN');assert.equal(unavailable.users[0].priority,'MEDIUM')
}))

async function seedMailbox(f:any, mailboxId=f.scope.humanId, purpose:string|null='user') {
  const stamp=f.base
  for(const resourceType of ['EXCHANGE_MAILBOX_RULES','EXCHANGE_ACCEPTED_DOMAINS'] as const){
    const payload=resourceType==='EXCHANGE_MAILBOX_RULES'?[mailboxRule('forward@outside.invalid',{mailboxUserId:mailboxId,mailboxUpn:f.scope.upn})]:[{domain:'fixture.invalid'}]
    await f.prisma.tenantEntraSnapshot.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType,payload,observedAt:stamp}})
    await f.prisma.tenantCollectionFieldState.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,fieldKey:sourceAttestationKey(resourceType),
      state:'COMPLETE',source:MAILBOX_SOURCE_VERSION,correlationId:mailboxSourceDigest(f.scope,resourceType,stamp,payload),lastSuccessfulAt:stamp}})
    await f.prisma.syncState.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType,status:'SUCCEEDED',lastSuccessfulAt:stamp}})
  }
  await f.prisma.tenantEntraSnapshot.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType:'EXCHANGE_MAILBOXES',payload:[{id:mailboxId,mail:f.scope.upn}],observedAt:stamp}})
  await f.prisma.syncState.create({data:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType:'EXCHANGE_MAILBOXES',status:'SUCCEEDED',lastSuccessfulAt:stamp}})
  if(purpose!==null)await seedPurpose(f,f.scope,[{mailboxUserId:mailboxId,userPurpose:purpose}])
}

async function seedPurpose(f:any, scope:any, payload:unknown, stamp=f.base, status='SUCCEEDED') {
  await f.prisma.tenantEntraSnapshot.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:'EXCHANGE_MAILBOX_SETTINGS',payload,observedAt:stamp}})
  await f.prisma.syncState.create({data:{organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,resourceType:'EXCHANGE_MAILBOX_SETTINGS',status,lastSuccessfulAt:stamp}})
}

test('current mailbox HIGH remains independently evaluable when authentication collection fails',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await seedMailbox(f)
  await f.prisma.syncState.updateMany({where:{customerTenantId:f.scope.customerTenantId,resourceType:'SIGN_INS'},data:{status:'FAILED'}})
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  const mailbox=dto.users.flatMap((user:any)=>user.findings).find((finding:any)=>finding.ruleId==='HV-ID-MBX-001.v1')
  assert.equal(mailbox?.priority,'HIGH');assert.equal(mailbox?.activityState,'CURRENT');assert.notEqual(dto.meta.capability,'FULL')
}))

for(const sameGuid of [true,false])test(`authorized rollup requires explicit user purpose and exact GUID, never matching UPN: ${sameGuid}`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await seedMailbox(f,sameGuid?f.scope.humanId:randomUUID())
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.users.length,sameGuid?1:2)
  const human=dto.users.find((user:any)=>user.subjectType==='USER')
  assert.equal(human.priority,sameGuid?'HIGH':'MEDIUM')
  assert.equal(human.findings.length,sameGuid?3:2)
  assert.equal(human.protection.securityDefaults.state,'ENABLED')
  assert.equal(dto.meta.capability,'FULL','Exact rollup does not masquerade as truncated evidence')
  if(!sameGuid)assert.equal(dto.users.find((user:any)=>user.subjectType==='MAILBOX').protection.securityDefaults.state,'UNKNOWN')
  assert.ok(!JSON.stringify(dto).includes('assessmentMailboxGenerations'))
}))

for(const purpose of ['shared','room','equipment','unknownFutureValue','missing','stale','failed','duplicate','conflicting','wrong-guid','oversized','future','newer-attempt'] as const)
test(`mailbox purpose ${purpose} never becomes a human finding or suppresses independent sources`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await seedMailbox(f,f.scope.humanId,null)
  if(purpose!=='missing'){
    const row={mailboxUserId:purpose==='wrong-guid'?randomUUID():f.scope.humanId,userPurpose:['shared','room','equipment','unknownFutureValue'].includes(purpose)?purpose:'user'}
    const payload=purpose==='duplicate'?[row,{...row,mailboxUserId:row.mailboxUserId.toUpperCase()}]:purpose==='conflicting'?[row,{...row,userPurpose:'shared'}]:purpose==='oversized'?Array.from({length:1001},()=>row):[row]
    const stamp=purpose==='stale'?new Date(f.base.getTime()-27*3600_000):purpose==='future'?new Date(Date.now()+60_000):f.base
    await seedPurpose(f,f.scope,payload,stamp,purpose==='failed'?'FAILED':'SUCCEEDED')
    if(purpose==='newer-attempt')await f.prisma.syncState.updateMany({where:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,resourceType:'EXCHANGE_MAILBOX_SETTINGS'},data:{lastAttemptAt:new Date()}})
  }
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.users.length,2)
  const human=dto.users.find((user:any)=>user.subjectType==='USER'),mailbox=dto.users.find((user:any)=>user.subjectType==='MAILBOX')
  assert.equal(human.priority,'MEDIUM');assert.equal(human.findings.length,2)
  assert.equal(mailbox.priority,'HIGH');assert.equal(mailbox.findings.length,1)
  assert.equal(mailbox.findings[0].ruleId,'HV-ID-MBX-001.v1');assert.equal(mailbox.findings[0].selectedSource,'MAILBOX_RULES')
  assert.equal(mailbox.findings[0].activityState,'CURRENT');assert.equal(mailbox.protection.securityDefaults.state,'UNKNOWN')
  assert.equal(new Set(dto.users.flatMap((user:any)=>user.findings.map((finding:any)=>finding.id))).size,3)
}))

for(const foreignOrganization of [true,false])test(`mailbox purpose cannot leak across ${foreignOrganization?'organization':'tenant'} scope`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await seedMailbox(f,f.scope.humanId,null)
  let foreign=f.scopes[1]
  if(!foreignOrganization){
    foreign={organizationId:f.scope.organizationId,customerTenantId:randomUUID()}
    await f.prisma.customerTenant.create({data:{id:foreign.customerTenantId,organizationId:foreign.organizationId,microsoftTenantId:randomUUID(),displayName:'Synthetic different tenant',status:'ACTIVE'}})
  }
  await seedPurpose(f,foreign,[{mailboxUserId:f.scope.humanId,userPurpose:'user'}])
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.users.length,2);assert.equal(dto.users.find((user:any)=>user.subjectType==='USER').priority,'MEDIUM')
  assert.equal(dto.users.find((user:any)=>user.subjectType==='MAILBOX').priority,'HIGH')
}))

for(const change of ['snapshot-generation','attestation-digest','attestation-state','legacy-no-pins'] as const)test(`persisted GET fails closed after mailbox ${change}`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await seedMailbox(f);await f.evaluate()
  const scope={organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId}
  if(change==='snapshot-generation')await f.prisma.tenantEntraSnapshot.updateMany({where:{...scope,resourceType:'EXCHANGE_MAILBOX_RULES'},data:{observedAt:new Date(f.base.getTime()+1000)}})
  else if(change==='legacy-no-pins')await f.client.query("UPDATE identity_risk_evaluation_runs SET aggregate=aggregate-'assessmentMailboxGenerations' WHERE organization_id=$1 AND customer_tenant_id=$2",[scope.organizationId,scope.customerTenantId])
  else await f.prisma.tenantCollectionFieldState.updateMany({where:{...scope,fieldKey:sourceAttestationKey('EXCHANGE_MAILBOX_RULES')},data:change==='attestation-digest'?{correlationId:'a'.repeat(64)}:{state:'FAILED'}})
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  const human=dto.users.find((user:any)=>user.subjectType==='USER')
  assert.equal(human.priority,'MEDIUM','Old mailbox finding must not retain current HIGH priority')
  assert.equal(human.findings.find((finding:any)=>finding.ruleId==='HV-ID-MBX-001.v1').activityState,'UNKNOWN')
  assert.equal(dto.sources.find((source:any)=>source.source==='MAILBOX_RULES').status,'FAILED')
  assert.equal(dto.meta.capability,'PARTIAL')
}))

for(const complete of [true,false])test(`zero findings retain exact ${complete?'complete':'partial'} assessed scope without claiming safety`,{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await f.prisma.signInLog.deleteMany({where:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId}})
  await f.evaluate()
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.users.length,0)
  assert.equal(dto.rules[0].status,complete?'READY':'PARTIAL')
  assert.equal(dto.rules[0].matchedIdentities,complete?0:null)
  assert.notEqual(dto.meta.capability,'FULL','Mailbox remains unavailable')
},false,complete))

test('capacity refusal commits unavailable metadata without pretending to evaluate empty evidence',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await f.prisma.signInLog.updateMany({where:{organizationId:f.scope.organizationId,customerTenantId:f.scope.customerTenantId,microsoftSignInId:'failure-0'},
    data:{raw:{...f.records[0].raw,oversized:'x'.repeat(17000)}}})
  const {result,batch}=await f.evaluate()
  assert.equal(result.status,'COMPLETED');assert.equal(batch.capability,'UNAVAILABLE');assert.equal(batch.sourceObservedAt,undefined)
  const dto=await f.service.assessment(f.scope.identity,f.scope.customerTenantId)
  assert.equal(dto.meta.capability,'UNAVAILABLE');assert.equal(dto.meta.status,'NOT_EVALUATED');assert.equal(dto.users.length,0)
  assert.ok(dto.rules.filter((rule:any)=>rule.ruleId!=='HV-ID-MBX-001.v1').every((rule:any)=>rule.reasonCode==='CAPACITY_LIMIT'&&rule.matchedIdentities===null))
}))

test('authorization is rechecked after private enrichment and before returning an assessment',{skip:!enabled,timeout:60_000},()=>fixture(async f=>{
  await f.evaluate()
  const read=f.reader.read.bind(f.reader)
  f.reader.read=async(...args:any[])=>{
    const value=await read(...args)
    await f.prisma.membership.updateMany({where:{organizationId:f.scope.organizationId,userId:f.scope.identity.subject},data:{status:'SUSPENDED'}})
    return value
  }
  await assert.rejects(()=>f.service.assessment(f.scope.identity,f.scope.customerTenantId),/Tenant access denied|active organization|workspace/i)
}))
