import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deliveryDescription,
  emptinessCopy,
  SAVED_APPLIES_FROM,
  TIER_CHANNELS,
  type AlertDisposition,
} from './dispositions.ts'

const TIERS: AlertDisposition[] = ['ACT_NOW', 'ACT_TODAY', 'RECORD_ONLY']

test('no tier promises a channel that cannot carry anything', () => {
  // SMS is deferred: the channel was shelved and the tier kept, so ACT_NOW will
  // keep meaning "phone" in the routing table long after nothing can dial.
  // Deriving the sentence from the tier's NAME would promise a call until
  // somebody remembered to edit a string.
  for (const tier of TIERS) {
    const shown = deliveryDescription(tier)
    const dead = TIER_CHANNELS[tier].filter((entry) => !entry.live)
    for (const channel of dead) {
      assert.ok(
        !new RegExp(channel.channel === 'PHONE' ? 'phone' : channel.channel, 'i').test(
          shown.today
        ),
        tier + ' promised delivery by ' + channel.channel + ': ' + shown.today
      )
    }
    // And what is deferred is stated rather than silently omitted.
    assert.equal(shown.deferred.length, dead.length)
  }
})

test('ACT_NOW says email and in-app today, and says phone is deferred', () => {
  const shown = deliveryDescription('ACT_NOW')
  assert.match(shown.today, /email/)
  assert.match(shown.today, /in-app/)
  assert.ok(!/phone/i.test(shown.today), 'ACT_NOW promised a phone call')
  assert.equal(shown.deferred.length, 1)
  assert.match(shown.deferred[0], /Phone delivery is not available yet/)
})

test('the sentence follows the channel data, not the tier name', () => {
  // The property that makes this worth more than a hand-written string per
  // tier: flip a channel and the copy changes with no edit to the copy.
  assert.match(deliveryDescription('ACT_TODAY').today, /email/)

  const mailDown = {
    ...TIER_CHANNELS,
    ACT_TODAY: [
      { channel: 'EMAIL', live: false, deferredBecause: 'Mail relay is down.' },
      { channel: 'IN_APP', live: true },
    ],
  } as const
  const after = deliveryDescription('ACT_TODAY', mailDown)
  assert.ok(
    !/email/i.test(after.today),
    'the sentence still promised email after the channel went dark'
  )
  assert.match(after.deferred[0], /Mail relay is down/)

  // And the real table is untouched, because nothing mutated it.
  assert.match(deliveryDescription('ACT_TODAY').today, /email/)
})

test('a tier with every channel dark says so rather than saying nothing', () => {
  const allDark = {
    ...TIER_CHANNELS,
    ACT_NOW: [
      { channel: 'PHONE', live: false, deferredBecause: 'Shelved.' },
      { channel: 'EMAIL', live: false, deferredBecause: 'Relay down.' },
      { channel: 'IN_APP', live: false, deferredBecause: 'Down.' },
    ],
  } as const
  const shown = deliveryDescription('ACT_NOW', allDark)
  assert.match(shown.today, /Nothing can be delivered/)
  assert.equal(shown.deferred.length, 3)
})

test('an empty list says which kind of empty it is', () => {
  // Production holds zero findings, so this is the screen every MSP sees on day
  // one. "Nothing matched" and "we have never been able to look" are different
  // facts with different remedies, and an empty array cannot tell them apart.
  const matched = emptinessCopy({ kind: 'NOTHING_MATCHED' })
  const never = emptinessCopy({ kind: 'NEVER_OBSERVED' })
  assert.ok(matched && never)
  assert.notEqual(matched!.title, never!.title)
  assert.notEqual(matched!.detail, never!.detail)

  // Only one of them may read as a result about the organisation.
  assert.match(matched!.detail, /empty result rather than a missing one/)
  assert.match(never!.detail, /never been able|No request has succeeded/)
  assert.ok(
    !/empty result/.test(never!.detail),
    'a failed load was described as an empty result'
  )

  // A populated list gets no empty-state copy at all.
  assert.equal(emptinessCopy({ kind: 'HAS_ITEMS' }), null)
})

test('saving says when the change takes effect', () => {
  // Intake reads dispositions once per run. "Saved" alone would promise
  // something the pipeline does not keep: an MSP who silences an alert
  // mid-run and then receives it concludes the setting is broken.
  assert.match(SAVED_APPLIES_FROM, /next evaluation run/)
  assert.match(SAVED_APPLIES_FROM, /already in progress is not affected/)
})
