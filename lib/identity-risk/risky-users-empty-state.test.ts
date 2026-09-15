import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hawkViewDetectionSummary, microsoftRiskSummary, riskyUsersEmptyState,
  type MicrosoftChannel, type MicrosoftChannelState, type RiskyUserCount,
} from './risky-users-view.ts'

/**
 * **THE SENTENCE AN MSP READS UNDER AN EMPTY TABLE.**
 *
 * The mounted section chose it from `filteredRows.length === 0` and the filters alone, so
 * "Users requiring review: Not available" rendered directly above "No users requiring review
 * found." One sentence says we do not know; the next says we know and it is none. **An MSP reads
 * the second and stops looking** — absence reading as reassurance, on the screen this product
 * exists to make honest.
 *
 * Every test below is about the same question: *may this state assert that nobody needs review?*
 * Exactly one may.
 */

const count = (over: Partial<RiskyUserCount> = {}): RiskyUserCount => ({
  accuracy: 'EXACT',
  value: 0,
  listCoverage: 'COMPLETE',
  display: '0',
  accessibleValue: '0',
  headline: 'No users requiring review',
  caption: 'From the evidence assessed.',
  reasons: [],
  known: [],
  gaps: [],
  asOf: '2026-09-13T09:00:00.000Z',
  findingsUndelivered: false,
  ...over,
}) as RiskyUserCount

// ---------------------------------------------------------------------------------------

test('ONLY A CONFIRMED ZERO MAY SAY NOBODY NEEDS REVIEW', () => {
  // THE WHOLE PROPERTY, AS ONE SWEEP. Every state that is not an exact, complete zero must leave
  // `assertsNone` false — which is the inversion the fix is: the reassuring sentence has to be
  // earned rather than being the default that other states fall through to.
  const states: [string, RiskyUserCount, boolean][] = [
    ['unreadable assessment', count({ accuracy: 'UNAVAILABLE', value: null }), false],
    ['withheld total', count({ accuracy: 'WITHHELD', value: null }), false],
    ['rows missing', count({ listCoverage: 'NONE_DELIVERED', value: 3 }), false],
    ['truncated list', count({ listCoverage: 'PARTIAL', value: 9 }), false],
    ['a lower bound only', count({ accuracy: 'AT_LEAST', value: 4 }), false],
    ['an exact non-zero with no rows', count({ accuracy: 'EXACT', value: 2 }), false],
    ['an exact, complete zero', count(), true],
  ]

  for (const [name, value, mayAssert] of states) {
    const state = riskyUsersEmptyState(value, false)
    assert.equal(state.assertsNone, mayAssert, `${name}: assertsNone should be ${mayAssert}`)
    if (!mayAssert) {
      assert.ok(
        !/^No users requiring review were found/.test(state.sentence),
        `${name} must not open with the all-clear sentence: ${state.sentence}`,
      )
    }
  }
})

test('THE CONTRADICTION THAT WAS ON SCREEN CANNOT BE PRODUCED', () => {
  // The exact pairing the PM saw: the card says "Not available", the table said "No users
  // requiring review found." This is the regression test for that screen, stated as the two
  // sentences rather than as an internal flag.
  const unavailable = count({ accuracy: 'UNAVAILABLE', value: null, display: 'Not available' })
  const state = riskyUsersEmptyState(unavailable, false)

  assert.equal(state.kind, 'NO_ASSESSMENT')
  assert.match(state.sentence, /not a zero and it is not an all-clear/)
  assert.equal(state.assertsNone, false)
})

test('a withheld count is not an error and not an empty state', () => {
  // `RiskyUserCountAccuracy` is explicit that a technician who reads a withheld count as breakage
  // opens a support ticket — a worse outcome than the dishonest number would have been. So this
  // arm must neither claim none nor read as a failure.
  const state = riskyUsersEmptyState(count({ accuracy: 'WITHHELD', value: null }), false)

  assert.equal(state.kind, 'COUNT_WITHHELD')
  assert.equal(state.assertsNone, false)
  assert.doesNotMatch(state.sentence, /error|failed|could not be loaded/i)
  assert.match(state.sentence, /nothing here says no user needs review/)
})

test('integrity is decided BEFORE the filters', () => {
  // "No users match the active search or filters" implies the set being filtered was known. When
  // the assessment could not be read, that is a quieter version of the same false claim — so the
  // filter arm must not win over an unreadable count.
  const unreadable = count({ accuracy: 'UNAVAILABLE', value: null })

  assert.equal(riskyUsersEmptyState(unreadable, true).kind, 'NO_ASSESSMENT')
  // And with a sound count, the filter arm still works — otherwise this ordering would have
  // removed a true and useful message.
  assert.equal(riskyUsersEmptyState(count({ value: 5 }), true).kind, 'FILTERED')
})

test('a zero is never rendered without its gaps', () => {
  // The type says a caller that drops them is dropping the disclosure that makes the zero
  // truthful. The count carries them; this is the surface that has to print them.
  const withGaps = count({ gaps: ['Sign-in logs unavailable for 2 days'] })
  const state = riskyUsersEmptyState(withGaps, false)

  assert.equal(state.assertsNone, true)
  assert.match(state.sentence, /Sign-in logs unavailable for 2 days/)
})

test('an unanticipated combination falls to the cautious arm, not the reassuring one', () => {
  // THE REASON THE DEFAULT MATTERS MORE THAN THE BRANCHES. The original code asserted "none
  // found" by default and narrowed it with a single filter check, so every state nobody had
  // thought about landed on the reassuring sentence. Here an unmodelled combination lands on a
  // non-claim.
  const odd = count({ accuracy: 'AT_LEAST', value: null, listCoverage: 'COMPLETE' })
  const state = riskyUsersEmptyState(odd, false)

  assert.equal(state.assertsNone, false)
  assert.match(state.sentence, /not a statement that no user needs review/)
})

// ---------------------------------------------------------------------------------------
// THE SUMMARY LINE, WHICH COULD NOT COME APART FROM THE COUNT BESIDE IT
// ---------------------------------------------------------------------------------------

test('THE GUARANTEED PAIRING: an unavailable count never renders a zero beside it', () => {
  // `nativeRiskyUserCount` and `nativeRiskyUserList` branch on the IDENTICAL condition —
  // `!native || !native.available` — so "Not available" and an empty row list are not merely
  // co-reachable, they always co-occur. Every tenant with no collection configured read
  // "Users requiring review: Not available" above "0 detected by HawkView", and the second line
  // is the one a technician believes, because it has a number in it.
  const line = hawkViewDetectionSummary(count({ accuracy: 'UNAVAILABLE', value: null }), 0)

  assert.doesNotMatch(line, /\b0\b/, `a zero survived an unavailable assessment: ${line}`)
  assert.match(line, /not available/i)
})

test('withheld totals and undelivered findings retain distinct qualified summaries', () => {
  // C87/C80: a withheld count is unknown, but a partial list must not erase
  // a known exact total. The old fixture's value/display must agree.
  const withheld = hawkViewDetectionSummary(count({ accuracy: 'WITHHELD', value: null }), 3)
  assert.match(withheld, /^3 detected by HawkView so far/)
  assert.match(withheld, /not available/)

  const truncated = hawkViewDetectionSummary(count({ listCoverage: 'PARTIAL', value: 9, display: '9' }), 2)
  assert.equal(truncated, '2 detected by HawkView shown; 9 reported users')
  assert.doesNotMatch(truncated, /not available/)

  // A delivery gap cannot become a zero-detections claim, even when the
  // separate tenant count is known. Preserve both facts, without merging them.
  const none = hawkViewDetectionSummary(count({ listCoverage: 'NONE_DELIVERED', value: 4, display: '4' }), 0)
  assert.doesNotMatch(none, /\b0\b/)
  assert.match(none, /findings not delivered/)
  assert.match(none, /4 reported users/)
})

test('a sound count still prints the plain number, including a true zero', () => {
  // THE DEMONSTRATED NON-FIRING. Without it the line could refuse to state anything and still
  // pass every assertion above — and a screen that never gives a number is its own failure.
  assert.equal(hawkViewDetectionSummary(count({ value: 5 }), 5), '5 detected by HawkView')
  assert.equal(hawkViewDetectionSummary(count(), 0), '0 detected by HawkView')
})

test('THE SECOND ZERO: an empty Microsoft list is not zero Microsoft risk', () => {
  // "no array" vs "an array" was the only distinction the old line could make. It could not tell
  // an empty list because Microsoft reported nothing from an empty list because Microsoft could
  // not report at all — opposite facts with opposite remedies.
  const channel = (state: MicrosoftChannelState, headline: string): MicrosoftChannel =>
    ({ state, headline, detail: '', addressable: false, reasonCode: null, observedAt: null })

  for (const state of ['UNAVAILABLE', 'INTERRUPTED', 'NOT_EVALUATED', 'CONTRADICTORY'] as const) {
    const line = microsoftRiskSummary(channel(state, `Microsoft: ${state}`), 0)
    assert.doesNotMatch(line, /\b0 active\b/, `${state} rendered a zero: ${line}`)
    assert.equal(line, `Microsoft: ${state}`, 'the channel already has a line written for this')
  }

  // THE NON-FIRING HALF. A reporting channel with genuinely nothing must still say zero, or the
  // fix has replaced one dishonesty with another.
  assert.equal(
    microsoftRiskSummary(channel('REPORTING', 'Microsoft is reporting'), 0),
    '0 active Microsoft risk',
  )
  assert.equal(
    microsoftRiskSummary(channel('REPORTING', 'Microsoft is reporting'), 4),
    '4 active Microsoft risk',
  )
})
