import { FEED_CAPABILITIES, reachableOutcomes } from '../risky-users-normalization/index.js'
import type { EventOutcome, NormalizationSource, NormalizedEvent } from '../risky-users-normalization/contract.js'
import type { Detector } from '../evaluation-core/contract.js'

/** Whether a feed can supply every part of a rule's pattern.
 *
 * The question nobody was asking. A rule of the form "failures, then a
 * success" run against a feed that produces no successes cannot fire — and it
 * reports `assessed: N, matched: 0`, which is indistinguishable from a
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
  /** Outcomes the source mentions without reading — named in a comment, or in a
   * guard that excludes them. Per detector on purpose: a shared allowlist lets
   * one explanation cover a mention elsewhere, so a new unexplained mention
   * stops failing. */
  mentionsNotRead?: readonly EventOutcome[]
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

/** The capability of a real feed, from the classifier's own table.
 *
 * CALLS the classifier rather than deriving from its mapping tables, and that
 * is load-bearing rather than stylistic. Engineer 3's warning: deriving the
 * audit set from the reason-name table yields a feed with NO successes, because
 * audit successes come from `Operation` where no logon error exists at all —
 * which would declare every failures-then-success rule inapplicable on the
 * audit feed. That is the original inert-detector bug re-created by the
 * machinery built to detect it, and worse, because it would be stated
 * confidently rather than passing in silence.
 *
 * Uses REACHABLE rather than OBSERVED deliberately. A quiet window is not an
 * incapable feed: an outcome that is mapped but has not occurred yet means the
 * tenant had a good month, and marking a rule inapplicable for that would be a
 * worse lie than the silence this mechanism exists to remove.
 */
export function capabilityOf(source: NormalizationSource): FeedCapability {
  return { feed: source, reachable: reachableOutcomes(source) }
}

/** Every outcome the classifier's own capability table mentions.
 *
 * Derived from their table rather than re-listed here, because a second copy of
 * a closed vocabulary is a second thing to keep in step — the objection
 * Engineer 3 raised against my `kind` proposal, applied to my own code. */
const ALL_OUTCOMES: readonly EventOutcome[] =
  [...new Set(FEED_CAPABILITIES.flatMap(entry => Object.keys(entry.outcomes) as EventOutcome[]))]

export type DeclarationGaps = Readonly<{
  /** Mentioned in the rule's source and not declared. The dangerous direction:
   * the rule reads an outcome nobody said it needed, so it never goes
   * INAPPLICABLE and quietly runs on a feed that cannot feed it. */
  readNotDeclared: readonly EventOutcome[]
  /** Declared and not mentioned. The overreach direction: a rule marked
   * inapplicable on feeds that could have run it. */
  declaredNotRead: readonly EventOutcome[]
}>

/** Checks a `requires` declaration against the rule's own source.
 *
 * `requires` was an author's assertion checkable only by reading the rule —
 * the same position `monotonic` was in before QA's harness. This is Engineer
 * 3's trick from their shape registry, one level up: diff what was declared
 * against the outcome literals the function actually mentions.
 *
 * WEAKER THAN A BEHAVIOURAL HARNESS, and worth saying so rather than letting it
 * look like proof. It sees literals in the compiled source, so it cannot follow
 * an outcome reached through a variable, a lookup table, or another module —
 * those are false negatives. And a mention inside a comment or inside a guard
 * that EXCLUDES an outcome reads as a use, which is a false positive.
 *
 * `mentionsNotRead` exists for that second case and is deliberately per
 * detector rather than a shared allowlist. Engineer 3's version cost them a
 * false pass until they keyed explanations per subject: a global list lets one
 * explanation cover a mention somewhere else, so a NEW unexplained mention
 * stops failing. That decays within a week.
 */
export function outcomeDeclarationGaps(bound: FeedBoundDetector): DeclarationGaps {
  const source = bound.detector.run.toString()
  const mentioned = ALL_OUTCOMES.filter(outcome => source.includes(outcome))
  const declared = new Set(bound.requires)
  const explained = new Set(bound.mentionsNotRead ?? [])
  return {
    readNotDeclared: mentioned.filter(outcome => !declared.has(outcome) && !explained.has(outcome)),
    declaredNotRead: bound.requires.filter(outcome => !source.includes(outcome)),
  }
}
