// HawkView QA — turns `Detector.monotonic` from a declaration into a checked
// property. Generic over Event, so it needs no domain knowledge and works for
// every detector, present and future.
//
// Monotonic means: adding events never removes a finding. An absence-keyed rule
// is not monotonic, and declaring it so is the dangerous direction — truncation
// then FABRICATES a finding rather than losing one.
import type { Detector, DetectorFinding } from './contract.js'

/** Identity must be STABLE under adding events, or the harness reports growth
 * as loss.
 *
 * This used to include `observedAt`, which the per-signal contract removed. Its
 * replacement is not `max(signals.latest)`: that value MOVES as events are
 * added, so keying on it would make every monotonic detector look broken the
 * moment a newer event arrived. A finding is identified by whom it is about. */
const identity = (finding: DetectorFinding): string =>
  `${finding.detectorId}|${finding.subject.kind}|${
    finding.subject.kind === 'DIRECTORY_USER' ? finding.subject.userRef : finding.subject.mailboxRef
  }`

/** Dropping `observedAt` from the identity removes a distinction, and a harness
 * that draws fewer distinctions catches fewer faults. This puts the strength
 * back where it now belongs: a finding may gain signals as events arrive, but
 * losing one is a basis disappearing under a claim that survived — which the
 * identity check alone cannot see, because the finding is still there. */
const signalNames = (finding: DetectorFinding): readonly string[] => finding.signals.map(s => s.signal)

/** Deterministic so a failure is reproducible from its seed alone. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

/** Three ways a finding can vanish, kept apart because they mean different things.
 *
 * LOST_WHILE_RAN is unambiguous: the larger run answered and dropped a finding
 * the smaller run made. That is non-monotonicity.
 *
 * SIGNAL_LOST_WHILE_RAN is the same fault one level in: the finding survived
 * but a signal it rested on did not. The count is unchanged, so nothing above
 * this notices, and the finding now cites a narrower basis than the smaller
 * window did.
 *
 * LOST_TO_DECLINE is a judgement call: the larger run returned INAPPLICABLE, so
 * the finding is gone but the detector never claimed to have looked. Some
 * declines are correct by construction — a detector that refuses a truncated
 * window, for instance. Merging the two would let a correct decline read as a
 * monotonicity violation, which is the same collapse this project keeps
 * removing, so the caller is told which it is rather than being handed a verdict. */
export type MonotonicityResult =
  | Readonly<{ held: true; trials: number; findingsSeen: number; declines: number }>
  | Readonly<{
      held: false
      kind: 'LOST_WHILE_RAN' | 'SIGNAL_LOST_WHILE_RAN' | 'LOST_TO_DECLINE'
      seed: number; trial: number; lost: readonly string[]
      subsetSize: number; supersetSize: number
    }>

/** Runs the detector over random nested pairs S subset of S', asserting every
 * finding from S survives in S'. A run that produces no findings at all proves
 * nothing, so `findingsSeen` is reported for the caller to insist on. */
export function checkMonotonic<Event>(
  detector: Detector<Event>,
  pool: readonly Event[],
  options: Readonly<{ trials?: number; seed?: number; declineIsViolation?: boolean }> = {},
): MonotonicityResult {
  const trials = options.trials ?? 200
  const seed = options.seed ?? 1
  // Default true: a finding that disappears is a finding that disappeared. Set
  // false for a detector whose declines are correct by construction.
  const declineIsViolation = options.declineIsViolation ?? true
  const random = rng(seed)
  let findingsSeen = 0
  let declines = 0

  for (let trial = 0; trial < trials; trial++) {
    // Build S subset of S' subset of pool: every member of S is in S'.
    const superset: Event[] = []
    const subset: Event[] = []
    for (const event of pool) {
      if (random() < 0.7) {
        superset.push(event)
        if (random() < 0.6) subset.push(event)
      }
    }
    if (subset.length === 0) continue

    const small = detector.run(subset)
    // An INAPPLICABLE smaller run has no findings to lose.
    if (small.status !== 'RAN' || small.findings.length === 0) continue
    findingsSeen += small.findings.length

    const large = detector.run(superset)
    if (large.status !== 'RAN') {
      declines++
      if (!declineIsViolation) continue
      return { held: false, kind: 'LOST_TO_DECLINE', seed, trial,
        lost: small.findings.map(identity), subsetSize: subset.length, supersetSize: superset.length }
    }

    const survived = new Map(large.findings.map(f => [identity(f), signalNames(f)] as const))
    const lost = small.findings.map(identity).filter(k => !survived.has(k))
    if (lost.length > 0) {
      return { held: false, kind: 'LOST_WHILE_RAN', seed, trial, lost,
        subsetSize: subset.length, supersetSize: superset.length }
    }

    const signalsLost = small.findings.flatMap(f => {
      const after = survived.get(identity(f)) ?? []
      return signalNames(f).filter(s => !after.includes(s)).map(s => `${identity(f)}|${s}`)
    })
    if (signalsLost.length > 0) {
      return { held: false, kind: 'SIGNAL_LOST_WHILE_RAN', seed, trial, lost: signalsLost,
        subsetSize: subset.length, supersetSize: superset.length }
    }
  }
  return { held: true, trials, findingsSeen, declines }
}
