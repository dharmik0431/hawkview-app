/** Whether a window was READABLE THROUGHOUT — the second half of the clearing rule.
 *
 * `conditionSatisfied` asks for this and nothing produces it. QA's warning, and it is
 * exact: when step 03 comes to wire it, THE CHEAPEST WAY TO MAKE AN ALERT CLEAR IS TO
 * PASS `true`, AND EVERY TEST STILL PASSES BECAUSE THE TESTS INJECT IT TOO. The
 * instrument sits below the level where the value is chosen.
 *
 * SO THERE IS NO BOOLEAN TO PASS. This module takes EVIDENCE and derives the answer,
 * and the only evidence that can yield `true` is a per-attempt collection history. A
 * caller who does not have that history cannot assert coverage — not because a rule
 * forbids it, but because the type has nowhere to put the assertion.
 *
 * WHAT THE DATABASE CAN ACTUALLY SUPPORT TODAY, which is the finding that matters more
 * than this module:
 *
 * `SyncState` is one row per (tenant, resourceType) — `@@unique([customerTenantId,
 * resourceType])` — carrying `status`, `lastAttemptAt`, `lastSuccessfulAt` and
 * `consecutiveFailures`. It is CURRENT STATE, NOT HISTORY. A failure inside the window
 * followed by a recovery leaves no trace at all: the counter resets on success and both
 * timestamps only ever hold the latest value. Continuity across a window is not
 * recoverable from it, at any cadence, by any query.
 *
 * `TenantHealthSnapshot` does keep history, and it is worse for this purpose rather than
 * better. Its producer is `tenants.service.ts` inside `listForIdentity` — the tenant-LIST
 * REQUEST PATH — and it skips the write when the status and freshness signature are
 * unchanged and under fifteen minutes old. Its own comment says "without producing a row
 * on every tenant-list poll". So row density is a function of WHO OPENED THE TENANTS PAGE,
 * not of whether collection worked, and a tenant nobody looked at for a week has no rows
 * for that week.
 *
 * That fails in the UNSAFE direction. Deriving coverage from "no failure rows in the
 * window" would mark an unvisited tenant as readable throughout, so a collector could be
 * dead for a month and the window would still read as covered — which is the exact
 * sentence `windowReadableThroughout` exists to prevent.
 *
 * CONSEQUENCE, AND IT IS NARROWER THAN IT SOUNDS. Today the only constructible evidence
 * is `NO_HISTORY_AVAILABLE`, so this returns false and a
 * `NO_FURTHER_EVENTS_IN_READABLE_WINDOW` condition never auto-clears. Exactly one
 * declared type resolves that way — `security.suspected_credential_attack` — and its
 * investigation is `ONLY_BY_A_PERSON` regardless, so what is lost is the CONDITION axis
 * moving to cleared, not an incident staying in somebody's queue. Safe, and visible.
 *
 * The real repair is a collection-attempt history, which is a schema decision rather than
 * an engineering one.
 */

/** One collection attempt, as a durable record rather than a current-state field. */
export interface CollectionAttempt {
  readonly at: Date
  readonly succeeded: boolean
}

/** What a caller can actually offer about a window.
 *
 * TWO VARIANTS AND ONLY ONE CAN YIELD TRUE. `NO_HISTORY_AVAILABLE` carries a reason
 * rather than a boolean, so "we do not know" is a statement about evidence and can never
 * be quietly upgraded to a claim. There is deliberately no variant meaning "trust me". */
export type WindowCoverage =
  | Readonly<{
      kind: 'ATTEMPT_HISTORY'
      /** Every attempt recorded for the sources this alert covers, in any order. */
      attempts: readonly CollectionAttempt[]
    }>
  | Readonly<{
      kind: 'NO_HISTORY_AVAILABLE'
      /** Why coverage cannot be established. Carried so the unanswerable set can be
       * measured and shrunk rather than quietly accumulating. */
      because: string
    }>

export interface Window {
  readonly from: Date
  readonly to: Date
}

/** Whether every part of the window is covered by a successful collection.
 *
 * `maxGapMs` is how long an uncovered stretch may be before the window stops counting as
 * readable. It is a PARAMETER rather than a constant here: what the tolerance should be
 * follows from the collection cadence, which is a product fact and not this function's to
 * choose. The scheduler's incremental pass is roughly five minutes today, so a tolerance
 * under that would make every window unreadable and one far above it would let a real
 * outage pass — but the number is a decision.
 *
 * A FAILED ATTEMPT IS NOT A GAP, IT IS A HOLE. Both are uncovered, and they are kept
 * separate in the reasoning because a failure is evidence we looked and could not see,
 * while a gap is evidence we did not look. Neither counts as readable; only the sentence
 * a reader gets differs, and this function returns a boolean, so it says nothing. Use
 * `describeCoverage` where the distinction has to reach a person. */
export function windowReadableThroughout(
  coverage: WindowCoverage,
  window: Window,
  maxGapMs: number,
): boolean {
  if (coverage.kind === 'NO_HISTORY_AVAILABLE') return false
  if (window.to.getTime() <= window.from.getTime()) return false

  // THE WINDOW FILTER IS A BOUND ON WORK, NOT A CORRECTNESS GUARD, and that is stated
  // because I first wrote a test implying otherwise. A mutation removing it survived, so I
  // searched instead of reasoning: 400,000 random attempt sets plus every triple drawn from
  // the boundary offsets, and the answer never differs. The walk below already requires
  // coverage ACROSS the window, so a distant success cannot substitute for one inside it —
  // an earlier success only makes the next gap check stricter, and a later one only extends
  // the cursor past an edge the final check had already cleared.
  //
  // Kept because a caller holding months of attempt history should not pay to sort it, and
  // because it makes the intent obvious. Do not rely on it for correctness: removing it
  // changes no answer today, and if the walk ever changes that may stop being true.
  const successes = coverage.attempts
    .filter((attempt) => attempt.succeeded)
    .map((attempt) => attempt.at.getTime())
    .filter((at) => at >= window.from.getTime() - maxGapMs && at <= window.to.getTime())
    .sort((left, right) => left - right)

  if (successes.length === 0) return false

  // Walk the window, requiring a success at least every maxGapMs. The leading edge
  // matters as much as the interior: a window whose first success lands halfway through
  // was unobserved for the first half, and an alert clearing on that would be clearing on
  // silence nobody could hear.
  let covered = window.from.getTime() - maxGapMs
  for (const at of successes) {
    if (at - covered > maxGapMs) return false
    covered = at
  }
  return window.to.getTime() - covered <= maxGapMs
}

/** The same answer, with what is missing named, for a reader rather than a branch. */
export function describeCoverage(
  coverage: WindowCoverage,
  window: Window,
  maxGapMs: number,
): string {
  if (coverage.kind === 'NO_HISTORY_AVAILABLE') {
    return `Coverage across this window cannot be established: ${coverage.because} ` +
      'A window HawkView could not confirm it was watching is not a quiet window.'
  }
  const failures = coverage.attempts.filter((attempt) => !attempt.succeeded).length
  return windowReadableThroughout(coverage, window, maxGapMs)
    ? `Collection succeeded across the whole window with no gap longer than ${maxGapMs}ms` +
      (failures > 0 ? `, despite ${failures} failed attempt(s) that recovered inside the tolerance.` : '.')
    : `Collection did not cover the whole window${failures > 0 ? ` (${failures} failed attempt(s))` : ''}, ` +
      'so silence across it is not evidence the condition stopped.'
}

/** What a caller can actually offer about the EVENTS in a window.
 *
 * THERE IS NO NUMBER TO PASS, for the same reason there was no boolean. `eventsInWindow`
 * was a bare `number` on the observation, and the cheapest way to clear an alert was to
 * pass `0` — which is exactly what a caller who never ran the query would pass. Zero
 * events found and zero events looked for are the same value and opposite facts.
 *
 * `NOT_COUNTED` carries a reason rather than a count, so "we did not look" is a statement
 * about evidence and cannot be arithmetic on. */
export type EventTally =
  | Readonly<{
      kind: 'COUNTED'
      /** When each event happened, for the sources this alert covers. Times rather than a
       * total, so whether an event falls inside the window is decided HERE against the
       * window the coverage is also measured over — not by the caller against some other
       * window. */
      at: readonly Date[]
    }>
  | Readonly<{
      kind: 'NOT_COUNTED'
      because: string
    }>

/** The two halves of `NO_FURTHER_EVENTS_IN_READABLE_WINDOW`, over ONE window.
 *
 * THE WINDOW IS CARRIED ONCE, AND THAT IS THE POINT. They were two independent fields on
 * the observation — a count and a boolean — so nothing tied them to the same period. A
 * caller could count events over the last hour and establish coverage over the last month
 * and the condition would read as satisfied: quiet recently, watched for ages, and the
 * event three weeks ago that the alert is about invisible to both halves. Neither field
 * was wrong on its own, which is why no test of either one could catch it. */
export interface QuietWindow {
  readonly window: Window
  readonly events: EventTally
  readonly coverage: WindowCoverage
  /** How long an uncovered stretch may be. See `windowReadableThroughout`. */
  readonly maxGapMs: number
}

/** Whether the window was quiet AND watched. Both, over the same window, or false.
 *
 * The boundary is INCLUSIVE at both ends: an event landing exactly on `from` or `to` is
 * inside the window and keeps the alert open. Deliberately the conservative direction —
 * the cost of counting a boundary event as inside is that an alert clears one cycle later,
 * and the cost of the other choice is an alert closing on the event it was raised for. */
export function windowWentQuiet(evidence: QuietWindow): boolean {
  // "We did not count" is not "we counted none". Checked before coverage so that a caller
  // holding perfect attempt history and no event query still cannot clear anything.
  if (evidence.events.kind === 'NOT_COUNTED') return false
  if (!windowReadableThroughout(evidence.coverage, evidence.window, evidence.maxGapMs)) {
    return false
  }
  const from = evidence.window.from.getTime()
  const to = evidence.window.to.getTime()
  return !evidence.events.at.some((at) => at.getTime() >= from && at.getTime() <= to)
}

/** The same answer with the reason named, for a person rather than a branch. */
export function describeQuietWindow(evidence: QuietWindow): string {
  if (evidence.events.kind === 'NOT_COUNTED') {
    return `Whether further events occurred is not established: ${evidence.events.because} ` +
      'An uncounted window is not a quiet one.'
  }
  const from = evidence.window.from.getTime()
  const to = evidence.window.to.getTime()
  const inside = evidence.events.at
    .filter((at) => at.getTime() >= from && at.getTime() <= to).length
  if (inside > 0) {
    return `${inside} further event(s) occurred inside the window, so the condition has not stopped.`
  }
  // No events inside, so the whole answer now rests on whether anyone was watching — which
  // is the half that gets forgotten, so it is the half this sentence leads with.
  return `No further events, and ` +
    describeCoverage(evidence.coverage, evidence.window, evidence.maxGapMs)
      .replace(/^Collection/, 'collection')
      .replace(/^Coverage/, 'coverage')
}
