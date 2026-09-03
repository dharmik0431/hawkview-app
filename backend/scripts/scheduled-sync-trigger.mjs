function safeResponseSummary(responseText) {
  // The API response is already customer-safe, but cron logs must not mirror
  // arbitrary payloads. Preserve only a short generic diagnostic.
  return responseText ? 'The API returned a non-success response.' : 'The API returned no response body.'
}

export async function runScheduledSync({
  targetUrl,
  sharedSecret,
  fetchImpl = fetch,
  timeoutMs = 4 * 60 * 1000,
} = {}) {
  const parsedTarget = new URL(targetUrl)
  if (parsedTarget.protocol !== 'https:') throw new Error('SCHEDULER_TARGET_URL must use HTTPS.')
  if (!sharedSecret || sharedSecret.length < 32) throw new Error('SCHEDULER_SHARED_SECRET must be at least 32 characters.')

  let response
  try {
    response = await fetchImpl(parsedTarget, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${sharedSecret}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // A second request could overlap a still-running first request. The
    // durable next cron is the safe recovery mechanism until a global
    // scheduler-operation lease exists.
    throw new Error('Scheduled synchronization could not reach the API.')
  }
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`Scheduled synchronization failed with HTTP ${response.status}: ${safeResponseSummary(responseText)}`)
  }
  try { return responseText ? JSON.parse(responseText) : {} } catch {
    throw new Error('Scheduled synchronization returned invalid JSON.')
  }
}
