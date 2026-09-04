function safeResponseSummary(responseText) {
  // The API response is already customer-safe, but cron logs must not mirror
  // arbitrary payloads. Preserve only a short generic diagnostic.
  return responseText ? 'The API returned a non-success response.' : 'The API returned no response body.'
}

export const SCHEDULED_SYNC_RESPONSE_MAX_BYTES = 64 * 1024

async function readSafeResponse(response) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > SCHEDULED_SYNC_RESPONSE_MAX_BYTES) {
    try { await response.body?.cancel() } catch { /* preserve the fixed safe failure */ }
    throw new Error('SCHEDULER_RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new Error('SCHEDULER_RESPONSE_UNAVAILABLE')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > SCHEDULED_SYNC_RESPONSE_MAX_BYTES) {
        await reader.cancel()
        throw new Error('SCHEDULER_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } catch {
    throw new Error('SCHEDULER_RESPONSE_READ_FAILED')
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

export function summarizeScheduledSyncResult(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const boundedCount = (key) => Number.isSafeInteger(record[key]) && record[key] >= 0 && record[key] <= 10_000 ? record[key] : 0
  return { outcome: 'COMPLETED', due: boundedCount('due'), succeeded: boundedCount('succeeded'), partial: boundedCount('partial'), failed: boundedCount('failed'), skipped: boundedCount('skipped') }
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
  const responseText = await readSafeResponse(response)
  if (!response.ok) {
    throw new Error(`Scheduled synchronization failed with HTTP ${response.status}: ${safeResponseSummary(responseText)}`)
  }
  try { return responseText ? JSON.parse(responseText) : {} } catch {
    throw new Error('Scheduled synchronization returned invalid JSON.')
  }
}
