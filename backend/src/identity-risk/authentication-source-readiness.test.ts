import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { evaluateAuthenticationRules } from '../risky-users-auth/index.js'
import { SYNTHETIC_SCOPE as scope, SYNTHETIC_NOW, at, auditRecord, graphRecord } from '../risky-users-auth/fixtures.js'
import { AUTH_WINDOW_SCHEMA, authenticationWindow, mergeAuthenticationWindow, prepareAuthenticationEvaluation,
  type AuthenticationDirectoryUser, type AuthenticationProof, type AuthenticationReference, type AuthenticationRow, type AuthenticationWindow } from './authentication-source-readiness.js'
const now = new Date(SYNTHETIC_NOW)
const user: AuthenticationDirectoryUser = { organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
  microsoftUserId:'11111111-1111-4111-8111-111111111111',userPrincipalName:'synthetic.human@example.invalid',userType:'Member' }
const reference: AuthenticationReference = async (kind, identifiers) => `hvr1_${kind}_${createHash('sha256').update(JSON.stringify(identifiers)).digest('hex')}`
const graphProof: AuthenticationProof = { status:'SUCCEEDED',lastSuccessfulAt:now,lastAttemptAt:new Date(at(-2)),lastErrorCode:null }
const stsProof: AuthenticationProof = { ...graphProof,status:'RUNNING',lastErrorCode:'sign-ins-non-premium-fallback-active' }
const window = (sts=false, complete=true): AuthenticationWindow => ({schemaVersion:AUTH_WINDOW_SCHEMA,source:sts?'M365_AUDIT_STS':'GRAPH_SIGN_INS',start:at(-24*60),end:SYNTHETIC_NOW,paginationComplete:complete})
const row = (raw: unknown): AuthenticationRow => ({organizationId:scope.organizationId,customerTenantId:scope.customerTenantId,raw,ingestedAt:now})
const run = (rows: AuthenticationRow[], options: {sts?:boolean;complete?:boolean;users?:AuthenticationDirectoryUser[];window?:AuthenticationWindow;proof?:AuthenticationProof}={}) =>
  prepareAuthenticationEvaluation(scope, rows, options.users??[user], options.proof??(options.sts?stsProof:graphProof), options.window??window(options.sts,options.complete),true,now,reference)
test('exact Graph and non-P2 STS witnesses produce A/B without provider calls; source fields remain independent',async()=>{
  for(const sts of [false,true]) {
    const rows=Array.from({length:10},(_,i)=>row(sts?{hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:auditRecord({Id:`event-${i}`,CreationTime:at(-10+i),ActorIpAddress:'192.0.2.10'})}:graphRecord({id:`event-${i}`,createdDateTime:at(-10+i)})))
    rows.push(row(sts?{hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:auditRecord({Id:'success',CreationTime:SYNTHETIC_NOW,Operation:'UserLoggedIn',ErrorCode:'0',ActorIpAddress:'192.0.2.10'})}:graphRecord({id:'success',createdDateTime:SYNTHETIC_NOW,status:{errorCode:0}})))
    const result=await run(rows,{sts});assert.ok(result.input)
    const evaluated=evaluateAuthenticationRules(result.input)
    assert.deepEqual(evaluated.findings.map(f=>f.ruleId).sort(),['HV-ID-AUTH-005.v2','HV-ID-AUTH-010.v1'])
    assert.equal(result.input.source,sts?'M365_AUDIT_STS':'GRAPH_SIGN_INS')
  }
})
test('partial legacy window permits supported positives but never a complete clean assessment',async()=>{
  const rows=Array.from({length:10},(_,i)=>row(graphRecord({id:`event-${i}`,createdDateTime:at(-10+i)})))
  const result=await run(rows,{complete:false});assert.ok(result.input)
  assert.equal(result.input.readiness.paginationComplete,false)
  assert.equal(result.sources.find(s=>s.source==='GRAPH_SIGN_INS')?.status,'PARTIAL')
  assert.equal(evaluateAuthenticationRules(result.input).findings.length,1)
  const empty=await run([],{complete:false});assert.ok(empty.input)
  assert.ok(evaluateAuthenticationRules(empty.input).rules.every(r=>r.status==='NOT_EVALUATED'))
})
test('foreign directory/event scope fails closed; tenant references are collision-separated',async()=>{
  await assert.rejects(run([row(graphRecord())],{users:[{...user,organizationId:'other'}]}),/IDENTITY_AUTH_SCOPE_INVALID/)
  await assert.rejects(run([{...row(graphRecord()),customerTenantId:'other'}]),/IDENTITY_AUTH_SCOPE_INVALID/)
  const own=await run([row(graphRecord())]);assert.ok(own.input)
  const otherScope={...scope,organizationId:'other'}
  const other=await prepareAuthenticationEvaluation(otherScope,[{...row(graphRecord()),organizationId:'other'}],[{...user,organizationId:'other'}],graphProof,window(),true,now,reference)
  assert.notEqual(own.input.events[0]?.subjectRef,other.input?.events[0]?.subjectRef)
})
test('valid nonselected feed never pools; malformed markers and unknown outcomes prevent clean readiness',async()=>{
  const clean=await run([row({hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:auditRecord()})])
  assert.equal(clean.input?.events.length,0)
  for(const marker of ['UNKNOWN',null,4,{}]) {
    const result=await run([row({...graphRecord(),hawkviewSource:marker})]);assert.equal(result.input?.readiness.state,'PARTIAL')
  }
  const unresolved=await run([row(graphRecord({userId:'not-a-directory-id'}))]);assert.equal(unresolved.input?.readiness.state,'PARTIAL')
})
test('after-end/future witnesses are excluded; stale and source-swapped proofs cannot evaluate',async()=>{
  const afterEnd=await run([row(graphRecord({createdDateTime:at(-1)}))],{window:{...window(),end:at(-2)}})
  assert.equal(afterEnd.input?.events.length,0);assert.equal(afterEnd.input?.readiness.state,'PARTIAL')
  assert.equal((await run([],{window:{...window(),start:at(-1500),end:at(-61)}})).input,null)
  assert.equal((await run([],{window:window(true)})).input,null)
  assert.equal((await run([],{proof:{...graphProof,lastAttemptAt:new Date(at(1))}})).input,null)
})
test('page-chain proof cannot be manufactured from failed/partial collection or carried across a source swap',()=>{
  assert.throws(()=>mergeAuthenticationWindow(window(),'GRAPH_SIGN_INS',new Date(at(-5)),new Date(at(-1)),true),/WINDOW_SUPERSEDED/)
  assert.throws(()=>mergeAuthenticationWindow(window(), 'GRAPH_SIGN_INS',new Date(at(-2)),now,false),/WINDOW_INVALID/)
  assert.equal(mergeAuthenticationWindow(window(false,false),'GRAPH_SIGN_INS',new Date(at(-2)),now,true).start,at(-2))
  assert.equal(mergeAuthenticationWindow(window(true),'GRAPH_SIGN_INS',new Date(at(-2)),now,true).start,at(-2))
  assert.equal(mergeAuthenticationWindow(window(),'GRAPH_SIGN_INS',new Date(at(-2)),now,true).start,at(-1440))
  assert.equal(authenticationWindow({...window(),start:at(-1441)}),null)
})
test('reference capacity is bounded and returns no half-built evidence',async()=>{
  const rows=Array.from({length:4000},(_,i)=>row(graphRecord({id:`event-${i}`,appId:`22222222-2222-4222-8222-${String(i).padStart(12,'0')}`})))
  const within=await run(rows.slice(0,3999));assert.ok(within.input);assert.equal(within.input.events.length,3999)
  const capped=await run(rows);assert.equal(capped.input,null);assert.deepEqual(capped.resolvedSubjects,[])
  assert.ok(capped.sources.every(s=>s.reasonCode==='CAPACITY_LIMIT'))
})

test('normal collection delay reports a bounded evaluated subset, not fabricated capacity exhaustion',async()=>{
  const captured={...window(),start:at(-1441),end:at(-1)}
  const result=await run([],{window:captured});assert.ok(result.input)
  assert.equal(result.input.authorizedFrom,at(-1440))
  assert.equal(result.sources.find(s=>s.source==='GRAPH_SIGN_INS')?.window.end,at(-1))
  assert.ok(evaluateAuthenticationRules(result.input).rules.every(rule=>!rule.reasonCodes.includes('LOOKBACK_CAPPED')))
})

test('explicit provider permission and license failures remain distinct; conflict markers are reported',async()=>{
  for(const [lastErrorCode,reason] of [['MICROSOFT_PERMISSION_REQUIRED','MISSING_PERMISSION'],['MICROSOFT_LICENSE_REQUIRED','LICENSE_REQUIRED']] as const){
    const result=await run([],{proof:{...graphProof,status:'FAILED',lastErrorCode}})
    assert.equal(result.input,null);assert.ok(result.sources.every(source=>source.reasonCode===reason))
  }
  const result=await run([row({...graphRecord({id:'disputed'}),hawkviewAuthenticationIntegrity:'CONFLICT'})])
  assert.deepEqual(result.disputedEventIds,['disputed'])
  assert.equal(result.sources.find(source=>source.source==='GRAPH_SIGN_INS')?.reasonCode,'CONFLICTING_EVIDENCE')
})
