import { coverageForEvaluation, type NormalizationBatch } from '../risky-users-normalization/index.js'
import type { CollectionScope, Coverage } from '../evaluation-core/contract.js'

/** The seam between the classifier and the evaluation core.
 *
 * Deliberately NOT inside `evaluation-core`. The core is generic over the event
 * type and knows nothing about Microsoft; importing the classifier there would
 * end that in one line. It is equally not inside the classifier, which should
 * not have to know what an evaluation is. It lives between them, and it is the
 * only file that has to change when either side moves.
 *
 * This mapping is the thing an integration branch exists to produce. Both
 * modules compiled together cleanly before this file existed — their files are
 * disjoint, so nothing forced them to agree. What forced it was writing down
 * the conversion, at which point the classifier's fourth bucket had nowhere to
 * land and the gap became a type error rather than a silent omission.
 */

export type CollectionScopeSource = Readonly<{ declared: boolean; asked: string }>

/** The classifier names its own collection scope; the core only distinguishes a
 * request it can name from one nobody recorded. Translating here keeps the
 * vocabulary on the classifier's side of the seam. */
export function collectionScopeOf(source: CollectionScopeSource): CollectionScope {
  return source.declared && source.asked.trim() !== ''
    ? { declared: true, asked: source.asked }
    : { declared: false }
}

/** Every bucket the classifier reports, mapped to the bucket the core reasons
 * about — and nothing dropped on the way.
 *
 * The core recomputes `uninterpretedEvents` from `unknown` and `unprocessable`
 * rather than accepting the classifier's total. Two sides carrying the same
 * number is two sides that can disagree, and the one that gates should be
 * derived from the parts it gates on. `assertAccountsForEveryRow` checks the
 * two agree, which is a real check precisely because they are computed apart.
 */
export function toEvaluationCoverage(
  batch: NormalizationBatch, scope: CollectionScopeSource,
): Coverage {
  const reported = coverageForEvaluation(batch)
  return {
    collectionScope: collectionScopeOf(scope),
    applies: reported.applies,
    doesNotApply: { ...reported.doesNotApply },
    notYetCited: { ...reported.notYetCited },
    unknown: { ...reported.unknown },
    unprocessable: { ...reported.unprocessable },
  }
}

const total = (counts: Readonly<Record<string, number>>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0)

/** Fails loudly if the mapping loses a row.
 *
 * A bucket added on the classifier's side that this file does not map would
 * otherwise vanish silently, and the coverage would keep looking complete while
 * describing fewer events than were classified. That is the same shape as a
 * detector narrowing its own input without saying so, one layer out — so it is
 * checked here rather than trusted, and the check compares two independently
 * computed totals rather than one value against itself.
 */
export function assertAccountsForEveryRow(batch: NormalizationBatch, coverage: Coverage): void {
  const reported = coverageForEvaluation(batch)
  const mapped = coverage.applies
    + total(coverage.doesNotApply) + total(coverage.notYetCited)
    + total(coverage.unknown) + total(coverage.unprocessable)
  const classified = reported.applies
    + total(reported.doesNotApply) + total(reported.notYetCited)
    + total(reported.unknown) + total(reported.unprocessable)
  if (mapped !== classified) {
    throw new Error(
      `Coverage mapping lost rows: classifier accounted for ${classified}, mapping carried ${mapped}. `
      + 'A bucket was added on the classifier side and is not mapped here.')
  }
  const coreGates = total(coverage.unknown) + total(coverage.unprocessable)
  if (coreGates !== reported.uninterpretedEvents) {
    throw new Error(
      `Gating total disagrees: core would gate on ${coreGates}, classifier reports `
      + `${reported.uninterpretedEvents}. The two must be the same events.`)
  }
}
