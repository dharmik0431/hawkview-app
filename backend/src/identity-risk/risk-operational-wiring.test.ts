import assert from 'node:assert/strict'
import test from 'node:test'
import { Logger } from '@nestjs/common'
import { TenantSyncService, runInSyncMemoryLane } from '../tenants/tenant-sync.service.js'
import { ScheduledSyncController } from '../tenants/scheduled-sync.controller.js'
import { RiskGlobalWorkStore } from './risk-global-work-store.js'
import { RiskAssessmentReader } from './risk-assessment-reader.service.js'
import { runGlobalRiskCycle } from './risk-global-cycle.js'
import { type CycleReason, READER_FLUSH_MS } from './risk-operational-diagnostics.js'

const settings = { HAWKVIEW_IDENTITY_RISK_ROLLOUT:'global', HAWKVIEW_IDENTITY_RISK_MODE:'shadow',
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-v1', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:'synthetic',
  HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:undefined }
async function configured(work:()=>Promise<void>) {
  const before=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]))
  for(const[k,v]of Object.entries(settings)){if(v===undefined)delete process.env[k];else process.env[k]=v}
  try{await work()}finally{for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
}
const scope={organizationId:'00000000-0000-0000-0000-000000000001',customerTenantId:'00000000-0000-0000-0000-000000000002',environment:'synthetic'}
function service(){return new TenantSyncService({}as any,{}as any,{}as any,{}as any,{}as any,{}as any)}

test('actual scheduler handoff reports commit only for completed assessment persistence result',()=>configured(async()=>{
  for(const status of ['OFF','HARD_DISABLED','IN_PROGRESS','REPLAYED','COMPLETED']){
    const s=service(); const observations:CycleReason[]=[]
    ;(s as any).riskAssessmentProjector={load(){throw new Error('must not materialize synthetic source')}}
    ;(s as any).identityRiskEvaluationScheduler={runAssessmentTenant:async()=>({status})}
    await (s as any).runPostSyncIdentityRiskEvaluation({id:scope.customerTenantId,organizationId:scope.organizationId},Date.now()+45_000,'synthetic-attempt',(reason:CycleReason)=>observations.push(reason))
    assert.deepEqual(observations,[status==='COMPLETED'?'COMMITTED':'RETURNED_UNCOMMITTED'])
  }
  const s=service(); const observations:CycleReason[]=[]
  ;(s as any).logger={warn(){}}
  ;(s as any).riskAssessmentProjector={}
  ;(s as any).identityRiskEvaluationScheduler={runAssessmentTenant:async()=>{throw new Error('token=SECRET')}}
  await assert.rejects(()=>(s as any).runPostSyncIdentityRiskEvaluation({id:scope.customerTenantId,organizationId:scope.organizationId},Date.now()+45_000,'synthetic-attempt',(r:CycleReason)=>observations.push(r)),/IDENTITY_RISK_CYCLE_UNAVAILABLE/)
  assert.equal(observations.length,0)
  // Legacy shadow path still swallows failure without reporting success.
  delete process.env.HAWKVIEW_IDENTITY_RISK_ROLLOUT
  await (s as any).runPostSyncIdentityRiskEvaluation({id:scope.customerTenantId,organizationId:scope.organizationId},undefined,undefined,(r:CycleReason)=>observations.push(r))
  assert.deepEqual(observations,[])
}))

test('actual cycle preserves busy lane and lease/dependency/config outcomes without queued work',()=>configured(async()=>{
  const original=RiskGlobalWorkStore.prototype.claimCycle; let claims=0
  RiskGlobalWorkStore.prototype.claimCycle=async()=>{claims++;return null}
  let release!:()=>void
  try{
    const s=service(); const reasons:CycleReason[]=[]; const observe=(r:CycleReason)=>{reasons.push(r)}
    await s.runScheduledGlobalRiskCycle(Date.now()+45_000,observe)
    assert.deepEqual(reasons.splice(0),['DEPENDENCY_UNAVAILABLE'])
    ;(s as any).identityRiskEvaluationScheduler={};(s as any).riskAssessmentProjector={}
    const held=runInSyncMemoryLane(()=>new Promise<void>(resolve=>{release=resolve}))
    await s.runScheduledGlobalRiskCycle(Date.now()+45_000,observe)
    assert.deepEqual(reasons.splice(0),['MEMORY_LANE_BUSY']);assert.equal(claims,0)
    release();await held
    await s.runScheduledGlobalRiskCycle(Date.now()+45_000,observe)
    assert.deepEqual(reasons.splice(0),['LEASE_BUSY']);assert.equal(claims,1)
    process.env.HAWKVIEW_IDENTITY_RISK_MODE='off'
    await s.runScheduledGlobalRiskCycle(Date.now()+45_000,observe)
    assert.deepEqual(reasons,['CONFIG_UNAVAILABLE'])
  }finally{release?.();RiskGlobalWorkStore.prototype.claimCycle=original}
}))

test('global result and lease release unchanged when diagnostic callback throws',()=>configured(async()=>{
  let release=0
  const deps={claimCycle:async()=>({id:scope.organizationId,environment:'synthetic'}),nextScope:async()=>null,
    releaseCycle:async()=>{release++},recordAttempt:async()=>'',ensure:async()=>{},evaluate:async()=>{},
    observe:()=>{throw new Error('SECRET')}}
  assert.deepEqual(await runGlobalRiskCycle(deps,Date.now()+45_000),{status:'COMPLETED',attempted:0,completed:0,failed:0})
  assert.equal(release,1)
}))

test('controller emits exactly one diagnostic per authenticated cycle; throwing sink preserves result',()=>configured(async()=>{
  const original=Logger.prototype.log
  try{
    for(const outcome of ['COMMITTED','ATTEMPT_FAILED','RETURNED_UNCOMMITTED'] as const){
      const lines:string[]=[]
      Logger.prototype.log=function(message:unknown){if(typeof message==='string'&&message.includes('risk_cycle_diagnostic'))lines.push(message)}
      const controller=new ScheduledSyncController({verify:async()=>{}}as any,{
        runScheduledGlobalRiskCycle:async(_deadline:number,observe:(reason:CycleReason)=>void)=>{
          if(outcome==='ATTEMPT_FAILED')throw new Error('password=SECRET')
          observe(outcome)
        },syncDueTenants:async()=>({status:'unchanged'}),
      }as any,{runAuthorizedScheduledMaintenance:async()=>({hasMore:false})}as any)
      ;(controller as any).logger={log(){},warn(){}}
      assert.deepEqual(await controller.syncDueTenants({headers:{}}as any),{status:'unchanged'})
      assert.deepEqual(lines.map(l=>JSON.parse(l)),[{version:1,eventName:'risk_cycle_diagnostic',reason:outcome}])
      Logger.prototype.log=function(){throw new Error('SECRET')}
      assert.deepEqual(await controller.syncDueTenants({headers:{}}as any),{status:'unchanged'})
    }
  }finally{Logger.prototype.log=original}
}))

test('reader busy branch remains fail-closed and emits only delayed aggregate, not request data',()=>configured(async()=>{
  const originalInterval=global.setInterval;const originalLog=Logger.prototype.log;const originalNow=Date.now
  let tick:(()=>void)|undefined;const lines:string[]=[];let release!:()=>void
  global.setInterval=((callback:()=>void)=>{tick=callback;return{unref(){}}})as any
  Logger.prototype.log=function(message:unknown){if(typeof message==='string'&&message.includes('risk_reader_diagnostic'))lines.push(message)}
  try{
    const reader=new RiskAssessmentReader({configured:true,allowsScope:()=>true,pin:()=>{throw new Error('must not load key')}}as any)
    const held=runInSyncMemoryLane(()=>new Promise<void>(resolve=>{release=resolve}))
    const result=await reader.read(scope,{id:'synthetic',pseudonymKeyVersionId:'synthetic-key',completedAt:new Date()},new Date(),false)
    assert.equal(result.meta.capability,'UNAVAILABLE');assert.equal(result.meta.evaluatedAt,null)
    assert.ok(result.rules.every(rule=>rule.reasonCode==='SOURCE_UNAVAILABLE'))
    assert.equal(lines.length,0);assert.ok(tick)
    Date.now=()=>originalNow()+READER_FLUSH_MS+100
    tick!();tick!()
    assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]!).counters.MEMORY_LANE_BUSY,1)
    assert.doesNotMatch(lines[0]!,/synthetic|00000000|scope|tenant|keyId/)
    release();await held
  }finally{release?.();global.setInterval=originalInterval;Logger.prototype.log=originalLog;Date.now=originalNow}
}))

test('actual controller distinguishes config, maintenance and elapsed admission gates',()=>configured(async()=>{
  const originalLog=Logger.prototype.log;const originalNow=Date.now
  try{
    for(const expected of ['CONFIG_UNAVAILABLE','MAINTENANCE_DEFERRED','ADMISSION_BUDGET_EXHAUSTED']){
      const lines:string[]=[];let riskCalls=0
      process.env.HAWKVIEW_IDENTITY_RISK_MODE=expected==='CONFIG_UNAVAILABLE'?'off':'shadow'
      let now=originalNow();Date.now=()=>now
      Logger.prototype.log=function(message:unknown){if(typeof message==='string'&&message.includes('risk_cycle_diagnostic'))lines.push(message)}
      const c=new ScheduledSyncController({verify:async()=>{}}as any,{
        runScheduledGlobalRiskCycle:async()=>{riskCalls++},syncDueTenants:async()=>({status:'unchanged'}),
      }as any,{runAuthorizedScheduledMaintenance:async()=>{
        if(expected==='ADMISSION_BUDGET_EXHAUSTED')now+=50_000
        return{hasMore:expected==='MAINTENANCE_DEFERRED'}
      }}as any)
      ;(c as any).logger={log(){},warn(){}}
      assert.deepEqual(await c.syncDueTenants({headers:{}}as any),{status:'unchanged'})
      assert.equal(riskCalls,0);assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]!).reason,expected)
    }
  }finally{Logger.prototype.log=originalLog;Date.now=originalNow}
}))
