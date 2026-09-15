import { type EventInstant } from './alert-event-time.js'

/** The episode boundary — what stops grouping becoming its own bug.
 *
 * Without it, an attack next month silently joins last month's closed incident and
 * nobody is told. An episode opens when the condition appears after a quiet
 * interval and closes when the incident does.
 *
 * THE SPAN IS A WATERMARK THAT ADVANCES WITH EVERY EVENT, never a value stamped
 * when the episode opens. The stamped reading is the easier one to build and its
 * consequence appears only on the SECOND event, which falls outside its own
 * episode's span — so a backfill landing between the first and the second reads
 * as new, a live attack manufactured from a late delivery. That is the exact
 * defect the no-arrival-time rule exists to prevent, which is why this arrived
 * from QA as a binding rule rather than a suggestion.
 *
 * TIMES ARE `EventInstant`, so arrival time cannot reach this decision. That brand
 * is only half the protection: it stops an implementation reading the wrong
 * timestamp and does nothing about one treating most-recently-delivered as newest.
 * Nothing here consults order of any kind — an event is placed by comparing its own
 * time to the span, so feeding the same events in any order gives the same
 * episodes, and a test asserts it.
 */

export interface EpisodeSpan {
  /** The earliest event's own time. Grows EARLIER when an out-of-order event
   * belongs to this episode — see `placeEvent`. */
  readonly firstEventAt: Date
  /** The latest event's own time. The watermark. */
  readonly lastEventAt: Date
}

export interface Placement {
  /** False when this event opens a NEW episode rather than joining the given one. */
  readonly joins: boolean
  /** The span after placing the event: the existing one grown, or a fresh one. */
  readonly span: EpisodeSpan
}

/** Places one event against the episode currently open for its subject.
 *
 * `span` is null when no episode is open, which opens one.
 *
 * THE SPAN GROWS IN BOTH DIRECTIONS, and that is a decision rather than an
 * inevitability. The watermark rule names the forward edge; an out-of-order event
 * whose own time precedes `firstEventAt` is the other one. Treating the two edges
 * differently would mean a backfilled event that clearly belongs to an episode
 * opened a second one beside it, which is the same manufactured-episode failure
 * arriving from the other side. So an event joins when its own time is within
 * `quietMs` of the span on EITHER side, and the span stretches to contain it.
 *
 * `quietMs` is a parameter rather than a constant here, and it stays one: the
 * interval is DERIVED from the alert type’s declared resolving condition by
 * `quietIntervalMsOf` in `alert-episode-interval.ts`, so there is no second notion
 * of quiet beside the one each type already declares. This function is handed the
 * number and does not choose it.
 *
 * `quietIntervalMsOf` is TOTAL: a type resolving on a quiet timeout derives its
 * interval from the window, and one resolving on an observation declares it. Which
 * path a type takes is a compile error to get wrong, so there is no "no interval"
 * case left for this function to be handed. */
export function placeEvent(
  span: EpisodeSpan | null,
  occurredAt: EventInstant,
  quietMs: number,
): Placement {
  const at = occurredAt.getTime()
  if (span === null) {
    return { joins: false, span: { firstEventAt: new Date(at), lastEventAt: new Date(at) } }
  }

  const quietBefore = span.firstEventAt.getTime() - quietMs
  const quietAfter = span.lastEventAt.getTime() + quietMs
  if (at < quietBefore || at > quietAfter) {
    return { joins: false, span: { firstEventAt: new Date(at), lastEventAt: new Date(at) } }
  }

  return {
    joins: true,
    span: {
      // Both edges move. `lastEventAt` is the watermark the plan names;
      // `firstEventAt` is its mirror, and leaving it fixed is what would make a
      // backfill open a second episode beside the one it belongs to.
      firstEventAt: new Date(Math.min(span.firstEventAt.getTime(), at)),
      lastEventAt: new Date(Math.max(span.lastEventAt.getTime(), at)),
    },
  }
}

/** Groups a batch of events into episodes by their own times.
 *
 * Sorts by event time first, which is what makes the result independent of
 * delivery: a batch containing a backfill and a live event gives the same episodes
 * whichever arrived first. Sorting is by `occurredAt` only — there is no arrival
 * time in the input to sort by even by accident. */
export function episodesOf(
  occurredAts: readonly EventInstant[],
  quietMs: number,
): readonly EpisodeSpan[] {
  const ordered = [...occurredAts].sort((left, right) => left.getTime() - right.getTime())
  const episodes: EpisodeSpan[] = []
  let current: EpisodeSpan | null = null

  for (const occurredAt of ordered) {
    const placement = placeEvent(current, occurredAt, quietMs)
    if (placement.joins && current !== null) {
      episodes[episodes.length - 1] = placement.span
    } else {
      episodes.push(placement.span)
    }
    current = placement.span
  }
  return episodes
}
