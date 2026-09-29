import assert from 'node:assert/strict'
import test from 'node:test'
import { computeTenantAttention, tenantActionableHealthProjection } from './computeTenantAttention.ts'
import { customerAttention, customerTarget, customerHealthScore } from './customer-attention.ts'
import { tenantFindingProvenance, collectorAttentionProvenance, accessProvenance, limitedEvidenceProvenance } from '../../backend/src/tenants/attention-provenance.ts'
const row = (provenance?: unknown, overrides = {}) => ({key:'arbitrary',label:'Reported evidence',why:'Supporting evidence.',severity:'high',provenance,...overrides})
const finding = () => row(tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'))
const source = (attention: unknown) => ({data:{status:'COMPLETE'},attention})
test('mixed source keeps tenant findings and explicit access, retaining diagnostics and uncertainty', () => {
 const raw = [finding(), row(accessProvenance('AUTHORIZATION_REQUIRED',true)), row(collectorAttentionProvenance('USERS','HAWKVIEW_INTERNAL_FAILURE')), row(limitedEvidenceProvenance(),{severity:'low'}), row()]
 const v = customerAttention(source(raw))
 assert.equal(v.findings.length,1);assert.equal(v.accessActions.length,1);assert.equal(v.operations.length,1);assert.equal(v.limitations.length,1);assert.equal(v.unknown.length,1);assert.equal(v.incomplete,true);assert.equal(v.raw,raw)
 const projection = tenantActionableHealthProjection(source(raw));assert.equal(projection.status,'UNAVAILABLE');assert.equal(projection.items.length,2)
})
for (const [name, provenance] of Object.entries({missing:undefined,future:{...tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'),version:2},extra:{...tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'),extra:true},wrongOwner:{...tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'),remediationOwner:'HAWKVIEW_OPERATIONS'},unknownKind:{...tenantFindingProvenance('MICROSOFT_ACTIVE_RISK'),kind:'FUTURE'},undeterminedAccess:accessProvenance('CONNECTION_UNAVAILABLE',false)})) {
 test(`${name} cannot promote text, severity, key or HTTP code into customer ownership`, () => {
  const v=customerAttention(source([row(provenance,{key:'risky-identities',label:'Critical MFA permission missing 403',severity:'critical'})]))
  assert.equal(v.findings.length+v.accessActions.length,0);assert.equal(v.unknown.length,1);assert.equal(v.incomplete,true)
 })
}
test('no client heuristic fallback manufactures tenant findings or access actions', () => {
 assert.deepEqual(computeTenantAttention({connectionStatus:'revoked',missingPermissions:['Permission'],users:[{role:'Global Administrator',mfaRegistration:'Not registered'}]}),[])
})
test('malformed rows preserve independently valid positive evidence', () => {
 const v=customerAttention(source([finding(),null,row(tenantFindingProvenance('MFA_REGISTRATION_COVERAGE'),{why:'bad\ntext'})]));assert.equal(v.findings.length,1);assert.equal(v.unknown.length,2);assert.equal(v.incomplete,true)
})
test('authoritative malformed source never falls through to another container', () => {
 const v=customerAttention({attention:null,tenantHealth:source([finding()])});assert.equal(v.sourceAvailable,false);assert.equal(v.findings.length,0)
})
test('empty supplied coverage is distinguished from unavailable, capped, and historical data', () => {
 assert.equal(customerAttention(source([])).incomplete,false)
 for (const value of [{},source(null),source(Array(101).fill(finding())),{attention:[]}]) assert.equal(customerAttention(value).incomplete,true)
})
test('all collector resource kinds remain diagnostics even with threatening labels', () => {
 for (const resource of ['USERS','SIGN_INS','LICENSES','APPLICATIONS','EXCHANGE_MAILBOXES']) {
  const v=customerAttention(source([row(collectorAttentionProvenance(resource,null),{label:'Attack detected',severity:'critical'})]));assert.equal(v.operations.length,1);assert.equal(v.findings.length,0);assert.equal(v.incomplete,true)
 }
})
test('navigation uses provenance kind, never misleading keys', () => {
 assert.equal(customerTarget(tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')),'risky-users')
 assert.equal(customerTarget(tenantFindingProvenance('MFA_REGISTRATION_COVERAGE')),'entra')
 assert.equal(customerTarget(accessProvenance('AUTHORIZATION_REQUIRED',true)),'settings')
 assert.equal(customerTarget(accessProvenance('CONNECTION_UNAVAILABLE',false)),'overview')
})
test('mixed health scores never become tenant security scores', () => {for(const score of [0,50,100,null,undefined])assert.equal(customerHealthScore({healthScore:score}),null)})
test('typed access and finding metadata survive projection for downstream source isolation', () => {
 const action={...finding(),actionUrl:'/tenants/a/risky-users',actionLabel:'Review Microsoft risk'}
 const p=tenantActionableHealthProjection(source([action]));assert.equal(p.status,'VERIFIED');assert.equal(p.items[0].actionUrl,action.actionUrl);assert.equal(p.items[0].provenance?.origin,'TENANT_FINDING')
})
