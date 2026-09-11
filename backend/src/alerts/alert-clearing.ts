import type { CollectorSyncStatus } from '../tenants/service-sync-freshness.js'
import { evidenceFromSync } from '../risky-users-wiring/evidence-availability.js'
import type { ConditionClearedWhen } from './alert-type.js'

/** Whether a declared resolving condition is SATISFIED by a concrete state.
 *
 * WHY THIS EXISTS. `alert-catalog.test.ts` proved every type STATES a resolving
 * condition and proved nothing about whether the state it names can ever occur.
 * `assert.ok(condition.kind)` is satisfied by every non-empty string, including
 * one naming something the system can never be in — an existence assertion on a
 * field whose CONTENT is the point is a spelling test, not a check.
 *
 * That matters in one direction especially. A condition too strong to satisfy
 * produces an alert that never auto-clears, and this whole feature exists because
 * 353 alerts never cleared. The strictness was the right call; the unchecked half
 * of it was a phone-tier page that could never close.
 *
 * THIS IS A WITNESS, NOT THE WIRING. It reads the declarations so a control can
 * exhibit a satisfying state per type. It is not called by `applyObservation` and
 * does not decide anything at runtime — connecting the declaration to the
 * lifecycle is step 02's, and this is the function it should use rather than
 * inventing a second interpretation of the same vocabulary.
 */

export interface SourceState {
  readonly source: string
  readonly status: CollectorSyncStatus
}

/** WHAT "COVERED" MEANS: the sources HawkView expects to be readable for THIS
 * tenant, given its licensing and its consent.
 *
 * The word was carrying the entire weight of `EVERY_COVERED_SOURCE_READABLE` while
 * existing only inside a `because` string, and the plausible invention — every
 * collector configured for the tenant — is precisely the one that produces a page
 * nobody can close. Production has 147 collectors with 10 failed and 7 stale
 * beyond a week, so that tenant exists today.
 *
 * Not covered, and each for its own reason:
 *
 *   NOT_LICENSED        The tenant does not have the product. Nothing to see and
 *                       nothing to fix.
 *   PERMISSION_REQUIRED A consent gap. It is its own alert with its own action and
 *                       is fixable in minutes by someone who knows. Folding it in
 *                       here converts a fixable permission problem into a
 *                       permanently-open blindness page.
 *   UNSUPPORTED         Microsoft does not expose it. A capability statement about
 *                       Microsoft rather than about this tenant, so it is the same
 *                       class as NOT_LICENSED — and being global rather than
 *                       per-tenant, leaving it covered would have made the
 *                       condition unsatisfiable for EVERY tenant, not merely some.
 *   NOT_CONFIGURED      HawkView has never been set up to collect it, and covered
 *                       means the sources HawkView EXPECTS to be readable. It does
 *                       not expect one it was never configured for.
 *
 * I argued for keeping NOT_CONFIGURED covered, on the grounds that excluding it
 * would let a tenant with nothing configured report full visibility. That reason
 * was answered by the empty-covered guard below: if nothing is configured, covered
 * is empty and the condition is false already. So the case was protected twice,
 * and the second guard cost what the first does not — a tenant with nine sources
 * working and one never configured would have had a phone-tier page that could
 * never close, because a never-configured source does not become readable without
 * somebody configuring it. That is the 353 problem reached through the fix for it.
 *
 * Confirmed from the code rather than assumed: `collectorStatus` returns
 * NOT_CONFIGURED only when no sync-state row exists at all. A collector that was
 * working and stops has a row, so it becomes FAILED, PERMISSION_REQUIRED or STALE.
 * NOT_CONFIGURED is therefore a steady-state fact about setup and never a symptom
 * of a disconnection, so it has no business gating a disconnection alert's closure.
 *
 * THREE SIBLINGS, AND ONLY THE FIRST IS A PAGE:
 *   cannot see                  an emergency
 *   was never allowed to see    a task  (consent)
 *   was never set up to see     a task  (configuration)
 *
 * Everything else is covered.
 *
 * THE CONDITION ON THE NOT_CONFIGURED EXCLUSION. It does mean this alert can report
 * visibility restored while HawkView collects a fraction of what is available. That
 * is a real overstatement and a different claim needing a different alert —
 * "collecting three of ten available sources for this tenant" is worth telling an
 * MSP and has its own action. The exclusion is conditional on that coverage gap
 * being visible somewhere rather than silently dropped, which is step 05's work and
 * the plan's own requirement that coverage gaps are shown rather than silent. Noted
 * in the handoff section; not built here. */
const NOT_COVERED: ReadonlySet<CollectorSyncStatus> = new Set([
  'NOT_LICENSED',
  'PERMISSION_REQUIRED',
  'UNSUPPORTED',
  'NOT_CONFIGURED',
])

export function coveredSources(sources: readonly SourceState[]): readonly SourceState[] {
  return sources.filter((source) => !NOT_COVERED.has(source.status))
}

/** Every covered source readable — with the degenerate case refused.
 *
 * THE VACUOUS TRUTH THIS WOULD OTHERWISE HAVE. `every` over an empty list is
 * true, so a tenant whose every source is unlicensed or permission-blocked would
 * satisfy "every covered source is readable" while HawkView could see nothing at
 * all, and a page claiming visibility restored would close on a tenant it cannot
 * see. At least one covered source has to exist for the claim to mean anything. */
export function everyCoveredSourceReadable(sources: readonly SourceState[]): boolean {
  const covered = coveredSources(sources)
  if (covered.length === 0) return false
  // `evidenceFromSync` rather than a second list of acceptable statuses, so
  // "readable" means here exactly what it means to the evidence engine.
  return covered.every((source) => evidenceFromSync(source.status).read)
}

/** A concrete state a resolving condition can be evaluated against. Deliberately
 * small: it carries what the declared kinds actually ask about and nothing else,
 * so it does not pre-empt step 02's shape. */
export interface ClearingObservation {
  readonly sources: readonly SourceState[]
  readonly connectionVerified: boolean
  readonly configurationRestored: boolean
  /** Events seen inside the declared window. */
  readonly eventsInWindow: number
  /** Whether the window was readable THROUGHOUT. A quiet window HawkView could
   * not see is not quiet, it is unobserved — so this is separate from the count
   * rather than folded into it. */
  readonly windowReadableThroughout: boolean
}

export function conditionSatisfied(
  condition: ConditionClearedWhen,
  observation: ClearingObservation,
): boolean {
  switch (condition.kind) {
    case 'COLLECTOR_REPORTS_SUCCESS':
      // Any one collector succeeding. Correct for an alert about one collector;
      // it is the wrong condition for an alert about seeing a whole tenant, which
      // is why EVERY_COVERED_SOURCE_READABLE exists separately.
      return observation.sources.some((source) => evidenceFromSync(source.status).read)

    case 'EVERY_COVERED_SOURCE_READABLE':
      return everyCoveredSourceReadable(observation.sources)

    case 'CONNECTION_VERIFIED':
      return observation.connectionVerified

    case 'CONFIGURATION_RESTORED':
      return observation.configurationRestored

    case 'NO_FURTHER_EVENTS_IN_READABLE_WINDOW':
      // Both halves, and the second is the one that matters: silence across a
      // window nobody could see is not evidence the condition stopped.
      return observation.eventsInWindow === 0 && observation.windowReadableThroughout
  }
}
