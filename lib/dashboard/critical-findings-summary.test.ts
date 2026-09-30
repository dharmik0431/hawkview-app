import assert from 'node:assert/strict'
import test from 'node:test'
import { criticalFindingsSummary } from './critical-findings-summary.ts'
import { tenantFindingProvenance } from '../../backend/src/tenants/attention-provenance.ts'
const critical={key:'positive',label:'Positive finding',why:'Reported evidence',severity:'critical',provenance:tenantFindingProvenance('MICROSOFT_ACTIVE_RISK')}
const tenant={id:'a',data:{status:'COMPLETE'},attention:[critical]}
test('duplicate summaries retain a known positive and uncertainty in either order',()=>{
 for(const rows of [[tenant,{id:'a'}],[{id:'a'},tenant]]){
  const summary=criticalFindingsSummary(rows)
  assert.equal(summary.value,'1 reported');assert.match(summary.coverage,/1 of 1/)
  assert.match(summary.qualification,/incomplete/)
 }
})
test('unusable identities cannot inflate critical count or readable coverage',()=>{
 for(const id of [undefined,null,1,'',' ',' a','a ','a\n','x'.repeat(257)]){
  const summary=criticalFindingsSummary([{...tenant,id}])
  assert.equal(summary.value,'Unavailable');assert.match(summary.coverage,/0 of 0.*without usable tenant IDs/)
 }
})
test('readable malformed rows remain scoped zero with incomplete qualification',()=>{
 const summary=criticalFindingsSummary([{...tenant,attention:[null,{},critical.provenance]}])
 assert.equal(summary.value,'0 reported');assert.match(summary.qualification,/additional findings may be missing/)
})
test('capped complete summaries never establish an exhaustive critical total',()=>{
 const summary=criticalFindingsSummary([{...tenant,attention:Array.from({length:3},(_,i)=>({...critical,key:String(i),severity:'high'}))}])
 assert.equal(summary.value,'0 reported');assert.match(summary.qualification,/not an exhaustive security assessment/)
 assert.doesNotMatch(summary.coverage+summary.qualification,/Current critical|all clear|zero risk/)
})
