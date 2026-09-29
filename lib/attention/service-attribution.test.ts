import assert from 'node:assert/strict'
import test from 'node:test'
import { serviceAttribution } from './service-attribution.ts'
import { ATTENTION_COLLECTOR_RESOURCES, collectorAttentionProvenance } from '../../backend/src/tenants/attention-provenance.ts'
const resourceServices = {
 USERS:'entra', LICENSES:null, DOMAINS:null, GROUPS:'entra', AUTH_REGISTRATIONS:'entra',
 CONDITIONAL_ACCESS:'entra',APPLICATIONS:'entra',SERVICE_PRINCIPALS:'entra',AUDIT_LOGS:'entra',
 M365_AUDIT:'o365',SIGN_INS:'entra',SECURE_SCORES:null,DEVICES:'entra',DIRECTORY_ROLES:'entra',
 EXCHANGE_MAILBOXES:'exchange',EXCHANGE_MAILBOX_SETTINGS:'exchange',EXCHANGE_ACCEPTED_DOMAINS:'exchange',EXCHANGE_MAILBOX_RULES:'exchange',
 SHAREPOINT_SITES:'sharepoint',SHAREPOINT_SETTINGS:'sharepoint',SHAREPOINT_USAGE:'sharepoint',
} as const
for(const resource of ATTENTION_COLLECTOR_RESOURCES)test(`closed collector identity ${resource} establishes coverage only`,()=>{
 const value=serviceAttribution({data:{status:'COMPLETE'},attention:[{key:'exchange-guess',label:'SharePoint guess',why:'Permission guess',severity:'critical',provenance:collectorAttentionProvenance(resource,'HAWKVIEW_INTERNAL_FAILURE')}]})
 for(const [service,state]of Object.entries(value.services)){
  assert.equal(state.finding,false);assert.equal(state.evidenceGap,resourceServices[resource]===service)
 }
 assert.equal(value.unattributed,resourceServices[resource]===null?1:0)
})
test('future resource and extra attribution fields cannot establish a service',()=>{
 for(const provenance of [
  {...collectorAttentionProvenance('USERS',null),resourceType:'FUTURE_EXCHANGE'},
  {...collectorAttentionProvenance('USERS',null),service:'exchange'},
  {...collectorAttentionProvenance('USERS',null),version:2},
 ]){
  const value=serviceAttribution({data:{status:'COMPLETE'},attention:[{key:'sync-exchange_mailboxes',label:'Exchange',why:'Reported',severity:'high',provenance}]})
  assert.equal(value.unattributed,1)
  assert.ok(Object.values(value.services).every(s=>!s.finding&&!s.evidenceGap))
 }
})
