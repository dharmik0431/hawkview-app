import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac, randomBytes } from 'node:crypto'
import { ResendSignatureVerifier, type SignedWebhook } from './resend-signature-verifier.service.js'

/** The verifier. **The point of every test here is the positive control**: a verifier that
 * rejects everything passes every forgery test and is indistinguishable from a correct one until
 * something real arrives. So each negative sits beside a genuine signature that must verify. */

const KEY = randomBytes(32)
const SECRET = `whsec_${KEY.toString('base64')}`
const NOW = Date.parse('2026-09-13T09:00:00.000Z')
const BODY = '{"type":"email.delivered","data":{"email_id":"p-1"}}'

/** A genuine Svix signature, computed the way Resend computes it. */
const sign = (id: string, timestampSeconds: number, body: string, key = KEY): string =>
  `v1,${createHmac('sha256', key).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`

const webhook = (over: Partial<SignedWebhook> = {}): SignedWebhook => {
  const id = 'msg_1'
  const timestamp = String(Math.floor(NOW / 1000))
  return { id, timestamp, signature: sign(id, Number(timestamp), BODY), rawBody: BODY, ...over }
}

const verifierWith = (secret: string | undefined): ResendSignatureVerifier => {
  const before = process.env.RESEND_WEBHOOK_SIGNING_SECRET
  if (secret === undefined) delete process.env.RESEND_WEBHOOK_SIGNING_SECRET
  else process.env.RESEND_WEBHOOK_SIGNING_SECRET = secret
  try {
    return new ResendSignatureVerifier()
  } finally {
    if (before === undefined) delete process.env.RESEND_WEBHOOK_SIGNING_SECRET
    else process.env.RESEND_WEBHOOK_SIGNING_SECRET = before
  }
}

test('A GENUINE SIGNATURE VERIFIES — the control every other test here depends on', () => {
  // A verifier that rejects everything passes every forgery test below and is indistinguishable
  // from a correct one until real traffic arrives. This is the test that tells them apart.
  assert.equal(verifierWith(SECRET).verify(webhook(), NOW), 'AUTHENTIC')

  // The bare base64 form too, because that is what somebody pasting from a different page has.
  assert.equal(verifierWith(KEY.toString('base64')).verify(webhook(), NOW), 'AUTHENTIC')
})

test('A FORGED OR ALTERED REQUEST IS SIGNATURE_INVALID', () => {
  const verifier = verifierWith(SECRET)

  // Signed with the wrong key.
  assert.equal(
    verifier.verify(webhook({ signature: sign('msg_1', Math.floor(NOW / 1000), BODY, randomBytes(32)) }), NOW),
    'SIGNATURE_INVALID')

  // BODY ALTERED AFTER SIGNING, which is the attack that matters: a genuine notice about somebody
  // else's message, edited to name ours.
  assert.equal(
    verifier.verify(webhook({ rawBody: BODY.replace('p-1', 'p-victim') }), NOW),
    'SIGNATURE_INVALID')

  // Id or timestamp altered — both are inside the signed content.
  assert.equal(verifier.verify(webhook({ id: 'msg_2' }), NOW), 'SIGNATURE_INVALID')
  assert.equal(verifier.verify(webhook({ timestamp: String(Math.floor(NOW / 1000) + 1) }), NOW),
    'SIGNATURE_INVALID')

  // Garbage in the signature header.
  assert.equal(verifier.verify(webhook({ signature: 'v1,not-base64!!' }), NOW), 'SIGNATURE_INVALID')
  assert.equal(verifier.verify(webhook({ signature: 'v2,abcd' }), NOW), 'SIGNATURE_INVALID')
})

test('A MISSING HEADER IS MISSING, NOT INVALID — they are different facts', () => {
  const verifier = verifierWith(SECRET)
  assert.equal(verifier.verify(webhook({ signature: undefined }), NOW), 'SIGNATURE_MISSING')
  assert.equal(verifier.verify(webhook({ signature: '' }), NOW), 'SIGNATURE_MISSING')
  assert.equal(verifier.verify(webhook({ id: undefined }), NOW), 'SIGNATURE_MISSING')
  assert.equal(verifier.verify(webhook({ timestamp: undefined }), NOW), 'SIGNATURE_MISSING')

  // WHY IT MATTERS: missing means something that is not Resend reached the endpoint — a probe, a
  // health check, a misconfigured proxy. Invalid means something CLAIMED to be Resend and was
  // not. The first is noise; the second is worth looking at, and collapsing them loses that.
})

test('A REPLAYED REQUEST IS REFUSED, however genuine its signature', () => {
  // Without a tolerance a captured request replays for ever: the content has not changed, so the
  // signature stays valid, and every replay would be recorded as a fresh outcome.
  const verifier = verifierWith(SECRET)
  const old = Math.floor((NOW - 10 * 60_000) / 1000)

  assert.equal(
    verifier.verify({ id: 'msg_1', timestamp: String(old), signature: sign('msg_1', old, BODY), rawBody: BODY }, NOW),
    'SIGNATURE_INVALID', 'ten minutes old')

  // AND THE FUTURE TOO, because a clock skewed forward is the same replay window in reverse.
  const ahead = Math.floor((NOW + 10 * 60_000) / 1000)
  assert.equal(
    verifier.verify({ id: 'msg_1', timestamp: String(ahead), signature: sign('msg_1', ahead, BODY), rawBody: BODY }, NOW),
    'SIGNATURE_INVALID')

  // INSIDE THE WINDOW IT STILL VERIFIES, or the tolerance is just an outage.
  const recent = Math.floor((NOW - 60_000) / 1000)
  assert.equal(
    verifier.verify({ id: 'msg_1', timestamp: String(recent), signature: sign('msg_1', recent, BODY), rawBody: BODY }, NOW),
    'AUTHENTIC')
})

test('UNCONFIGURED FAILS CLOSED, and says so separately', () => {
  // With no secret there is nothing to check against. An endpoint that accepts everything while
  // unconfigured is the endpoint anybody can use to mark our messages delivered.
  const verifier = verifierWith(undefined)
  assert.equal(verifier.configured, false)
  assert.equal(verifier.verify(webhook(), NOW), 'SIGNATURE_INVALID')

  // A malformed secret is the same, and does not stop the service constructing — a webhook
  // secret must not take HawkView down at boot and stop it collecting.
  assert.equal(verifierWith('whsec_').verify(webhook(), NOW), 'SIGNATURE_INVALID')
  assert.equal(verifierWith(SECRET).configured, true)
})

test('A ROTATING SECRET DOES NOT REJECT GENUINE TRAFFIC', () => {
  // During a rotation two signatures arrive in one header, space separated. Matching only the
  // first would reject real deliveries for the length of every rotation.
  const verifier = verifierWith(SECRET)
  const timestamp = Math.floor(NOW / 1000)
  const other = sign('msg_1', timestamp, BODY, randomBytes(32))
  const ours = sign('msg_1', timestamp, BODY)

  assert.equal(verifier.verify(webhook({ signature: `${other} ${ours}` }), NOW), 'AUTHENTIC')
  assert.equal(verifier.verify(webhook({ signature: `${ours} ${other}` }), NOW), 'AUTHENTIC')
  // Two signatures, neither ours, is still a refusal.
  assert.equal(
    verifier.verify(webhook({ signature: `${other} ${sign('msg_1', timestamp, BODY, randomBytes(32))}` }), NOW),
    'SIGNATURE_INVALID')
})
