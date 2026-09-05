import assert from 'node:assert/strict'
import test from 'node:test'
import { RiskHistoryRetention, riskHistoryRetentionConfig } from './risk-history-retention.js'
import { ScheduledSyncController } from '../tenants/scheduled-sync.controller.js'

const scope={organizationId:'10000000-0000-4000-8000-000000000001',customerTenantId:'20000000-0000-4000-8000-000000000001'}
const valid={HAWKVIEW_RISK_HISTORY_RETENTION_MODE:'delete',HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES:JSON.stringify([scope])}
test('retention config requires explicit mode AND closed scope; hostile/duplicate/oversized input fails OFF',()=>{
  assert.ok(riskHistoryRetentionConfig(valid))
  for(const mode of [undefined,'','true','shadow','DELETE','off']) assert.equal(riskHistoryRetentionConfig({...valid,HAWKVIEW_RISK_HISTORY_RETENTION_MODE:mode}),null)
  for(const scopes of ['', '[]','*','null','{}','["all"]',JSON.stringify([scope,scope]),JSON.stringify([{...scope,password:'secret'}]),
    JSON.stringify([scope]).replace('"organizationId":','"organizationId":"bad","organizationId":'), ' '.repeat(12001),
    JSON.stringify([scope]).replace('organizationId','organization\\u0049d')])
    assert.equal(riskHistoryRetentionConfig({...valid,HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES:scopes}),null)
  assert.ok(riskHistoryRetentionConfig({...valid,HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES:'all'}))
})

async function configured(work:()=>Promise<void>){
  const keys=[...Object.keys(valid),'HAWKVIEW_IDENTITY_RISK_MODE']
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
  Object.assign(process.env,valid,{HAWKVIEW_IDENTITY_RISK_MODE:'off'})
  try{await work()}finally{for(const k of keys) if(before[k]===undefined) delete process.env[k];else process.env[k]=before[k]}
}
test('retention OFF performs zero database operations',()=>configured(async()=>{
  delete process.env.HAWKVIEW_RISK_HISTORY_RETENTION_MODE
  const worker=new RiskHistoryRetention(); (worker as any).tx=()=>{throw new Error('must not access DB')}
  assert.equal((await worker.run()).status,'OFF')
}))
test('scheduler authenticates then cleanup with risk OFF; no evaluation/key hooks; collection remains independent',()=>configured(async()=>{
  const order:string[]=[];const messages:string[]=[]
  const controller=new ScheduledSyncController({verify:async()=>{order.push('auth')}} as any,
    {syncDueTenants:async()=>{order.push('collection');return {status:'ok'}},runScheduledGlobalRiskCycle:async()=>{throw new Error('evaluation forbidden')}} as any,
    {runAuthorizedRiskHistoryMaintenance:async()=>{order.push('history');return {status:'COMPLETED',runs:1}},runAuthorizedScheduledMaintenance:async()=>{throw new Error('keys/operational maintenance forbidden while OFF')}} as any)
  ;(controller as any).logger={log:(s:string)=>messages.push(s),warn:(s:string)=>messages.push(s)}
  await controller.syncDueTenants({headers:{}} as any)
  assert.deepEqual(order,['auth','history','collection'])
  assert.ok(messages.some(m=>m.includes('risk_history_retention')))
  assert.doesNotMatch(messages.join('\n'),/organizationId|customerTenantId|password/)
}))
test('unauthorized requests cannot reach retention; raw failure is closed and does not block collection',()=>configured(async()=>{
  let cleanup=0,collections=0
  const controller=new ScheduledSyncController({verify:async()=>{throw new Error('unauthorized')}} as any,
    {syncDueTenants:async()=>{collections++;return {status:'ok'}}} as any,
    {runAuthorizedRiskHistoryMaintenance:async()=>{cleanup++;throw new Error('password=secret tenant@example.invalid')}} as any)
  const messages:string[]=[];(controller as any).logger={log:(s:string)=>messages.push(s),warn:(s:string)=>messages.push(s)}
  await assert.rejects(()=>controller.syncDueTenants({headers:{}} as any),/unauthorized/)
  assert.equal(cleanup,0);assert.equal(collections,0)
  ;(controller as any).schedulerTokenVerifier={verify:async()=>{}}
  await controller.syncDueTenants({headers:{}} as any)
  assert.equal(cleanup,1);assert.equal(collections,1)
  assert.doesNotMatch(messages.join('\n'),/password|secret|tenant@example/)
}))

test('cycle enforces scope/time/batch cap, preserves counts and does not infer drained backlog',()=>configured(async()=>{
  const worker=new RiskHistoryRetention()
  let next=0,prunes=0,releases=0
  worker.claim=async()=>({key:'synthetic',id:'synthetic'})
  worker.next=async()=>{next++;return scope}
  worker.prune=async()=>{prunes++;return {findings:256,matchedResults:0,coverage:0,runs:0}}
  worker.release=async()=>{releases++}
  const result=await worker.run()
  assert.equal(next,128);assert.equal(prunes,128);assert.equal(releases,1)
  assert.equal(result.findings,32768);assert.equal(result.backlog,'UNKNOWN')
  assert.doesNotMatch(JSON.stringify(result),/synthetic|organizationId|customerTenantId/)
}))
