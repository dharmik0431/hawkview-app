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
export function getMicrosoftSecureScore(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null

  let latest: { percentage: number; observedAt: number } | null = null

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
    }
    if (!latest || candidate.observedAt >= latest.observedAt) latest = candidate
  }

  return latest?.percentage ?? null
}
