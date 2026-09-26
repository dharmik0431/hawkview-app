/** Microsoft documents daily scores, newest first, and supports $top=1.
 * https://learn.microsoft.com/graph/api/resources/securescore
 * https://learn.microsoft.com/graph/api/security-list-securescores
 * This is a current-score query, never a complete historical inventory.
 */
export const CURRENT_SECURE_SCORE_URL = 'https://graph.microsoft.com/v1.0/security/secureScores?$top=1'
export type CurrentSecureScore = {
  id: string
  createdDateTime: string
  currentScore: number
  maxScore: number
}

export class SecureScoreResponseError extends Error {
  constructor(readonly reason: 'INVALID_RESPONSE' | 'INVALID_CONTINUATION' | 'PARTIAL_PROVIDER_RESPONSE' | 'INVALID_HTTP_STATUS' | 'EMPTY_RESPONSE' | 'ROW_LIMIT') {
    super(reason === 'ROW_LIMIT' ? 'Microsoft secure scores exceeded a bounded collection row limit.'
      : `Microsoft secure scores returned an invalid response (${reason}).`)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function currentSecureScoresFromResponse(payload: unknown, now: number, maximumRows = 100): CurrentSecureScore[] {
  if (!record(payload) || !Array.isArray(payload.value)) throw new SecureScoreResponseError('INVALID_RESPONSE')
  // Deliberately scoped to the documented current-score query. Continuation
  // is unused metadata, never fetched. This does not attest full historical
  // inventory or independent coverage of every provider beyond this response.
  const next = payload['@odata.nextLink']
  if (next !== undefined) {
    if (typeof next !== 'string' || next.length === 0 || next.length > 4096 || /[\u0000-\u0020\u007f]/.test(next)) {
      throw new SecureScoreResponseError('INVALID_CONTINUATION')
    }
    let link: URL
    try { link = new URL(next) } catch { throw new SecureScoreResponseError('INVALID_CONTINUATION') }
    if (link.origin !== 'https://graph.microsoft.com' || link.username || link.password || link.hash ||
      link.pathname !== '/v1.0/security/secureScores') throw new SecureScoreResponseError('INVALID_CONTINUATION')
  }
  if (payload.value.length === 0) throw new SecureScoreResponseError('EMPTY_RESPONSE')
  if (payload.value.length > maximumRows) throw new SecureScoreResponseError('ROW_LIMIT')
  return payload.value.map((row: unknown) => {
    if (!record(row) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 ||
      typeof row.createdDateTime !== 'string' || row.createdDateTime.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.createdDateTime) ||
      typeof row.currentScore !== 'number' || !Number.isFinite(row.currentScore) || row.currentScore < 0 ||
      typeof row.maxScore !== 'number' || !Number.isFinite(row.maxScore) || row.maxScore <= 0 || row.currentScore > row.maxScore) {
      throw new SecureScoreResponseError('INVALID_RESPONSE')
    }
    const observedAt = Date.parse(row.createdDateTime)
    // Check calendar fields before applying an offset: Date.parse alone can
    // normalize February 30. Preserve the original DateTimeOffset string.
    const localFields = row.createdDateTime.slice(0, 19)
    const calendarTime = Date.parse(`${localFields}Z`)
    if (!Number.isFinite(now) || !Number.isFinite(observedAt) || !Number.isFinite(calendarTime) ||
      new Date(calendarTime).toISOString().slice(0, 19) !== localFields || observedAt > now) {
      throw new SecureScoreResponseError('INVALID_RESPONSE')
    }
    // Preserve provider time even when old. Collection success does not assert
    // provider freshness; no existing provider-age policy exists for this feed.
    // Only these fields feed tenant-list and tenant-bundle score consumers.
    // Nested controls/comparative scores are neither needed nor retained.
    return { id: row.id, createdDateTime: row.createdDateTime, currentScore: row.currentScore, maxScore: row.maxScore }
  })
}
