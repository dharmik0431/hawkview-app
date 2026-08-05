const DEFAULT_TARGET_URL =
  'https://hawkview-api-dev.onrender.com/api/internal/sync/due-tenants'

const targetUrl =
  process.env.SCHEDULER_TARGET_URL?.trim() || DEFAULT_TARGET_URL
const sharedSecret = process.env.SCHEDULER_SHARED_SECRET?.trim() ?? ''

const parsedTarget = new URL(targetUrl)
if (parsedTarget.protocol !== 'https:') {
  throw new Error('SCHEDULER_TARGET_URL must use HTTPS.')
}

if (sharedSecret.length < 32) {
  throw new Error('SCHEDULER_SHARED_SECRET must be at least 32 characters.')
}

const response = await fetch(parsedTarget, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${sharedSecret}`,
  },
  signal: AbortSignal.timeout(4 * 60 * 1000),
})

const responseText = await response.text()
if (!response.ok) {
  const safeBody = responseText.slice(0, 500)
  throw new Error(
    `Scheduled synchronization failed with HTTP ${response.status}: ${safeBody}`
  )
}

let result
try {
  result = responseText ? JSON.parse(responseText) : {}
} catch {
  throw new Error('Scheduled synchronization returned invalid JSON.')
}

console.log('Scheduled synchronization completed.', result)
