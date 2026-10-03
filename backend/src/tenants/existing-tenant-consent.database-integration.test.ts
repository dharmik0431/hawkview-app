import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { MicrosoftConsentService } from '../microsoft/microsoft-consent.service.js'
import { TenantsService } from './tenants.service.js'
import { publishManagedAuthority } from '../microsoft/managed-connector-authority.js'
import { applyManagedConsentEffects } from '../microsoft/managed-consent-effects.js'
import { scheduledSyncTenantWhere, selectScheduledTenantWork } from './scheduled-sync-selection.js'

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
  const organizationId=randomUUID(),customerTenantId=randomUUID(),microsoftTenantId=randomUUID(),actor=randomUUID()
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
  ;(tenants as any).getAccessibleOrganizationIds=async()=>[organizationId]
  ;(tenants as any).getTenantOnboardingActor=async()=>actor
  ;(tenants as any).buildFrontendConsentRedirect=(result:string,error:string|null)=>({result,error})
  let providerCalls=0
  const good=async()=>{providerCalls++;return {displayName:'Synthetic tenant',primaryDomain:'fixture.invalid',grantedPermissions:['Directory.Read.All'],missingPermissions:[],missingRequiredPermissions:[],missingNonConnectionPermissions:[]}}
  microsoft.verifyClaimedTenantAfterConsent=good
  const connection=async()=>(await observer.query('SELECT * FROM tenant_connections WHERE customer_tenant_id=$1',[customerTenantId])).rows[0]
  const issue=async()=>{
    const response=await tenants.createConsentUrlForIdentity({subject:'synthetic',email:'actor@fixture.invalid'} as any,customerTenantId)
    const state=new URL(response.consentUrl).searchParams.get('state')!
    const parsed=await microsoft.verifyConsentState(state)
    return {state,parsed,key:{operationId:parsed.operationId!,organizationId,customerTenantId,flow:'EXISTING_TENANT' as const,stateHash:microsoft.hashConsentNonce(parsed.nonce)}}
  }
  const callback=(state:string,extra:Record<string,unknown>={})=>tenants.completeMicrosoftConsent({state,tenant:microsoftTenantId,admin_consent:'True',...extra})
  const operation=async(id:string)=>(await observer.query('SELECT * FROM microsoft_consent_attempts WHERE id=$1',[id])).rows[0]
  try {
    await prisma.organization.create({data:{id:organizationId,name:'Synthetic route fixture',slug:organizationId}})
    await prisma.user.create({data:{id:actor,email:`${actor}@fixture.invalid`}})
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
