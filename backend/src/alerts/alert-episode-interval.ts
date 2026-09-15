import type { AlertTypeDeclaration, EpisodeGrouping } from './alert-type.js'

/** How long an alert type must be quiet before its episode closes.
 *
 * TWO PATHS, AND WHICH ONE A TYPE TAKES IS DECIDED BY ITS RESOLVING CONDITION:
 *
 *   resolves on a quiet timeout      DERIVED from the declared window
 *   resolves on an observation       DECLARED explicitly, with its reasoning
 *
 * The first case is one concept stated once. "No further events in a readable
 * 24-hour window" already says how long quiet must last, and an episode closing on a
 * different number would mean the incident and the condition disagree about when it
 * stopped, with nothing forcing them back together.
 *
 * The second case is a DIFFERENT FACT, not a duplicate. `CONFIGURATION_RESTORED` is
 * an observation, so there is no timeout to derive from — and "how long a gap means
 * the next activity is a new burst" is a genuine question about the type that nothing
 * else answers. The rule against second constants applies to two numbers meaning the
 * same thing; these do not.
 *
 * THIS FUNCTION IS TOTAL, and deliberately has no failure case. An earlier version
 * threw when no window was declared, which was correct while the declaration could be
 * silent — six of the seven types had no interval at all, including both
 * directory-change types, which are exactly the 301-alert and 334-occurrence cases
 * this work exists to fix. Making the interval part of `EpisodeGrouping` moved the
 * guarantee from a runtime throw to the compiler: a type that declares neither path,
 * or both, does not compile. There is nothing left for a runtime check to catch that
 * a deliberate cast would not also defeat, and a guard reachable only by cast is a
 * guard whose test has to fabricate a shape the type forbids.
 */

const HOUR_MS = 60 * 60 * 1000

/** Takes the GROUPING PAIR rather than the whole declaration, for two reasons.
 *
 * It is the minimal dependency — nothing here needs a severity or a summary. And it
 * is what makes the two paths narrow: TypeScript will not carry a check on
 * `declaration.conditionClears.kind` across to `declaration.episodeInterval`,
 * because `AlertTypeDeclaration` is a union of intersections and the relationship
 * lives in only one of the intersected members. Narrowing the two-variant union
 * directly does work, and a declaration is assignable to it. The compiler refusing
 * the first version was correct: it could not see that a non-timeout condition
 * guarantees an interval, and nor could a reader. */
export function quietIntervalMsOf(grouping: EpisodeGrouping): number {
  // Narrowed on the INTERVAL'S PRESENCE rather than on the condition's kind, and the
  // compiler is what settled that. `conditionClears` cannot discriminate this union:
  // the observation variant's condition is itself a union of four kinds, so there is
  // no single literal at that path to narrow by, and a check on it leaves
  // `episodeInterval` possibly undefined. `episodeInterval` is present on exactly
  // one variant, so it discriminates cleanly.
  //
  // This is not a precedence rule. The union guarantees exactly one of the two is
  // available, so neither branch is a fallback for the other.
  if (grouping.episodeInterval !== undefined) {
    return grouping.episodeInterval.hours * HOUR_MS
  }
  return grouping.conditionClears.windowHours * HOUR_MS
}

/** Whether this type's interval came from its resolving condition or was stated on
 * its own. Not a validity check — both are valid. A reader deciding whether a number
 * is revisitable needs to know which kind it is, because a derived one moves only
 * when the resolving condition does. */
export function quietIntervalIsDerived(grouping: EpisodeGrouping): boolean {
  return grouping.episodeInterval === undefined
}
