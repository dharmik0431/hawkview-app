import type { PimPlane } from './pim-schedule-contract.js'
import type { PimPlaneReadResult, PimPlaneView } from './pim-schedule-reader.js'

export const PIM_SCHEDULE_SUMMARY_VERSION = 'pim-schedule-summary/v1'

/** Bounded summary of the last committed observation.
 *
 * `observedRecordCount` is the number of records HawkView actually observed in that attempt. It is
 * NOT a count of effective holders and NOT an authoritative tenant total; `assurance` and `coverage`
 * are carried verbatim so a consumer cannot mistake it for either. */
export interface PimScheduleCommittedSummary {
  readonly attemptId: string
  readonly scopeVersion: string
  readonly committedAt: string
  readonly contentChangedAt: string
  readonly contentDigest: string
  readonly observedRecordCount: number
  readonly ageMs: number
  readonly traversalOutcome: 'EXHAUSTED'
  readonly assurance: 'UNKNOWN'
  readonly coverage: 'NOT_ESTABLISHED'
}

export interface PimScheduleSummaryResponse {
  readonly responseVersion: typeof PIM_SCHEDULE_SUMMARY_VERSION
  readonly plane: PimPlane
  readonly status: PimPlaneReadResult['status']
  readonly lastCommitted: PimScheduleCommittedSummary | null
  /** Present only for 'last-attempt-failed'. */
  readonly failureKind?: string
}

/** Every field is picked by name. Never spread the view: it carries scope/connection incarnations,
 * endpoint descriptors, projection identity and parsed rows, none of which belong in this contract. */
function committedSummary(view: PimPlaneView): PimScheduleCommittedSummary {
  return {
    attemptId: view.attemptId,
    scopeVersion: view.scopeVersion,
    // Clocks come from the stored receipt, never from request time.
    committedAt: view.committedAt.toISOString(),
    contentChangedAt: view.contentChangedAt.toISOString(),
    contentDigest: view.contentDigest,
    observedRecordCount: view.observedRowCount,
    ageMs: view.ageMs,
    traversalOutcome: view.traversalOutcome,
    assurance: view.assurance,
    coverage: view.coverage,
  }
}

/** Maps the existing reader result into the bounded HTTP contract.
 *
 * 'never-collected' stays distinct from an observed attempt that recorded zero records: the former
 * has no committed summary at all, the latter has one with observedRecordCount 0. A newer failed
 * attempt may still carry the older committed summary — it keeps that attempt's own clocks and does
 * not claim a fresh success. */
export function toPimScheduleSummary(
  plane: PimPlane,
  result: PimPlaneReadResult
): PimScheduleSummaryResponse {
  const base = { responseVersion: PIM_SCHEDULE_SUMMARY_VERSION, plane } as const
  if (result.status === 'observed') {
    return { ...base, status: 'observed', lastCommitted: committedSummary(result.view) }
  }
  if (result.status === 'last-attempt-failed') {
    return {
      ...base,
      status: 'last-attempt-failed',
      lastCommitted: result.view === null ? null : committedSummary(result.view),
      failureKind: result.failureKind,
    }
  }
  return { ...base, status: 'never-collected', lastCommitted: null }
}
