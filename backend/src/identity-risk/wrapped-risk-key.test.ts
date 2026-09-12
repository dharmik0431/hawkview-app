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

/** FOUR PROPERTIES, FOUR TESTS, AND EVERY ASSERTION SAYS WHAT IT CAUGHT.
 *
 * These were one `test()` holding about nineteen assertions under one name covering four
 * separate properties — no implicit provisioning, no fallback, bounded session replay, and
 * cleanup leaking neither input nor key — with almost no assertion messages. A failure
 * anywhere reported as one opaque failure of all four.
 *
 * That is not hypothetical: this test failed once during a full-suite run and could not be
 * reproduced in 76 subsequent executions, and nobody could say WHICH of the four had broken.
 * The investigation had to test the whole thing. A CHECK THAT CANNOT SAY WHAT IT CAUGHT HAS
 * TOLD YOU ALMOST NOTHING, and that cost is only paid on the day it matters.
 *
 * Split for diagnosis, not for coverage: every assertion below was in the original and none
 * has been weakened. Each test now builds its OWN provider and counters, so a failure cannot
 * be inherited from an earlier step in a shared sequence.
 *
 * NOT REPRODUCED IS NOT NOT PRESENT. 76 executions on one machine, one Node version, one OS.
 * An intermittent seen once in an unknown configuration can hide below that sampling, and
 * nothing here clears the test. This makes the next occurrence self-diagnosing; it does not
 * make it less likely.
 */

/** Restores every environment variable this file mutates, whatever the test does. */
async function withPilotEnv(body: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(env()).map((name) => [name, process.env[name]]))
  Object.assign(process.env, env())
  try { await body() } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** A provider over a real wrapped key, with its own counters so no test reads another's. */
function freshProvider() {
  const counters = { reads: 0, failures: 0 }
  const cipher = wrapRiskKey(key, material, root)
  const provider = new WrappedRiskPseudonymProvider({
    ciphertext: async () => { counters.reads += 1; return cipher },
    recordFailure: async () => { counters.failures += 1 },
  })
  return { provider, counters }
}

test('a session replays a reference for the same input and separates purposes', async () => {
  await withPilotEnv(async () => {
    const { provider } = freshProvider()
    const session = await provider.pin(key, Date.now() + 30000)

    const first = await session.reference('mailbox', ['SYNTHETIC_MAILBOX'])
    assert.match(first, /^hvr1_mailbox_[0-9a-f]{64}$/,
      'a reference must be the versioned, purpose-tagged, hex-digest shape')
    assert.equal(await session.reference('mailbox', ['SYNTHETIC_MAILBOX']), first,
      'the same input and purpose must replay the same reference inside one session')
    // THE DIGEST, NOT THE WHOLE STRING, and this is a weakness I put in on the rewrite.
    // A reference is `hvr1_${purpose}_${digest}`, so comparing whole strings passes even if
    // the digest ignores purpose entirely — the prefix differs by itself. Mutation-tested:
    // removing `purpose` from the hashed message SURVIVES a whole-string comparison and is
    // caught by this one. The property is that the CRYPTOGRAPHIC part is purpose-separated,
    // not that the label is; a label can be rewritten by whoever holds the string.
    const other = await session.reference('evidence', ['SYNTHETIC_MAILBOX'])
    const digestOf = (reference: string) => reference.split('_').at(-1)
    assert.notEqual(digestOf(other), digestOf(first),
      'a different purpose must produce a different DIGEST — otherwise a reference minted for one purpose can be used to look up another by rewriting its prefix')
    assert.notEqual(other, first, 'and the full reference differs too')
  })
})

test('a session serialises without leaking its input or its key material', async () => {
  await withPilotEnv(async () => {
    const { provider } = freshProvider()
    const session = await provider.pin(key, Date.now() + 30000)
    await session.reference('mailbox', ['SYNTHETIC_MAILBOX'])

    const serialised = JSON.stringify(session)
    assert.equal(serialised.includes('SYNTHETIC_MAILBOX'), false,
      'the plaintext input must not survive serialisation — a logged session would leak it')
    assert.equal(serialised.includes(material.toString('hex')), false,
      'the unwrapped key material must not survive serialisation')
  })
})

test('a closed or expired session is unusable, and says so as KEY_UNAVAILABLE', async () => {
  await withPilotEnv(async () => {
    const { provider } = freshProvider()

    const closed = await provider.pin(key, Date.now() + 30000)
    await closed.reference('mailbox', ['SYNTHETIC_MAILBOX'])
    closed.close?.()
    await assert.rejects(() => closed.reference('mailbox', ['SYNTHETIC_MAILBOX']),
      /KEY_UNAVAILABLE/,
      'a closed session must refuse rather than serve from retained material')

    // The deadline bound. 30ms against a 40ms sleep; the margin was probed at 29, 31 and 40ms
    // and the answer does not change, so this is a bound rather than a race.
    const expired = await provider.pin(key, Date.now() + 30)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await assert.rejects(() => expired.reference('mailbox', ['SYNTHETIC_MAILBOX']),
      /KEY_UNAVAILABLE/,
      'a session past its deadline must refuse — a pin is a lease, not a handle')
  })
})

test('there is no implicit provisioning and no fallback, and a refusal reads nothing', async () => {
  await withPilotEnv(async () => {
    const { provider, counters } = freshProvider()
    assert.equal(createPilotPseudonymProvider().configured, true,
      'the pilot provider must be configured under this environment, or the negatives below ' +
      'pass for the wrong reason')

    await provider.pin(key, Date.now() + 1000)
    const before = counters.reads
    await assert.rejects(
      () => provider.pin({ ...key, customerTenantId: randomUUID() }, Date.now() + 1000),
      /KEY_UNAVAILABLE/,
      'a key outside the pilot scope must be refused rather than provisioned')
    assert.equal(counters.reads, before,
      'and refused BEFORE reading ciphertext — a read here means the scope check runs too late')

    delete process.env.SECRET_ENCRYPTION_KEY
    assert.equal(createPilotPseudonymProvider().configured, false,
      'with no wrapping root the provider must report unconfigured, not fall back')
    await assert.rejects(() => provider.pin(key, Date.now() + 1000), /KEY_UNAVAILABLE/,
      'and must refuse to pin rather than serve an unwrapped or default key')
    assert.equal(counters.reads, before,
      'still no ciphertext read: a missing root must not send us looking for material')
    assert.equal(counters.failures, 0,
      'a refusal on configuration is not a failure to record — recording it would bury the ' +
      'real failures under expected ones')

    Object.assign(process.env, env())
    process.env.HAWKVIEW_IDENTITY_RISK_KEY_PROVIDER = 'managed-kms'
    assert.equal(createPilotPseudonymProvider().configured, false,
      'No workload transport means no implicit AWS client')
  })
})

test('a provider failure never echoes what it was handling', async () => {
  await withPilotEnv(async () => {
    const badProvider = new WrappedRiskPseudonymProvider({
      ciphertext: async () => { throw new Error('password=NEVER-ECHO') },
      recordFailure: async () => undefined,
    })
    await assert.rejects(() => badProvider.pin(key, Date.now() + 1000),
      { message: 'IDENTITY_RISK_KEY_UNAVAILABLE' },
      'the underlying error text must be replaced, not wrapped — an echoed message is how a ' +
      'secret reaches a log')
  })
})
