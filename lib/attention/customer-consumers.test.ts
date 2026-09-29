import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as customer from './customer-attention.ts'
import * as attention from './computeTenantAttention.ts'
import * as risk from '../identity-risk/microsoft-risk-summary.ts'
import * as navigation from '../tenants/navigation.ts'
import { tenantFindingProvenance, collectorAttentionProvenance, accessProvenance } from '../../backend/src/tenants/attention-provenance.ts'
const require = createRequire(import.meta.url), ts = require('typescript')
function compile(path: string): any {
 const ex = {}; const source=readFileSync(new URL(path,import.meta.url),'utf8')
 const js=ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 const mocks:Record<string,unknown>={'lucide-react':new Proxy({},{get:()=>()=>null}),'@/components/ui/badge':{},'@/lib/utils':{},'@/lib/attention/customer-attention':customer,'@/lib/attention/computeTenantAttention':attention,'@/lib/identity-risk/microsoft-risk-summary':risk,'@/lib/tenants/navigation':navigation}
 new Function('require','exports',js)((name:string)=>mocks[name]??require(name),ex);return ex
}
const matrix=compile('../../components/dashboard/tenant-risk-matrix-helpers.ts'),directory=compile('../../components/tenants/tenant-status-badge.tsx')
const row=(provenance:unknown,key='arbitrary')=>({key,label:'Reported item',why:'Supporting evidence.',severity:'high',provenance})
const finding=row(tenantFindingProvenance('MFA_REGISTRATION_COVERAGE'),'sync-collector-spoof'), access=row(accessProvenance('AUTHORIZATION_REQUIRED',true),'risky-spoof'),ops=row(collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE'),'risky-critical'),unknown=row(undefined)
const base={id:'tenant-a',connectionStatus:'error',status:'active',data:{status:'COMPLETE'},healthScore:100,lastSync:'2026-09-29T17:59:00.000Z',missingPermissions:[],attention:[] as any[]}
for(const [name,rows,actions,findings] of [['mixed',[finding,access,ops,unknown],2,1],['operations',[ops],null,null],['unknown',[unknown],null,null],['access',[access],1,0],['findings',[finding],1,1],['empty',[],0,0]] as const){
 test(`${name}: directory and dashboard counts/status preserve the same partition`,()=>{
  const tenant={...base,attention:rows};const v=customer.customerAttention(tenant)
  assert.equal(matrix.getTenantActiveIssuesInfo(tenant).count,actions);assert.equal(matrix.getTenantThreatsInfo(tenant).count,findings)
  assert.equal(directory.getTenantDisplayStatus(tenant).label,customer.customerStatus(v));assert.equal(matrix.getTenantMatrixOverallState(tenant).label,customer.customerStatus(v))
  if(v.incomplete){assert.match(directory.getTenantDisplayStatus(tenant).label,/incomplete/);assert.match(matrix.getTenantActiveIssuesInfo(tenant).summaryText,/incomplete|unavailable/i)}
 })
}
for(const connectionStatus of ['error','disconnected','pending-consent'])test(`partial Microsoft positives survive ${connectionStatus} without becoming exact or native counts`,()=>{
 const at='2026-09-15T12:00:00.000Z'
 const tenant={...base,connectionStatus,microsoftRiskSummary:{source:'MICROSOFT_IDENTITY_PROTECTION',availability:'PARTIAL',completeness:'PARTIAL',rawRecordCount:3,observedActiveDistinctUserCount:2,activeDistinctUserCount:null,snapshotObservedAt:at,collectionSucceededAt:at,reasonCode:'PARTIAL_RECORDS'}}
 const v=matrix.getTenantRiskyUsersInfo(tenant);assert.equal(v.count,2);assert.equal(v.isExact,false)
 assert.match(matrix.getTenantIdentityInfo(tenant).riskyText,/2 identities/);assert.equal(matrix.getTenantRecommendedAction(tenant).destinationUrl,navigation.tenantRiskyUsersPath(tenant.id))
 assert.equal(matrix.getTenantThreatsInfo(tenant).count,0)
})
test('unknown ownership never manufactures reconnect or permission remediation',()=>{
 for(const connectionStatus of ['error','disconnected','revoked']){
  const tenant={...base,connectionStatus,missingPermissions:['403'],attention:[row(accessProvenance('CONNECTION_UNAVAILABLE',false))]}
  assert.equal(matrix.getTenantRecommendedAction(tenant).label,'View tenant');assert.equal(directory.getTenantDisplayStatus(tenant).primaryActionLabel,'View tenant')
 }
})
