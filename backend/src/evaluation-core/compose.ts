import { countOf } from './evaluate.js'
import type { Assessment, Count, Finding, WithheldReason, ZeroClaim } from './contract.js'

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
   * neighbours' findings. */
  findings: readonly Finding[]
  count: Count
  claim: TenantClaim
}>

/** NOTE: the tenant count treats subject refs as one tenant-wide namespace, so
 * a subject found in two streams is one subject. That holds only while every
 * detector emits the same kind of ref for the same person; a stream keying
 * findings by something else (a raw mailbox id, say) would count that person
 * twice. Raised with PM rather than assumed silently. */
export function composeTenantAssessment(streams: readonly StreamAssessment[]): TenantAssessment {
  const findings = streams.flatMap(entry => entry.assessment.findings)

  const withheld: readonly Withholding[] = streams.length === 0
    // No streams means nothing was assessed. A tenant-wide zero drawn from an
    // empty denominator is the same overclaim as a rule with no applicable
    // events reporting clean, so it reuses that reason rather than a new one.
    ? [{ stream: null, because: 'NOTHING_APPLICABLE' }]
    : streams.flatMap(entry => entry.assessment.claim.permitted
      ? []
      : [{ stream: entry.stream, because: entry.assessment.claim.because }])

  // An exact tenant zero asserts "across everything HawkView checks, nobody has
  // a finding". One stream that could not answer means we did not check
  // everything — but the streams that did answer still support a floor, so this
  // withholds the exact claim without discarding what they found.
  const claim: TenantClaim = withheld.length === 0 ? { permitted: true } : { permitted: false, withheld }

  // The per-stream count rule, unchanged. Because it is unchanged, the corollary
  // holds without being coded: a lower bound is never zero, so a tenant with one
  // unreadable stream and nothing found in the others reports not-available
  // rather than the nonsense of "at least none".
  const forCount: ZeroClaim = claim.permitted
    ? { permitted: true }
    : { permitted: false, because: withheld[0]!.because }

  return {
    streams,
    findings,
    count: countOf(new Set(findings.map(finding => finding.subject)).size, forCount),
    claim,
  }
}
