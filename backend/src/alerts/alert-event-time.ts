/** When something happened, as distinct from when HawkView heard about it.
 *
 * EPISODE AND URGENCY ARE DECIDED BY THE EVENT'S OWN TIME, NEVER BY ARRIVAL.
 * Microsoft's audit feed arrives late and out of order — one collector is
 * currently four hundred hours behind — so a backfill that lands at once would
 * otherwise read as an attack happening now, and would page somebody about
 * something that finished two weeks ago.
 *
 * THE RULE IS ENFORCED BY THE TYPE, NOT BY CONVENTION. An earlier version of
 * this file took `occurredAt: Date` and relied on callers passing the right one —
 * but `receivedAt` is also a `Date`, so the wrong one typechecked. That is
 * arrival time being present-and-ignored, which is exactly the arrangement that
 * decays: the next person sees two Dates and picks whichever is in scope.
 *
 * `urgencyOf` now takes an `EventInstant`, which only `eventInstant()` produces
 * and which only reads `occurredAt`. `urgencyOf(time.receivedAt, now)` does not
 * compile. A deliberate cast can still defeat it — nothing in TypeScript survives
 * a determined `as` — but it cannot happen by reaching for the nearer variable,
 * which is how it would actually happen.
 *
 * Arrival time is still recorded, because it is genuinely useful: collector lag,
 * and telling a reader that a burst arrived together. The constraint is on the
 * DECISION PATH, not on the system.
 */

declare const EVENT_INSTANT: unique symbol

/** An instant that came from an event's own clock. Constructible only through
 * `eventInstant`, so nothing else can reach the urgency decision. */
export type EventInstant = Date & { readonly [EVENT_INSTANT]: true }

export function eventInstant(time: AlertEventTime): EventInstant {
  return time.occurredAt as EventInstant
}

export interface AlertEventTime {
  /** When the event happened, according to the source that recorded it. */
  readonly occurredAt: Date
  /** When HawkView received it. For diagnostics and for measuring collector lag
   * — never for urgency, and never for episode boundaries. */
  readonly receivedAt: Date
}

export type EventUrgency =
  /** Happening now, as far as the event's own clock is concerned. */
  | 'LIVE'
  /** Recent enough to still be worth acting on today. */
  | 'RECENT'
  /** Old. Worth recording and worth reading in context; not worth waking
   * somebody for, however recently it arrived. */
  | 'HISTORICAL'

export const LIVE_WITHIN_MS = 60 * 60 * 1000
export const RECENT_WITHIN_MS = 24 * 60 * 60 * 1000

/** Urgency from the event's own time. Cannot be handed an arrival time. */
export function urgencyOf(occurredAt: EventInstant, now: Date): EventUrgency {
  const age = now.getTime() - occurredAt.getTime()
  // An event stamped in the future is a clock problem, not an emergency. Treated
  // as LIVE rather than HISTORICAL because a skewed source reporting a real
  // attack should still be heard, and the skew is visible in collectorLag.
  if (age <= LIVE_WITHIN_MS) return 'LIVE'
  if (age <= RECENT_WITHIN_MS) return 'RECENT'
  return 'HISTORICAL'
}

/** How far behind the collector was for this event. A number, not a verdict. */
export function collectorLagMs(time: AlertEventTime): number {
  return time.receivedAt.getTime() - time.occurredAt.getTime()
}

/** Whether this arrived as part of a backfill rather than as live traffic.
 *
 * Useful for explaining a burst of incidents to a reader — "these arrived at
 * once because the collector caught up" — and for step 03's migration, which
 * must not deliver historical alerts. It is NOT an input to urgency: a genuinely
 * live event from a lagging collector is still live. */
export function arrivedLate(time: AlertEventTime, thresholdMs = RECENT_WITHIN_MS): boolean {
  return collectorLagMs(time) > thresholdMs
}
