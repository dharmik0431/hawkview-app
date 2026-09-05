import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { RiskHistoryRetention, riskHistoryRetentionConfig, HISTORY_BATCH_ROWS, HISTORY_BATCH_RUNS } from './risk-history-retention.js'

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
type Scope = { organizationId: string; customerTenantId: string }
async function fixture(work: (f: { c: pg.Client; prisma: PrismaService; scopes: Scope[]; worker: RiskHistoryRetention; config: NonNullable<ReturnType<typeof riskHistoryRetentionConfig>>; lease: { key: string; id: string } }) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable local database only')
  const c = new pg.Client({ connectionString: url.toString() }); const prisma = new PrismaService()
  await c.connect(); await prisma.$connect()
  const scopes: Scope[] = []; const orgs: string[] = []
  const worker = new RiskHistoryRetention()
  let lease: { key: string; id: string } | null = null
  try {
    for (let o = 0; o < 2; o++) {
      const organizationId = randomUUID(); orgs.push(organizationId)
      await prisma.organization.create({ data: { id: organizationId, name: 'Synthetic retention', slug: organizationId } })
      for (let t = 0; t < 2; t++) {
        const customerTenantId = randomUUID()
        await prisma.customerTenant.create({ data: { id: customerTenantId, organizationId, microsoftTenantId: randomUUID(), displayName: 'example.invalid', status: 'PENDING' } })
        scopes.push({ organizationId, customerTenantId })
      }
    }
    const config = riskHistoryRetentionConfig({ HAWKVIEW_RISK_HISTORY_RETENTION_MODE: 'delete', HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES: JSON.stringify(scopes) })!
    lease = await worker.claim(config, Date.now() + 3000); assert.ok(lease)
    await work({ c, prisma, scopes, worker, config, lease })
  } finally {
    await c.query('ROLLBACK')
    // Synthetic owned fixtures only. Org cascade must remain compatible with
    // the derived graph's new NO ACTION constraints.
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    if (lease) await c.query('DELETE FROM identity_risk_history_cursors WHERE scope_key=$1', [lease.key])
    await prisma.$disconnect(); await c.end()
  }
}

async function run(c: pg.Client, s: Scope, age = '91 days', status = 'COMPLETED', lease = false) {
  const id = randomUUID()
  await c.query(`INSERT INTO identity_risk_evaluation_runs
    (id,organization_id,customer_tenant_id,run_key,engine_version,catalog_version,status,window_start,window_end,
    source_watermark_hash,source_content_hash,capability,created_at,completed_at,expires_at,lease_expires_at)
    VALUES ($1::uuid,$2,$3,$1::text,'synthetic','synthetic',$4,CURRENT_TIMESTAMP-INTERVAL '2 hours',CURRENT_TIMESTAMP-INTERVAL '1 hour',
    'synthetic','synthetic','UNAVAILABLE',CURRENT_TIMESTAMP-$5::interval,CURRENT_TIMESTAMP-$5::interval,
    CURRENT_TIMESTAMP-$5::interval+INTERVAL '7 days',CASE WHEN $6 THEN CURRENT_TIMESTAMP+INTERVAL '1 hour' ELSE NULL END)`,
  [id, s.organizationId, s.customerTenantId, status, age, lease])
  return id
}
async function graph(c: pg.Client, s: Scope, runId: string, count = 1, fresh = false) {
  const args = [s.organizationId, s.customerTenantId, runId, count, fresh]
  await c.query(`INSERT INTO identity_risk_matched_results
    (id,organization_id,customer_tenant_id,evaluation_run_id,result_key,rule_id,subject_type,subject_id,severity,confidence,coverage,observed_at,created_at,expires_at)
    SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid()::text,'HV-ID-MBX-001.v1','MAILBOX','synthetic','HIGH','HIGH','FULL',
    CURRENT_TIMESTAMP-INTERVAL '91 days',CURRENT_TIMESTAMP-INTERVAL '91 days',
    CASE WHEN $5 THEN CURRENT_TIMESTAMP+INTERVAL '1 day' ELSE CURRENT_TIMESTAMP-INTERVAL '1 day' END FROM generate_series(1,$4::int)`, args)
  await c.query(`INSERT INTO identity_risk_findings
    (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,subject_type,subject_id,state,severity,confidence,coverage,observed_at,created_at,updated_at,expires_at)
    SELECT gen_random_uuid(),$1,$2,m.id,gen_random_uuid()::text,'HV-ID-MBX-001.v1','v1','MAILBOX','synthetic','OPEN','HIGH','HIGH','FULL',
    m.observed_at,m.created_at,m.created_at,m.expires_at FROM identity_risk_matched_results m WHERE m.evaluation_run_id=$3`, args.slice(0,3))
  await c.query(`INSERT INTO identity_risk_rule_coverage (id,organization_id,customer_tenant_id,evaluation_run_id,rule_id,created_at,expires_at)
    VALUES (gen_random_uuid(),$1,$2,$3,'HV-ID-MBX-001.v1',CURRENT_TIMESTAMP-INTERVAL '91 days',
    CASE WHEN $4 THEN CURRENT_TIMESTAMP+INTERVAL '1 day' ELSE CURRENT_TIMESTAMP-INTERVAL '1 day' END)`, [...args.slice(0,3),fresh])
}
const prune = (f: { worker: RiskHistoryRetention; config: any; lease: any }, s: Scope) => f.worker.prune(s,f.config,f.lease,Date.now()+3000)
const count = async (c: pg.Client, s: Scope) => (await c.query(`SELECT
  (SELECT count(*)::int FROM identity_risk_evaluation_runs WHERE organization_id=$1 AND customer_tenant_id=$2) AS runs,
  (SELECT count(*)::int FROM identity_risk_findings WHERE organization_id=$1 AND customer_tenant_id=$2) AS findings,
  (SELECT count(*)::int FROM identity_risk_matched_results WHERE organization_id=$1 AND customer_tenant_id=$2) AS matches,
  (SELECT count(*)::int FROM identity_risk_rule_coverage WHERE organization_id=$1 AND customer_tenant_id=$2) AS coverage`, [s.organizationId,s.customerTenantId])).rows[0]

test('history: legacy 7d-expired rows stay physically retained until original 90d; no validity rewrite', { skip: !enabled }, () => fixture(async f => {
  const s=f.scopes[0]!
  for (const age of [8,30,89,91]) await run(f.c,s,`${age} days`)
  const before=await f.c.query('SELECT id,created_at::text,expires_at::text FROM identity_risk_evaluation_runs WHERE customer_tenant_id=$1 ORDER BY id',[s.customerTenantId])
  assert.equal((await prune(f,s)).runs,1)
  const after=await f.c.query('SELECT id,created_at::text,expires_at::text FROM identity_risk_evaluation_runs WHERE customer_tenant_id=$1 ORDER BY id',[s.customerTenantId])
  assert.equal(after.rows.length,3)
  for (const row of after.rows) assert.deepEqual(row,before.rows.find(b=>b.id===row.id))
  assert.equal((await f.c.query('SELECT count(*)::int AS n FROM identity_risk_evaluation_runs WHERE customer_tenant_id=$1 AND expires_at>CURRENT_TIMESTAMP',[s.customerTenantId])).rows[0].n,0)
  assert.equal((await prune(f,s)).runs,0)
}))

test('history: exact UTC 90d boundary versus one microsecond before, using the transaction clock', { skip: !enabled }, () => fixture(async f => {
  const s=f.scopes[0]!, original=(f.worker as any).tx.bind(f.worker)
  let beforeId='', expiredId=''
  ;(f.worker as any).tx=(d:number,w:any)=>original(d,async(c:pg.Client)=>{
    beforeId=await run(c,s,'2160 hours - 0.000001 seconds')
    expiredId=await run(c,s,'2160 hours')
    return w(c)
  })
  assert.equal((await prune(f,s)).runs,1)
  const remaining=await f.c.query('SELECT id FROM identity_risk_evaluation_runs WHERE id=ANY($1::uuid[])',[[beforeId,expiredId]])
  assert.deepEqual(remaining.rows.map(r=>r.id),[beforeId])
}))

test('history: FULL, PARTIAL, UNAVAILABLE and failed no-source assessments share the original-age policy', {skip:!enabled},()=>fixture(async f=>{
  const s=f.scopes[0]!
  for(const capability of ['FULL','PARTIAL','UNAVAILABLE']) {
    for(const age of ['8 days','91 days']) {
      const id=await run(f.c,s,age)
      await f.c.query('UPDATE identity_risk_evaluation_runs SET capability=$2 WHERE id=$1',[id,capability])
    }
  }
  const failed=await run(f.c,s,'91 days','FAILED')
  await f.c.query('UPDATE identity_risk_evaluation_runs SET completed_at=NULL WHERE id=$1',[failed])
  assert.equal((await prune(f,s)).runs,4)
  const retained=await f.c.query('SELECT capability FROM identity_risk_evaluation_runs WHERE organization_id=$1 AND customer_tenant_id=$2 ORDER BY capability',[s.organizationId,s.customerTenantId])
  assert.deepEqual(retained.rows.map(r=>r.capability),['FULL','PARTIAL','UNAVAILABLE'])
}))

test('history: 2x2 isolation, terminal-only, live leases/children preserved and CAS never clears newer heads', { skip: !enabled }, () => fixture(async f => {
  for (const s of f.scopes) await graph(f.c,s,await run(f.c,s))
  const s=f.scopes[0]!, expired=(await f.c.query('SELECT id FROM identity_risk_evaluation_runs WHERE customer_tenant_id=$1',[s.customerTenantId])).rows[0].id
  const active=await run(f.c,s,'91 days','RUNNING'), leased=await run(f.c,s,'91 days','FAILED',true)
  const fresh=await run(f.c,s,'1 day'), liveChild=await run(f.c,s)
  await graph(f.c,s,liveChild,1,true)
  for (const [environment,id] of [['old',expired],['new',fresh]]) await f.c.query(`INSERT INTO identity_risk_attempt_heads
    (organization_id,customer_tenant_id,environment,attempt_id,completed_run_id) VALUES ($1,$2,$3,$4,$5)`,[s.organizationId,s.customerTenantId,environment,randomUUID(),id])
  const newer=(await f.c.query("SELECT * FROM identity_risk_attempt_heads WHERE customer_tenant_id=$1 AND environment='new'",[s.customerTenantId])).rows
  const result=await prune(f,s)
  assert.deepEqual(result,{findings:1,matchedResults:1,coverage:1,runs:1})
  for (const other of f.scopes.slice(1)) assert.deepEqual(await count(f.c,other),{runs:1,findings:1,matches:1,coverage:1})
  assert.equal((await f.c.query("SELECT completed_run_id FROM identity_risk_attempt_heads WHERE customer_tenant_id=$1 AND environment='old'",[s.customerTenantId])).rows[0].completed_run_id,null)
  assert.deepEqual((await f.c.query("SELECT * FROM identity_risk_attempt_heads WHERE customer_tenant_id=$1 AND environment='new'",[s.customerTenantId])).rows,newer)
  assert.equal((await f.c.query('SELECT count(*)::int AS n FROM identity_risk_evaluation_runs WHERE id=ANY($1::uuid[])',[[active,leased,fresh,liveChild]])).rows[0].n,4)
  await assert.rejects(()=>prune(f,{organizationId:f.scopes[2]!.organizationId,customerTenantId:s.customerTenantId}),/RISK_HISTORY_UNAVAILABLE/)
}))

test('history: pathological children use a shared row cap; live graph cannot cascade; eventual cursor wraps drain', { skip: !enabled, timeout:30000 }, () => fixture(async f => {
  const s=f.scopes[0]!, id=await run(f.c,s)
  await graph(f.c,s,id,HISTORY_BATCH_ROWS+1)
  const first=await prune(f,s)
  assert.equal(first.findings,HISTORY_BATCH_ROWS); assert.equal(first.runs,0)
  for(let i=0;i<10;i++) { const r=await prune(f,s); assert.ok(r.findings+r.matchedResults+r.coverage<=HISTORY_BATCH_ROWS) }
  assert.deepEqual(await count(f.c,s),{runs:0,findings:0,matches:0,coverage:0})
  const parent=await run(f.c,s); await graph(f.c,s,parent,1,true)
  await assert.rejects(()=>f.c.query('DELETE FROM identity_risk_evaluation_runs WHERE id=$1',[parent]),/foreign key/)
}))

test('history: run cap and run cursor advance past permanently live-child oldest records', { skip: !enabled,timeout:30000 }, () => fixture(async f => {
  const s=f.scopes[0]!
  for(let i=0;i<HISTORY_BATCH_RUNS;i++) await graph(f.c,s,await run(f.c,s,'100 days'),1,true)
  await run(f.c,s,'91 days')
  assert.equal((await prune(f,s)).runs,0)
  assert.equal((await prune(f,s)).runs,1)
  for(let i=0;i<HISTORY_BATCH_RUNS+1;i++) await run(f.c,f.scopes[1]!)
  assert.equal((await prune(f,f.scopes[1]!)).runs,HISTORY_BATCH_RUNS)
  assert.equal((await prune(f,f.scopes[1]!)).runs,1)
}))

test('history: one pathological parent drains over child pages, and live-child prefixes do not pin expired siblings', {skip:!enabled,timeout:30000},()=>fixture(async f=>{
  const s=f.scopes[0]!,id=await run(f.c,s);await graph(f.c,s,id)
  await f.c.query(`INSERT INTO identity_risk_findings
    (id,organization_id,customer_tenant_id,matched_result_id,dedupe_key,rule_id,rule_version,subject_type,subject_id,state,severity,confidence,coverage,observed_at,created_at,updated_at,expires_at)
    SELECT gen_random_uuid(),f.organization_id,f.customer_tenant_id,f.matched_result_id,gen_random_uuid()::text,
    f.rule_id,f.rule_version,f.subject_type,f.subject_id,f.state,f.severity,f.confidence,f.coverage,f.observed_at,f.created_at,f.updated_at,f.expires_at
    FROM identity_risk_findings f CROSS JOIN generate_series(1,1024) n WHERE f.customer_tenant_id=$1`,[s.customerTenantId])
  let removed=0
  for(let i=0;i<6;i++) {
    const r=await prune(f,s);removed+=r.findings+r.matchedResults+r.coverage
    assert.ok(r.findings+r.matchedResults+r.coverage<=HISTORY_BATCH_ROWS)
    if(i<4)assert.equal(r.runs,0)
  }
  assert.equal(removed,1027)
  assert.deepEqual(await count(f.c,s),{runs:0,findings:0,matches:0,coverage:0})
  const protectedRun=await run(f.c,s);await graph(f.c,s,protectedRun,257)
  await f.c.query(`UPDATE identity_risk_findings SET expires_at=CURRENT_TIMESTAMP+INTERVAL '1 day'
    WHERE matched_result_id IN (SELECT id FROM identity_risk_matched_results WHERE evaluation_run_id=$1 ORDER BY id LIMIT 256)`,[protectedRun])
  const progress=await prune(f,s)
  assert.equal(progress.findings,1);assert.equal(progress.matchedResults,1);assert.equal(progress.runs,0)
  assert.equal((await count(f.c,s)).findings,256)
}))

test('history: rollback after each delete/head boundary and retry does not lose evidence or miscount', { skip: !enabled,timeout:30000 }, () => fixture(async f => {
  const s=f.scopes[0]!, id=await run(f.c,s); await graph(f.c,s,id)
  await f.c.query(`INSERT INTO identity_risk_attempt_heads (organization_id,customer_tenant_id,environment,attempt_id,completed_run_id)
    VALUES ($1,$2,'synthetic',$3,$4)`,[s.organizationId,s.customerTenantId,randomUUID(),id])
  const original=(f.worker as any).tx.bind(f.worker)
  for(const needle of ['DELETE FROM identity_risk_findings','DELETE FROM identity_risk_matched_results','DELETE FROM identity_risk_rule_coverage','UPDATE identity_risk_attempt_heads','DELETE FROM identity_risk_evaluation_runs']) {
    ;(f.worker as any).tx=(d:number,w:any)=>original(d,async(c:pg.Client)=>{
      const query=c.query.bind(c)
      ;(c as any).query=async(...args:any[])=>{const result=await (query as any)(...args); if(String(args[0]).includes(needle)) throw new Error('synthetic rollback');return result}
      return w(c)
    })
    await assert.rejects(()=>prune(f,s),/SOURCE_UNAVAILABLE/)
    assert.deepEqual(await count(f.c,s),{runs:1,findings:1,matches:1,coverage:1})
    assert.equal((await f.c.query('SELECT completed_run_id FROM identity_risk_attempt_heads WHERE customer_tenant_id=$1',[s.customerTenantId])).rows[0].completed_run_id,id)
  }
  ;(f.worker as any).tx=original
  assert.equal((await prune(f,s)).runs,1)
  assert.equal((await prune(f,s)).runs,0)
}))

test('history: overlapping leases, stale CAS, RUNNING row lock and new-head lock fail safely', { skip: !enabled }, () => fixture(async f => {
  assert.equal(await f.worker.claim(f.config,Date.now()+3000),null)
  const s=f.scopes[0]!, id=await run(f.c,s)
  await f.c.query('BEGIN'); await f.c.query('UPDATE identity_risk_evaluation_runs SET status=$2 WHERE id=$1',[id,'RUNNING'])
  assert.equal((await prune(f,s)).runs,0)
  await f.c.query('COMMIT')
  assert.equal((await prune(f,s)).runs,0)
  await f.c.query('UPDATE identity_risk_history_cursors SET lease_id=$2 WHERE scope_key=$1',[f.lease.key,randomUUID()])
  await assert.rejects(()=>prune(f,s),/SOURCE_UNAVAILABLE/)
  assert.equal((await count(f.c,s)).runs,1)
}))

test('history: real blocked SQL is cancelled before lock release, no late deletion or cursor progress', { skip: !enabled,timeout:10000 }, () => fixture(async f => {
  const s=f.scopes[0]!, id=await run(f.c,s); await graph(f.c,s,id)
  await f.c.query('BEGIN'); await f.c.query('SELECT scope_key FROM identity_risk_history_cursors WHERE scope_key=$1 FOR UPDATE',[f.lease.key])
  const start=Date.now()
  let ownedPid=0
  const original=(f.worker as any).tx.bind(f.worker)
  ;(f.worker as any).tx=(d:number,w:any)=>original(d,async(c:pg.Client)=>{
    ownedPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    return w(c)
  })
  await assert.rejects(()=>f.worker.prune(s,f.config,f.lease,start+400),/SOURCE_UNAVAILABLE/)
  assert.ok(Date.now()-start<1500)
  assert.ok(ownedPid>0)
  // Prove the actual owned backend disappeared while the blocker still holds,
  // rather than merely timing out the awaiting Promise.
  for(let i=0;i<20;i++) {
    const active=await f.c.query('SELECT pid FROM pg_stat_activity WHERE pid=$1',[ownedPid])
    if(!active.rowCount) break
    await new Promise(r=>setTimeout(r,10))
  }
  assert.equal((await f.c.query('SELECT pid FROM pg_stat_activity WHERE pid=$1',[ownedPid])).rowCount,0)
  assert.deepEqual(await count(f.c,s),{runs:1,findings:1,matches:1,coverage:1})
  await f.c.query('ROLLBACK'); await new Promise(r=>setTimeout(r,50))
  assert.deepEqual(await count(f.c,s),{runs:1,findings:1,matches:1,coverage:1})
}))

test('history: observe performs no writes and OFF configuration performs no DB work', { skip: !enabled }, () => fixture(async f => {
  await run(f.c,f.scopes[0]!)
  const original=(f.worker as any).tx.bind(f.worker)
  ;(f.worker as any).tx=(d:number,w:any)=>original(d,async(c:pg.Client)=>{
    const query=c.query.bind(c); (c as any).query=(...args:any[])=>{
      assert.doesNotMatch(String(args[0]),/\b(INSERT|UPDATE|DELETE)\b/); return (query as any)(...args)
    }; return w(c)
  })
  assert.deepEqual(await f.worker.preflight({...f.config,mode:'observe'},Date.now()+3000),{candidateRunsObserved:1,capped:false})
}))

test('history: invalid/future timestamps and independently live matched parents fail closed', {skip:!enabled},()=>fixture(async f=>{
  const s=f.scopes[0]!
  const future=await run(f.c,s,'-1 day')
  const invalid=await run(f.c,s)
  await f.c.query("UPDATE identity_risk_evaluation_runs SET created_at='-infinity' WHERE id=$1",[invalid])
  const badCompletion=await run(f.c,s)
  await f.c.query("UPDATE identity_risk_evaluation_runs SET completed_at=created_at-INTERVAL '1 hour' WHERE id=$1",[badCompletion])
  const missingCompletion=await run(f.c,s,'8 days')
  await assert.rejects(()=>f.c.query('UPDATE identity_risk_evaluation_runs SET completed_at=NULL WHERE id=$1',[missingCompletion]),/identity_risk_runs_completion_check/)
  const invalidLease=await run(f.c,s)
  await f.c.query("UPDATE identity_risk_evaluation_runs SET lease_expires_at='-infinity' WHERE id=$1",[invalidLease])
  const runningExpiredLease=await run(f.c,s,'91 days','RUNNING')
  await f.c.query("UPDATE identity_risk_evaluation_runs SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 day' WHERE id=$1",[runningExpiredLease])
  const liveParent=await run(f.c,s);await graph(f.c,s,liveParent)
  await f.c.query("UPDATE identity_risk_matched_results SET expires_at=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE evaluation_run_id=$1",[liveParent])
  const badChild=await run(f.c,s);await graph(f.c,s,badChild)
  await f.c.query("UPDATE identity_risk_findings SET updated_at='infinity' WHERE matched_result_id IN (SELECT id FROM identity_risk_matched_results WHERE evaluation_run_id=$1)",[badChild])
  const result=await prune(f,s)
  assert.equal(result.runs,0);assert.equal(result.findings,0);assert.equal(result.matchedResults,0)
  assert.equal((await count(f.c,s)).runs,8)
  assert.equal((await f.c.query('SELECT count(*)::int AS n FROM identity_risk_evaluation_runs WHERE id=ANY($1::uuid[])',[[future,invalid,badCompletion]])).rows[0].n,3)
}))

test('history: concurrent newer head update is preserved; concurrent prune accounting is idempotent', {skip:!enabled},()=>fixture(async f=>{
  const s=f.scopes[0]!,old=await run(f.c,s),fresh=await run(f.c,s,'1 day')
  await graph(f.c,s,old)
  await f.c.query(`INSERT INTO identity_risk_attempt_heads (organization_id,customer_tenant_id,environment,attempt_id,completed_run_id)
    VALUES ($1,$2,'synthetic',$3,$4)`,[s.organizationId,s.customerTenantId,randomUUID(),old])
  await f.c.query('BEGIN')
  await f.c.query('UPDATE identity_risk_attempt_heads SET attempt_id=$2,completed_run_id=$3 WHERE customer_tenant_id=$1',[s.customerTenantId,randomUUID(),fresh])
  await assert.rejects(()=>prune(f,s),/SOURCE_UNAVAILABLE/)
  await f.c.query('COMMIT')
  const before=(await f.c.query('SELECT * FROM identity_risk_attempt_heads WHERE customer_tenant_id=$1',[s.customerTenantId])).rows
  const outcomes=await Promise.all([prune(f,s),prune(f,s)])
  assert.equal(outcomes.reduce((n,r)=>n+r.runs,0),1)
  assert.equal(outcomes.reduce((n,r)=>n+r.findings+r.matchedResults+r.coverage,0),3)
  assert.deepEqual((await f.c.query('SELECT * FROM identity_risk_attempt_heads WHERE customer_tenant_id=$1',[s.customerTenantId])).rows,before)
}))

test('history: real maximum normal graph drains incrementally with evaluation OFF and no provider calls', {skip:!enabled,timeout:60000},()=>fixture(async f=>{
  const s=f.scopes[0]!,id=await run(f.c,s)
  await graph(f.c,s,id,2000)
  await f.c.query(`INSERT INTO identity_risk_rule_coverage (id,organization_id,customer_tenant_id,evaluation_run_id,rule_id,created_at,expires_at)
    SELECT gen_random_uuid(),$1,$2,$3,'HV-ID-EXP-'||lpad(n::text,3,'0')||'.v1',CURRENT_TIMESTAMP-INTERVAL '91 days',CURRENT_TIMESTAMP-INTERVAL '1 day'
    FROM generate_series(1,21) n`,[s.organizationId,s.customerTenantId,id])
  await f.worker.release(f.lease,Date.now()+3000)
  const values={HAWKVIEW_IDENTITY_RISK_MODE:'off',HAWKVIEW_RISK_HISTORY_RETENTION_MODE:'delete',HAWKVIEW_RISK_HISTORY_RETENTION_SCOPES:JSON.stringify(f.scopes)}
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]))
  Object.assign(process.env,values)
  const calls: {findings:number;matchedResults:number;coverage:number;runs:number}[]=[]
  let planShown=false
  let inspectedPlan:any
  const originalTx=(f.worker as any).tx.bind(f.worker)
  ;(f.worker as any).tx=(d:number,w:any)=>originalTx(d,async(c:pg.Client)=>{
    const query=c.query.bind(c)
    ;(c as any).query=async(...args:any[])=>{
      if(!planShown && String(args[0]).includes('DELETE FROM identity_risk_findings')) {
        planShown=true
        // Actual delete plan in this synthetic owned transaction only. Revert
        // every diagnostic mutation before the worker's real counted DELETE.
        await query('SAVEPOINT retention_plan')
        try {
          const p=await (query as any)(`EXPLAIN (ANALYZE, FORMAT JSON) ${String(args[0])}`,args[1])
          inspectedPlan=p.rows[0]['QUERY PLAN'][0].Plan
        } finally { await query('ROLLBACK TO SAVEPOINT retention_plan') }
      }
      const started=Date.now()
      try{return await (query as any)(...args)}catch{
        // Closed phase labels only, never SQL parameters/provider payloads.
        const phase=String(args[0]).match(/DELETE FROM identity_risk_(findings|matched_results|rule_coverage|evaluation_runs)/)?.[1]??'transaction'
        console.info(`Synthetic retention blocked phase=${phase}, elapsedMs=${Date.now()-started}`)
        throw new Error('synthetic retention SQL failure')
      }
    }
    return w(c)
  })
  const original=f.worker.prune.bind(f.worker)
  let failedAttempts=0
  f.worker.prune=async(...args)=>{
    try { const r=await original(...args);calls.push(r);return r }
    catch(error){failedAttempts++;throw error}
  }
  const originalFetch=globalThis.fetch
  globalThis.fetch=async()=>{throw new Error('Cleanup must not call providers')}
  const started=Date.now()
  try {
    let runs=0,children=0,reportedFailures=0
    for(let i=0;i<3 && !runs;i++) {
      const result=await f.worker.run()
      reportedFailures+=result.failedBatches
      runs+=result.runs;children+=result.findings+result.matchedResults+result.coverage
    }
    // A hard 1s transport budget can legitimately expire under test-host load.
    // It must be reported exactly, retry without lost/double-counted evidence,
    // and still drain this finite synthetic graph within the bounded attempts.
    assert.equal(reportedFailures,failedAttempts)
    // Assert outside the worker catch boundary: a plan regression must fail
    // this test, not be swallowed as a retryable maintenance failure.
    assert.ok(inspectedPlan,'Actual synthetic delete plan must have completed')
    const parentScans:any[]=[],candidateSets:any[]=[]
    const visit=(n:any)=>{
      if(n['Relation Name']==='identity_risk_matched_results' && n.Alias==='p')parentScans.push(n)
      if(['CTE candidate_matches','CTE candidate_findings'].includes(n['Subplan Name']))candidateSets.push(n)
      for(const c of n.Plans??[])visit(c)
    }
    visit(inspectedPlan)
    assert.ok(parentScans.length>0)
    for(const scan of parentScans) {
      assert.ok(String(scan['Node Type']).includes('Index'),'Unique parent probes must not scan all tenant matches')
      assert.match(scan['Index Cond']??'',/\bid\s*=\s*[^=]*\bmatched_result_id\b/,'Parent index condition must bind the unique ID to this finding')
      assert.ok(scan['Actual Rows']<=1)
      assert.ok(scan['Actual Loops']>0 && scan['Actual Loops']<=HISTORY_BATCH_ROWS)
    }
    assert.equal(candidateSets.length,2)
    for(const set of candidateSets)assert.ok(set['Actual Rows']*set['Actual Loops']<=HISTORY_BATCH_ROWS)
    console.info(JSON.stringify({syntheticRetentionPlan:{parentRowsPerLoop:parentScans.map(s=>s['Actual Rows']),parentLoops:parentScans.map(s=>s['Actual Loops']),candidateRows:candidateSets.map(s=>s['Actual Rows']*s['Actual Loops'])}}))
    assert.equal(runs,1);assert.equal(children,4022)
    for(const r of calls) assert.ok(r.findings+r.matchedResults+r.coverage<=HISTORY_BATCH_ROWS)
    assert.deepEqual(await count(f.c,s),{runs:0,findings:0,matches:0,coverage:0})
    console.info(`Synthetic retention capacity: 4022 children, 1 run, ${calls.length} committed batches, ${failedAttempts} bounded failures/retries, ${Date.now()-started}ms; not a production SLA`)
  }finally{
    globalThis.fetch=originalFetch
    for(const k of Object.keys(values)) if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k]
  }
}))

test('history: durable tenant cursor visits beyond 1000 tenants across lease restarts and wraps', {skip:!enabled,timeout:120000},()=>fixture(async f=>{
  const org=f.scopes[0]!.organizationId
  const tenants=Array.from({length:1001},()=>({id:randomUUID(),organizationId:org,microsoftTenantId:randomUUID(),displayName:'example.invalid',status:'PENDING' as const}))
  await f.prisma.customerTenant.createMany({data:tenants})
  await f.c.query(`INSERT INTO identity_risk_evaluation_runs
    (id,organization_id,customer_tenant_id,run_key,engine_version,catalog_version,status,window_start,window_end,
    source_watermark_hash,source_content_hash,capability,created_at,completed_at,expires_at)
    SELECT gen_random_uuid(),organization_id,id,id::text,'synthetic','synthetic','COMPLETED',CURRENT_TIMESTAMP-INTERVAL '92 days',
    CURRENT_TIMESTAMP-INTERVAL '91 days','synthetic','synthetic','UNAVAILABLE',CURRENT_TIMESTAMP-INTERVAL '91 days',
    CURRENT_TIMESTAMP-INTERVAL '91 days',CURRENT_TIMESTAMP-INTERVAL '84 days' FROM customer_tenants WHERE id=ANY($1::uuid[])`,[tenants.map(t=>t.id)])
  // Never use all against a shared test database. The internal worker config is
  // widened only for these 1001 synthetic IDs to test cursor depth (public cap100).
  const config={...f.config,scopes:tenants.map(t=>({organizationId:org,customerTenantId:t.id}))}
  const seen=new Set<string>();let lease=f.lease
  for(let i=0;i<1001;i++) {
    if(i && i%64===0){await f.worker.release(lease,Date.now()+3000);lease=(await new RiskHistoryRetention().claim(config,Date.now()+3000))!;assert.ok(lease)}
    const next=await new RiskHistoryRetention().next(config,lease,Date.now()+3000)
    assert.ok(next);assert.equal(next.organizationId,org);assert.ok(!seen.has(next.customerTenantId));seen.add(next.customerTenantId)
  }
  assert.equal(seen.size,1001)
  assert.equal(await f.worker.next(config,lease,Date.now()+3000),null)
  assert.equal((await f.worker.next(config,lease,Date.now()+3000))?.customerTenantId,[...seen][0])
  assert.equal((await f.c.query('SELECT count(*)::int AS n FROM identity_risk_evaluation_runs WHERE organization_id=$1',[org])).rows[0].n,1001)
}))
