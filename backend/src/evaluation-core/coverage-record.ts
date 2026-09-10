import type { CollectionScope, Coverage } from './contract.js'

/** Storing the coverage vector, and reading it back without lying about it.
 *
 * Pure: this is a codec, not a database. It holds no connection and issues no
 * query, so the core's "no database" rule is intact — but the shape it writes
 * is a storage decision, and the decision that matters is what happens on the
 * way back in.
 *
 * A run with no accounting recorded and a run that recorded all-zero accounting
 * are different facts. Integer columns defaulting to zero cannot tell them
 * apart, and every row written before accounting existed would read as "we
 * assessed nothing and found nothing" rather than "this predates accounting" —
 * the bare-zero defect written into the database, where it is permanent and
 * indistinguishable after the fact. So the column is nullable, absence decodes
 * to its own case, and this module refuses to guess.
 */

/** Bumped when the stored shape changes meaning. An unrecognized version is
 * refused rather than read optimistically: a reader that assumes it understands
 * an unknown shape is how a field silently changes meaning across a version. */
export const COVERAGE_RECORD_VERSION = 'hawkview-coverage/v1'

/** Why we do not have a coverage vector for a run. Distinct cases, because
 * "nobody recorded this" and "something recorded is wrong" send a maintainer to
 * different places, and neither is "the tenant was clean". */
export type CoverageUnavailable =
  /** The column is null. Written before accounting existed, or by a writer that
   * had none to give. NEVER interchangeable with a recorded zero. */
  | 'NOT_RECORDED'
  /** Recorded by a version this build does not know. Refused rather than
   * partially read. */
  | 'UNRECOGNIZED_VERSION'
  /** Present, claimed to be this version, and does not hold the shape. */
  | 'MALFORMED'

export type DecodedCoverage =
  | Readonly<{ present: true; coverage: Coverage }>
  | Readonly<{ present: false; because: CoverageUnavailable }>

/** JSON-safe, and deliberately one object rather than a row of integers: named
 * buckets keep the partition visible, where adjacent integer columns invite a
 * SUM that adds could-not-process to does-not-apply — the exact collapse this
 * whole design exists to prevent. */
export function encodeCoverage(coverage: Coverage): Record<string, unknown> {
  return {
    version: COVERAGE_RECORD_VERSION,
    collectionScope: coverage.collectionScope.declared
      ? { declared: true, asked: coverage.collectionScope.asked }
      : { declared: false },
    applies: coverage.applies,
    doesNotApply: { ...coverage.doesNotApply },
    unknown: { ...coverage.unknown },
    unprocessable: { ...coverage.unprocessable },
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reason maps arrive from storage, so every key and count is checked rather
 * than trusted. A negative or fractional count is not a smaller number, it is
 * evidence the row was not written by something we understand. */
function reasonCounts(value: unknown): Readonly<Record<string, number>> | null {
  if (!isObject(value)) return null
  const entries = Object.entries(value)
  if (entries.some(([reason, count]) =>
    reason.trim() === '' || typeof count !== 'number' || !Number.isInteger(count) || count < 0)) return null
  return Object.fromEntries(entries) as Record<string, number>
}

function collectionScope(value: unknown): CollectionScope | null {
  if (!isObject(value)) return null
  if (value.declared === false) return { declared: false }
  if (value.declared === true && typeof value.asked === 'string' && value.asked.trim() !== '') {
    return { declared: true, asked: value.asked }
  }
  return null
}

/** `null` and `undefined` mean the column was never written, which is its own
 * answer and not an empty coverage vector. */
export function decodeCoverage(raw: unknown): DecodedCoverage {
  if (raw === null || raw === undefined) return { present: false, because: 'NOT_RECORDED' }
  if (!isObject(raw)) return { present: false, because: 'MALFORMED' }
  if (raw.version !== COVERAGE_RECORD_VERSION) return { present: false, because: 'UNRECOGNIZED_VERSION' }

  const scope = collectionScope(raw.collectionScope)
  const doesNotApply = reasonCounts(raw.doesNotApply)
  const unknown = reasonCounts(raw.unknown)
  const unprocessable = reasonCounts(raw.unprocessable)
  const applies = raw.applies
  if (scope === null || doesNotApply === null || unknown === null || unprocessable === null
    || typeof applies !== 'number' || !Number.isInteger(applies) || applies < 0) {
    return { present: false, because: 'MALFORMED' }
  }

  return { present: true, coverage: { collectionScope: scope, applies, doesNotApply, unknown, unprocessable } }
}
