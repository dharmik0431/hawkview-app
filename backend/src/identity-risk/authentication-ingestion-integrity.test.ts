import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticationFactFingerprint, integrityConflictMarker, persistAuthenticationRecords } from './authentication-ingestion-integrity.js'
const MARKED_AT=new Date('2026-09-08T12:02:00Z')
/** Written from measured PostgreSQL output, NOT imported from the module under
 *  test, so the two are independent. jsonb renders with a space after each key
 *  colon and each separating comma. Verified against a live PostgreSQL 17 for
 *  the eleven shapes pinned in the model test below. */
function pgTextBytes(value:any):number{
  if(Array.isArray(value)){let t=2;for(let i=0;i<value.length;i++)t+=(i?2:0)+pgTextBytes(value[i]);return t}
  if(!value||typeof value!=='object')return Buffer.byteLength(JSON.stringify(value??null))
  const keys=Object.keys(value);let t=2
  for(let i=0;i<keys.length;i++)t+=(i?2:0)+Buffer.byteLength(JSON.stringify(keys[i]))+2+pgTextBytes(value[keys[i]])
  return t}
const scope={organizationId:'11111111-1111-4111-8111-111111111111',customerTenantId:'22222222-2222-4222-8222-222222222222'}
const record=(id='event',raw:any={})=>({...scope,microsoftSignInId:id,eventDateTime:new Date('2026-09-08T12:00:00Z'),ingestedAt:new Date('2026-09-08T12:01:00Z'),expiresAt:new Date('2026-12-07T12:00:00Z'),
  riskLevel:'high',raw:{id,createdDateTime:'2026-09-08T12:00:00Z',userId:'33333333-3333-4333-8333-333333333333',appId:'44444444-4444-4444-8444-444444444444',status:{errorCode:50126},ipAddress:'192.0.2.1',...raw}})
function fixture(){
  let rows=new Map<string,any>(),fail=false,maxBatch=0
  const prisma:any={$transaction:async(work:any)=>{
    const pending=structuredClone(rows)
    const result=await work({
      $executeRawUnsafe:async(sql:string,...args:any[])=>{
        if(sql.startsWith('UPDATE')){assert.deepEqual(args.slice(0,2),Object.values(scope));const row=pending.get(args[2]);assert.ok(row)
          assert.ok(sql.includes('$4::jsonb'),'the marked value must be bound, not interpolated, or this fixture cannot observe it')
          row.raw.hawkviewAuthenticationIntegrity=JSON.parse(args[3])}
        else assert.ok(sql==="SET LOCAL TIME ZONE 'UTC'"||sql.includes('set_config')||sql.includes('pg_advisory_xact_lock'))
        if(sql.includes('pg_advisory_xact_lock'))assert.equal(args[0],`hawkview:auth-ingestion:${scope.organizationId}:${scope.customerTenantId}`)
        return 1
      },
      $queryRawUnsafe:async(sql:string,...args:any[])=>{
        if(sql.includes("current_setting('TimeZone')"))return [{timezone:'UTC'}]
        // The post-write verification. In production PostgreSQL answers this; here
        // pgTextBytes stands in for it, which is exactly why the authoritative
        // proof for this check is the real-database test, not this mock.
        if(sql.includes('octet_length')&&!sql.includes('FOR UPDATE')){
          const rows=args[2].flatMap((id:string)=>pending.has(id)?[pending.get(id)]:[])
          return [{maxRow:BigInt(rows.reduce((m:number,r:any)=>Math.max(m,pgTextBytes(r.raw)),0)),
                   total:BigInt(rows.reduce((t:number,r:any)=>t+pgTextBytes(r.raw),0))}]
        }
        assert.ok(sql.includes('FOR UPDATE'));assert.ok(sql.includes('2097152'));assert.deepEqual(args.slice(0,2),Object.values(scope));assert.ok(args[2].length<=500)
        const selected=args[2].flatMap((id:string)=>pending.has(id)?[{id,raw:pending.get(id).raw}]:[])
        // The real reader bounds each row AND the selected set, in rendered jsonb
        // text. A fixture that always answers bounded:true cannot observe a row
        // its own reader could no longer reach, which is the defect under test.
        const bounded=selected.every((r:any)=>pgTextBytes(r.raw)<=16_384)&&selected.reduce((t:number,r:any)=>t+pgTextBytes(r.raw),0)<=2_097_152
        return selected.length?selected.map((r:any)=>({...r,bounded,raw:bounded?r.raw:null,id:bounded?r.id:null})):[{id:null,raw:null,bounded:true}]
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
  const f=fixture(),original=record();await persistAuthenticationRecords(f.prisma,scope,[original],undefined,MARKED_AT)
  const before=structuredClone(f.rows.get('event'))
  assert.deepEqual(await persistAuthenticationRecords(f.prisma,scope,[{...original,ingestedAt:new Date(),expiresAt:new Date(),riskLevel:'low',raw:{...original.raw,location:{city:'New'}}}],undefined,MARKED_AT),{inserted:0,hasConflicts:false})
  assert.deepEqual(f.rows.get('event'),before)
})
for(const [name,patch]of Object.entries({outcome:{status:{errorCode:0}},user:{userId:'different'},app:{appId:'different'},time:{createdDateTime:'2026-09-08T12:00:01Z'},address:{ipAddress:'192.0.2.2'},source:{hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:{Id:'event'}}}))
  test(`duplicate ${name} conflict is sticky within and across batches`,async()=>{
    for(const together of [false,true]){
      const f=fixture(),original=record(),different=record('event',patch)
      if(!together)await persistAuthenticationRecords(f.prisma,scope,[original],undefined,MARKED_AT)
      assert.equal((await persistAuthenticationRecords(f.prisma,scope,together?[original,different]:[different],undefined,MARKED_AT)).hasConflicts,true)
      assert.equal(f.rows.size,1);assert.deepEqual(f.rows.get('event').raw.hawkviewAuthenticationIntegrity,
        {state:'CONFLICT',because:together?'BATCH_DUPLICATE_MISMATCH':'STORED_FINGERPRINT_MISMATCH',at:MARKED_AT.toISOString()})
      assert.equal(f.rows.get('event').raw.status.errorCode,50126);assert.equal(f.rows.get('event').riskLevel,'high')
      assert.equal((await persistAuthenticationRecords(f.prisma,scope,[original],undefined,MARKED_AT)).hasConflicts,true)
    }
  })
test('scope, byte/row/deadline bounds fail closed and failed transaction rolls back its quarantine',async()=>{
  const f=fixture();await persistAuthenticationRecords(f.prisma,scope,[record()],undefined,MARKED_AT)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[{...record(),organizationId:'foreign'}]),/RECORD_INVALID/)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record('large',{extra:'x'.repeat(17000)})]),/CAPACITY/)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record()],Date.now()-1),/DEADLINE/)
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,Array(100001).fill(record())),/CAPACITY/)
  f.fail();await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record('event',{status:{errorCode:0}}),record('new')]),/SYNTHETIC_PERSISTENCE_FAILED/)
  assert.equal(f.rows.size,1);assert.equal(f.rows.get('event').raw.hawkviewAuthenticationIntegrity,undefined)
})
test('501 records use bounded transactions and cross-chunk duplicates are still quarantined',async()=>{
  const f=fixture(),rows=Array.from({length:500},(_,i)=>record(`event-${i}`));rows.push(record('event-0',{status:{errorCode:0}}))
  assert.equal((await persistAuthenticationRecords(f.prisma,scope,rows,undefined,MARKED_AT)).hasConflicts,true);assert.equal(f.maxBatch,500);assert.equal(f.rows.size,500)
})
test('fingerprint rejects hostile accessors/prototypes and tracks STS outcome rather than synthesized display status',()=>{
  const hostile=Object.defineProperty({},'status',{enumerable:true,get(){throw new Error('must not invoke')}})
  assert.equal(authenticationFactFingerprint(hostile),null);assert.equal(authenticationFactFingerprint(Object.create({id:'inherited'})),null)
  const raw={hawkviewSource:'MICROSOFT_365_MANAGEMENT_ACTIVITY',managementActivityRecord:{Id:'event',ErrorCode:'50126',Operation:'UserLoginFailed',ExtendedProperties:[{Name:'ErrorCode',Value:'50126'}]}}
  assert.notEqual(authenticationFactFingerprint(raw),authenticationFactFingerprint({...raw,managementActivityRecord:{...raw.managementActivityRecord,ErrorCode:'0'}}))
  assert.equal(authenticationFactFingerprint(raw),authenticationFactFingerprint({...raw,location:{city:'optional'}}))
})

for(const [name,patch,because] of [
  ['a raw the fingerprint cannot read',{hawkviewSource:'SOMETHING_ELSE'},'FINGERPRINT_UNAVAILABLE'],
  ['a payload that arrives already marked',{hawkviewAuthenticationIntegrity:'CONFLICT'},'INPUT_PRE_MARKED'],
] as const) test(`quarantine records its own cause: ${name}`,async()=>{
  const f=fixture()
  assert.equal((await persistAuthenticationRecords(f.prisma,scope,[record('subject',patch)],undefined,MARKED_AT)).hasConflicts,true)
  assert.deepEqual(f.rows.get('subject').raw.hawkviewAuthenticationIntegrity,{state:'CONFLICT',because,at:MARKED_AT.toISOString()})
})
test('a stored cause is never overwritten by a later conflict, which is the whole point of recording it',async()=>{
  const f=fixture()
  await persistAuthenticationRecords(f.prisma,scope,[record()],undefined,MARKED_AT)
  await persistAuthenticationRecords(f.prisma,scope,[record('event',{status:{errorCode:0}})],undefined,MARKED_AT)
  const first=structuredClone(f.rows.get('event').raw.hawkviewAuthenticationIntegrity)
  assert.deepEqual(first,{state:'CONFLICT',because:'STORED_FINGERPRINT_MISMATCH',at:MARKED_AT.toISOString()})
  // A replay a day later would satisfy the conflict test on the stored marker alone.
  // Re-stamping it would destroy the only evidence of why the row was quarantined.
  for(const replay of [record(),record('event',{hawkviewSource:'SOMETHING_ELSE'})])
    assert.equal((await persistAuthenticationRecords(f.prisma,scope,[replay],undefined,new Date('2026-09-09T09:00:00Z'))).hasConflicts,true)
  assert.deepEqual(f.rows.get('event').raw.hawkviewAuthenticationIntegrity,first,'the first cause and its clock must survive')
})
test('a row whose marker would breach the stored bound is refused rather than marked past it',async()=>{
  const bytes=(row:any)=>Buffer.byteLength(JSON.stringify(row.raw))
  // Sized to sit inside the 16 KiB stored bound but within a marker of it. The
  // module re-reads rows under that same bound, so a row marked past it becomes
  // unreachable to its own reader. Refusing the write is the only safe outcome:
  // truncating the evidence or dropping the quarantine would both lie.
  const pad=16_384-bytes(record('probe',{extra:''}))-80
  const clean=record('clean',{extra:'x'.repeat(pad)})
  const marked=record('marked',{extra:'x'.repeat(pad),hawkviewSource:'SOMETHING_ELSE'})
  assert.ok(bytes(clean)<=16_384&&bytes(clean)>16_384-160,`fixture must sit inside the bound but within the reserve, got ${bytes(clean)}`)
  assert.ok(bytes(marked)<=16_384,'and the marked payload must itself still fit, or this proves nothing about the reserve')
  const f=fixture()
  await persistAuthenticationRecords(f.prisma,scope,[clean],undefined,MARKED_AT)
  assert.equal(f.rows.size,1,'an unmarked payload inside the bound still inserts')
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[marked],undefined,MARKED_AT),/CAPACITY/,
    'the same payload must be refused once a marker would push it past the bound')
})
test('the marker builder carries a cause and a UTC clock, and never a fingerprint or payload',()=>{
  const built=integrityConflictMarker('BATCH_DUPLICATE_MISMATCH',MARKED_AT)
  assert.deepEqual(Object.keys(built).sort(),['at','because','state'])
  assert.equal(built.at,'2026-09-08T12:02:00.000Z');assert.ok(built.at.endsWith('Z'))
  assert.deepEqual(built,JSON.parse(JSON.stringify(built)),'the marker must survive the jsonb round trip unchanged')
})

/** Independently reported by Codex on HAW63-marker-origin-v1 and reproduced here.
 *  A duplicate's cause is promoted AFTER both rows pass input validation, so an
 *  input-side reserve can never protect it: neither row carries a cause of its own. */
test('a same-chunk duplicate must never persist a row its own reader could not read back',async()=>{
  const f=fixture(),original=record()
  original.raw.padding='x'.repeat(16_320-Buffer.byteLength(JSON.stringify({...original.raw,padding:''})))
  assert.equal(Buffer.byteLength(JSON.stringify(original.raw)),16_320,'fixture must sit just inside the bound unmarked')
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[original,record('event',{status:{errorCode:0}})],undefined,MARKED_AT),
    /IDENTITY_AUTH_CAPACITY/,'marking it would breach the stored bound, so the write must be refused')
  assert.equal(f.rows.size,0,'and refused means nothing persisted, not persisted-then-oversized')
})
test('marking a stored row that would breach the bound is refused, and the row is left exactly as it was',async()=>{
  const f=fixture(),original=record()
  original.raw.padding='x'.repeat(16_300-Buffer.byteLength(JSON.stringify({...original.raw,padding:''})))
  await persistAuthenticationRecords(f.prisma,scope,[original],undefined,MARKED_AT)
  const before=structuredClone(f.rows.get('event'))
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record('event',{status:{errorCode:0},padding:original.raw.padding})],undefined,MARKED_AT),
    /IDENTITY_AUTH_CAPACITY/,'the update path must bound the row it is about to write')
  assert.deepEqual(f.rows.get('event'),before,'evidence is never truncated and quarantine is never dropped to make it fit')
})
test('rows that each fit can still put the selected set past the aggregate bound',async()=>{
  const f=fixture()
  const pad=(row:any,size:number)=>{row.raw.padding='x'.repeat(size-Buffer.byteLength(JSON.stringify({...row.raw,padding:''})));return row}
  const stored=Array.from({length:130},(_,i)=>pad(record(`event-${i}`),16_000))
  await persistAuthenticationRecords(f.prisma,scope,stored,undefined,MARKED_AT)
  assert.equal(f.rows.size,130)
  assert.ok([...f.rows.values()].every(r=>pgTextBytes(r.raw)<16_384),'every stored row is individually well inside the row bound')
  const replays=stored.map((row,i)=>pad(record(`event-${i}`,{status:{errorCode:0}}),16_000))
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,replays,undefined,MARKED_AT),
    /IDENTITY_AUTH_CAPACITY/,'marking them all exceeds the set bound even though no single row does')
  assert.ok([...f.rows.values()].every(r=>r.raw.hawkviewAuthenticationIntegrity===undefined),'and none of them was marked')
})
test('the stored-size model matches what PostgreSQL 17 actually renders',()=>{
  // pgTextBytes exists ONLY so this mock can stand in for the database. The
  // module itself no longer estimates sizes at all — it measures them in SQL —
  // so nothing here constrains production behaviour. Pinned against a live
  // PostgreSQL, read-only, 2026-09-28.
  //
  // The divergence below is why estimating was abandoned rather than tuned:
  // PostgreSQL preserves a written numeric literal where JSON.stringify
  // normalises it. A 400-digit scale understates by 502 bytes, and the scale is
  // unbounded, so no margin could have covered it. The real proof lives in
  // authentication-ingestion-capacity.database-integration.test.ts.
  for(const [doc,measured] of [
    [{a:1,b:2},16],[{},2],[[],2],[[1,2],6],[{a:{b:[1,2]}},20],[{s:'x'},10],
    [{n:1e5},13],[{n:0.30000000000000004},26],[{u:'\u00e9'},11],
    [{hawkviewAuthenticationIntegrity:{state:'CONFLICT',because:'STORED_FINGERPRINT_MISMATCH',at:'2026-09-28T20:48:02.233Z'}},134],
  ] as const) assert.equal(pgTextBytes(doc),measured,`model disagrees with PostgreSQL for ${JSON.stringify(doc)}`)
  assert.equal(pgTextBytes({n:1.0}),8,'the known divergence: PostgreSQL renders 10 for a written 1.0 literal')
})

test('sizing uses what PostgreSQL stores, not compact JSON, or a row slips through the gap between them',async()=>{
  const marker=integrityConflictMarker('FINGERPRINT_UNAVAILABLE',MARKED_AT)
  const marked=(pad:string)=>({...record('gap',{hawkviewSource:'SOMETHING_ELSE'}).raw,padding:pad,hawkviewAuthenticationIntegrity:marker})
  // Land the MARKED row exactly on the bound by compact bytes. Compact sizing
  // therefore accepts it, while PostgreSQL stores more than the bound and the
  // reader can never reach it again. The gap between the two is the defect.
  const pad=16_384-Buffer.byteLength(JSON.stringify(marked('')))
  const full=marked('x'.repeat(pad))
  assert.equal(Buffer.byteLength(JSON.stringify(full)),16_384,'compact sizing sees exactly the bound and would accept')
  assert.ok(pgTextBytes(full)>16_384,`PostgreSQL stores ${pgTextBytes(full)}, past the bound`)
  const f=fixture()
  await assert.rejects(()=>persistAuthenticationRecords(f.prisma,scope,[record('gap',{hawkviewSource:'SOMETHING_ELSE',padding:'x'.repeat(pad)})],undefined,MARKED_AT),
    /IDENTITY_AUTH_CAPACITY/,'sizing against compact JSON would have let this through')
  assert.equal(f.rows.size,0)
})
