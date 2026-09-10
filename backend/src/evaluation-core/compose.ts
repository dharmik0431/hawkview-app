import { countOf, distinctUsers } from './evaluate.js'
import type { Assessment, Count, CountScope, FindingSet, WithheldReason } from './contract.js'

/** Composing several evidence streams into one tenant answer.
 *
 * Sign-ins and mailbox artefacts are different evidence with different
 * coverage — a mailbox we could not read is not a sign-in we could not
 * interpret — so each stream is assessed separately and joined here. This is
 * what the previous engine got wrong: it held one boolean for everything, so
 * every unrelated fact that could set it ended up wearing a single reason code.
 *
 * Nothing here is a second policy. Composition is the failed-detector decision
 * one level up — a stream that could not answer is partial evidence about the
 * tenant in exactly the way a detector that could not run is partial evidence
 * about its stream — so it reuses that machinery rather than restating it.
 */

/** `stream: null` is the tenant itself rather than any particular stream, which
 * is the one case where nothing can name itself: there were no streams to ask. */
export type Withholding = Readonly<{ stream: string | null; because: WithheldReason }>

export type StreamAssessment = Readonly<{ stream: string; assessment: Assessment }>

/** A withheld tenant claim cannot be stated without naming who withheld it and
 * why. That is what stops this layer becoming the new single boolean: there is
 * no way to say "unavailable" here without saying unavailable *of what*. */
export type TenantClaim =
  | Readonly<{ permitted: true }>
  | Readonly<{ permitted: false; withheld: readonly Withholding[] }>

export type TenantAssessment = Readonly<{
  streams: readonly StreamAssessment[]
  /** Every finding from every stream that produced one. A stream that could not
   * be read never suppresses what another stream found — the veto pattern at
   * tenant scale, and the same mistake as a failed detector erasing its
   * neighbours' findings. Incomplete in any stream is incomplete here. */
  findings: FindingSet
  count: Count
  claim: TenantClaim
}>

/** The tenant total counts distinct directory users across streams, so one
 * person found in both sign-ins and mailbox artefacts is one person. Only
 * promoted directory-user refs are compared; mailbox refs are a separate
 * namespace and are never matched against them. */
export function composeTenantAssessment(streams: readonly StreamAssessment[]): TenantAssessment {
  const findings = streams.flatMap(entry => entry.assessment.findings.items)
  // Incomplete anywhere is incomplete for the tenant: a technician reading the
  // tenant view must not be told the list is whole because one of its parts was.
  const findingGaps = [...new Set(streams.flatMap(entry =>
    entry.assessment.findings.complete ? [] : entry.assessment.findings.because))]
  const [firstGap, ...restGaps] = findingGaps

  const withheld: readonly Withholding[] = streams.length === 0
    // No streams means nothing was assessed. A tenant-wide zero drawn from an
    // empty denominator is the same overclaim as a rule with no applicable
    // events reporting clean, so it reuses that reason rather than a new one.
    ? [{ stream: null, because: 'NOTHING_APPLICABLE' }]
    // A stream withheld for several reasons contributes several withholdings.
    // Picking one to represent it would reintroduce, per stream, the collapse
    // this list exists to prevent.
    : streams.flatMap(entry => entry.assessment.claim.permitted
      ? []
      : entry.assessment.claim.because.map(because => ({ stream: entry.stream, because })))

  // An exact tenant zero asserts "across everything HawkView checks, nobody has
  // a finding". One stream that could not answer means we did not check
  // everything — but the streams that did answer still support a floor, so this
  // withholds the exact claim without discarding what they found.
  const claim: TenantClaim = withheld.length === 0 ? { permitted: true } : { permitted: false, withheld }

  return {
    streams,
    findings: firstGap === undefined
      ? { items: findings, complete: true }
      : { items: findings, complete: false, because: [firstGap, ...restGaps] },
    // The per-stream count rule, unchanged. Because it is unchanged, the
    // corollary holds without being coded: a lower bound is never zero, so a
    // tenant with one unreadable stream and nothing found in the others reports
    // not-available rather than the nonsense of "at least none".
    //
    // It takes only whether a claim was permitted. Every withheld stream's
    // reason stays in `claim.withheld`, so there is no longer a place where one
    // reason has to stand in for several.
    // Scope unions across streams: a check that could not run on one tenant's
    // evidence source is not covered for that tenant, however many streams it
    // has. A tenant-level zero has to name the same gaps its parts named.
    count: countOf(distinctUsers(findings), claim.permitted, {
      evidenceRequested: [...new Set(streams.flatMap(entry => entry.assessment.count.scope.evidenceRequested))],
      // Accumulates across streams: a stream that settled its own scope cannot
      // make another stream's undecided events decided, and one that declined
      // nothing cannot un-decline another's. Merged on the PAIR, so two streams
      // setting events aside under the same reason in different vocabularies
      // stay apart — which is the whole reason the vocabulary travels.
      setAside: [...streams
        .flatMap(entry => entry.assessment.count.scope.setAside)
        .reduce((merged, entry) => {
          const key = `${entry.vocabulary}\u0000${entry.reason}`
          const running = merged.get(key)
          merged.set(key, running === undefined ? entry : { ...entry, count: running.count + entry.count })
          return merged
        }, new Map<string, CountScope['setAside'][number]>())
        .values()],
      covered: streams.flatMap(entry => entry.assessment.count.scope.covered),
      notCovered: streams.flatMap(entry => entry.assessment.count.scope.notCovered),
    }),
    claim,
  }
}
