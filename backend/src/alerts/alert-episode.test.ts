import assert from 'node:assert/strict'
import test from 'node:test'
import { episodesOf, placeEvent, type EpisodeSpan } from './alert-episode.js'
import { eventInstant, type EventInstant } from './alert-event-time.js'

/** The episode boundary, tested before anything is built on top of it. */

const HOUR = 60 * 60 * 1000
const QUIET = 24 * HOUR

/** An event time. `receivedAt` is deliberately absurd in most of these — it is
 * not an input to any decision here, and several tests prove that by varying it. */
function at(iso: string, receivedAt = '2030-01-01T00:00:00.000Z'): EventInstant {
  return eventInstant({ occurredAt: new Date(iso), receivedAt: new Date(receivedAt) })
}

function span(first: string, last: string): EpisodeSpan {
  return { firstEventAt: new Date(first), lastEventAt: new Date(last) }
}

test('the span is a watermark: it advances with every event', () => {
  // Three events an hour apart. After the third, the span must reach the third —
  // not stop at the first, which is what stamping the span when the episode opens
  // would produce.
  let current: EpisodeSpan | null = null
  for (const iso of ['2026-03-01T00:00:00.000Z', '2026-03-01T01:00:00.000Z', '2026-03-01T02:00:00.000Z']) {
    const placement = placeEvent(current, at(iso), QUIET)
    current = placement.span
  }
  assert.equal(current?.lastEventAt.toISOString(), '2026-03-01T02:00:00.000Z')
  assert.equal(current?.firstEventAt.toISOString(), '2026-03-01T00:00:00.000Z')
})

test('THE SECOND EVENT OF AN EPISODE IS INSIDE ITS OWN EPISODE', () => {
  // This is the defect a stamped span produces, stated as the thing that breaks.
  // Open an episode, add an event 30 hours later — beyond QUIET from the FIRST
  // event, within QUIET of the SECOND. With a watermark it joins. With a span
  // stamped at open it opens a third episode, and a backfill becomes a live attack.
  const opened = placeEvent(null, at('2026-03-01T00:00:00.000Z'), QUIET).span
  const second = placeEvent(opened, at('2026-03-01T20:00:00.000Z'), QUIET)
  assert.equal(second.joins, true)

  const third = placeEvent(second.span, at('2026-03-02T18:00:00.000Z'), QUIET)
  assert.equal(third.joins, true, 'the window must move with the latest event, not stay at the first')
  assert.equal(third.span.lastEventAt.toISOString(), '2026-03-02T18:00:00.000Z')

  // POSITIVE CONTROL: the watermark advancing is not the same as never closing.
  // An event beyond QUIET of the LATEST event still opens a new episode.
  const later = placeEvent(third.span, at('2026-03-05T00:00:00.000Z'), QUIET)
  assert.equal(later.joins, false, 'a genuine gap must still end the episode')
  assert.equal(later.span.firstEventAt.toISOString(), '2026-03-05T00:00:00.000Z')
})

test('a backfilled event earlier than the episode joins it, and the span grows backwards', () => {
  const opened = placeEvent(null, at('2026-03-02T00:00:00.000Z'), QUIET).span
  const backfill = placeEvent(opened, at('2026-03-01T12:00:00.000Z'), QUIET)
  assert.equal(backfill.joins, true, 'an event 12h before the episode belongs to it')
  assert.equal(backfill.span.firstEventAt.toISOString(), '2026-03-01T12:00:00.000Z')
  assert.equal(backfill.span.lastEventAt.toISOString(), '2026-03-02T00:00:00.000Z',
    'growing backwards must not move the watermark backwards')

  // POSITIVE CONTROL for the backward edge: far enough before, and it is a
  // separate episode. Otherwise "grows backwards" would mean "swallows history".
  const ancient = placeEvent(backfill.span, at('2026-02-20T00:00:00.000Z'), QUIET)
  assert.equal(ancient.joins, false)
})

test('EPISODES ARE THE SAME WHATEVER ORDER THE EVENTS ARRIVE IN', () => {
  // The rule EventInstant cannot enforce. Same events, three delivery orders.
  const times = [
    '2026-03-01T00:00:00.000Z',
    '2026-03-01T06:00:00.000Z',
    '2026-03-10T00:00:00.000Z',
    '2026-03-10T02:00:00.000Z',
  ]
  const chronological = episodesOf(times.map((iso) => at(iso)), QUIET)
  const reversed = episodesOf([...times].reverse().map((iso) => at(iso)), QUIET)
  const interleaved = episodesOf([times[2], times[0], times[3], times[1]].map((iso) => at(iso)), QUIET)

  assert.deepEqual(reversed, chronological)
  assert.deepEqual(interleaved, chronological)

  // And the grouping is the right one, not merely a stable wrong one.
  assert.deepEqual(chronological, [
    span('2026-03-01T00:00:00.000Z', '2026-03-01T06:00:00.000Z'),
    span('2026-03-10T00:00:00.000Z', '2026-03-10T02:00:00.000Z'),
  ])
})

test('arrival time cannot reach the decision', () => {
  // Same event times; wildly different receipt times, including a backfill that
  // arrived years later and a pair that arrived in the opposite order.
  const times = ['2026-03-01T00:00:00.000Z', '2026-03-01T06:00:00.000Z', '2026-04-01T00:00:00.000Z']
  const promptly = episodesOf(times.map((iso) => at(iso, iso)), QUIET)
  const chaotic = episodesOf([
    at(times[0], '2029-01-01T00:00:00.000Z'),
    at(times[1], '2026-03-01T06:00:01.000Z'),
    at(times[2], '2026-04-01T00:00:02.000Z'),
  ], QUIET)
  assert.deepEqual(chaotic, promptly)
})

test('the quiet interval is the thing that decides, and it decides both ways', () => {
  // Exactly at the interval joins; one millisecond past it does not. Stated
  // explicitly because an off-by-one here is a silently split or silently merged
  // incident, and neither is visible in production.
  const opened = placeEvent(null, at('2026-03-01T00:00:00.000Z'), QUIET).span
  assert.equal(placeEvent(opened, at('2026-03-02T00:00:00.000Z'), QUIET).joins, true)
  assert.equal(placeEvent(opened, at('2026-03-02T00:00:00.001Z'), QUIET).joins, false)

  // A different interval gives a different answer for the same events, so the
  // parameter is genuinely read rather than shadowed by a constant.
  assert.equal(placeEvent(opened, at('2026-03-02T00:00:00.001Z'), 48 * HOUR).joins, true)
})

test('no events is no episodes, and one event is one episode of zero width', () => {
  assert.deepEqual(episodesOf([], QUIET), [])
  assert.deepEqual(episodesOf([at('2026-03-01T00:00:00.000Z')], QUIET), [
    span('2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
  ])
})

test('a span is not aliased to a caller-held object', () => {
  // placeEvent returns new Dates rather than the ones it was given, so a caller
  // holding the previous span cannot have it mutated underneath them — and a
  // stored episode cannot be edited by whoever still holds the event's Date.
  const occurredAt = at('2026-03-01T00:00:00.000Z')
  const placement = placeEvent(null, occurredAt, QUIET)
  assert.notEqual(placement.span.firstEventAt, occurredAt)
  assert.equal(placement.span.firstEventAt.getTime(), occurredAt.getTime())
})
