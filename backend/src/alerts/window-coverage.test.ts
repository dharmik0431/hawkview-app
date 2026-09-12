import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeCoverage,
  windowReadableThroughout,
  type CollectionAttempt,
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
