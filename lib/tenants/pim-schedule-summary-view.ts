/** Client boundary for the authenticated PIM schedule summary API delivered in PR318.
 *
 * Parsing here validates the shape the server promised. It does NOT establish that the server
 * authorized the caller for this tenant — that decision is the API's, and nothing on the client
 * can substitute for it. */

export const PIM_SUMMARY_RESPONSE_VERSION = 'pim-schedule-summary/v1'

export type PimSchedulePlane = 'ACTIVE' | 'ELIGIBLE'
export type PimSummaryStatus = 'observed' | 'never-collected' | 'last-attempt-failed'

/** Deliberately omits attemptId, scopeVersion and contentDigest. The API returns them, but this
 * view model never carries them, so no rendering path can leak an internal identifier into product
 * copy even by accident. */
export type PimObservationView = {
  readonly observedRecordCount: number
  readonly collectedAt: Date
  readonly contentChangedAt: Date
  readonly ageMs: number
  readonly coverageVerified: false
}

export type PimPlaneSummaryView = {
  readonly plane: PimSchedulePlane
  readonly status: PimSummaryStatus
  /** Present for 'observed', and for 'last-attempt-failed' when an older commit survives. */
  readonly lastObservation: PimObservationView | null
  /** True only for 'last-attempt-failed' with an older observation retained. */
  readonly showingOlderObservation: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const finiteCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

const storedTime = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null
  const at = new Date(v)
  return Number.isFinite(at.getTime()) ? at : null
}

function parseObservation(value: unknown): PimObservationView | null {
  if (!isRecord(value)) return null
  const collectedAt = storedTime(value.committedAt)
  const contentChangedAt = storedTime(value.contentChangedAt)
  if (!collectedAt || !contentChangedAt) return null
  if (!finiteCount(value.observedRecordCount) || !finiteCount(value.ageMs)) return null
  // Verbatim, never re-derived: if the server stops saying these, we must not silently upgrade them.
  if (value.assurance !== 'UNKNOWN' || value.coverage !== 'NOT_ESTABLISHED') return null
  if (typeof value.contentDigest !== 'string' || !value.contentDigest) return null
  return {
    observedRecordCount: value.observedRecordCount,
    collectedAt,
    contentChangedAt,
    ageMs: value.ageMs,
    coverageVerified: false,
  }
}

/** Returns null for anything unsupported, mismatched or malformed.
 *
 * A null result means "we could not read this answer", which the view must render differently from
 * "the tenant has no observations". Degrading a parse failure into an empty summary would state
 * something the server never said. */
export function parsePimPlaneSummary(
  requestedPlane: PimSchedulePlane,
  value: unknown
): PimPlaneSummaryView | null {
  if (!isRecord(value)) return null
  if (value.responseVersion !== PIM_SUMMARY_RESPONSE_VERSION) return null
  // A response for a different plane is a mismatch, not data for this one.
  if (value.plane !== requestedPlane) return null

  const status = value.status
  if (status !== 'observed' && status !== 'never-collected' && status !== 'last-attempt-failed') {
    return null
  }

  // The API always sends `lastCommitted` as an explicit nullable property. An omitted field is a
  // malformed answer, not a tenant with no observations, so it is refused rather than emptied.
  if (!Object.prototype.hasOwnProperty.call(value, 'lastCommitted')) return null
  const raw = value.lastCommitted
  if (raw === undefined) return null

  if (status === 'never-collected') {
    // Never-collected must carry an explicit null; a present observation contradicts the status.
    if (raw !== null) return null
    return { plane: requestedPlane, status, lastObservation: null, showingOlderObservation: false }
  }

  if (status === 'observed') {
    const observation = parseObservation(raw)
    if (!observation) return null
    return { plane: requestedPlane, status, lastObservation: observation, showingOlderObservation: false }
  }

  // last-attempt-failed: an older commit may or may not survive, stated as an explicit null.
  if (raw === null) {
    return { plane: requestedPlane, status, lastObservation: null, showingOlderObservation: false }
  }
  const older = parseObservation(raw)
  if (!older) return null
  return { plane: requestedPlane, status, lastObservation: older, showingOlderObservation: true }
}
