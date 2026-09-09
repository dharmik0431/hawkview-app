import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticationFactFingerprint, persistAuthenticationRecords } from './authentication-ingestion-integrity.js'
const scope={organizationId:'11111111-1111-4111-8111-111111111111',customerTenantId:'22222222-2222-4222-8222-222222222222'}
const record=(id='event',raw:any={})=>({...scope,microsoftSignInId:id,eventDateTime:new Date('2026-09-08T12:00:00Z'),ingestedAt:new Date('2026-09-08T12:01:00Z'),expiresAt:new Date('2026-12-07T12:00:00Z'),
  riskLevel:'high',raw:{id,createdDateTime:'2026-09-08T12:00:00Z',userId:'33333333-3333-4333-8333-333333333333',appId:'44444444-4444-4444-8444-444444444444',status:{errorCode:50126},ipAddress:'192.0.2.1',...raw}})
function fixture(){
  let rows=new Map<string,any>(),fail=false,maxBatch=0
  const prisma:any={$transaction:async(work:any)=>{
    const pending=structuredClone(rows)
    const result=await work({
      $executeRawUnsafe:async(sql:string,...args:any[])=>{
        if(sql.startsWith('UPDATE')){assert.deepEqual(args.slice(0,2),Object.values(scope));const row=pending.get(args[2]);assert.ok(row);row.raw.hawkviewAuthenticationIntegrity='CONFLICT'}
        else assert.ok(sql==="SET LOCAL TIME ZONE 'UTC'"||sql.includes('set_config')||sql.includes('pg_advisory_xact_lock'))
        if(sql.includes('pg_advisory_xact_lock'))assert.equal(args[0],`hawkview:auth-ingestion:${scope.organizationId}:${scope.customerTenantId}`)
        return 1
      },
      $queryRawUnsafe:async(sql:string,...args:any[])=>{
        if(sql.includes("current_setting('TimeZone')"))return [{timezone:'UTC'}]
        assert.ok(sql.includes('FOR UPDATE'));assert.ok(sql.includes('2097152'));assert.deepEqual(args.slice(0,2),Object.values(scope));assert.ok(args[2].length<=500)
        const selected=args[2].flatMap((id:string)=>pending.has(id)?[{id,raw:pending.get(id).raw,bounded:true}]:[])
        return selected.length?selected:[{id:null,raw:null,bounded:true}]
      },
      signInLog:{createMany:async({data,skipDuplicates}:any)=>{
        assert.equal(skipDuplicates,false);maxBatch=Math.max(maxBatch,data.length)
        if(fail)throw new Error('SYNTHETIC_PERSISTENCE_FAILED')
        for(const row of data){assert.ok(!pending.has(row.microsoftSignInId));pending.set(row.microsoftSignInId,structuredClone(row))}
        return {count:data.length}
      }},
    })
    rows=pending;return result
  }}
  return {prisma,get rows(){return rows},get maxBatch(){return maxBatch},fail(){fail=true}}
}
test('identical replay and optional geographic enrichment deduplicate without renewal or Microsoft-risk mutation',async()=>{
  const f=fixture(),original=record();await persistAuthenticationRecords(f.prisma,scope,[original])
  const before=structuredClone(f.rows.get('event'))
  assert.deepEqual(await persistAuthenticationRecords(f.prisma,scope,[{...original,ingestedAt:new Date(),expiresAt:new Date(),riskLevel:'low',raw:{...original.raw,location:{city:'New'}}}]),{inserted:0,hasConflicts:false})
  assert.deepEqual(f.rows.get('event'),before)
})
for(const [name,patch]of Object.entries({outcome:{status:{errorCode:0}},user:{userId:'different'},app:{appId:'different'},time:{createdDateTime:'2026-09-08T12:00:01Z'},address:{ipAddress:'192.0.2.2'},source:{hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:{Id:'event'}}}))
  test(`duplicate ${name} conflict is sticky within and across batches`,async()=>{
    for(const together of [false,true]){
      const f=fixture(),original=record(),different=record('event',patch)
      if(!together)await persistAuthenticationRecords(f.prisma,scope,[original])
      assert.equal((await persistAuthenticationRecords(f.prisma,scope,together?[original,different]:[different])).hasConflicts,true)
      assert.equal(f.rows.size,1);assert.equal(f.rows.get('event').raw.hawkviewAuthenticationIntegrity,'CONFLICT')
      assert.equal(f.rows.get('event').raw.status.errorCode,50126);assert.equal(f.rows.get('event').riskLevel,'high')
      assert.equal((await persistAuthenticationRecords(f.prisma,scope,[original])).hasConflicts,true)
    }
  })
test('scope, byte/row/deadline bounds fail closed and failed transaction rolls back its quarantine',async()=>{
  const f=fixture();await persistAuthenticationRecords(f.prisma,scope,[record()])
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[{...record(),organizationId:'foreign'}]),/RECORD_INVALID/)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record('large',{extra:'x'.repeat(17000)})]),/CAPACITY/)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record()],Date.now()-1),/DEADLINE/)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,Array(100001).fill(record())),/CAPACITY/)
  f.fail();await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record('event',{status:{errorCode:0}}),record('new')]),/SYNTHETIC_PERSISTENCE_FAILED/)
  assert.equal(f.rows.size,1);assert.equal(f.rows.get('event').raw.hawkviewAuthenticationIntegrity,undefined)
})
test('501 records use bounded transactions and cross-chunk duplicates are still quarantined',async()=>{
  const f=fixture(),rows=Array.from({length:500},(_,i)=>record(`event-${i}`));rows.push(record('event-0',{status:{errorCode:0}}))
  assert.equal((await persistAuthenticationRecords(f.prisma,scope,rows)).hasConflicts,true);assert.equal(f.maxBatch,500);assert.equal(f.rows.size,500)
})
test('fingerprint rejects hostile accessors/prototypes and tracks STS outcome rather than synthesized display status',()=>{
  const hostile=Object.defineProperty({},'status',{enumerable:true,get(){throw new Error('must not invoke')}})
  assert.equal(authenticationFactFingerprint(hostile),null);assert.equal(authenticationFactFingerprint(Object.create({id:'inherited'})),null)
  const raw={hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:{Id:'event',ErrorCode:'50126',Operation:'UserLoginFailed',ExtendedProperties:[{Name:'ErrorCode',Value:'50126'}]}}
  assert.notEqual(authenticationFactFingerprint(raw),authenticationFactFingerprint({...raw,managementActivityRecord:{...raw.managementActivityRecord,ErrorCode:'0'}}))
  assert.equal(authenticationFactFingerprint(raw),authenticationFactFingerprint({...raw,location:{city:'optional'}}))
})
