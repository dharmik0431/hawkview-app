import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
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

/** Every rendering of a secret this codebase could plausibly produce, DERIVED FROM THE
 * SECRET rather than searched for as a spelling somebody guessed.
 *
 * THE DEFECT THIS REPLACES: the old assertions searched a serialised session for
 * `material.toString('hex')` and for the literal input. Both are spellings the leak has no
 * reason to use. Measured by putting a real leak on the session object and running the
 * shipped file: hex and plaintext were caught; base64, a byte array, the input as base64,
 * and THE BUFFER ITSELF were not. The Buffer case is the one that matters, because
 * `JSON.stringify` renders a Buffer as `{"type":"Buffer","data":[222,173,...]}` — so the
 * single most likely way this leak ever actually happens, somebody putting `material` on the
 * session object, produced a serialisation containing every byte of the key and passed.
 *
 * AN ASSERTION OVER A RENDERED STRING TESTS THE RENDERING. The search term has to come from
 * the secret, not from the author.
 *
 * THE LIMIT, STATED RATHER THAN IMPLIED: this catches the renderings enumerated here. It is
 * NOT a proof that no encoding leaks. Which encodings are worth enumerating is a judgement
 * about what a reader could invert, so the honest claim is narrow — no run of the key's
 * bytes in any encoding we render elsewhere. A new encoding in the codebase belongs here. */
function renderingsOf(secret: Buffer): readonly { how: string; text: string }[] {
  const candidates = [
    { how: 'hex', text: secret.toString('hex') },
    { how: 'base64', text: secret.toString('base64') },
    { how: 'base64url', text: secret.toString('base64url') },
    { how: 'utf8', text: secret.toString('utf8') },
    { how: 'latin1', text: secret.toString('latin1') },
    { how: 'ascii', text: secret.toString('ascii') },
    // The one that would actually have happened. A Buffer reaching JSON.stringify becomes a
    // decimal byte array, which contains no hex and no base64 and every byte of the key.
    { how: 'JSON Buffer form', text: [...secret].join(',') },
  ]
  // A degenerate rendering would match everything and turn this into a test that always
  // fails. Lossy encodings of random bytes can collapse; anything too short to be evidence
  // is dropped rather than searched, and the drop is visible in the returned list.
  return candidates.filter((candidate) => candidate.text.length >= 16)
}

/** Which renderings of `secret` appear in `text`. Empty is the healthy answer. */
function leakedRenderings(text: string, secret: Buffer): readonly string[] {
  return renderingsOf(secret).filter((r) => text.includes(r.text)).map((r) => r.how)
}

test('a session serialises without leaking its input or its key material', async () => {
  await withPilotEnv(async () => {
    const { provider } = freshProvider()
    const session = await provider.pin(key, Date.now() + 30000)
    await session.reference('mailbox', ['SYNTHETIC_MAILBOX'])

    const serialised = JSON.stringify(session)
    assert.deepEqual(leakedRenderings(serialised, material), [],
      'no rendering of the unwrapped key material may survive serialisation')
    assert.deepEqual(leakedRenderings(serialised, Buffer.from('SYNTHETIC_MAILBOX')), [],
      'nor any rendering of the plaintext input — a logged session would carry it')
  })
})

test('THE LEAK DETECTOR FIRES, including on the case that would actually happen', () => {
  // A leak test that has never been shown to catch a leak is a test that passes. Each of
  // these is a real way the material reaches a serialisation, and the Buffer one is the way
  // it would happen: nobody writes `material.toString("hex")` onto a session by accident,
  // and plenty of people write `material`.
  // ASSERTED BY PRESENCE, NOT BY EXACT LIST, and the reason is a flake I nearly shipped INTO
  // the file we are fixing for flakiness. `base64url` is a prefix of `base64` whenever the
  // payload happens to contain no `+` or `/` — so an exact-list expectation passes or fails
  // depending on `randomBytes(32)`. It held for the 32-byte key and failed for the ASCII
  // input on the first run. What each case must show is that the RIGHT rendering fires;
  // whether a second, overlapping encoding also fires is an accident of the bytes.
  const firesOn = (leaked: string, secret: Buffer) =>
    leakedRenderings(JSON.stringify({ leaked }), secret)

  assert.ok(leakedRenderings(JSON.stringify({ leaked: material }), material).includes('JSON Buffer form'),
    'a Buffer on the object leaks every byte and must be caught')
  assert.ok(firesOn(material.toString('base64'), material).includes('base64'),
    'base64 was not caught before this change')
  assert.ok(leakedRenderings(JSON.stringify({ leaked: [...material] }), material).includes('JSON Buffer form'),
    'a plain byte array is the same leak without the Buffer wrapper')
  assert.ok(firesOn(material.toString('hex'), material).includes('hex'),
    'the one the old assertion caught still gets caught')

  // The input, by the route the old assertion missed.
  const input = Buffer.from('SYNTHETIC_MAILBOX')
  assert.ok(firesOn(input.toString('base64'), input).includes('base64'),
    'the input base64-encoded is still the input')
  assert.ok(firesOn(input.toString('utf8'), input).includes('utf8'),
    'and the plaintext input itself, which is what the old assertion did catch')
})

test('THE LEAK DETECTOR DOES NOT FIRE ON THE FEATURE\'S OWN CORRECT OUTPUT', () => {
  // The control in the other direction, and it is the one that keeps this test alive. A leak
  // detector that flags a reference DERIVED from the material would be weakened by the next
  // person to hit it, and then it catches nothing. An HMAC is a function of the key; it is
  // not the key, and the whole product depends on that distinction holding.
  const derived = createHmac('sha256', material).update('SYNTHETIC_MAILBOX').digest('hex')
  assert.deepEqual(leakedRenderings(JSON.stringify({ reference: derived }), material), [],
    'an HMAC derived from the material is not a leak of it')
  assert.equal(derived.length, 64, 'and the control must be a real digest, not an empty string')
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
