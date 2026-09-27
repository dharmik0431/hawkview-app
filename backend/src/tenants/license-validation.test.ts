import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'
import { validatedLicenseRows } from './license-validation.js'
import { deriveCollectionReadiness, microsoftRiskSourceAllowed } from './collection-readiness.js'
const tenant={id:'tenant-a',organizationId:'org-a'}
const now=new Date('2026-09-27T20:00:00Z'), at=new Date(now.getTime()-1000)
const p1={servicePlanId:'p1',servicePlanName:'AAD_PREMIUM',provisioningStatus:'Success'}
const p2={servicePlanId:'p2',servicePlanName:'AAD_PREMIUM_P2',provisioningStatus:'Success'}
const sku=(plans:unknown=[p1])=>({skuId:'sku-a',skuPartNumber:'P1',servicePlans:plans})
function harness(initialRows: any[] = validatedLicenseRows([sku([p2])]), scopedTenant = tenant) {
 const tenant = scopedTenant
 let rows=structuredClone(initialRows), snapshot:any={payload:structuredClone(initialRows),organizationId:tenant.organizationId,observedAt:at}
 const state:any={status:'SUCCEEDED',lastAttemptAt:at,lastSuccessfulAt:at,consecutiveFailures:0}
 let payload:any={value:[sku()]}, responseStatus=200, failCommit=false, resolved=0, saves=0
 const update=(data:any)=> {const failures=data.consecutiveFailures?.increment?state.consecutiveFailures+1:data.consecutiveFailures??state.consecutiveFailures;Object.assign(state,data,{consecutiveFailures:failures});return {...state}}
 const db:any={
  syncState:{upsert:async({where,update:data}:any)=>{assert.equal(where.customerTenantId_resourceType.customerTenantId,tenant.id);return update(data)},update:async({data}:any)=>{return update(data)}},
  $executeRawUnsafe:async()=>0,
  tenantEntraSnapshot:{findUnique:async()=>snapshot,upsert:async({create,update:data}:any)=>{snapshot={...create,...data};saves++;return snapshot}},
  tenantLicense:{upsert:async({create,update:data}:any)=>{assert.equal(create.organizationId,tenant.organizationId);rows=rows.filter(r=>r.skuId!==create.microsoftSkuId);rows.push({...data,skuId:create.microsoftSkuId});},deleteMany:async({where}:any)=>{assert.equal(where.organizationId,tenant.organizationId);assert.equal(where.customerTenantId,tenant.id);rows=rows.filter(r=>where.microsoftSkuId.notIn.includes(r.skuId))}},
  $transaction:async(work:any)=>{const prior={rows:structuredClone(rows),snapshot:structuredClone(snapshot)};try{const result=await work(db);if(failCommit)throw new Error('synthetic commit failure');return result}catch(e){({rows,snapshot}=prior);throw e}},
 }
 const service:any=new TenantSyncService(db,{} as any,{} as any,{publishIncident:async()=>{},resolveIncident:async()=>{resolved++}} as any,{buildSnapshotDifferenceEvidence:()=>[]} as any,{} as any)
 service.changeEvidence={buildSnapshotDifferenceEvidence:()=>[]}
 service.logger={warn(){},log(){}}
 service.fetchGraphPage=async()=>new Response(JSON.stringify(payload),{status:responseStatus})
 return {service,state,get rows(){return rows},get snapshot(){return snapshot},get saves(){return saves},get resolved(){return resolved},set payload(value:any){payload=value},set responseStatus(value:number){responseStatus=value},set failCommit(value:boolean){failCommit=value},run:()=>service.syncLicenses(tenant,'synthetic-token')}
}
for(const [name,value] of Object.entries({blankSKU:[{...sku(),skuId:' '}],longSKU:[{...sku(),skuPartNumber:'x'.repeat(201)}],malformedSKU:[sku(),{}],nullSKU:[null],missingPlans:[{skuId:'x',skuPartNumber:'X'}],malformedPlan:[sku([p1,{}])],overPlans:[sku(Array.from({length:129},(_,i)=>({...p1,servicePlanId:String(i)})))],overSKUs:Array.from({length:1001},(_,i)=>({...sku(),skuId:String(i)})),duplicateSKU:[sku(),sku()],duplicatePlan:[sku([p1,p1])],longPlan:[sku([{...p1,servicePlanName:'x'.repeat(121)}])]})) {
 test(`${name} preserves the prior snapshot, rows and success; complete recovery validates`,async()=>{
  const h=harness();const old=h.snapshot;h.payload={value};await assert.rejects(h.run)
  assert.deepEqual(h.snapshot,old);assert.equal(h.saves,0);assert.equal(h.state.status,'FAILED');assert.equal(h.state.lastSuccessfulAt,at);assert.equal(h.resolved,0)
  h.payload={value:[sku([p2])]};await h.run();assert.equal(h.state.status,'SUCCEEDED');assert.equal(h.saves,1);assert.equal(h.resolved,1)
  assert.equal(h.rows[0].servicePlans[0].servicePlanName, 'AAD_PREMIUM_P2')
 })
}

test('complete empty and unchanged license inventory persists without inventing a loss',async()=>{
 const h=harness([]);h.payload={value:[]};await h.run();assert.equal(h.state.status,'SUCCEEDED');assert.equal(h.rows.length,0);assert.equal(h.saves,1)
 h.payload={value:[sku([p2])]};await h.run();assert.equal(h.rows[0].servicePlans[0].servicePlanName,'AAD_PREMIUM_P2')
 const before=structuredClone(h.snapshot);h.failCommit=true;h.payload={value:[]};await assert.rejects(h.run);assert.deepEqual(h.snapshot,before);assert.equal(h.rows[0].servicePlans[0].servicePlanName,'AAD_PREMIUM_P2')
})
test('partial response and missing value retain the prior complete inventory',async()=>{
 const h=harness();h.responseStatus=206;h.payload={value:[]};await assert.rejects(h.run);assert.equal(h.saves,0)
 h.responseStatus=200;h.payload={};await assert.rejects(h.run);assert.equal(h.saves,0)
 h.payload={value:[], '@odata.nextLink':'https://graph.microsoft.com/next'};await assert.rejects(h.run);assert.equal(h.saves,0)
})
test('invalid/missing/future success clocks cannot make readiness or P2 source allowed',()=>{
 for(const clock of [null,new Date('bad'),new Date(now.getTime()+1),new Date(now.getTime()-26*3600000-1)]){
  const input={connectionStatus:'ACTIVE',connectionVerifiedAt:at,consentedPermissions:['IdentityRiskyUser.Read.All'],licenseServicePlans:[p2],syncStates:[{resourceType:'LICENSES',status:'SUCCEEDED',lastAttemptAt:at,lastSuccessfulAt:clock,lastErrorCode:null,lastErrorMessage:null}],now}
  assert.equal(microsoftRiskSourceAllowed(input),false)
  const d=deriveCollectionReadiness(input).workloads.find(x=>x.key==='entra_identity_protection')!.datasets!.find(x=>x.key==='entra_identity_protection_risky_users')!
  assert.equal(d.licensePrerequisite.state,'UNVERIFIED')
 }
})
test('26 hour inclusive daily policy and canonical valid ingestion are unchanged',()=>{
 for(const hours of [24,25,26]) assert.equal(microsoftRiskSourceAllowed({connectionStatus:'ACTIVE',connectionVerifiedAt:at,consentedPermissions:['IdentityRiskyUser.Read.All'],licenseServicePlans:[p2],syncStates:[{resourceType:'LICENSES',status:'SUCCEEDED',lastAttemptAt:at,lastSuccessfulAt:new Date(now.getTime()-hours*3600000),lastErrorCode:null,lastErrorMessage:null}],now}),true)
 assert.equal(validatedLicenseRows([sku([{...p2,servicePlanName:' AAD_PREMIUM_P2 '}])])[0].servicePlans[0].servicePlanName,'AAD_PREMIUM_P2')
})
test('independent tenants with identical SKU IDs keep separate inventories',async()=>{
 const a=harness(),b=harness([],{id:'tenant-b',organizationId:'org-b'});a.payload={value:[sku()]};b.payload={value:[sku([p2])]};await Promise.all([a.run(),b.run()]);assert.equal(a.rows[0].servicePlans[0].servicePlanName,'AAD_PREMIUM');assert.equal(b.rows[0].servicePlans[0].servicePlanName,'AAD_PREMIUM_P2')
})
