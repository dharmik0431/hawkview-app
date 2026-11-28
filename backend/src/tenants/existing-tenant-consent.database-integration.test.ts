import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { NotFoundException } from '@nestjs/common'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { TenantsService } from './tenants.service.js'
import { publishManagedAuthority } from '../microsoft/managed-connector-authority.js'
import { applyManagedConsentEffects } from '../microsoft/managed-consent-effects.js'
import { DAILY_INVENTORY_RESOURCES, HOURLY_INVENTORY_FIRST_RETRY_MS, scheduledSyncTenantWhere, selectScheduledTenantWork } from './scheduled-sync-selection.js'

const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
test('existing tenant public consent route with physical transaction and synthetic provider', { skip, timeout:90000 }, async t => {
  const url = assertDisposableTestDatabase()
  const pool = new pg.Pool({connectionString:url.toString(),max:6}), observer = await pool.connect()
  await observer.query("SET TIME ZONE 'UTC'")
  const prisma = new PrismaClient({adapter:new PrismaPg({connectionString:url.toString(),max:8,options:'-c timezone=UTC'})})
  // This suite uses the fully migrated disposable schema, including real FKs.
  // Refuse to overwrite another suite's global connector fixture.
  assert.equal((await observer.query("SELECT count(*)::int AS n FROM platform_microsoft_connectors WHERE id='default'")).rows[0].n,0)
  const organizationId=randomUUID(),customerTenantId=randomUUID(),microsoftTenantId=randomUUID(),actor=randomUUID(),actorSubject=randomUUID()
  const foreignOrganizationId=randomUUID(),foreignTenantId=randomUUID(),siblingTenantId=randomUUID(),foreignActor=randomUUID()
  const connectionKey=`tenant:${customerTenantId}:connection`,authorizedKey=`tenant:${customerTenantId}:onboarding-authorized`
  const notificationScope=[organizationId,connectionKey,authorizedKey]
  // Include malformed-tenant rows at this fixture's exact keys so scope-rejection
  // tests still observe them. Other organizations and sibling tenant keys stay out.
  const notificationRows=async()=>(await observer.query('SELECT * FROM notifications WHERE organization_id=$1 AND dedupe_key IN ($2,$3) ORDER BY id',notificationScope)).rows
  const foreignRows=async()=>({
    notifications:(await observer.query('SELECT * FROM notifications WHERE organization_id=$1 OR customer_tenant_id=$2 ORDER BY id',[foreignOrganizationId,siblingTenantId])).rows,
    states:(await observer.query('SELECT s.* FROM notification_user_states s JOIN notifications n ON n.id=s.notification_id WHERE n.organization_id=$1 OR n.customer_tenant_id=$2 ORDER BY s.id',[foreignOrganizationId,siblingTenantId])).rows,
    connections:(await observer.query('SELECT * FROM tenant_connections WHERE customer_tenant_id IN ($1,$2) ORDER BY id',[foreignTenantId,siblingTenantId])).rows,
    sync:(await observer.query('SELECT * FROM sync_states WHERE customer_tenant_id IN ($1,$2) ORDER BY id',[foreignTenantId,siblingTenantId])).rows,
  })
  let revision=randomUUID()
  const revisions=[revision]
  const publication = (next:string) => ({expectedRevision:revision,revision:next,operationId:randomUUID(),clientId:randomUUID(),homeTenantId:randomUUID(),credentialExpiresAt:null,
    sealed:{ciphertext:Buffer.from('synthetic'),initializationVector:Buffer.alloc(12),authenticationTag:Buffer.alloc(16),keyVersion:1}})
  const microsoft = new MicrosoftConsentService(prisma as any,{access:async()=> 'synthetic-credential'} as any)
  ;(microsoft as any).getStateConfiguration=async()=>({stateSecret:'synthetic-consent-state-secret-at-least-32-bytes',redirectUri:'https://callback.invalid/consent'})
  const tenants = new TenantsService(prisma as any,microsoft,{publishIncident(){throw Error('legacy effect')},resolveIncident(){throw Error('legacy effect')}} as any)
  ;(tenants as any).buildFrontendConsentRedirect=(result:string,error:string|null)=>({result,error})
  let providerCalls=0
  const good=async()=>{providerCalls++;return {displayName:'Synthetic tenant',primaryDomain:'fixture.invalid',grantedPermissions:['Directory.Read.All'],missingPermissions:[],missingRequiredPermissions:[],missingNonConnectionPermissions:[]}}
  microsoft.verifyClaimedTenantAfterConsent=good
  const connection=async()=>(await observer.query('SELECT * FROM tenant_connections WHERE customer_tenant_id=$1',[customerTenantId])).rows[0]
  const issue=async()=>{
    const response=await tenants.createConsentUrlForIdentity({subject:actorSubject,email:'actor@fixture.invalid'} as any,customerTenantId)
    const state=new URL(response.consentUrl).searchParams.get('state')!
    const parsed=await microsoft.verifyConsentState(state)
    return {state,parsed,key:{operationId:parsed.operationId!,organizationId,customerTenantId,flow:'EXISTING_TENANT' as const,stateHash:microsoft.hashConsentNonce(parsed.nonce)}}
  }
  const callback=(state:string,extra:Record<string,unknown>={})=>tenants.completeMicrosoftConsent({state,tenant:microsoftTenantId,admin_consent:'True',...extra})
  const operation=async(id:string)=>(await observer.query('SELECT * FROM microsoft_consent_attempts WHERE id=$1',[id])).rows[0]
  try {
    await prisma.organization.create({data:{id:organizationId,name:'Synthetic route fixture',slug:organizationId,onboardingCompletedAt:new Date()}})
    await prisma.user.create({data:{id:actor,authProviderUserId:actorSubject,email:`${actor}@fixture.invalid`}})
    const membership=await prisma.membership.create({data:{userId:actor,organizationId,role:'MSP_OWNER',status:'ACTIVE'}})
    await observer.query("INSERT INTO customer_tenants(id,organization_id,microsoft_tenant_id,status,updated_at) VALUES($1,$2,$3,'ACTIVE',now())",[customerTenantId,organizationId,microsoftTenantId])
    await observer.query("INSERT INTO tenant_connections(id,organization_id,customer_tenant_id,status,consented_permissions,updated_at) VALUES($1,$2,$3,'CONNECTED',ARRAY['Exchange.ManageAsAppV2'],now())",[randomUUID(),organizationId,customerTenantId])
    // Shared CI database deliberately contains unrelated data. A matching dedupe
    // key in another organization also catches missing scope on fixture updates.
    await prisma.organization.create({data:{id:foreignOrganizationId,name:'Foreign route fixture',slug:foreignOrganizationId}})
    await prisma.user.create({data:{id:foreignActor,email:`${foreignActor}@fixture.invalid`}})
    for(const [org,tenant] of [[foreignOrganizationId,foreignTenantId],[organizationId,siblingTenantId]]) {
      await observer.query("INSERT INTO customer_tenants(id,organization_id,microsoft_tenant_id,status,updated_at) VALUES($1,$2,$3,'ACTIVE',now())",[tenant,org,randomUUID()])
      await observer.query("INSERT INTO tenant_connections(id,organization_id,customer_tenant_id,status,updated_at) VALUES($1,$2,$3,'CONNECTED',now())",[randomUUID(),org,tenant])
      await observer.query("INSERT INTO sync_states(id,organization_id,customer_tenant_id,resource_type,updated_at) VALUES($1,$2,$3,'USERS',now())",[randomUUID(),org,tenant])
      for(const key of org===foreignOrganizationId?[connectionKey,authorizedKey]:[`tenant:${tenant}:connection`]) {
        const row=await prisma.notification.create({data:{organizationId:org,customerTenantId:tenant,dedupeKey:key,eventType:'fixture.unrelated',
          category:'error',severity:'high',title:'Foreign fixture',description:'Synthetic unrelated secret sentinel',source:'route-test'}})
        await prisma.notificationUserState.create({data:{notificationId:row.id,userId:foreignActor,readAt:new Date()}})
      }
    }
    const foreignBefore=await foreignRows()
    assert.equal((await publishManagedAuthority(prisma,{...publication(revision),expectedRevision:null})).status,'published')
    await t.test('viewer cannot issue consent or change a connected tenant',async()=>{
      const before=await connection(),attempts=await prisma.microsoftConsentAttempt.count({where:{organizationId,customerTenantId,flow:'EXISTING_TENANT'}})
      await prisma.membership.update({where:{id:membership.id},data:{role:'MSP_VIEWER'}})
      try {
        await assert.rejects(issue(),NotFoundException)
        assert.deepEqual(await connection(),before)
        assert.equal(await prisma.microsoftConsentAttempt.count({where:{organizationId,customerTenantId,flow:'EXISTING_TENANT'}}),attempts)
      } finally {
        await prisma.membership.update({where:{id:membership.id},data:{role:'MSP_OWNER'}})
      }
    })
    await t.test('actual URL binds committed context and retains actor, optional permission, and replay identity',async()=>{
      const issued=await issue(),op=await operation(issued.key.operationId)
      assert.equal(op.initiated_by_user_id,actor);assert.equal(op.operation_state,'ISSUED')
      assert.equal((await connection()).collection_incarnation,op.expected_connection)
      assert.deepEqual(await callback(issued.state),{result:'success',error:null})
      assert.deepEqual((await connection()).consented_permissions,['Directory.Read.All','Exchange.ManageAsAppV2'])
      const before=await notificationRows()
      assert.equal(before.length,1);assert.equal(before[0].occurrence_count,1)
      assert.match(before[0].description,/ready for scheduled/)
      const calls=providerCalls
      assert.deepEqual(await callback(issued.state),{result:'success',error:null})
      assert.equal(providerCalls,calls);assert.deepEqual(await notificationRows(),before)
    })
    await t.test('two concurrent callbacks admit exactly one provider verifier',async()=>{
      const issued=await issue(),entered=gate(),resume=gate();const before=providerCalls
      microsoft.verifyClaimedTenantAfterConsent=async()=>{entered.release();await resume.promise;return good()}
      const first=callback(issued.state);await entered.promise
      assert.deepEqual(await callback(issued.state),{result:'error',error:'consent-in-progress'})
      resume.release();assert.deepEqual(await first,{result:'success',error:null});assert.equal(providerCalls,before+1)
      microsoft.verifyClaimedTenantAfterConsent=good
    })
    for (const failed of [false,true]) await t.test(`old callback ${failed?'failure':'success'} after new issuance cannot mutate new authority`,async()=>{
      const old=await issue(),entered=gate(),resume=gate()
      microsoft.verifyClaimedTenantAfterConsent=async()=>{entered.release();await resume.promise;if(failed)throw Error('synthetic private error');return good()}
      const first=callback(old.state);await entered.promise
      const next=await issue(),before=await connection(),notes=await notificationRows()
      resume.release();assert.deepEqual(await first,{result:'error',error:'superseded'})
      assert.deepEqual(await connection(),before);assert.deepEqual(await notificationRows(),notes)
      microsoft.verifyClaimedTenantAfterConsent=good;assert.deepEqual(await callback(next.state),{result:'success',error:null})
    })
    await t.test('effect failure cannot downgrade success; conditional replay can recover',async()=>{
      const issued=await issue()
      await observer.query(`ALTER TABLE notifications ADD CONSTRAINT reject_route_effect CHECK (metadata->>'consentOperationId' <> '${issued.key.operationId}')`)
      assert.deepEqual(await callback(issued.state),{result:'success',error:null})
      assert.equal((await connection()).status,'CONNECTED');assert.equal((await operation(issued.key.operationId)).operation_state,'SUCCEEDED')
      await observer.query('ALTER TABLE notifications DROP CONSTRAINT reject_route_effect')
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'applied')
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'replayed')
    })
    await t.test('denial and mismatched tenant do not call verifier',async()=>{
      const before=providerCalls,denied=await issue()
      assert.deepEqual(await callback(denied.state,{error:'sensitive-provider-error',error_description:'secret'}),{result:'error',error:'consent-denied'})
      const wrong=await issue();assert.deepEqual(await callback(wrong.state,{tenant:randomUUID()}),{result:'error',error:'tenant-mismatch'})
      assert.equal(providerCalls,before)
      assert.doesNotMatch(JSON.stringify(await notificationRows()),/sensitive-provider-error|secret/)
    })
    await t.test('managed replacement while verifier waits makes old callback historical',async()=>{
      const issued=await issue(),entered=gate(),resume=gate()
      microsoft.verifyClaimedTenantAfterConsent=async()=>{entered.release();await resume.promise;return good()}
      const first=callback(issued.state);await entered.promise
      const next=randomUUID();assert.equal((await publishManagedAuthority(prisma,publication(next))).status,'published');revision=next;revisions.push(next)
      const before=await connection();resume.release();assert.deepEqual(await first,{result:'error',error:'superseded'});assert.deepEqual(await connection(),before)
      microsoft.verifyClaimedTenantAfterConsent=good
    })
    await t.test('missing USERS remains scheduled without a callback sync-state write',async()=>{
      const issued=await issue();await callback(issued.state)
      assert.equal((await observer.query("SELECT count(*)::int AS n FROM sync_states WHERE resource_type='USERS' AND organization_id=$1 AND customer_tenant_id=$2",[organizationId,customerTenantId])).rows[0].n,0)
      const now=new Date(),found=await prisma.customerTenant.findMany({where:{AND:[scheduledSyncTenantWhere(now),{organizationId,id:customerTenantId}]},select:{id:true,syncStates:true}})
      assert.equal(found.length,1);assert.equal(selectScheduledTenantWork(found,now,10)[0].tenantId,customerTenantId)
    })
    await t.test('missing required permissions fail without clearing prior optional Exchange evidence',async()=>{
      const issued=await issue()
      microsoft.verifyClaimedTenantAfterConsent=async()=>({...await good(),missingRequiredPermissions:['Organization.Read.All']})
      assert.deepEqual(await callback(issued.state),{result:'missing-permissions',error:'missing-permissions'})
      assert.equal((await connection()).status,'ERROR')
      assert.ok((await connection()).consented_permissions.includes('Exchange.ManageAsAppV2'))
      microsoft.verifyClaimedTenantAfterConsent=good
    })
    await t.test('provider completion after fixed final deadline cannot update connection',async()=>{
      const issued=await issue(),before=await connection()
      microsoft.verifyClaimedTenantAfterConsent=async()=>{
        await observer.query(`WITH s AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS d)
          UPDATE microsoft_consent_attempts SET created_at=d-interval '7 minutes',expires_at=d+interval '8 minutes',
          operation_claimed_at=d-interval '6 minutes',consumed_at=d-interval '6 minutes',operation_final_deadline=d-interval '1 minute'
          FROM s WHERE id=$1`,[issued.key.operationId])
        return good()
      }
      assert.deepEqual(await callback(issued.state),{result:'error',error:'expired'})
      assert.deepEqual(await connection(),before)
      microsoft.verifyClaimedTenantAfterConsent=good
    })
    await t.test('real actor FK failure rolls back issuance and connection mutation',async()=>{
      const before=await connection(),count=(await observer.query('SELECT count(*)::int AS n FROM microsoft_consent_attempts WHERE organization_id=$1 AND customer_tenant_id=$2',[organizationId,customerTenantId])).rows[0].n
      ;(tenants as any).getTenantOnboardingActor=async()=>randomUUID()
      await assert.rejects(issue())
      assert.deepEqual(await connection(),before)
      assert.equal((await observer.query('SELECT count(*)::int AS n FROM microsoft_consent_attempts WHERE organization_id=$1 AND customer_tenant_id=$2',[organizationId,customerTenantId])).rows[0].n,count)
      ;(tenants as any).getTenantOnboardingActor=async()=>actor
    })
    await t.test('recipient reset failure rolls back incident but never terminal success',async()=>{
      const target=(await observer.query('SELECT id FROM notifications WHERE organization_id=$2 AND dedupe_key=$1',[`tenant:${customerTenantId}:onboarding-authorized`,organizationId])).rows[0]
      await prisma.notificationUserState.create({data:{notificationId:target.id,userId:actor,readAt:new Date()}})
      const before=(await observer.query('SELECT * FROM notifications WHERE id=$1',[target.id])).rows[0]
      await observer.query(`CREATE FUNCTION consent_route_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic reset failure'; END $$`)
      await observer.query('CREATE TRIGGER consent_route_reject_delete BEFORE DELETE ON notification_user_states FOR EACH ROW EXECUTE FUNCTION consent_route_reject_delete()')
      const issued=await issue();assert.deepEqual(await callback(issued.state),{result:'success',error:null})
      assert.equal((await connection()).status,'CONNECTED')
      assert.deepEqual((await observer.query('SELECT * FROM notifications WHERE id=$1',[target.id])).rows[0],before)
      assert.equal((await observer.query('SELECT count(*)::int AS n FROM notification_user_states WHERE notification_id=$1',[target.id])).rows[0].n,1)
      await observer.query('DROP TRIGGER consent_route_reject_delete ON notification_user_states')
      await observer.query('DROP FUNCTION consent_route_reject_delete()')
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'applied')
      assert.equal((await observer.query('SELECT count(*)::int AS n FROM notification_user_states WHERE notification_id=$1',[target.id])).rows[0].n,0)
      assert.equal(await applyManagedConsentEffects(prisma,{...issued.key,operationId:issued.key.operationId.toUpperCase()}),'replayed')
    })
    await t.test('later incident survives delayed success effects',async()=>{
      const issued=await issue();await callback(issued.state)
      await observer.query("UPDATE notifications SET metadata='{}',last_occurred_at=clock_timestamp()+interval '1 second' WHERE organization_id=$2 AND dedupe_key=$1",[`tenant:${customerTenantId}:connection`,organizationId])
      const before=await notificationRows()
      // Remove the success marker to exercise stale occurrence rejection, not replay.
      await observer.query("UPDATE notifications SET metadata='{}' WHERE organization_id=$2 AND dedupe_key=$1",[`tenant:${customerTenantId}:onboarding-authorized`,organizationId])
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale')
      assert.deepEqual((await observer.query('SELECT * FROM notifications WHERE organization_id=$2 AND dedupe_key=$1',[`tenant:${customerTenantId}:connection`,organizationId])).rows[0],before.find(r=>r.dedupe_key.endsWith(':connection')))
    })
    // v2 regression fixtures use deterministic synthetic occurrence times. The
    // provider/route/transactions are real; no clock scheduling is causal proof.
    const deferred = async (success=true, beforeFinish?:()=>Promise<void>) => {
      await observer.query('DELETE FROM notifications WHERE organization_id=$1 AND dedupe_key IN ($2,$3)',notificationScope)
      const issued=await issue()
      await beforeFinish?.()
      await observer.query(`ALTER TABLE notifications ADD CONSTRAINT reject_route_effect CHECK (metadata->>'consentOperationId' <> '${issued.key.operationId}')`)
      try { assert.deepEqual(await callback(issued.state,success?{}:{error:'access_denied'}),success?{result:'success',error:null}:{result:'error',error:'consent-denied'}) }
      finally { await observer.query('ALTER TABLE notifications DROP CONSTRAINT reject_route_effect') }
      return {...issued,terminal:(await operation(issued.key.operationId)).operation_terminal_at as Date}
    }
    const note = async (key:string,at:Date,tenant:string|null=customerTenantId) => {
      const row=await prisma.notification.create({data:{organizationId,customerTenantId:tenant,eventType:'tenant.connection_failed',category:'error',severity:'high',
        title:'Synthetic occurrence',description:'Regression fixture',source:'route-test',dedupeKey:key,
        firstOccurredAt:at,lastOccurredAt:at,createdAt:at,updatedAt:at,occurrenceCount:7}})
      await prisma.notificationUserState.create({data:{notificationId:row.id,userId:actor,readAt:at}})
      return row
    }
    const notes = async () => ({rows:await notificationRows(),
      states:(await observer.query('SELECT s.* FROM notification_user_states s JOIN notifications n ON n.id=s.notification_id WHERE n.organization_id=$1 AND n.dedupe_key IN ($2,$3) ORDER BY s.id',notificationScope)).rows})
    for (const success of [true,false]) for (const targetKey of [connectionKey,authorizedKey]) {
      await t.test(`equal-time occurrence and read state survive deferred ${success?'success':'failure'} for ${targetKey.endsWith(':connection')?'connection':'authorized'} key`,async()=>{
        const issued=await deferred(success)
        await note(targetKey,issued.terminal)
        const before=await notes(),authority=await connection()
        assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale')
        assert.deepEqual(await notes(),before,'ambiguous occurrence or recipient state changed')
        assert.deepEqual(await connection(),authority)
      })
    }
    for (const success of [true,false]) await t.test(`synthetic equal-time terminal snapshot is conservative on ${success?'success':'failure'}`,async()=>{
      let incident!:Awaited<ReturnType<typeof note>>
      const issued=await deferred(success,async()=>{incident=await note(connectionKey,new Date(Date.now()-1000))})
      // Normalize only fixture timestamps on both sides of the actual captured
      // identity. This models equality deterministically without a sleep/race.
      await observer.query('UPDATE notifications SET last_occurred_at=$2::timestamptz WHERE id=$1',[incident.id,issued.terminal])
      await observer.query(`UPDATE microsoft_consent_attempts SET operation_effects_snapshot=jsonb_set(operation_effects_snapshot,'{rows,0,at}',
        to_jsonb((SELECT last_occurred_at::text FROM notifications WHERE id=$2))) WHERE id=$1`,[issued.key.operationId,incident.id])
      const before=await notes()
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale')
      assert.deepEqual(await notes(),before,'ambiguous terminal snapshot changed')
    })
    await t.test('same-millisecond microsecond ordering is treated as ambiguous',async()=>{
      const issued=await deferred()
      const incident=await note(connectionKey,issued.terminal)
      await observer.query("UPDATE notifications SET last_occurred_at=last_occurred_at+interval '100 microseconds' WHERE id=$1",[incident.id])
      const before=await notes()
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale')
      assert.deepEqual(await notes(),before)
    })
    // A conflicting target with an OLDER timestamp must also survive. This
    // discriminates occurrence/absence binding from a timestamp-only correction.
    for (const success of [true,false]) for (const insertConnection of [true,false]) {
      await t.test(`absent-row race preserves concurrent ${insertConnection?'connection':'authorized'} insert and read state on ${success?'success':'failure'}`,async()=>{
        const issued=await deferred(success),entered=gate(),resume=gate()
        const hooked={$transaction:(work:any,options:any)=>prisma.$transaction(async tx=>work({
          $executeRawUnsafe:(sql:string,...v:any[])=>tx.$executeRawUnsafe(sql,...v),
          $queryRawUnsafe:async(sql:string,...v:any[])=>{const rows=await tx.$queryRawUnsafe(sql,...v);if(sql.includes('ORDER BY dedupe_key FOR UPDATE')){entered.release();await resume.promise}return rows}
        }),options)}
        const run=applyManagedConsentEffects(hooked as any,issued.key)
        await entered.promise
        let before!:Awaited<ReturnType<typeof notes>>
        try {await note(insertConnection?connectionKey:authorizedKey,new Date(issued.terminal.getTime()-1000));before=await notes()}
        finally {resume.release()}
        const outcome=await run,after=await notes()
        const conflictsWithTarget=success?!insertConnection:insertConnection
        assert.equal(outcome,conflictsWithTarget?'stale':'applied')
        assert.deepEqual(after.rows.find(row=>row.id===before.rows[0].id),before.rows[0],'unobserved occurrence changed')
        assert.deepEqual(after.states,before.states,'unobserved recipient state reset')
        assert.equal(after.rows.length,conflictsWithTarget?1:2)
        assert.equal(await applyManagedConsentEffects(prisma,issued.key),conflictsWithTarget?'stale':'replayed')
        assert.deepEqual(await notes(),after,'replay adopted a concurrent occurrence')
      })
    }
    await t.test('older observed occurrence resolves while target updates once and only target read state resets',async()=>{
      let incident!:Awaited<ReturnType<typeof note>>,target!:Awaited<ReturnType<typeof note>>
      const issued=await deferred(true,async()=>{
        const earlier=new Date(Date.now()-1000)
        incident=await note(connectionKey,earlier);target=await note(authorizedKey,earlier)
        await observer.query("UPDATE notifications SET last_occurred_at=last_occurred_at+interval '100 microseconds' WHERE id=ANY($1::uuid[])",[[incident.id,target.id]])
      })
      const before=await notes()
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'applied')
      const after=await notes(),resolved=after.rows.find(row=>row.id===incident.id),authorized=after.rows.find(row=>row.id===target.id)
      assert.equal(resolved.resolved_at.getTime(),issued.terminal.getTime());assert.equal(resolved.occurrence_count,7)
      assert.equal(authorized.occurrence_count,8);assert.equal(authorized.metadata.consentOperationId,issued.key.operationId)
      assert.deepEqual(after.states,before.states.filter(row=>row.notification_id===incident.id))
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'replayed');assert.deepEqual(await notes(),after)
    })
    for (const success of [true,false]) for (const replacement of ['increment','replace'] as const) {
      await t.test(`terminal occurrence identity survives later ${replacement} with an older timestamp on ${success?'success':'failure'}`,async()=>{
        let incident!:Awaited<ReturnType<typeof note>>
        const issued=await deferred(success,async()=>{incident=await note(connectionKey,new Date(Date.now()-1000))})
        if (replacement==='replace') {
          await prisma.notification.delete({where:{id:incident.id}})
          await note(connectionKey,new Date(issued.terminal.getTime()-1000))
        } else await observer.query("UPDATE notifications SET occurrence_count=occurrence_count+1 WHERE id=$1",[incident.id])
        const before=await notes(),authority=await connection()
        for(let attempt=0;attempt<2;attempt++)assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale')
        assert.deepEqual(await notes(),before,'new occurrence was adopted');assert.deepEqual(await connection(),authority)
      })
    }
    await t.test('legacy terminal without a snapshot cannot acquire new effect authority',async()=>{
      const issued=await deferred()
      await observer.query('UPDATE microsoft_consent_attempts SET operation_effects_snapshot=NULL WHERE id=$1',[issued.key.operationId])
      const before=await notes()
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale');assert.deepEqual(await notes(),before)
    })
    await t.test('dedupe key with a different tenant scope cannot be adopted or treated as replay',async()=>{
      const issued=await deferred(),row=await note(authorizedKey,new Date(issued.terminal.getTime()-1000),null)
      await observer.query('UPDATE notifications SET metadata=$2::jsonb WHERE id=$1',[row.id,JSON.stringify({consentOperationId:issued.key.operationId})])
      const before=await notes()
      assert.equal(await applyManagedConsentEffects(prisma,issued.key),'stale');assert.deepEqual(await notes(),before)
    })
    await t.test('unrelated organization and sibling tenant rows remain unchanged',async()=>{
      assert.deepEqual(await foreignRows(),foreignBefore,'foreign fixture changed')
    })
  } finally {
    await observer.query('DROP TRIGGER IF EXISTS consent_route_reject_delete ON notification_user_states')
    await observer.query('DROP FUNCTION IF EXISTS consent_route_reject_delete()')
    await observer.query('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS reject_route_effect')
    await prisma.organization.deleteMany({where:{id:{in:[organizationId,foreignOrganizationId]}}})
    await prisma.user.deleteMany({where:{id:{in:[actor,foreignActor]}}})
    await observer.query("DELETE FROM platform_microsoft_connectors WHERE id='default' AND configuration_revision=ANY($1::uuid[])",[revisions])
    await observer.query('DELETE FROM managed_connector_authority_revisions WHERE revision=ANY($1::uuid[])',[revisions])
    await observer.query('DELETE FROM encrypted_secrets WHERE id=ANY($1::uuid[])',[revisions])
    await prisma.$disconnect();observer.release();await pool.end()
  }
})

/**
 * Hourly current-state inventory candidate selection, against the REAL
 * `scheduledSyncTenantWhere` query and `selectScheduledTenantWork` on migrated
 * PostgreSQL. Runs only in the existing disposable CI database; locally it
 * skips, so a green local run says nothing about it.
 *
 * The fixture is complete and isolated — its own organization, user, membership
 * and tenant — and every comparison is made against a FIXED clock, so the
 * boundary cases stay deterministic on any future date.
 */
test('a migrated PostgreSQL database selects hourly inventory while USERS and both anchors are fresh', { skip, timeout: 90000 }, async (t) => {
  const url = assertDisposableTestDatabase()
  // Constructed exactly as this suite's existing case does, including the UTC
  // session option: these timestamptz boundary comparisons depend on it, and
  // the case cannot be run locally to discover a difference.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString(), max: 4, options: '-c timezone=UTC' }),
  })

  /** Fixed, valid, and later than every fixture timestamp below. */
  const CLOCK = new Date(Date.UTC(2026, 2, 15, 12, 0, 0))
  const HOUR = 60 * 60 * 1000
  /** The existing first-retry delay for these resources, taken from the
   *  formula rather than written as a literal. */
  const FIRST_RETRY = HOURLY_INVENTORY_FIRST_RETRY_MS
  const before = (ms: number) => new Date(CLOCK.getTime() - ms)

  const testRun = randomUUID()
  const organizationIds: string[] = []
  const userIds: string[] = []
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  })

  const seedWorkspace = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        authProviderUserId: randomUUID(),
        email: `hourly-${label}-${testRun}@integration.hawkview.invalid`,
        displayName: `Hourly Owner ${label}`,
      },
    })
    userIds.push(user.id)
    const organization = await prisma.organization.create({
      data: { name: `Hourly MSP ${label}`, slug: `hourly-${label}-${testRun}`, onboardingCompletedAt: new Date() },
    })
    organizationIds.push(organization.id)
    await prisma.membership.create({
      data: { userId: user.id, organizationId: organization.id, role: 'MSP_OWNER', status: 'ACTIVE' },
    })
    const tenant = await prisma.customerTenant.create({
      data: {
        organizationId: organization.id,
        microsoftTenantId: randomUUID(),
        displayName: `Hourly Customer ${label}`,
        primaryDomain: `${label}.${testRun}.example`,
        status: 'ACTIVE',
        connection: {
          create: {
            connectionMode: 'HAWKVIEW_MANAGED',
            status: 'CONNECTED',
            consentedPermissions: [],
            onboardingCompletedAt: new Date(),
          },
        },
      },
    })
    // Fresh USERS and both daily anchors, so nothing except the hourly rule can
    // make this tenant a candidate.
    for (const resourceType of ['USERS', 'LICENSES', 'DOMAINS', ...DAILY_INVENTORY_RESOURCES] as const) {
      await prisma.syncState.create({
        data: {
          organizationId: organization.id,
          customerTenantId: tenant.id,
          resourceType,
          status: 'SUCCEEDED',
          lastSuccessfulAt: before(60_000),
          lastAttemptAt: before(60_000),
        },
      })
    }
    return { organizationId: organization.id, tenantId: tenant.id }
  }

  const candidateFound = async (workspace: { organizationId: string; tenantId: string }) =>
    prisma.customerTenant.findMany({
      where: { AND: [scheduledSyncTenantWhere(CLOCK), { organizationId: workspace.organizationId, id: workspace.tenantId }] },
      select: { id: true, connection: { select: { exchangeReadOnlyEnabledAt: true } }, syncStates: { select: {
        resourceType: true, status: true, lastAttemptAt: true, lastSuccessfulAt: true,
        lastErrorCode: true, lastErrorMessage: true, consecutiveFailures: true,
      } } },
    })

  const setInventory = async (
    workspace: { organizationId: string; tenantId: string },
    data: Record<string, unknown>,
    resourceType: typeof DAILY_INVENTORY_RESOURCES[number] | 'EXCHANGE_MAILBOX_CONFIGURATION' | 'CONDITIONAL_ACCESS' | 'LICENSES' | 'DOMAINS' = 'CONDITIONAL_ACCESS',
  ) => {
    await prisma.syncState.upsert({
      where: { customerTenantId_resourceType: { customerTenantId: workspace.tenantId, resourceType } },
      create: { organizationId: workspace.organizationId, customerTenantId: workspace.tenantId, resourceType, ...data },
      update: data,
    })
  }

  const workspace = await seedWorkspace('a')

  await t.test('the control: nothing is due before the hourly boundary', async () => {
    // One millisecond short of the boundary. Pinning this first means the
    // positive case below cannot pass because the tenant was always a candidate.
    await setInventory(workspace, {
      status: 'SUCCEEDED', lastSuccessfulAt: before(HOUR - 1), lastAttemptAt: before(HOUR - 1),
    })
    assert.deepEqual(await candidateFound(workspace), [])
  })

  await t.test('exactly one hour of age makes it a candidate without pulling the daily pass in', async () => {
    await setInventory(workspace, {
      status: 'SUCCEEDED', lastSuccessfulAt: before(HOUR), lastAttemptAt: before(HOUR),
    })
    const found = await candidateFound(workspace)
    assert.equal(found.length, 1)
    const work = selectScheduledTenantWork(found as never, CLOCK, 10)
    assert.equal(work.length, 1)
    assert.equal(work[0]!.tenantId, workspace.tenantId)
    // The daily anchor clock is untouched by hourly eligibility.
    assert.equal(work[0]!.fullInventoryDue, false)
  })

  await t.test('recent or partial RUNNING, never-collected and future timestamps are not candidates', async () => {
    for (const data of [
      { status: 'RUNNING', lastSuccessfulAt: before(6 * HOUR), lastAttemptAt: before(HOUR - 1) },
      { status: 'RUNNING', lastSuccessfulAt: before(6 * HOUR), lastAttemptAt: before(6 * HOUR), lastErrorCode: 'PARTIAL_COLLECTION' },
      { status: 'SUCCEEDED', lastSuccessfulAt: null, lastAttemptAt: before(6 * HOUR) },
      { status: 'SUCCEEDED', lastSuccessfulAt: new Date(CLOCK.getTime() + HOUR), lastAttemptAt: before(60_000) },
    ]) {
      await setInventory(workspace, data)
      assert.deepEqual(await candidateFound(workspace), [], JSON.stringify(data))
    }
  })

  await t.test('an abandoned clean RUNNING hourly resource is selected at the one-hour boundary', async () => {
    await setInventory(workspace, {
      status: 'RUNNING', lastSuccessfulAt: before(6 * HOUR), lastAttemptAt: before(HOUR),
      lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    })
    const found = await candidateFound(workspace)
    assert.equal(found.length, 1)
    const work = selectScheduledTenantWork(found as never, CLOCK, 10)
    assert.equal(work.length, 1)
    assert.equal(work[0]!.tenantId, workspace.tenantId)
    assert.equal(work[0]!.fullInventoryDue, false)
  })

  const failedInventory = async (attemptedAgoMs: number, consecutiveFailures: number) => {
    await setInventory(workspace, {
      status: 'FAILED',
      lastSuccessfulAt: before(6 * HOUR),
      lastAttemptAt: before(attemptedAgoMs),
      consecutiveFailures,
      lastErrorCode: 'MICROSOFT_THROTTLED',
    })
    const found = await candidateFound(workspace)
    return { candidates: found.length, selected: selectScheduledTenantWork(found as never, CLOCK, 10) }
  }

  await t.test('a first failure is a candidate at exactly fifteen minutes and not one millisecond before', async () => {
    // A FAILED row is NOT globally ineligible: it has its own targeted retry
    // eligibility, which for these resources is fifteen minutes. This pins the
    // query at that exact boundary, which is the regression the previous
    // forty-five-minute fixture passed straight over.
    const justBefore = await failedInventory(FIRST_RETRY - 1, 1)
    assert.equal(justBefore.candidates, 0)

    const atBoundary = await failedInventory(FIRST_RETRY, 1)
    assert.equal(atBoundary.candidates, 1)
    assert.equal(atBoundary.selected.length, 1)
    assert.equal(atBoundary.selected[0]!.fullInventoryDue, false)

    // Well inside the delay stays invisible, and the window that used to be
    // hidden between fifteen and thirty minutes is now reachable.
    assert.equal((await failedInventory(5 * 60 * 1000, 1)).candidates, 0)
    assert.equal((await failedInventory(20 * 60 * 1000, 1)).candidates, 1)
  })

  await t.test('a higher failure counter may be a candidate but is not selected before its own backoff', async () => {
    // Two consecutive failures mean a thirty-minute delay. The widened coarse
    // branch admits it at twenty minutes, and the unchanged predicate must
    // still refuse to select it — candidacy is deliberately a superset.
    const coarseOnly = await failedInventory(20 * 60 * 1000, 2)
    assert.equal(coarseOnly.candidates, 1, 'the coarse branch admits it')
    assert.deepEqual(coarseOnly.selected, [], 'the predicate still refuses it')

    const pastItsDelay = await failedInventory(31 * 60 * 1000, 2)
    assert.equal(pastItsDelay.candidates, 1)
    assert.equal(pastItsDelay.selected.length, 1)
    assert.equal(pastItsDelay.selected[0]!.fullInventoryDue, false)
  })

  await t.test('each healthy anchor is hourly eligible at its own inclusive boundary', async () => {
    // Restore both anchors before the later DNS, score and risk controls: an old
    // LICENSES row would otherwise make their negative arms pass for the wrong reason.
    await setInventory(workspace, {
      status: 'SUCCEEDED', lastSuccessfulAt: before(HOUR - 1), lastAttemptAt: before(HOUR - 1),
    })
    for (const resourceType of ['LICENSES', 'DOMAINS'] as const) {
      for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
        await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(age), lastAttemptAt: before(age), lastErrorCode: null }, resourceType)
        const found = await candidateFound(workspace)
        assert.equal(found.length, age >= HOUR ? 1 : 0, `${resourceType}: ${age}`)
        const work = selectScheduledTenantWork(found, CLOCK, 1)
        assert.equal(work.length, age >= HOUR ? 1 : 0)
        if (work.length) {
          assert.equal(work[0]!.fullInventoryDue, false)
          assert.equal(work[0]!.dueAt.getTime(), before(age).getTime())
        }
      }
      await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000), lastErrorCode: null }, resourceType)
    }
  })

  await t.test('an overdue independent daily dataset survives fresh hourly anchors', async () => {
    await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(24 * HOUR + 1), lastAttemptAt: before(24 * HOUR + 1) }, 'GROUPS')
    const found = await candidateFound(workspace)
    assert.equal(found.length, 1)
    assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]!.fullInventoryDue, true)
    await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000) }, 'GROUPS')
  })

  await t.test('failed anchors retain the one-hour full-pass branch', async () => {
    for (const resourceType of ['LICENSES', 'DOMAINS'] as const) {
      for (const age of [HOUR - 1, HOUR]) {
        await setInventory(workspace, { status: 'FAILED', lastSuccessfulAt: before(3 * HOUR), lastAttemptAt: before(age), lastErrorCode: 'MICROSOFT_TRANSIENT', consecutiveFailures: 1 }, resourceType)
        const found = await candidateFound(workspace)
        assert.equal(found.length, 1, `${resourceType} retains existing broad failed candidacy`)
        assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, age >= HOUR)
      }
      await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000), lastErrorCode: null, consecutiveFailures: 0 }, resourceType)
    }
  })

  await t.test('DNS alone is hourly eligible at the exact boundary and retains its daily failure policy', async () => {
    for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
      await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(age), lastAttemptAt: before(age) }, 'DOMAIN_DNS_HEALTH')
      const found = await candidateFound(workspace)
      assert.equal(found.length, age >= HOUR ? 1 : 0)
      const work = selectScheduledTenantWork(found, CLOCK, 1)
      assert.equal(work.length, age >= HOUR ? 1 : 0)
      if (work.length) assert.equal(work[0]!.fullInventoryDue, false)
    }
    for (const age of [FIRST_RETRY, 31 * 60_000, 6 * HOUR, 24 * HOUR - 1, 24 * HOUR]) {
      await setInventory(workspace, { status: 'FAILED', lastSuccessfulAt: before(48 * HOUR), lastAttemptAt: before(age), lastErrorCode: 'MICROSOFT_TRANSIENT' }, 'DOMAIN_DNS_HEALTH')
      const found = await candidateFound(workspace)
      assert.equal(found.length, age >= 24 * HOUR ? 1 : 0, `failed DNS age ${age}`)
      if (found.length) assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, true)
    }
    await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000), lastErrorCode: null }, 'DOMAIN_DNS_HEALTH')
  })

  await t.test('secure-score alone is hourly eligible at the exact boundary and retains its daily failure policy', async () => {
    for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
      await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(age), lastAttemptAt: before(age) }, 'SECURE_SCORES')
      const found = await candidateFound(workspace)
      assert.equal(found.length, age >= HOUR ? 1 : 0)
      const work = selectScheduledTenantWork(found, CLOCK, 1)
      assert.equal(work.length, age >= HOUR ? 1 : 0)
      if (work.length) assert.equal(work[0]!.fullInventoryDue, false)
    }
    for (const age of [FIRST_RETRY, 31 * 60_000, 6 * HOUR, 24 * HOUR - 1, 24 * HOUR]) {
      await setInventory(workspace, { status: 'FAILED', lastSuccessfulAt: before(48 * HOUR), lastAttemptAt: before(age), lastErrorCode: 'MICROSOFT_TRANSIENT' }, 'SECURE_SCORES')
      const found = await candidateFound(workspace)
      assert.equal(found.length, age >= 24 * HOUR ? 1 : 0, `failed secure-score age ${age}`)
      if (found.length) assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, true)
    }
    await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000), lastErrorCode: null }, 'SECURE_SCORES')
  })

  await t.test('risky users gain healthy hourly candidacy without moving failed-only query timing', async () => {
    for (const age of [HOUR - 1, HOUR, HOUR + 1]) {
      await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(age), lastAttemptAt: before(age), lastErrorCode: null }, 'RISKY_USERS')
      const found = await candidateFound(workspace)
      assert.equal(found.length, age >= HOUR ? 1 : 0)
      const work = selectScheduledTenantWork(found, CLOCK, 1)
      assert.equal(work.length, age >= HOUR ? 1 : 0)
      if (work.length) assert.equal(work[0]!.fullInventoryDue, false)
    }
    for (const age of [15 * 60_000, 30 * 60_000, 30 * 60_000 + 1]) {
      await setInventory(workspace, { status: 'FAILED', lastSuccessfulAt: before(48 * HOUR), lastAttemptAt: before(age), lastErrorCode: 'MICROSOFT_TRANSIENT', consecutiveFailures: 1 }, 'RISKY_USERS')
      const found = await candidateFound(workspace)
      assert.equal(found.length, age > 30 * 60_000 ? 1 : 0, `failed risk age ${age}`)
      const work = selectScheduledTenantWork(found, CLOCK, 1)
      assert.equal(work.length, found.length)
      if (work.length) assert.equal(work[0]!.fullInventoryDue, false)
    }
    await setInventory(workspace, { status: 'FAILED', lastSuccessfulAt: before(48 * HOUR), lastAttemptAt: before(90 * 60_000), lastErrorCode: 'MICROSOFT_TRANSIENT', consecutiveFailures: 4 }, 'RISKY_USERS')
    const backedOff = await candidateFound(workspace)
    assert.equal(backedOff.length, 1)
    assert.deepEqual(selectScheduledTenantWork(backedOff, CLOCK, 1), [])
    for (const code of ['MICROSOFT_PERMISSION_REQUIRED', 'HAWKVIEW_CAPACITY_GUARD']) {
      await setInventory(workspace, { lastErrorCode: code, consecutiveFailures: 1 }, 'RISKY_USERS')
      assert.deepEqual(await candidateFound(workspace), [])
    }
    await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000), lastErrorCode: null, consecutiveFailures: 0 }, 'RISKY_USERS')
  })

  await t.test('daily guard candidate and pure rule agree for every existing daily resource', async () => {
    for (const resource of DAILY_INVENTORY_RESOURCES) {
      for (const delta of [-1, 0, 1]) {
        await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(24 * HOUR + delta), lastAttemptAt: before(24 * HOUR + delta) }, resource)
        const found = await candidateFound(workspace)
        // DNS, secure scores and risky users may already be hourly due; only the daily flag changes at 24h.
        assert.equal(found.length, ['DOMAIN_DNS_HEALTH', 'SECURE_SCORES', 'RISKY_USERS'].includes(resource) || delta >= 0 ? 1 : 0, `${resource}: ${delta}`)
        if (found.length) assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, delta >= 0)
      }
      await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000) }, resource)
    }
  })

  await t.test('failed daily permission checks wait a day; missing data is not hidden by fresh anchors', async () => {
    for (const delta of [-1, 0, 1]) {
      await setInventory(workspace, { status: 'FAILED', lastSuccessfulAt: null, lastAttemptAt: before(24 * HOUR + delta), lastErrorCode: 'MICROSOFT_PERMISSION_REQUIRED' }, 'SHAREPOINT_USAGE')
      const found = await candidateFound(workspace)
      assert.equal(found.length, delta >= 0 ? 1 : 0)
      if (found.length) assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, true)
    }
    for (const data of [
      { status: 'RUNNING', lastAttemptAt: before(48 * HOUR), lastSuccessfulAt: null },
      { status: 'FAILED', lastAttemptAt: new Date(CLOCK.getTime() + HOUR), lastSuccessfulAt: null },
      { status: 'SUCCEEDED', lastAttemptAt: before(HOUR), lastSuccessfulAt: new Date(CLOCK.getTime() + HOUR) },
      { status: 'IDLE', lastAttemptAt: before(HOUR), lastSuccessfulAt: null },
    ]) {
      await setInventory(workspace, data, 'SHAREPOINT_USAGE')
      assert.deepEqual(await candidateFound(workspace), [])
    }
    await prisma.syncState.delete({ where: { customerTenantId_resourceType: { customerTenantId: workspace.tenantId, resourceType: 'SHAREPOINT_USAGE' } } })
    const found = await candidateFound(workspace)
    assert.equal(found.length, 1)
    assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, true)
    await setInventory(workspace, { status: 'SUCCEEDED', lastSuccessfulAt: before(60_000), lastAttemptAt: before(60_000), lastErrorCode: null }, 'SHAREPOINT_USAGE')
  })

  await t.test('optional Exchange guard mirrors the existing connection flag and active-tenant gate', async () => {
    assert.deepEqual(await candidateFound(workspace), [])
    await prisma.tenantConnection.update({ where: { customerTenantId_organizationId: { customerTenantId: workspace.tenantId, organizationId: workspace.organizationId } }, data: { exchangeReadOnlyEnabledAt: before(HOUR) } })
    const found = await candidateFound(workspace)
    assert.equal(found.length, 1)
    assert.equal(selectScheduledTenantWork(found, CLOCK, 1)[0]?.fullInventoryDue, true)
    await prisma.customerTenant.update({ where: { id: workspace.tenantId }, data: { status: 'SUSPENDED' } })
    assert.deepEqual(await candidateFound(workspace), [])
    await prisma.customerTenant.update({ where: { id: workspace.tenantId }, data: { status: 'ACTIVE' } })
    await prisma.tenantConnection.update({ where: { customerTenantId_organizationId: { customerTenantId: workspace.tenantId, organizationId: workspace.organizationId } }, data: { exchangeReadOnlyEnabledAt: null } })
    assert.deepEqual(await candidateFound(workspace), [])
  })

})
