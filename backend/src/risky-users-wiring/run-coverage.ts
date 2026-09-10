import { COVERAGE_RECORD_VERSION, decodeCoverage, encodeCoverage } from '../evaluation-core/coverage-record.js'
import type { Coverage } from '../evaluation-core/contract.js'
import type { TenantAssessment } from '../evaluation-core/compose.js'

/** Persisting the denominator a run's claim rested on.
 *
 * "4 assessed, 8 out of scope" is evaluation-time information: it exists while
 * `evaluate` runs and nowhere afterwards. A run that reported a zero without it
 * cannot be re-examined later — you can see the answer and not what it was an
 * answer about, which is the position every one of the 1,054 historical runs is
 * in permanently.
 *
 * Per stream, never merged. Sign-ins and mailbox artefacts have different
 * coverage; one number for a tenant would be a lie by averaging, and averaging
 * is not recoverable afterwards either.
 */

export const RUN_COVERAGE_VERSION = 'hawkview-run-coverage/v1'

export type StreamCoverage = Readonly<{ stream: string; coverage: Coverage }>

export type DecodedRunCoverage =
  | Readonly<{ present: true; streams: readonly StreamCoverage[] }>
  /** Distinct from an empty stream list, which would mean a run that genuinely
   * assessed nothing. Absence is not zero — the whole reason the column is
   * nullable and undefaulted. */
  | Readonly<{ present: false; because: 'NOT_RECORDED' | 'UNRECOGNIZED_VERSION' | 'MALFORMED' }>

export function encodeRunCoverage(assessment: TenantAssessment): Record<string, unknown> {
  return {
    version: RUN_COVERAGE_VERSION,
    streams: assessment.streams.map(entry => ({
      stream: entry.stream,
      coverage: encodeCoverage(entry.assessment.coverage),
    })),
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Refuses rather than partially reads, at both levels.
 *
 * A run whose outer envelope this build understands may still carry a stream
 * coverage written by a version it does not, and reading the outer one
 * successfully is exactly what would make that easy to miss. One unreadable
 * stream makes the whole record unreadable: a partial answer about which
 * streams a claim covered is worse than no answer, because it looks complete.
 */
export function decodeRunCoverage(raw: unknown): DecodedRunCoverage {
  if (raw === null || raw === undefined) return { present: false, because: 'NOT_RECORDED' }
  if (!isObject(raw)) return { present: false, because: 'MALFORMED' }
  if (raw.version !== RUN_COVERAGE_VERSION) return { present: false, because: 'UNRECOGNIZED_VERSION' }
  if (!Array.isArray(raw.streams)) return { present: false, because: 'MALFORMED' }

  const streams: StreamCoverage[] = []
  for (const entry of raw.streams) {
    if (!isObject(entry) || typeof entry.stream !== 'string' || entry.stream.trim() === '') {
      return { present: false, because: 'MALFORMED' }
    }
    const decoded = decodeCoverage(entry.coverage)
    if (!decoded.present) {
      // The inner reason travels up rather than flattening to MALFORMED: a
      // stream written by a future version and a stream written wrongly send a
      // maintainer to different places.
      return { present: false, because: decoded.because }
    }
    streams.push({ stream: entry.stream, coverage: decoded.coverage })
  }
  return { present: true, streams }
}

/** The versions this build writes, for a migration or an audit to read without
 * grepping. Two levels, because the envelope and the vector move separately. */
export const COVERAGE_VERSIONS = Object.freeze({
  run: RUN_COVERAGE_VERSION,
  stream: COVERAGE_RECORD_VERSION,
})
