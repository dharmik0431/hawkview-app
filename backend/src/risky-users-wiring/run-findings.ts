import type { Count, Finding, FindingSignal, SignalRecency } from '../evaluation-core/contract.js'
import type { TenantAssessment, TenantClaim } from '../evaluation-core/compose.js'

/** Persisting the findings a run produced, and what they rested on.
 *
 * Stored rather than recomputed because recomputing greentech's window takes
 * 7,983 ms measured — not a page load — and a cache to hide that is a third
 * thing to build and a fourth to get wrong.
 *
 * NOT in `identity_risk_matched_results`. That table requires `severity`,
 * `confidence` and `coverage` as non-null strings and this engine computes none
 * of them, so writing there means three fabricated values per finding in the
 * tables an MSP acts from. A nullable JSONB column has no field to satisfy,
 * which removes both the fabrication and the later pressure to fabricate.
 *
 * ABSENCE IS NOT AN EMPTY LIST, at both levels. A run with no findings record
 * and a run that recorded zero findings are different facts, and the column is
 * undefaulted so they stay different. This is the same distinction the coverage
 * record makes, and the same one the whole feature exists to protect — a
 * default would convert every historical row into "found nothing", which reads
 * as a clean tenant and cannot be told apart afterwards.
 */

export const RUN_FINDINGS_VERSION = 'hawkview-run-findings/v1'

/** The verdict travels WITH the findings that support it, in one record.
 *
 * Not a convenience. A count stored apart from its basis is the separation
 * this whole feature exists to remove — it is how `exact: true, value: 0`
 * came to sit beside `capability: PARTIAL` in the table this replaces, and how
 * a tile reading "4 users" came to sit above a list reading "none". Two rows,
 * two reads, two chances to drift.
 *
 * So `count`, `claim` and `items` are one JSON document. Either the whole
 * verdict comes back or none of it does, which is what lets the reader refuse
 * a count whose findings did not decode. */

export type DecodedRunFindings =
  | Readonly<{ present: true; findings: readonly Finding[]; count: Count; claim: TenantClaim; complete: boolean }>
  /** Distinct from `findings: []`, which means a run that genuinely produced
   * none. Absence is not zero. */
  | Readonly<{ present: false; because: 'NOT_RECORDED' | 'UNRECOGNIZED_VERSION' | 'MALFORMED' }>

export function encodeRunFindings(assessment: TenantAssessment): Record<string, unknown> {
  return {
    version: RUN_FINDINGS_VERSION,
    // `complete` travels with the list because "these are the findings" and
    // "these are the findings we could produce" are different claims, and the
    // second one is only visible from the gaps that explain it.
    count: assessment.count,
    claim: assessment.claim,
    complete: assessment.findings.complete,
    because: assessment.findings.complete ? [] : assessment.findings.because,
    items: assessment.findings.items.map(finding => ({
      detectorId: finding.detectorId,
      subject: finding.subject,
      signals: finding.signals.map(signal => ({
        signal: signal.signal,
        count: signal.count,
        latest: signal.latest === null ? null : { at: signal.latest.at, kind: signal.latest.kind },
        capped: signal.capped,
      })),
    })),
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readRecency = (raw: unknown): SignalRecency | null | 'INVALID' => {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) return 'INVALID'
  if (typeof raw.at !== 'string' || raw.at === '') return 'INVALID'
  // The kind is checked against the closed set rather than cast. A recency
  // whose kind we cannot read is worse than one with no kind at all: it would
  // render an event time as a read time or the reverse, and a read time is
  // always recent, so the wrong one makes stale evidence look urgent.
  if (raw.kind !== 'EVENT_OCCURRED' && raw.kind !== 'STATE_OBSERVED') return 'INVALID'
  return { at: raw.at, kind: raw.kind }
}

const readSignal = (raw: unknown): FindingSignal | null => {
  if (!isObject(raw)) return null
  if (typeof raw.signal !== 'string' || raw.signal.trim() === '') return null
  if (!Number.isInteger(raw.count) || (raw.count as number) < 0) return null
  if (typeof raw.capped !== 'boolean') return null
  const latest = readRecency(raw.latest)
  if (latest === 'INVALID') return null
  return { signal: raw.signal, count: raw.count as number, latest, capped: raw.capped }
}

/** Refuses rather than partially reads.
 *
 * One unreadable signal makes the whole record unreadable, deliberately. A
 * finding shown with some of its basis silently dropped is worse than one not
 * shown at all: the count stays, the evidence under it shrinks, and nothing on
 * the screen says a signal went missing. That is the veto pattern's opposite
 * failure and it is the one this shape can actually suffer.
 */
export function decodeRunFindings(raw: unknown): DecodedRunFindings {
  if (raw === null || raw === undefined) return { present: false, because: 'NOT_RECORDED' }
  if (!isObject(raw)) return { present: false, because: 'MALFORMED' }
  if (raw.version !== RUN_FINDINGS_VERSION) return { present: false, because: 'UNRECOGNIZED_VERSION' }
  if (!Array.isArray(raw.items)) return { present: false, because: 'MALFORMED' }

  const findings: Finding[] = []
  for (const item of raw.items) {
    if (!isObject(item) || typeof item.detectorId !== 'string' || !isObject(item.subject)) {
      return { present: false, because: 'MALFORMED' }
    }
    if (!Array.isArray(item.signals) || item.signals.length === 0) {
      // A finding resting on nothing recorded. Empty is not a shape this
      // contract admits, so reading one means the record is wrong rather than
      // that the finding had no basis.
      return { present: false, because: 'MALFORMED' }
    }
    const signals: FindingSignal[] = []
    for (const rawSignal of item.signals) {
      const signal = readSignal(rawSignal)
      if (signal === null) return { present: false, because: 'MALFORMED' }
      signals.push(signal)
    }
    const [first, ...rest] = signals as [FindingSignal, ...FindingSignal[]]
    findings.push({
      detectorId: item.detectorId,
      subject: item.subject as Finding['subject'],
      signals: [first, ...rest],
    })
  }
  // The verdict is required, not optional. A record carrying findings with no
  // count is half a verdict, and half a verdict rendered is a number with no
  // basis or a basis with no number — both of which this reader exists to refuse.
  if (!isObject(raw.count) || !isObject(raw.claim) || typeof raw.complete !== 'boolean') {
    return { present: false, because: 'MALFORMED' }
  }
  return {
    present: true,
    findings,
    count: raw.count as unknown as Count,
    claim: raw.claim as unknown as TenantClaim,
    complete: raw.complete,
  }
}
