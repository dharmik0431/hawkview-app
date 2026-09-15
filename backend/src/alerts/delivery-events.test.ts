import assert from 'node:assert/strict'
import test from 'node:test'
import {
  outcomeRow, parseResendEvent, suppressesOnOutcome,
} from './delivery-events.js'
import {
  authenticate, messageId, providerMessageId,
  type RawWebhook,
} from './email-delivery.js'

/** The webhook's pure half. Everything the endpoint can get wrong is here, so none of it needs an
 * HTTP server to pin. */

const AT = '2026-09-13T09:00:00.000Z'
const PID = providerMessageId('re_abc123')
const MID = messageId('msg-1')

const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'email.delivered',
  created_at: AT,
  data: { email_id: 're_abc123' },
  ...over,
})

const raw = (over: Partial<RawWebhook> = {}): RawWebhook =>
  ({ providerId: PID, kind: 'DELIVERED', atIso: AT, bounce: null, ...over })

// ---------------------------------------------------------------------------------------
// PARSING
// ---------------------------------------------------------------------------------------

test('the three modelled events parse into our vocabulary', () => {
  for (const [type, kind] of [
    ['email.delivered', 'DELIVERED'], ['email.bounced', 'BOUNCED'], ['email.complained', 'COMPLAINED'],
  ] as const) {
    const result = parseResendEvent(body({ type }))
    assert.equal(result.parsed, true, type)
    assert.equal(result.parsed && result.raw.kind, kind)
  }
})

test('an unmodelled event type is neither an error nor an unmatched event', () => {
  // Resend sends email.sent and email.opened. Recording those as UNMATCHED would bury the
  // forged-event signal that table exists to surface under routine traffic — and treating them as
  // errors would alarm every time the provider adds a feature.
  for (const type of ['email.sent', 'email.opened', 'email.clicked']) {
    const result = parseResendEvent(body({ type }))
    assert.deepEqual(result, { parsed: false, because: 'EVENT_NOT_MODELLED' }, type)
  }
})

test('a malformed body is distinguished from an unmodelled one', () => {
  // Two different facts: "the provider sent something we do not model" and "the provider sent
  // something that is not a webhook". Collapsing them would hide a real parser failure behind
  // routine unmodelled traffic.
  for (const bad of ['', 'not json', '[]', '{}', JSON.stringify({ type: 'email.delivered' })]) {
    const result = parseResendEvent(bad)
    assert.equal(result.parsed, false, bad)
    assert.equal(result.parsed === false && result.because, 'MALFORMED', bad)
  }
  // Present type, absent email id.
  assert.deepEqual(
    parseResendEvent(body({ data: {} })),
    { parsed: false, because: 'MALFORMED' },
  )
})

test('the timestamp is the provider s, not ours', () => {
  // A webhook delayed by an hour of provider retries must not record an hour-late delivery as
  // having just happened.
  const past = '2026-09-13T08:00:00.000Z'
  const result = parseResendEvent(body({ created_at: past }))
  assert.equal(result.parsed && result.raw.atIso, past)
})

test('a bounce class is read where stated and left null where it is not', () => {
  // Null rather than HARD, so the single decision that an unclassified bounce is HARD stays in
  // record() rather than being taken twice in two places that can disagree.
  const hard = parseResendEvent(body({ type: 'email.bounced', data: { email_id: 're_abc123', bounce: { type: 'Permanent' } } }))
  assert.equal(hard.parsed && hard.raw.bounce, 'HARD')
  const soft = parseResendEvent(body({ type: 'email.bounced', data: { email_id: 're_abc123', bounce_type: 'Transient' } }))
  assert.equal(soft.parsed && soft.raw.bounce, 'SOFT')
  const unstated = parseResendEvent(body({ type: 'email.bounced' }))
  assert.equal(unstated.parsed && unstated.raw.bounce, null)
})

// ---------------------------------------------------------------------------------------
// RECORDING. Every verified event lands, including the ones that matched nothing.
// ---------------------------------------------------------------------------------------

/** The only door to an `AuthenticEvent`, which is the point of the brand. */
const verified = (over: Partial<RawWebhook> = {}) => {
  const received = authenticate(raw(over), 'AUTHENTIC')
  assert.equal(received.authentic, true)
  return (received as Extract<typeof received, { authentic: true }>).event
}

test('outcomeRow cannot be reached with an unverified event, by type', () => {
  // THE UNVERIFIED BRANCH IS GONE RATHER THAN LEFT AS DEFENSIVE CODE. Unverifiable requests are
  // now counted per hour instead of stored, and a CHECK forbids their verdicts in this table — so
  // a function that could still build such a row would read as a supported path while producing
  // rows the database rejects.
  //
  // Asserted by the compiler, not at run time: `outcomeRow` takes `AuthenticEvent`, whose only
  // constructor is `authenticate` returning its authentic arm. The line below is the negative,
  // and it is a type error rather than a failed assertion.
  const unverified = authenticate(raw(), 'SIGNATURE_INVALID')
  assert.equal(unverified.authentic, false)
  // @ts-expect-error an unverified event has no path into an outcome row
  outcomeRow(unverified, MID)
})

test('a verified event matching no job is recorded as UNMATCHED, not dropped', () => {
  // A job we lost, an id never recorded, or a replay inside the signature's tolerance. All three
  // look like nothing happening if the row is dropped for want of something to attach it to — and
  // all three require the signing secret, so this path is bounded by the provider's traffic.
  const row = outcomeRow(verified(), null)
  assert.equal(row.kind, 'UNMATCHED')
  assert.equal(row.because, 'NO_SUCH_JOB')
  assert.equal(row.messageId, null)
  assert.equal(row.providerId, PID, 'the id is kept, so it can be reconciled later')
})

test('a verified, matched event records the outcome against the message', () => {
  assert.deepEqual(outcomeRow(verified(), MID), {
    providerId: PID, messageId: MID, kind: 'DELIVERED', bounce: null, because: null, occurredAtIso: AT,
  })
})

test('only a bounce carries a bounce class, matching the CHECK in the migration', () => {
  // Without this a DELIVERED row could carry HARD, and any query grouping by bounce class would
  // answer a question about a set that should be empty.
  assert.equal(outcomeRow(verified({ kind: 'DELIVERED', bounce: 'HARD' }), MID).bounce, null)
  assert.equal(outcomeRow(verified({ kind: 'BOUNCED', bounce: 'HARD' }), MID).bounce, 'HARD')
})

test('a reason belongs to an unmatched event and to nothing else, in both directions', () => {
  assert.equal(outcomeRow(verified(), MID).because, null, 'a real outcome has no reason-not-to-be-one')
  assert.notEqual(outcomeRow(verified(), null).because, null, 'and an unmatched row is never silent about why')
})

test('the only reasons this table can now carry are the ones a secret-holder can cause', () => {
  // THE BOUND, STATED AS A PROPERTY RATHER THAN AS A ROUTE BEHAVIOUR. SIGNATURE_MISSING and
  // SIGNATURE_INVALID are reachable by anyone who learns the URL; NO_SUCH_JOB and
  // ALREADY_RESOLVED need the signing secret, so their volume is bounded by the provider's
  // traffic, which is bounded by our own sending. Only the second pair may appear here, and the
  // CHECK in 20260913180000 says the same thing where it survives a rewrite of the route.
  const reasons = new Set<string>()
  reasons.add(outcomeRow(verified(), null).because!)
  for (const reason of reasons) {
    assert.ok(
      reason === 'NO_SUCH_JOB' || reason === 'ALREADY_RESOLVED',
      `${reason} is reachable without the signing secret and must not be storable per-row`,
    )
  }
})

// ---------------------------------------------------------------------------------------
// THE ADDRESS-LEVEL CONSEQUENCE. A different subject from the message's outcome.
// ---------------------------------------------------------------------------------------

test('a hard bounce and a complaint suppress; a soft bounce and a delivery do not', () => {
  const suppressing: readonly (readonly [string, boolean])[] = [
    ['BOUNCED/HARD', true], ['BOUNCED/SOFT', false], ['COMPLAINED', true], ['DELIVERED', false],
  ]
  const rowFor = (label: string) =>
    label === 'BOUNCED/HARD' ? outcomeRow(verified({ kind: 'BOUNCED', bounce: 'HARD' }), MID)
      : label === 'BOUNCED/SOFT' ? outcomeRow(verified({ kind: 'BOUNCED', bounce: 'SOFT' }), MID)
        : label === 'COMPLAINED' ? outcomeRow(verified({ kind: 'COMPLAINED' }), MID)
          : outcomeRow(verified(), MID)

  for (const [label, expected] of suppressing) {
    assert.equal(suppressesOnOutcome(rowFor(label)), expected, label)
  }
})

test('an UNMATCHED row never suppresses an address', () => {
  // A forged bounce must not be able to silence a real inbox. This is the whole reason the
  // signature verdict rides in through `Received` rather than being checked beside the record.
  // The forged event never becomes a row at all now — it is counted, and `outcomeRow` will not
  // accept it. So the property is stronger than it was: not 'a forged bounce does not suppress'
  // but 'a forged bounce cannot be represented as a bounce'.
  const unverified = authenticate(raw({ kind: 'BOUNCED', bounce: 'HARD' }), 'SIGNATURE_INVALID')
  assert.equal(unverified.authentic, false)
  // An UNMATCHED row, however it arose, never suppresses.
  assert.equal(suppressesOnOutcome(outcomeRow(verified({ kind: 'BOUNCED', bounce: 'HARD' }), null)), false)
})
