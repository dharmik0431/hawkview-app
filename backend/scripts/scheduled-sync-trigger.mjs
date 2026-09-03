const RETRYABLE_STATUSES = new Set([502, 503, 504])
export const MAX_SCHEDULED_SYNC_ATTEMPTS = 2

function safeResponseSummary(responseText) {
  // The API response is already customer-safe, but cron logs must not mirror
  // arbitrary payloads. Preserve only a short generic diagnostic.
  return responseText ? 'The API returned a non-success response.' : 'The API returned no response body.'
}

function retryableTransportError(error) {
  return error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError'
}

export async function runScheduledSync({
  targetUrl,
  sharedSecret,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 4 * 60 * 1000,
  attempts = MAX_SCHEDULED_SYNC_ATTEMPTS,
} = {}) {
  const parsedTarget = new URL(targetUrl)
  if (parsedTarget.protocol !== 'https:') throw new Error('SCHEDULER_TARGET_URL must use HTTPS.')
  if (!sharedSecret || sharedSecret.length < 32) throw new Error('SCHEDULER_SHARED_SECRET must be at least 32 characters.')

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(parsedTarget, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${sharedSecret}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const responseText = await response.text()
      if (response.ok) {
        try { return responseText ? JSON.parse(responseText) : {} } catch { throw new Error('Scheduled synchronization returned invalid JSON.') }
      }
      const error = new Error(`Scheduled synchronization failed with HTTP ${response.status}: ${safeResponseSummary(responseText)}`)
      if (!RETRYABLE_STATUSES.has(response.status)) throw error
      lastError = error
    } catch (error) {
      if (!retryableTransportError(error)) throw error
      lastError = new Error('Scheduled synchronization could not reach the API.')
    }
    if (attempt < attempts) await sleep(1_000 * attempt)
  }
  throw lastError ?? new Error('Scheduled synchronization failed.')
}
