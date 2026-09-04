import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createPilotPseudonymProvider, WrappedRiskPseudonymProvider } from './pilot-pseudonym-provider.js'
import { pilotRiskConfig } from './pilot-risk-config.js'
import { readRiskWrappingRoot, unwrapRiskKey, wrapRiskKey, wrappedRiskName, WRAPPED_RISK_PROVIDER } from './wrapped-risk-crypto.js'
import type { PseudonymKeyVersion } from './identity-risk-pseudonym.js'

const scope = { environment: 'synthetic', organizationId: randomUUID(), customerTenantId: randomUUID() }
const version = { ...scope, id: randomUUID(), provider: WRAPPED_RISK_PROVIDER, immutableKeyId: '' }
const key: PseudonymKeyVersion = { ...version, immutableKeyId: wrappedRiskName(version) }
const root = randomBytes(32)
const material = randomBytes(32)
function env() { return { HAWKVIEW_IDENTITY_RISK_MODE: 'shadow', HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: scope.environment,
  HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'wrapped-pilot-v1', SECRET_ENCRYPTION_KEY: root.toString('base64'),
  HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: JSON.stringify({ organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, expiresAt: new Date(Date.now() + 3600000).toISOString() }) } }

test('single expiring pilot configuration is exact, bounded and fail-closed', () => {
  assert.ok(pilotRiskConfig(env()))
  for (const changes of [ { HAWKVIEW_IDENTITY_RISK_MODE: 'enabled' }, { HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER: 'secret-store' },
    { HAWKVIEW_IDENTITY_RISK_ENVIRONMENT: '*' }, { HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: '{}' },
    { HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: '[]' }, { HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: 'x'.repeat(513) },
    ...[Date.now()-1,Date.now()+8*86400000].map((time) => ({ HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE: JSON.stringify({ organizationId: scope.organizationId,customerTenantId: scope.customerTenantId,expiresAt:new Date(time).toISOString() }) })) ]) {
    assert.equal(pilotRiskConfig({ ...env(), ...changes }), null)
  }
  for (const value of ['', 'x'.repeat(44), '00', 'x'.repeat(1000)]) assert.throws(() => readRiskWrappingRoot({ SECRET_ENCRYPTION_KEY: value }), /KEY_UNAVAILABLE/)
  const valid=env()
  assert.equal(pilotRiskConfig({...valid,HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE:valid.HAWKVIEW_IDENTITY_RISK_PILOT_SCOPE.replace('{',`{"organizationId":"${scope.organizationId}",`)}),null)
})

test('authenticated wrap separates trusted scope/version/name and rejects substitution/tampering/length errors', () => {
  const cipher = wrapRiskKey(key, material, root)
  const unwrapped = unwrapRiskKey(key, cipher, root)
  assert.deepEqual(unwrapped, material); unwrapped.fill(0)
  for (const other of [{ ...key, organizationId: randomUUID() }, { ...key, customerTenantId: randomUUID() }, { ...key, environment:'other' }, { ...key, id: randomUUID() }]) {
    const scoped = { ...other, immutableKeyId: wrappedRiskName(other) }
    assert.throws(() => unwrapRiskKey(scoped, { ...cipher, name: scoped.immutableKeyId }, root), { message: 'IDENTITY_RISK_KEY_UNAVAILABLE' })
  }
  for (const bad of [{ ...cipher,name:'postgresql:arbitrary-secret' }, { ...cipher,iv:randomBytes(11) }, { ...cipher,tag:randomBytes(16) },
    { ...cipher,ciphertext:randomBytes(32) }, { ...cipher,ciphertext:randomBytes(31) }]) assert.throws(() => unwrapRiskKey(key,bad,root), { message:'IDENTITY_RISK_KEY_UNAVAILABLE' })
  assert.throws(() => unwrapRiskKey(key,cipher,randomBytes(32)), /KEY_UNAVAILABLE/)
  assert.throws(() => wrapRiskKey(key,randomBytes(31),root), /KEY_UNAVAILABLE/)
  assert.notDeepEqual(cipher.iv, wrapRiskKey(key,material,root).iv)
  for (const hostile of [Object.create(key), {...key,password:'SYNTHETIC_SECRET'}, Object.defineProperty({...key},'id',{get:()=>{throw new Error('getter must never run')}})]) {
    assert.throws(()=>wrappedRiskName(hostile),{message:'IDENTITY_RISK_KEY_UNAVAILABLE'})
  }
})

test('runtime provider has no implicit provisioning/fallback; bounded session replay and cleanup leak no input/key', async () => {
  const previous = Object.fromEntries(Object.keys(env()).map((name) => [name,process.env[name]]))
  Object.assign(process.env,env())
  let reads=0; let failures=0
  const cipher=wrapRiskKey(key,material,root)
  const provider=new WrappedRiskPseudonymProvider({ ciphertext:async () => { reads++;return cipher },recordFailure:async () => { failures++ } })
  try {
    assert.equal(createPilotPseudonymProvider().configured,true)
    const session=await provider.pin(key,Date.now()+30000)
    const first=await session.reference('mailbox',['SYNTHETIC_MAILBOX'])
    assert.match(first,/^hvr1_mailbox_[0-9a-f]{64}$/)
    assert.equal(await session.reference('mailbox',['SYNTHETIC_MAILBOX']),first)
    assert.notEqual(await session.reference('evidence',['SYNTHETIC_MAILBOX']),first)
    assert.equal(JSON.stringify(session).includes('SYNTHETIC_MAILBOX'),false)
    assert.equal(JSON.stringify(session).includes(material.toString('hex')),false)
    session.close?.(); await assert.rejects(() => session.reference('mailbox',['SYNTHETIC_MAILBOX']),/KEY_UNAVAILABLE/)
    const expired=await provider.pin(key,Date.now()+30)
    await new Promise((resolve)=>setTimeout(resolve,40))
    await assert.rejects(() => expired.reference('mailbox',['SYNTHETIC_MAILBOX']),/KEY_UNAVAILABLE/)
    const before=reads
    await assert.rejects(() => provider.pin({...key,customerTenantId:randomUUID()},Date.now()+1000),/KEY_UNAVAILABLE/)
    assert.equal(reads,before)
    delete process.env.SECRET_ENCRYPTION_KEY
    assert.equal(createPilotPseudonymProvider().configured,false)
    await assert.rejects(() => provider.pin(key,Date.now()+1000),/KEY_UNAVAILABLE/)
    assert.equal(reads,before)
    assert.equal(failures,0)
    Object.assign(process.env,env())
    const badProvider=new WrappedRiskPseudonymProvider({ciphertext:async()=>{throw new Error('password=NEVER-ECHO')},recordFailure:async()=>undefined})
    await assert.rejects(()=>badProvider.pin(key,Date.now()+1000),{message:'IDENTITY_RISK_KEY_UNAVAILABLE'})
    process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER='managed-kms'
    assert.equal(createPilotPseudonymProvider().configured,false,'No workload transport means no implicit AWS client')
  } finally { for (const [name,value] of Object.entries(previous)) {if(value===undefined) delete process.env[name];else process.env[name]=value} }
})
