import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTenantHealth, TENANT_HEALTH_RESOURCE_REGISTRY } from './tenant-health.js'
import { ATTENTION_COLLECTOR_RESOURCES, readAttentionProvenance, collectorAttentionProvenance } from './attention-provenance.js'
import { summarizeMicrosoftRisk } from '../identity-risk/microsoft-risk-summary.js'
const now = new Date('2026-09-29T12:00:00Z')
const base = { tenantId: 'synthetic', effectiveStatus: 'active', connectionStatus: 'ACTIVE', missingPermissions: [] as string[], syncStates: [], authSnapshot: null, riskyIdentityCount: null, now }
const failed = (resourceType: string, code = 'HAWKVIEW_INTERNAL_FAILURE') => ({ resourceType, status: 'FAILED', lastAttemptAt: now, lastSuccessfulAt: now, lastErrorCode: code, lastErrorMessage: 'opaque test message', consecutiveFailures: 3 })
test('resource mapping is exhaustive against the health registry', () => assert.deepEqual([...ATTENTION_COLLECTOR_RESOURCES].sort(), TENANT_HEALTH_RESOURCE_REGISTRY.map(r => r.resourceType).sort()))
for (const resource of ATTENTION_COLLECTOR_RESOURCES) test(`actual collector constructor ${resource}`, () => {
  const item = deriveTenantHealth({ ...base, syncStates: [failed(resource)] }).attention.find(x => x.key === `sync-${resource.toLowerCase()}`)!
  assert.deepEqual(item.provenance, { version: 1, origin: 'COLLECTION_OPERATION', kind: 'COLLECTOR_ATTENTION', resourceType: resource, remediationOwner: 'HAWKVIEW_OPERATIONS' })
  assert.deepEqual(readAttentionProvenance(JSON.parse(JSON.stringify(item.provenance))), item.provenance)
})
test('connection and consent ownership requires explicit facts', () => {
  for (const [connectionStatus, effectiveStatus, owner] of [['REVOKED','disconnected','CUSTOMER_ADMIN'],['ERROR','disconnected','UNDETERMINED'],['ACTIVE','disconnected','UNDETERMINED']]) {
    const item=deriveTenantHealth({...base,connectionStatus,effectiveStatus}).attention[0]!
    assert.equal(item.provenance.origin,'ACCESS_CONFIGURATION');assert.equal(item.provenance.remediationOwner,owner)
  }
  for (const input of [{...base,connectionStatus:'PENDING_CONSENT'},{...base,missingPermissions:['AuditLog.Read.All']}]) assert.equal(deriveTenantHealth(input).attention[0]!.provenance.remediationOwner,'CUSTOMER_ADMIN')
  assert.equal(deriveTenantHealth({...base,effectiveStatus:'pending'}).attention[0]!.provenance.remediationOwner,'UNDETERMINED')
})
test('403, arbitrary codes and permission-shaped messages never imply customer ownership',()=>{
  for(const code of ['403','MICROSOFT_PERMISSION_REQUIRED','401','MICROSOFT_AUTHENTICATION_REQUIRED','unrecognized']) {
    const row={...failed('USERS',code),lastErrorMessage:'customer consent permission forbidden'}
    assert.equal(deriveTenantHealth({...base,syncStates:[row]}).attention[0]!.provenance.remediationOwner,'UNDETERMINED')
  }
  assert.equal(collectorAttentionProvenance('NEW_RESOURCE','HAWKVIEW_INTERNAL_FAILURE').origin,'UNKNOWN')
  assert.equal(collectorAttentionProvenance('USERS','sign-ins-record-validation-partial').remediationOwner,'UNDETERMINED')
})
for(const [activity,type,kind] of [
 ['Disable conditional access policy','conditionalAccessPolicy','CONDITIONAL_ACCESS_CHANGE'],
 ['Delete authentication method','authenticationMethod','AUTHENTICATION_CHANGE'],
 ['Update application','application','APPLICATION_ACCESS_CHANGE'],
 ['Update directory role','Role','ADMINISTRATIVE_ROLE_CHANGE'],
]) test(`audit producer ${kind}`,()=>{
 const result=deriveTenantHealth({...base,auditEvents:[{microsoftAuditId:'synthetic-event',eventDateTime:now,activityDisplayName:activity,category:'UserManagement',operationType:'Update',result:'success',initiatedBy:{user:{userPrincipalName:'admin@example.invalid'}},targetResources:[{displayName:'Synthetic target',type}]}]})
 assert.equal(result.attention.length,1);assert.equal(result.attention[0]!.provenance.kind,kind);assert.equal(result.attention[0]!.provenance.origin,'TENANT_FINDING')
})
test('partial Microsoft positives and MFA findings coexist with operations without an exact zero',()=>{
 const microsoftRiskSummary=summarizeMicrosoftRisk({payload:[{id:'synthetic',riskState:'atRisk',riskLevel:'high'},{}],snapshotObservedAt:now,collectionSucceededAt:now,collectionStatus:'SUCCEEDED',now})
 const result=deriveTenantHealth({...base,microsoftRiskSummary,syncStates:[failed('USERS')],authSnapshot:{observedAt:now,payload:[{isMfaRegistered:false}]}})
 assert.equal(result.riskyIdentityCount,null);assert.equal(result.microsoftRiskSummary,microsoftRiskSummary)
 assert.equal(result.attention.find(x=>x.key==='risky-identities')!.provenance.kind,'MICROSOFT_ACTIVE_RISK')
 assert.equal(result.attention.find(x=>x.key==='mfa-coverage')!.provenance.kind,'MFA_REGISTRATION_COVERAGE')
 assert.equal(result.attention.find(x=>x.key==='sync-users')!.provenance.origin,'COLLECTION_OPERATION')
})
test('limited evidence remains a limitation, not a finding or completed execution',()=>{
 const result=deriveTenantHealth({...base,syncStates:[{...failed('SIGN_INS','sign-ins-non-premium-fallback-active'),status:'RUNNING',consecutiveFailures:0}]})
 assert.deepEqual(result.attention.find(x=>x.key==='sign-ins-limited-evidence')!.provenance,{version:1,origin:'EVIDENCE_LIMITATION',kind:'LIMITED_SIGN_IN_EVIDENCE',remediationOwner:'UNDETERMINED'})
})
test('missing, future, malformed and unknown tags remain unclassified without dropping records',()=>{
 const tags=[undefined,null,[],{}, {version:2,origin:'TENANT_FINDING'}, {version:1,origin:'TENANT_FINDING',kind:'COLLECTOR_ATTENTION',remediationOwner:'CUSTOMER_ADMIN'}, {version:1,origin:'COLLECTION_OPERATION',kind:'COLLECTOR_ATTENTION',resourceType:'NEW',remediationOwner:'HAWKVIEW_OPERATIONS'}, {version:1,origin:'TENANT_FINDING',kind:'MICROSOFT_ACTIVE_RISK',remediationOwner:'CUSTOMER_ADMIN',extra:'untrusted'}]
 const items=tags.map((tag,id)=>({id,tag,classification:readAttentionProvenance(tag)}))
 assert.equal(items.length,tags.length);for(const item of items)assert.equal(item.classification.origin,'UNKNOWN')
 assert.equal(deriveTenantHealth(base).riskyIdentityCount,null)
})
