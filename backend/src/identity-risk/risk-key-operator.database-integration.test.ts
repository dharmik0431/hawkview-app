import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { runRiskKeyOperator } from './risk-key-operator.js'

test('operator real DB preflight is read-only; scoped concurrent ensure is create-only; failed writes roll back', {
  skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1', timeout: 45000,
}, async () => {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  const client = new pg.Client({ connectionString: url.toString() }); await client.connect()
  const prisma = new PrismaService(); await prisma.$connect()
  const scope = { environment:'operator-synthetic', organizationId:randomUUID(), customerTenantId:randomUUID() }
  const failingTenant = randomUUID(); const failingVersion = randomUUID()
  const trigger = `operator_failure_${randomUUID().replaceAll('-','')}`
  const config = { HAWKVIEW_IDENTITY_RISK_MODE:'shadow', HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER:'wrapped-pilot-v1',
    HAWKVIEW_IDENTITY_RISK_ENVIRONMENT:scope.environment, SECRET_ENCRYPTION_KEY:'42'.repeat(32),
    HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:'' }
  const previous = Object.fromEntries(Object.keys(config).map(name=>[name,process.env[name]]))
  Object.assign(process.env,config)
  const select = (tenant=scope.customerTenantId) => { process.env.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE=JSON.stringify({organizationId:scope.organizationId,customerTenantId:tenant,expiresAt:new Date(Date.now()+3600000).toISOString()}) }
  const args = (version: string, apply=false, tenant=scope.customerTenantId) => ['--environment',scope.environment,'--organization',scope.organizationId,'--tenant',tenant,'--version',version,
    ...(apply ? ['--apply','--confirm-scope',`${scope.environment}/${scope.organizationId}/${tenant}/${version}`] : [])]
  const counts = async () => (await client.query(`SELECT
    (SELECT count(*) FROM identity_risk_pseudonym_key_versions WHERE organization_id=$1::uuid) AS keys,
    (SELECT count(*) FROM identity_risk_wrapped_keys w JOIN identity_risk_pseudonym_key_versions k ON k.id=w.key_version_id WHERE k.organization_id=$1::uuid) AS ciphertexts,
    (SELECT count(*) FROM identity_risk_key_events e JOIN identity_risk_pseudonym_key_versions k ON k.id=e.key_version_id WHERE k.organization_id=$1::uuid) AS events`,[scope.organizationId])).rows[0]
  let functionCreated=false; let triggerCreated=false
  try {
    await prisma.organization.create({data:{id:scope.organizationId,name:'Synthetic operator',slug:`synthetic-${scope.organizationId}`}})
    for (const id of [scope.customerTenantId,failingTenant]) await prisma.customerTenant.create({data:{id,organizationId:scope.organizationId,microsoftTenantId:randomUUID(),displayName:'Synthetic operator tenant'}})
    select()
    const requested = randomUUID()
    const before = await counts()
    const dry = await runRiskKeyOperator(args(requested))
    assert.equal(dry.exitCode,0); assert.equal(JSON.parse(dry.output).action,'WOULD_CREATE')
    assert.deepEqual(await counts(),before,'Default preflight writes no key/ciphertext/event')
    const unknownTenant=randomUUID(); select(unknownTenant)
    assert.equal((await runRiskKeyOperator(args(randomUUID(),true,unknownTenant))).exitCode,1)
    assert.deepEqual(await counts(),before)
    select()
    const versions=Array.from({length:4},()=>randomUUID())
    const results=await Promise.all(versions.map(id=>runRiskKeyOperator(args(id,true))))
    assert.ok(results.every(r=>r.exitCode===0),JSON.stringify(results))
    const winner=JSON.parse(results[0]!.output).activeVersionId
    assert.equal(new Set(results.map(r=>JSON.parse(r.output).activeVersionId)).size,1)
    const original=(await client.query('SELECT name,ciphertext,iv,tag FROM identity_risk_wrapped_keys WHERE key_version_id=$1',[winner])).rows[0]
    assert.equal((await counts()).keys,'1'); assert.equal((await counts()).ciphertexts,'1')
    const after=await counts()
    assert.equal(JSON.parse((await runRiskKeyOperator(args(winner))).output).action,'REUSE_ACTIVE_VERSION')
    assert.deepEqual(await counts(),after)
    assert.equal(JSON.parse((await runRiskKeyOperator(args(winner,true))).output).activeVersionId,winner)
    assert.deepEqual((await client.query('SELECT name,ciphertext,iv,tag FROM identity_risk_wrapped_keys WHERE key_version_id=$1',[winner])).rows[0],original)
    // Actual executable process must close successful and failed DB transports,
    // not merely return from a mocked API. CI runs source tests before bundling.
    for (const connection of [url.toString(), 'postgresql://synthetic:PRIVATE_SENTINEL@127.0.0.1:1/synthetic']) {
      const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../provision-risk-key.ts',import.meta.url)),...args(winner)],
        {encoding:'utf8',timeout:15000,maxBuffer:65536,env:{...process.env,DATABASE_URL:connection}})
      assert.ifError(child.error); assert.equal(child.signal,null); assert.equal(child.stderr,'')
      assert.equal(child.status,connection===url.toString()?0:1)
      assert.doesNotMatch(child.stdout,/PRIVATE_SENTINEL|postgresql|SECRET_ENCRYPTION_KEY|ciphertext|42{10}/)
      assert.equal(JSON.parse(child.stdout).outcome,connection===url.toString()?'PREFLIGHT_OK':'FAILED')
    }
    assert.deepEqual(await counts(),after,'Executable dry-run also writes no evidence or keys')
    select(failingTenant)
    assert.equal((await runRiskKeyOperator(args(winner,true,failingTenant))).exitCode,1,'A foreign tenant version is not reused')
    // Fail after registry/ciphertext insertion, at the audit event, on this one synthetic version only.
    await client.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key_version_id='${failingVersion}'::uuid THEN RAISE EXCEPTION 'PRIVATE_OPERATOR_FAILURE'; END IF; RETURN NEW; END $$`)
    functionCreated=true
    await client.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON identity_risk_key_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    triggerCreated=true
    const failed=await runRiskKeyOperator(args(failingVersion,true,failingTenant))
    assert.equal(failed.exitCode,1); assert.doesNotMatch(failed.output,/PRIVATE_OPERATOR_FAILURE|42{10}|postgresql|ciphertext/)
    assert.equal((await client.query('SELECT count(*) FROM identity_risk_pseudonym_key_versions WHERE id=$1',[failingVersion])).rows[0].count,'0')
    assert.equal((await client.query('SELECT count(*) FROM identity_risk_wrapped_keys WHERE key_version_id=$1',[failingVersion])).rows[0].count,'0')
    assert.equal((await client.query('SELECT count(*) FROM identity_risk_key_events WHERE key_version_id=$1',[failingVersion])).rows[0].count,'0')
    assert.deepEqual(await counts(),after,'The failure did not alter the established scoped winner')
  } finally {
    if(triggerCreated) await client.query(`DROP TRIGGER ${trigger} ON identity_risk_key_events`)
    if(functionCreated) await client.query(`DROP FUNCTION ${trigger}()`)
    await prisma.organization.deleteMany({where:{id:scope.organizationId}})
    await prisma.$disconnect(); await client.end()
    for(const[name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value}
  }
})
