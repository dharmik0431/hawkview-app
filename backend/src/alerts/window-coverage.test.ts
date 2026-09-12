import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeCoverage,
  describeQuietWindow,
  windowReadableThroughout,
  windowWentQuiet,
  type CollectionAttempt,
  type QuietWindow,
  type WindowCoverage,
} from './window-coverage.js'

/** The second half of the clearing rule, and the trap it was waiting to become. */

const MINUTE = 60 * 1000
const TOLERANCE = 10 * MINUTE
const from = new Date('2026-03-01T00:00:00.000Z')
const to = new Date('2026-03-01T01:00:00.000Z')
const window = { from, to }

/** Successes every `everyMs` across the window, which is what a healthy collector leaves. */
const steady = (everyMs: number, succeeded = true): readonly CollectionAttempt[] => {
  const attempts: CollectionAttempt[] = []
  for (let t = from.getTime() - everyMs; t <= to.getTime(); t += everyMs) {
    attempts.push({ at: new Date(t), succeeded })
  }
  return attempts
}

const history = (attempts: readonly CollectionAttempt[]): WindowCoverage =>
  ({ kind: 'ATTEMPT_HISTORY', attempts })

test('THERE IS NO BOOLEAN TO PASS, which is the whole point', () => {
  // QA's warning: when step 03 wires this, the cheapest way to make an alert clear is to
  // pass `true`, and every test still passes because the tests inject it too. So the
  // shortcut is not available — the only input that can yield true is evidence, and
  // "we do not know" is a variant carrying a reason rather than a boolean.
  const unknown: WindowCoverage = {
    kind: 'NO_HISTORY_AVAILABLE',
    because: 'SyncState holds current state only, so a failure that recovered leaves no trace.',
  }
  assert.equal(windowReadableThroughout(unknown, window, TOLERANCE), false)

  // And no reason, however confident, changes that. There is no variant meaning "trust me".
  assert.equal(
    windowReadableThroughout(
      { kind: 'NO_HISTORY_AVAILABLE', because: 'the collector is definitely fine' }, window, TOLERANCE),
    false)
})

test('A CONTINUOUSLY COLLECTED WINDOW IS READABLE', () => {
  // The positive case, without which every assertion below is satisfied by a function
  // that always returns false.
  assert.equal(windowReadableThroughout(history(steady(5 * MINUTE)), window, TOLERANCE), true)
  // Right at the tolerance.
  assert.equal(windowReadableThroughout(history(steady(TOLERANCE)), window, TOLERANCE), true)
})

test('A GAP LONGER THAN THE TOLERANCE MAKES THE WINDOW UNREADABLE', () => {
  const withHole = steady(5 * MINUTE).filter((attempt) => {
    const minutesIn = (attempt.at.getTime() - from.getTime()) / MINUTE
    return !(minutesIn > 20 && minutesIn < 40) // a twenty-minute hole in the middle
  })
  assert.equal(windowReadableThroughout(history(withHole), window, TOLERANCE), false)

  // One millisecond past the tolerance is still past it. An off-by-one here is an alert
  // clearing on silence nobody could hear.
  const justOver = [
    { at: new Date(from.getTime() - 1), succeeded: true },
    { at: new Date(from.getTime() + TOLERANCE + 1), succeeded: true },
    { at: to, succeeded: true },
  ]
  assert.equal(windowReadableThroughout(history(justOver), window, TOLERANCE), false)
})

test('THE LEADING AND TRAILING EDGES COUNT AS MUCH AS THE MIDDLE', () => {
  // A window whose first success lands halfway through was unobserved for the first half.
  const startsLate = steady(5 * MINUTE).filter(
    (attempt) => attempt.at.getTime() >= from.getTime() + 30 * MINUTE)
  assert.equal(windowReadableThroughout(history(startsLate), window, TOLERANCE), false,
    'unobserved at the start is unobserved')

  // And one that stops early was unobserved at the end — which is the direction that
  // matters most, because it is the collector dying just before the alert would clear.
  const stopsEarly = steady(5 * MINUTE).filter(
    (attempt) => attempt.at.getTime() <= to.getTime() - 30 * MINUTE)
  assert.equal(windowReadableThroughout(history(stopsEarly), window, TOLERANCE), false,
    'a collector that died before the window closed did not cover it')
})

test('FAILED ATTEMPTS DO NOT COVER A WINDOW, however many there are', () => {
  // We looked and could not see. That is not quiet, and a count of attempts is not a
  // count of observations — which is the same error as reading 0 events as 0 problems.
  assert.equal(windowReadableThroughout(history(steady(MINUTE, false)), window, TOLERANCE), false)

  // But a failure that recovered inside the tolerance does not spoil the window: the
  // question is whether there was an uncovered STRETCH, not whether anything ever failed.
  const flapping = steady(2 * MINUTE).map((attempt, index) =>
    index % 3 === 0 ? { ...attempt, succeeded: false } : attempt)
  assert.equal(windowReadableThroughout(history(flapping), window, TOLERANCE), true)
})

test('an empty history is not a covered window', () => {
  assert.equal(windowReadableThroughout(history([]), window, TOLERANCE), false)
  // And a degenerate window is not readable either, rather than vacuously true.
  assert.equal(
    windowReadableThroughout(history(steady(MINUTE)), { from: to, to: from }, TOLERANCE), false)
  assert.equal(
    windowReadableThroughout(history(steady(MINUTE)), { from, to: from }, TOLERANCE), false)
})

test('A DISTANT SUCCESS CANNOT SUBSTITUTE FOR COVERAGE INSIDE THE WINDOW', () => {
  // This test originally claimed the out-of-window FILTER is what protects us here. It is
  // not. A mutation removing that filter survived, so I searched rather than reasoned:
  // 400,000 random attempt sets and every boundary triple, and the answer never differs.
  // The WALK is what does the work — an earlier success only makes the next gap check
  // stricter, and a later one only extends past an edge the final check had cleared.
  //
  // The property is still worth pinning, because a single old success marking every window
  // readable is the failure that would matter. It just belongs to the walk, and naming the
  // filter as its cause would leave somebody believing the walk was covered when it is the
  // only thing holding this up.
  const elsewhere = [
    { at: new Date(from.getTime() - 6 * 60 * MINUTE), succeeded: true },
    { at: new Date(to.getTime() + 6 * 60 * MINUTE), succeeded: true },
  ]
  assert.equal(windowReadableThroughout(history(elsewhere), window, TOLERANCE), false)

  // STRADDLING the window with nothing inside it: the most tempting shape, because both
  // ends look covered. The middle is what was never observed.
  assert.equal(
    windowReadableThroughout(history([
      { at: new Date(from.getTime() - MINUTE), succeeded: true },
      { at: new Date(to.getTime() - MINUTE), succeeded: true },
    ]), window, TOLERANCE),
    false,
    'a success at each end does not cover the fifty-eight minutes between them')

  // POSITIVE CONTROL: the same span WITH the interior filled in is readable, so the refusal
  // above is about the gap rather than about the window being hard to satisfy at all.
  assert.equal(windowReadableThroughout(history(steady(5 * MINUTE)), window, TOLERANCE), true)
})

test('the description says which kind of uncovered it was', () => {
  // A failure is evidence we looked and could not see; a gap is evidence we did not look.
  // The boolean cannot carry that and a person acting on it needs it.
  const unknown: WindowCoverage = { kind: 'NO_HISTORY_AVAILABLE', because: 'no attempt history exists.' }
  assert.match(describeCoverage(unknown, window, TOLERANCE), /cannot be established/i)
  assert.match(describeCoverage(unknown, window, TOLERANCE), /no attempt history exists/)

  assert.match(describeCoverage(history(steady(5 * MINUTE)), window, TOLERANCE), /succeeded across the whole window/i)
  assert.match(
    describeCoverage(history(steady(MINUTE, false)), window, TOLERANCE),
    /did not cover the whole window/i)
  // A recovered failure is mentioned rather than hidden, because "readable throughout
  // despite three failures" is a different sentence from "readable throughout".
  const flapping = steady(2 * MINUTE).map((attempt, index) =>
    index % 3 === 0 ? { ...attempt, succeeded: false } : attempt)
  assert.match(describeCoverage(history(flapping), window, TOLERANCE), /despite \d+ failed attempt/i)
})

test('THE TOLERANCE IS READ FROM THE ARGUMENT, not a constant that happens to match', () => {
  // Same attempts, two tolerances, two answers. Without this a hardcoded tolerance would
  // pass every test above, since they all use one value.
  const every15 = steady(15 * MINUTE)
  assert.equal(windowReadableThroughout(history(every15), window, 10 * MINUTE), false)
  assert.equal(windowReadableThroughout(history(every15), window, 20 * MINUTE), true)
})

/** The two halves, and the failure mode that lived in the gap between them. */

const quiet = (over: Partial<QuietWindow> = {}): QuietWindow => ({
  window,
  events: { kind: 'COUNTED', at: [] },
  coverage: history(steady(MINUTE)),
  maxGapMs: TOLERANCE,
  ...over,
})

test('THERE IS NO NUMBER TO PASS EITHER, and zero was the dangerous one', () => {
  // `eventsInWindow` was a bare number, so the cheapest way to clear an alert was to pass
  // 0 — which is also exactly what a caller who never ran the query would pass. Zero found
  // and zero looked for are the same value and opposite facts, so the count had to stop
  // being a number a caller supplies.
  assert.equal(windowWentQuiet(quiet()), true, 'counted none, across a watched window')

  const notCounted = quiet({
    events: { kind: 'NOT_COUNTED', because: 'no event query was run for this alert.' },
  })
  assert.equal(windowWentQuiet(notCounted), false,
    'perfect coverage does not make an uncounted window a quiet one')

  // And the refusal survives being the ONLY thing wrong. This is the mutation that would
  // otherwise pass: check coverage first, and a NOT_COUNTED tally with good history reads
  // as quiet because nothing ever looks at the tally's kind.
  assert.match(describeQuietWindow(notCounted), /not established/)
})

test('AN EVENT INSIDE THE WINDOW KEEPS IT OPEN, boundaries included', () => {
  const inside = new Date(from.getTime() + 30 * MINUTE)
  assert.equal(windowWentQuiet(quiet({ events: { kind: 'COUNTED', at: [inside] } })), false)

  // Both edges count as inside. The conservative direction on purpose: a boundary event
  // treated as outside means an alert closing on the very event it was raised for, and a
  // boundary event treated as inside costs one more cycle before it clears.
  for (const edge of [from, to]) {
    assert.equal(windowWentQuiet(quiet({ events: { kind: 'COUNTED', at: [edge] } })), false,
      `an event exactly on ${edge === from ? 'from' : 'to'} is inside the window`)
  }

  // Outside it, on either side, is genuinely outside — otherwise nothing could ever clear.
  const before = new Date(from.getTime() - MINUTE)
  const after = new Date(to.getTime() + MINUTE)
  assert.equal(windowWentQuiet(quiet({ events: { kind: 'COUNTED', at: [before, after] } })), true)
})

test('ONE WINDOW, NOT TWO, and no test of either half could have found this', () => {
  // The defect in the old shape: `eventsInWindow` and `windowReadableThroughout` were
  // independent fields, so nothing required them to describe the same period. Count over
  // the last hour, establish coverage over the last month, and the condition reads as
  // satisfied while the event it was raised for is invisible to both halves — each field
  // correct about its own window, the pair meaningless.
  //
  // It is now unexpressible: `QuietWindow` holds ONE window and both halves read it. What
  // a test can still show is the behavioural consequence — moving the window moves both
  // halves together, and it cannot be moved for one and not the other.
  const eventAt = new Date(from.getTime() + 30 * MINUTE)
  const evidence = quiet({ events: { kind: 'COUNTED', at: [eventAt] } })
  assert.equal(windowWentQuiet(evidence), false, 'the event is inside')

  // Slide the window past the event. The SAME move that puts the event outside also moves
  // the period coverage must span — and this history does not reach there, so it does not
  // silently become quiet. The two halves cannot be aimed independently.
  const slid = {
    ...evidence,
    window: { from: new Date(to.getTime()), to: new Date(to.getTime() + 60 * MINUTE) },
  }
  assert.equal(windowWentQuiet(slid), false,
    'the event left the window and coverage left with it')

  // POSITIVE CONTROL: with history that does span the later period, it clears — so the
  // assertion above is discriminating, not just failing for a second reason forever.
  const laterHistory: CollectionAttempt[] = []
  for (let t = to.getTime() - TOLERANCE; t <= to.getTime() + 60 * MINUTE; t += MINUTE) {
    laterHistory.push({ at: new Date(t), succeeded: true })
  }
  assert.equal(windowWentQuiet({ ...slid, coverage: history(laterHistory) }), true)
})

test('the sentence names which half failed, because they fail for opposite reasons', () => {
  const noisy = quiet({ events: { kind: 'COUNTED', at: [new Date(from.getTime() + MINUTE)] } })
  assert.match(describeQuietWindow(noisy), /1 further event/)

  const unwatched = quiet({
    coverage: { kind: 'NO_HISTORY_AVAILABLE', because: 'SyncState keeps no attempt history.' },
  })
  const sentence = describeQuietWindow(unwatched)
  assert.match(sentence, /No further events/, 'the quiet half is true and is said so')
  assert.match(sentence, /SyncState keeps no attempt history/, 'and the reason it is not enough')
})
