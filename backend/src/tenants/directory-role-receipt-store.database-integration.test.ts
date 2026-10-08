import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { ChangeEvidenceService } from '../changes/change-evidence.service.js'
import { collectDirectoryRoles } from './directory-role-collector.js'
import { publishManagedAuthority, type AuthorityDatabase, type AuthorityTransaction } from '../microsoft/managed-connector-authority.js'
import { captureRoleAttempt, activateRoleScope, claimRoleAttempt, completeRoleAttempt, finishRoleAttempt,
  ROLE_CLOCK_SQL, ROLE_DEADLINE_PREDICATE, type RoleContext } from './directory-role-receipt-store.js'
const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
const difference = ChangeEvidenceService.prototype.buildSnapshotDifferenceEvidence
function gate<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
// A provider/lock callback may never run if its operation rejects or returns early.
// Parent cancellation must also unwind the owner so its finally releases resources.
async function waitForGate<T>(barrier: { promise: Promise<T> }, pending: Promise<unknown>, signal: AbortSignal) {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([cancelled, barrier.promise, pending.then(() => {
      throw new Error('operation settled before reaching the expected test gate')
    })])
  } finally { signal.removeEventListener('abort', abort) }
}
function collection(rows: unknown[] = []) { return { rows, contentDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') } }
const role = (id: string) => ({ id, principalId: 'person-'+id, roleDefinitionId: 'definition', directoryScopeId: '/' })

test('role receipt composed actual Prisma transactions', { skip, timeout: 90000 }, async t => {
  const url = assertDisposableTestDatabase()
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 })
  const schema = 'role_receipt_' + randomUUID().replaceAll('-', '')
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 8 }, { schema }) })
  let observerToRelease: pg.PoolClient | undefined
  try {
    const observer = observerToRelease = await pool.connect()
    await observer.query(`CREATE SCHEMA ${schema}`)
    await observer.query(`SET search_path TO ${schema},public`)
    // Clone actual migrated table shapes. No fixture-only SQL reimplementation of the core.
    for (const name of ['customer_tenants','tenant_connections','sync_states','tenant_entra_snapshots','change_evidence_events',
      'platform_microsoft_connectors','encrypted_secrets','managed_connector_authority_revisions']) {
      await observer.query(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`)
    }
    const host = (hook?: (sql: string, pid: number) => Promise<void>, beforeCommit?: () => Promise<void>, entered?: (pid: number) => void): AuthorityDatabase => ({
      async $transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>) {
        return prisma.$transaction(async actual => {
          await actual.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`)
          await actual.$executeRawUnsafe("SET LOCAL statement_timeout='8s'")
          const [{ pid }] = await actual.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid')
          entered?.(pid)
          const tx: AuthorityTransaction = {
            async $queryRawUnsafe<T>(sql: string, ...values: any[]): Promise<T> {
              const result = await actual.$queryRawUnsafe<T>(sql, ...values); await hook?.(sql,pid); return result
            },
            async $executeRawUnsafe(sql: string, ...values: any[]): Promise<number> {
              const result = await actual.$executeRawUnsafe(sql, ...values); await hook?.(sql,pid); return result
            },
          }
          const result = await work(tx); await beforeCommit?.(); return result
        }, { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 15000 })
      },
    })
    const db=host()
    const revision=randomUUID(), organizationId=randomUUID(), customerTenantId=randomUUID(), microsoftTenantId=randomUUID()
    const who={organizationId,customerTenantId,microsoftTenantId,configurationRevision:revision}
    const publication=(expectedRevision: string | null, next=randomUUID()) => ({expectedRevision,revision:next,operationId:randomUUID(),clientId:randomUUID(),homeTenantId:randomUUID(),credentialExpiresAt:null,
      sealed:{ciphertext:Buffer.from('synthetic'),initializationVector:Buffer.alloc(12),authenticationTag:Buffer.alloc(16),keyVersion:1}})
    const waitBlocked=async(pid:number) => {
      const end=Date.now()+4000
      while(Date.now()<end) {
        t.signal.throwIfAborted()
        const q=await observer.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])
        if(q.rows[0].n>0)return
        await new Promise(r=>setTimeout(r,5))
      }
      assert.fail('expected blocked backend '+pid)
    }
    const state=async()=> (await observer.query('SELECT * FROM sync_states WHERE customer_tenant_id=$1 AND resource_type=\'DIRECTORY_ROLES\'',[customerTenantId])).rows[0]
    const snapshot=async()=> (await observer.query('SELECT * FROM tenant_entra_snapshots WHERE customer_tenant_id=$1',[customerTenantId])).rows
    const evidence=async()=> (await observer.query('SELECT * FROM change_evidence_events ORDER BY id')).rows
    const claim=async(ctx:RoleContext, database=db)=>{const r=await claimRoleAttempt(database,ctx);assert.equal(r.status,'claimed');if(r.status!=='claimed')throw Error('claim');return r.attempt}
    let ctx!:RoleContext
    await observer.query(`INSERT INTO customer_tenants(id,organization_id,microsoft_tenant_id,status,updated_at) VALUES($1,$2,$3,'ACTIVE',now())`,[customerTenantId,organizationId,microsoftTenantId])
    await observer.query(`INSERT INTO tenant_connections(id,organization_id,customer_tenant_id,status,connection_mode,updated_at) VALUES($1,$2,$3,'CONNECTED','HAWKVIEW_MANAGED',now())`,[randomUUID(),organizationId,customerTenantId])
    assert.equal((await publishManagedAuthority(db,publication(null,revision))).status,'published')
    await t.test('managed missing opt-in rejects; customer legacy stays unverified; activation CAS and first R creation',async()=>{
      assert.deepEqual(await captureRoleAttempt(db,who),{status:'rejected',reason:'UNAVAILABLE'})
      assert.equal(await state(),undefined)
      try {
        await observer.query("UPDATE tenant_connections SET connection_mode='CUSTOMER_MANAGED' WHERE customer_tenant_id=$1",[customerTenantId])
        assert.deepEqual(await captureRoleAttempt(db,who),{status:'legacy'})
        assert.deepEqual(await activateRoleScope(db,{...who,expectedConnectionIncarnation:null,expectedScopeIncarnation:null}),{status:'rejected',reason:'UNAVAILABLE'})
        assert.equal(await state(),undefined)
      } finally {
        await observer.query("UPDATE tenant_connections SET connection_mode='HAWKVIEW_MANAGED' WHERE customer_tenant_id=$1",[customerTenantId])
      }
      assert.equal((await snapshot()).length,0)
      const [a,b]=await Promise.all([activateRoleScope(db,{...who,expectedConnectionIncarnation:null,expectedScopeIncarnation:null}),activateRoleScope(db,{...who,expectedConnectionIncarnation:null,expectedScopeIncarnation:null})])
      const winner=a.status==='activated'?a:b;assert.equal(winner.status,'activated')
      assert.equal([a,b].filter(x=>x.status==='activated').length,1)
      if(winner.status!=='activated')throw Error('activation');ctx=winner.context
      assert.equal((await state()).role_complete_id,null)
      assert.equal((await state()).last_successful_at,null)
    })
    // Subtest failures do not throw from t.test; do not cascade with an absent context.
    assert.ok(ctx,'initial managed activation must establish the shared test context')
    await t.test('runtime capture rejects retained marker on revoked/inactive authority, never legacy',async()=>{
      const before=await state()
      try {
        await observer.query("UPDATE tenant_connections SET status='REVOKED' WHERE customer_tenant_id=$1",[customerTenantId])
        assert.deepEqual(await captureRoleAttempt(db,who),{status:'rejected',reason:'UNAVAILABLE'})
        await observer.query("UPDATE tenant_connections SET status='CONNECTED' WHERE customer_tenant_id=$1",[customerTenantId])
        await observer.query("UPDATE customer_tenants SET status='DISCONNECTED' WHERE id=$1",[customerTenantId])
        assert.deepEqual(await captureRoleAttempt(db,who),{status:'rejected',reason:'UNAVAILABLE'})
        assert.deepEqual(await state(),before)
      } finally {
        await observer.query("UPDATE tenant_connections SET status='CONNECTED' WHERE customer_tenant_id=$1",[customerTenantId])
        await observer.query("UPDATE customer_tenants SET status='ACTIVE' WHERE id=$1",[customerTenantId])
      }
    })
    await t.test('one winner, BUSY loser and empty/no-change COMPLETE advances identity atomically',async()=>{
      const [a,b]=await Promise.all([claimRoleAttempt(db,ctx),claimRoleAttempt(db,ctx)])
      const winner=a.status==='claimed'?a:b;assert.equal(winner.status,'claimed');assert.equal([a,b].filter(x=>x.status==='claimed').length,1)
      if(winner.status!=='claimed')throw Error('claim')
      const result=await completeRoleAttempt(db,winner.attempt,collection(),difference);assert.equal(result.status,'committed')
      const before=await state(), next=await claim(ctx)
      const second=await completeRoleAttempt(db,next,collection(),difference);assert.equal(second.status,'committed')
      assert.notEqual((await state()).role_complete_id,before.role_complete_id)
      const [snap]=await snapshot();const s=await state();assert.equal(snap.role_publication_attempt_id,s.role_complete_id)
      assert.equal(+snap.observed_at,+s.role_complete_checked_at);assert.equal(+s.last_successful_at,+s.role_complete_checked_at)
      assert.equal((await evidence()).length,0)
    })
    await t.test('actual difference builder, unchanged order, retained replay before newer failure/expiry',async()=>{
      const a=await claim(ctx), rows=collection([role('a'),role('b')]);const first=await completeRoleAttempt(db,a,rows,difference)
      assert.equal(first.status,'committed');assert.equal((await evidence()).length,2)
      const b=await claim(ctx),running=await state();assert.equal((await completeRoleAttempt(db,a,rows,difference)).status,'replayed');assert.deepEqual(await state(),running)
      assert.equal((await finishRoleAttempt(db,b,'PARTIAL')).status,'partial')
      const unchanged=await state();assert.equal((await completeRoleAttempt(db,a,rows,difference)).status,'replayed');assert.deepEqual(await state(),unchanged)
      assert.equal((await completeRoleAttempt(db,a,collection([role('bad')]),difference)).status,'rejected')
      const failed=await claim(ctx);assert.equal((await finishRoleAttempt(db,failed,'FAILED')).status,'failed')
      const failure=await state();assert.equal((await completeRoleAttempt(db,a,rows,difference)).status,'replayed');assert.deepEqual(await state(),failure)
      const c=await claim(ctx);await completeRoleAttempt(db,c,collection([role('b'),role('a')]),difference)
      assert.equal((await evidence()).length,2);assert.deepEqual(await completeRoleAttempt(db,a,rows,difference),{status:'rejected',reason:'SUPERSEDED'})
      const d=await claim(ctx);await observer.query("UPDATE sync_states SET role_attempt_started_at=date_trunc('milliseconds',clock_timestamp()-interval '10 minutes'),role_attempt_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[(await state()).id])
      assert.equal((await finishRoleAttempt(db,d,'FAILED')).status,'expired')
      const old=await state();assert.equal((await completeRoleAttempt(db,c,collection([role('b'),role('a')]),difference)).status,'replayed');assert.deepEqual(await state(),old)
    })
    for(const point of ['evidence','snapshot','receipt','commit']) await t.test('rollback after '+point+' rolls back all composed writes',async()=>{
      const a=await claim(ctx), before={s:await state(),p:await snapshot(),e:await evidence()}
      const fail=async()=>{throw Error('injected '+point)}
      const broken=host(async sql=>{if((point==='evidence'&&sql.includes('INSERT INTO change_evidence_events'))||(point==='snapshot'&&sql.includes('INSERT INTO tenant_entra_snapshots'))||(point==='receipt'&&sql.includes("SET role_attempt_outcome='COMPLETE'")))await fail()},point==='commit'?fail:undefined)
      await assert.rejects(completeRoleAttempt(broken,a,collection([role(point)]),difference),/injected/)
      assert.deepEqual({s:await state(),p:await snapshot(),e:await evidence()},before)
      assert.equal((await finishRoleAttempt(db,a,'FAILED')).status,'failed')
    })
    await t.test('prepared bytes and attempt identity are captured before lock waits',async()=>{
      const a=await claim(ctx),originalId=a.attemptId,rows=collection([role('captured')]),entered=gate(),release=gate()
      const pending=completeRoleAttempt(host(async sql=>{if(sql.includes('pg_advisory_xact_lock_shared')){entered.resolve();await release.promise}}),a,rows,difference)
      try {
        await waitForGate(entered,pending,t.signal)
        const mutableRow=rows.rows[0] as ReturnType<typeof role>
        mutableRow.principalId='mutated';a.attemptId=randomUUID()
      } finally { release.resolve(); await Promise.allSettled([pending]) }
      const result=await pending;assert.equal(result.status,'committed')
      const [snap]=await snapshot();assert.equal(snap.role_publication_attempt_id,originalId);assert.equal(snap.payload[0].principalId,'person-captured')
    })
    await t.test('observer sees previous complete until commit; G blocks actual managed replacement',async()=>{
      const a=await claim(ctx), before=await snapshot(), entered=gate(),release=gate(),pid=gate<number>()
      const pending=completeRoleAttempt(host(undefined,async()=>{entered.resolve();await release.promise}),a,collection([role('committed')]),difference)
      const replacement=publication(revision)
      let replace: ReturnType<typeof publishManagedAuthority> | undefined
      try {
        await waitForGate(entered,pending,t.signal)
        replace=publishManagedAuthority(host(undefined,undefined,pid.resolve),replacement)
        await waitBlocked(await waitForGate(pid,replace,t.signal));assert.deepEqual(await snapshot(),before)
      } finally { release.resolve(); await Promise.allSettled([pending,replace]) }
      assert.ok(replace)
      assert.equal((await pending).status,'committed');assert.equal((await replace).status,'published')
      assert.deepEqual(await finishRoleAttempt(db,a,'FAILED'),{status:'rejected',reason:'SUPERSEDED'})
      who.configurationRevision=replacement.revision;ctx={...ctx,configurationRevision:replacement.revision}
      const captured=await captureRoleAttempt(db,who)
      assert.equal(captured.status,'claimed')
      if(captured.status!=='claimed')throw Error('capture')
      assert.equal(captured.attempt.scopeIncarnation,ctx.scopeIncarnation)
      assert.equal(captured.authority.configurationRevision,replacement.revision)
      assert.equal(captured.attempt.configurationRevision,replacement.revision)
      assert.equal((await finishRoleAttempt(db,captured.attempt,'FAILED')).status,'failed')
    })
    await t.test('captured adapter releases locks for provider; old G success/error reject and fresh G completes under retained S',async()=>{
      for(const failure of [false,true]) {
        const entered=gate(),release=gate(),capturedRevision=who.configurationRevision
        const beforeSnapshot=await snapshot(),beforeEvidence=await evidence()
        const dependencies={db,token:async(authority:{configurationRevision:string})=>{
          assert.equal(authority.configurationRevision,capturedRevision);return 'synthetic-token'
        },fetchPage:async()=>{entered.resolve();await release.promise;if(failure)throw Error('old provider failure');return Response.json({value:[]})},
        read:async(response:Response)=>response.text(),buildDifference:difference,legacy:async()=>{throw Error('activated fallback')}}
        const pending=collectDirectoryRoles(who,dependencies)
        const replacement=publication(capturedRevision)
        try {
          await waitForGate(entered,pending,t.signal)
          // This actual writer must finish while the provider callback is still paused.
          assert.equal((await publishManagedAuthority(db,replacement)).status,'published')
        } finally {release.resolve();await Promise.allSettled([pending])}
        assert.deepEqual(await pending,{status:'rejected',reason:'SUPERSEDED'})
        assert.deepEqual(await snapshot(),beforeSnapshot);assert.deepEqual(await evidence(),beforeEvidence)
        who.configurationRevision=replacement.revision;ctx={...ctx,configurationRevision:replacement.revision}
        const fresh=await collectDirectoryRoles(who,{...dependencies,token:async(authority:{configurationRevision:string})=>{
          assert.equal(authority.configurationRevision,replacement.revision);return 'new-token'
        },fetchPage:async()=>Response.json({value:[]})})
        assert.equal(fresh.status,'committed')
        if(fresh.status!=='committed')throw Error('fresh capture')
        assert.equal(fresh.receipt.scopeIncarnation,ctx.scopeIncarnation)
      }
    })
    await t.test('post-lock clock after C wait rejects expired attempt; caller time cannot extend it',async()=>{
      const a=await claim(ctx), client=await pool.connect(),pid=gate<number>()
      let pending: ReturnType<typeof completeRoleAttempt> | undefined
      try {
        await client.query('BEGIN');await client.query(`SET LOCAL search_path TO ${schema},public`)
        await client.query('SELECT id FROM tenant_connections WHERE customer_tenant_id=$1 FOR UPDATE',[customerTenantId])
        pending=completeRoleAttempt(host(undefined,undefined,pid.resolve),a,collection(),difference)
        await waitBlocked(await waitForGate(pid,pending,t.signal))
        await client.query("UPDATE sync_states SET role_attempt_started_at=date_trunc('milliseconds',clock_timestamp()-interval '10 minutes'),role_attempt_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1",[(await state()).id])
        await client.query('COMMIT');assert.equal((await pending).status,'expired')
      } finally {
        try { await client.query('ROLLBACK') } finally { client.release();await Promise.allSettled([pending]) }
      }
    })
    await t.test('shared raw SQL deadline expression: ms/us before equality after and fractional legacy',async()=>{
      for(const [deadline,points] of [['2030-01-01T00:00:00.001000Z',['2030-01-01T00:00:00.000999Z','2030-01-01T00:00:00.001000Z','2030-01-01T00:00:00.001001Z']],['2030-01-01T00:00:00.001500Z',['2030-01-01T00:00:00.001499Z','2030-01-01T00:00:00.001500Z','2030-01-01T00:00:00.001501Z']]] as const) {
        for(let i=0;i<points.length;i++) {
          const q=await observer.query(`SELECT (${ROLE_DEADLINE_PREDICATE}) AS live FROM (SELECT $1::timestamptz AS sampled_at,$2::timestamptz AS role_attempt_expires_at) s`,[points[i],deadline])
          assert.equal(q.rows[0].live,i===0)
        }
      }
      assert.ok(ROLE_CLOCK_SQL.includes(ROLE_DEADLINE_PREDICATE))
      const mutant=await observer.query("SELECT date_trunc('milliseconds',$1::timestamptz)<$2::timestamptz AS live",['2030-01-01T00:00:00.001501Z','2030-01-01T00:00:00.001500Z']);assert.equal(mutant.rows[0].live,true)
    })
    await t.test('activation/connection ABA invalidates late success and failure; identity isolation',async()=>{
      const a=await claim(ctx), old=ctx
      const activated=await activateRoleScope(db,{...ctx,expectedConnectionIncarnation:ctx.connectionIncarnation,expectedScopeIncarnation:ctx.scopeIncarnation,rotateConnection:true})
      assert.equal(activated.status,'activated');if(activated.status!=='activated')throw Error('activation');ctx=activated.context
      const b=await claim(ctx);await completeRoleAttempt(db,b,collection(),difference);const current=await state()
      assert.deepEqual(await finishRoleAttempt(db,a,'FAILED'),{status:'rejected',reason:'INCARNATION_CHANGED'})
      assert.equal((await completeRoleAttempt(db,a,collection(),difference)).status,'rejected')
      for(const wrong of [{...ctx,organizationId:randomUUID()},{...ctx,microsoftTenantId:randomUUID()},{...old}])assert.equal((await claimRoleAttempt(db,wrong)).status,'rejected')
      assert.deepEqual(await state(),current)
      assert.notEqual(ctx.connectionIncarnation,old.connectionIncarnation);assert.notEqual(ctx.scopeIncarnation,old.scopeIncarnation)
    })
    await t.test('actual USERS→C work interleaves with C→R without reverse acquisition',async()=>{
      await observer.query(`INSERT INTO sync_states(id,organization_id,customer_tenant_id,resource_type,updated_at) VALUES($1,$2,$3,'USERS',now())`,[randomUUID(),organizationId,customerTenantId])
      const cLocked=gate(),release=gate(),pid=gate<number>(),users=await pool.connect()
      let pending: ReturnType<typeof claimRoleAttempt> | undefined
      let update: Promise<pg.QueryResult> | undefined
      try {
        await users.query('BEGIN');await users.query(`SET LOCAL search_path TO ${schema},public`)
        await users.query("SELECT id FROM sync_states WHERE resource_type='USERS' FOR UPDATE")
        pending=claimRoleAttempt(host(async sql=>{if(sql.includes("connection_mode='HAWKVIEW_MANAGED'")){cLocked.resolve();await release.promise}}),ctx)
        await waitForGate(cLocked,pending,t.signal)
        pid.resolve((await users.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        update=users.query('UPDATE tenant_connections SET last_verified_at=clock_timestamp() WHERE customer_tenant_id=$1',[customerTenantId])
        try{await waitBlocked(await waitForGate(pid,update,t.signal))}finally{release.resolve()}
        assert.equal((await pending).status,'claimed');await update;await users.query('COMMIT')
      }finally{
        release.resolve()
        await Promise.allSettled([pending,update])
        try { await users.query('ROLLBACK') } finally { users.release() }
      }
    })
    for (const point of ['G','T','R','S','S-row']) await t.test('expiry clock is after the actual '+point+' lock barrier',async()=>{
      const current=await state()
      const a=current.role_attempt_outcome==='RUNNING'?{...ctx,attemptId:current.role_attempt_id}:await claim(ctx)
      const client=await pool.connect(),pid=gate<number>()
      let pending: ReturnType<typeof completeRoleAttempt> | undefined
      try {
        await observer.query("UPDATE sync_states SET role_attempt_expires_at=date_trunc('milliseconds',clock_timestamp()+interval '150 milliseconds') WHERE id=$1",[(await state()).id])
        await client.query('BEGIN');await client.query(`SET LOCAL search_path TO ${schema},public`)
        if(point==='G')await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['hawkview:managed-connector:default:authority:v1'])
        if(point==='S-row')await client.query("SELECT id FROM tenant_entra_snapshots WHERE customer_tenant_id=$1 AND resource_type='DIRECTORY_ROLES' FOR UPDATE",[customerTenantId])
        if(point==='T')await client.query('SELECT id FROM customer_tenants WHERE id=$1 FOR UPDATE',[customerTenantId])
        if(point==='R')await client.query("SELECT id FROM sync_states WHERE customer_tenant_id=$1 AND resource_type='DIRECTORY_ROLES' FOR UPDATE",[customerTenantId])
        if(point==='S')await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`hawkview:snapshot:${customerTenantId}:DIRECTORY_ROLES`])
        const before=await snapshot()
        pending=completeRoleAttempt(host(undefined,undefined,pid.resolve),a,collection(),difference)
        await waitBlocked(await waitForGate(pid,pending,t.signal))
        const deadline=Date.now()+4000
        let due=false
        while(Date.now()<deadline){
          t.signal.throwIfAborted()
          due=(await observer.query("SELECT clock_timestamp()>=role_attempt_expires_at AS due FROM sync_states WHERE customer_tenant_id=$1 AND resource_type='DIRECTORY_ROLES'",[customerTenantId])).rows[0].due
          if(due)break
          await new Promise(r=>setTimeout(r,5))
        }
        assert.ok(due,'database deadline must have elapsed before releasing lock')
        await client.query('COMMIT');assert.equal((await pending).status,'expired');assert.deepEqual(await snapshot(),before)
      }finally{
        try { await client.query('ROLLBACK') } finally { client.release();await Promise.allSettled([pending]) }
      }
    })
    await t.test('constraints reject non-role metadata and half receipts; actual Prisma typed read',async()=>{
      await assert.rejects(observer.query("UPDATE sync_states SET role_scope_incarnation=$1 WHERE resource_type='USERS'",[randomUUID()]),/role_fields_only|role_scope_shape/)
      await assert.rejects(observer.query("UPDATE sync_states SET role_complete_digest=NULL WHERE resource_type='DIRECTORY_ROLES'"),/role_complete_shape/)
      const stateId=(await state()).id
      const rows=await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`);return tx.syncState.findMany({where:{id:stateId}})})
      assert.equal(rows.length,1)
      assert.equal(rows[0].roleScopeIncarnation,ctx.scopeIncarnation)
    })
  } finally {
    try { await prisma.$disconnect() } finally {
      try { await observerToRelease?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally {
        observerToRelease?.release()
        await pool.end()
      }
    }
  }
})

test('role migration preserves legacy rows and rolls back DDL atomically', { skip, timeout: 30000 }, async () => {
  const url=assertDisposableTestDatabase(),client=new pg.Client({connectionString:url.toString()})
  const schema='role_upgrade_'+randomUUID().replaceAll('-','')
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`)
    for(const name of ['tenant_connections','sync_states','tenant_entra_snapshots'])await client.query(`CREATE TABLE ${schema}.${name} (LIKE public.${name} INCLUDING ALL)`)
    // Exact legacy shape, using the migrated schema only to avoid maintaining a second fixture schema.
    const columns=(await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=$1 AND (column_name LIKE 'role_%' OR column_name='collection_incarnation')`,[schema])).rows
    for(const c of columns)await client.query(`ALTER TABLE ${schema}.${c.table_name} DROP COLUMN ${c.column_name} CASCADE`)
    const tenant=randomUUID(),org=randomUUID()
    await client.query(`INSERT INTO tenant_connections(id,organization_id,customer_tenant_id,status,updated_at) VALUES($1,$2,$3,'CONNECTED',now())`,[randomUUID(),org,tenant])
    for(const resource of ['DIRECTORY_ROLES','USERS'])await client.query(`INSERT INTO sync_states(id,organization_id,customer_tenant_id,resource_type,status,last_successful_at,updated_at)
      VALUES($1,$2,$3,$4::"SyncResourceType",'SUCCEEDED','2020-01-01T00:00:00Z',now())`,[randomUUID(),org,tenant,resource])
    await client.query(`INSERT INTO tenant_entra_snapshots(id,organization_id,customer_tenant_id,resource_type,payload,updated_at)
      VALUES($1,$2,$3,'DIRECTORY_ROLES','[{"id":"legacy"}]',now())`,[randomUUID(),org,tenant])
    const before=await client.query('SELECT * FROM sync_states ORDER BY id')
    const migration=await readFile(new URL('../../prisma/migrations/20261002130000_directory_role_receipt_core/migration.sql',import.meta.url),'utf8')
    await client.query(migration.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND column_name='role_scope_version'",[schema])).rowCount,0)
    await client.query(migration)
    const after=(await client.query('SELECT * FROM sync_states ORDER BY id')).rows
    for(let i=0;i<after.length;i++) {
      const legacy=Object.fromEntries(Object.entries(after[i]).filter(([key])=>!key.startsWith('role_')))
      assert.deepEqual(legacy,before.rows[i])
      assert.ok(Object.entries(after[i]).filter(([key])=>key.startsWith('role_')).every(([,value])=>value===null))
    }
    assert.equal((await client.query('SELECT collection_incarnation FROM tenant_connections')).rows[0].collection_incarnation,null)
    const snap=(await client.query('SELECT payload,role_publication_attempt_id FROM tenant_entra_snapshots')).rows[0]
    assert.deepEqual(snap.payload,[{id:'legacy'}]);assert.equal(snap.role_publication_attempt_id,null)
    // Old-style generic writes remain possible while trust is disabled; these do NOT establish a receipt.
    await client.query("UPDATE sync_states SET status='FAILED',last_error_code='LEGACY' WHERE resource_type='DIRECTORY_ROLES'")
    await client.query("UPDATE tenant_entra_snapshots SET payload='[]',observed_at=now()")
    assert.equal((await client.query("SELECT role_complete_id FROM sync_states WHERE resource_type='DIRECTORY_ROLES'")).rows[0].role_complete_id,null)
    const boundary=(await client.query(`SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN ('tenant_connections','sync_states','tenant_entra_snapshots') ORDER BY relname`)).rows
    assert.equal(boundary.length,3);assert.ok(boundary.every(row=>row.relrowsecurity===true))
  }finally{await client.query('ROLLBACK');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end()}
})
