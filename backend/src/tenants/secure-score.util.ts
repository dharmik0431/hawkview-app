type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestamp(value: unknown): number {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : 0
}

/**
 * Returns the newest valid Microsoft Secure Score as a whole-number percentage.
 * Missing or malformed Graph data remains unavailable instead of being reported as 0.
 */
function selectMicrosoftSecureScore(payload: unknown) {
  if (!Array.isArray(payload)) return null

  let latest: { percentage: number; observedAt: number; createdDateTime: unknown } | null = null

  for (const entry of payload) {
    if (!isRecord(entry)) continue

    const currentScore = asFiniteNumber(entry.currentScore)
    const maxScore = asFiniteNumber(entry.maxScore)
    if (
      currentScore === null ||
      maxScore === null ||
      currentScore < 0 ||
      maxScore <= 0
    ) {
      continue
    }

    const candidate = {
      percentage: Math.round(
        Math.max(0, Math.min(100, (currentScore / maxScore) * 100)),
      ),
      observedAt: timestamp(entry.createdDateTime),
      createdDateTime: entry.createdDateTime,
    }
    if (!latest || candidate.observedAt >= latest.observedAt) latest = candidate
  }

  return latest
}

/** Preserve the existing scalar selection, including legacy undated rows. */
export function getMicrosoftSecureScore(payload: unknown): number | null {
  return selectMicrosoftSecureScore(payload)?.percentage ?? null
}

function sourceDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null
  }
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const parsed = Date.parse(value)
  const localFields = value.slice(0, 19)
  const calendarTime = Date.parse(`${localFields}Z`)
  if (!Number.isFinite(parsed) || !Number.isFinite(calendarTime) ||
    new Date(calendarTime).toISOString().slice(0, 19) !== localFields) return null
  return new Date(parsed).toISOString()
}

export type MicrosoftSecureScoreDetails = {
  version: 1
  percentage: number | null
  /** Microsoft's createdDateTime from the exact winning score row. */
  scoreCreatedAt: string | null
  /** Persisted snapshot clock, not the Microsoft score date or job completion. */
  snapshotObservedAt: string | null
  /** SECURE_SCORES success clock; not atomically paired with this snapshot. */
  lastSuccessfulCollectionAt: string | null
}

/** Source clocks only: no query-time, global synchronization, or freshness inference. */
export function getMicrosoftSecureScoreDetails(
  snapshot: { payload: unknown; observedAt: unknown } | null | undefined,
  lastSuccessfulCollectionAt: unknown,
): MicrosoftSecureScoreDetails {
  const selected = selectMicrosoftSecureScore(snapshot?.payload)
  const snapshotObservedAt = sourceDate(snapshot?.observedAt)
  const scoreCreatedAt = sourceDate(selected?.createdDateTime)
  return {
    version: 1,
    percentage: selected?.percentage ?? null,
    // Legacy persisted values may violate the collector's date validation.
    // Keep the scalar compatible, but do not publish an inconsistent age.
    scoreCreatedAt: scoreCreatedAt && (!snapshotObservedAt ||
      Date.parse(scoreCreatedAt) <= Date.parse(snapshotObservedAt)) ? scoreCreatedAt : null,
    snapshotObservedAt,
    lastSuccessfulCollectionAt: sourceDate(lastSuccessfulCollectionAt),
  }
}
