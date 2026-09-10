import type { EventOutcome, NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Detector } from '../evaluation-core/contract.js'

/** Whether a feed can supply every part of a rule's pattern.
 *
 * The question nobody was asking. A rule of the form "failures, then a
 * success" run against a feed that produces no successes cannot fire — and it
 * reports `considered: N, matched: 0`, which is indistinguishable from a
 * healthy detector that looked at everything and found nothing. Every piece of
 * accounting built into the core reads green, because the events forming the
 * other half of the pattern were never there to count.
 *
 * That is not a hypothetical: the audit feed had no source of successes at all,
 * so a credential-compromise rule was INERT rather than underperforming on
 * exactly the tenants without premium licensing — the customers this detection
 * exists for.
 *
 * The declaration lives here rather than on `Detector` deliberately. The core is
 * generic over the event type and holds no outcome vocabulary; putting required
 * outcomes on a detector would drag Microsoft's vocabulary into it. Wiring is
 * where a detector is pointed at a feed, so wiring is where the question can be
 * asked at all.
 */

export type FeedBoundDetector = Readonly<{
  detector: Detector<NormalizedEvent>
  /** The outcomes this rule's pattern needs to be ABLE to occur.
   *
   * Not what it expects to find — what its logic reads. A rule that looks for a
   * success following failures requires both, and on a feed that can never
   * express one of them the rule is not quiet, it is inert. */
  requires: readonly EventOutcome[]
}>

/** Outcomes a feed's vocabulary can actually reach. Supplied by the classifier,
 * which is the only layer that knows what each feed's codes and reason names
 * can resolve to. */
export type FeedCapability = Readonly<{ feed: string; reachable: ReadonlySet<EventOutcome> }>

export function unreachableRequirements(
  bound: FeedBoundDetector, capability: FeedCapability,
): readonly EventOutcome[] {
  return bound.requires.filter(outcome => !capability.reachable.has(outcome))
}

/** Replaces a rule its feed cannot support with one that says so.
 *
 * INAPPLICABLE rather than a new state, and that is the whole point: this is
 * the same fact as a detector that needs conditional-access data on a source
 * that carries none. It narrows the count's scope instead of gating the claim,
 * it names itself in the detector's own words, and a technician reading the
 * tenant sees "this check cannot run on this evidence" instead of a silence
 * they would read as reassurance.
 *
 * Deliberately NOT a filter. Dropping the detector would leave the tenant with
 * one fewer check and nothing saying so, which is the disappearance this
 * whole design exists to prevent.
 */
export function bindToFeed(
  bound: FeedBoundDetector, capability: FeedCapability,
): Detector<NormalizedEvent> {
  const missing = unreachableRequirements(bound, capability)
  if (missing.length === 0) return bound.detector
  return {
    id: bound.detector.id,
    monotonic: bound.detector.monotonic,
    run: () => ({
      status: 'INAPPLICABLE',
      because: `This check reads outcomes the ${capability.feed} feed cannot produce `
        + `(${[...missing].sort().join(', ')}), so it could never report a finding here.`,
    }),
  }
}
