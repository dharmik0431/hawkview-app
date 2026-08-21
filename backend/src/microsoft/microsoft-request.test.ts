import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyMicrosoftFailure,
  customerCollectionFailureMessage,
  fetchMicrosoftWithRetry,
  microsoftErrorMetadata,
  MicrosoftRequestError,
  retryAfterMilliseconds,
} from './microsoft-request.js'

test('retries bounded Microsoft transient responses and honors Retry-After', async () => {
  const statuses = [500, 429, 200]
  const waits: number[] = []
  let calls = 0
  const response = await fetchMicrosoftWithRetry(
    'https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies',
    { headers: { Accept: 'application/json' } },
    {
      label: 'Conditional Access',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        calls += 1
        assert.match(new Headers(init?.headers).get('client-request-id') ?? '', /^[0-9a-f-]{36}$/)
        const status = statuses.shift() ?? 500
        return new Response(status === 200 ? '{}' : 'temporary', {
          status,
          headers: status === 429 ? { 'Retry-After': '2' } : undefined,
        })
      }) as typeof fetch,
      wait: async (milliseconds) => { waits.push(milliseconds) },
    },
  )
  assert.equal(response.status, 200)
  assert.equal(calls, 3)
  assert.deepEqual(waits, [500, 2000])
})

test('does not retry unsafe requests unless the caller explicitly proves idempotency', async () => {
  let calls = 0
  const response = await fetchMicrosoftWithRetry(
    'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    { method: 'POST' },
    {
      label: 'token',
      fetchImpl: (async () => {
        calls += 1
        return new Response('{}', { status: 503 })
      }) as typeof fetch,
      wait: async () => undefined,
    },
  )
  assert.equal(response.status, 503)
  assert.equal(calls, 1)
})

test('classifies customer action independently from human-readable messages', () => {
  assert.deepEqual(
    classifyMicrosoftFailure(new MicrosoftRequestError('opaque', 500, 'InternalServerError', 'req-1')),
    {
      failureClass: 'MICROSOFT_TRANSIENT', reasonCode: 'MICROSOFT_TRANSIENT',
      status: 500, microsoftCode: 'InternalServerError', requestId: 'req-1',
      retryable: true, customerAction: 'NONE',
    },
  )
  assert.equal(classifyMicrosoftFailure(new Error('HTTP 403')).customerAction, 'REVIEW_PERMISSIONS')
  assert.equal(
    classifyMicrosoftFailure(new MicrosoftRequestError('oauth rejected', 400, 'invalid_client', null)).failureClass,
    'AUTHENTICATION_REQUIRED',
  )
  assert.equal(
    classifyMicrosoftFailure(new MicrosoftRequestError('token rejected', 401, 'InvalidAuthenticationToken', null)).retryable,
    false,
  )
  assert.equal(
    classifyMicrosoftFailure(new MicrosoftRequestError('oauth rejected', 400, 'AADSTS7000215', null)).customerAction,
    'RECONNECT',
  )
  assert.equal(classifyMicrosoftFailure(new Error('HTTP 410 syncStateNotFound')).failureClass, 'DELTA_RESET_REQUIRED')
  assert.equal(classifyMicrosoftFailure(new Error('fetch failed')).failureClass, 'NETWORK_TIMEOUT')
})

test('customer transient copy retains baseline and never blames tenant configuration', () => {
  const message = customerCollectionFailureMessage(
    'Conditional Access',
    classifyMicrosoftFailure(new Error('Microsoft returned 500')),
    true,
  )
  assert.match(message, /temporarily could not provide Conditional Access data/i)
  assert.match(message, /retained the last successful data/i)
  assert.match(message, /retry automatically/i)
  assert.doesNotMatch(message, /review policies|permission|redacted|diagnostic/i)
})

test('Retry-After accepts bounded seconds or HTTP dates', () => {
  assert.equal(retryAfterMilliseconds('4', 0), 4000)
  assert.equal(retryAfterMilliseconds(new Date(7000).toUTCString(), 1000), 6000)
  assert.equal(retryAfterMilliseconds('invalid', 0), null)
  assert.equal(retryAfterMilliseconds('999', 0), 10_000)
})

test('projects only bounded Microsoft error code and request identity', async () => {
  const result = await microsoftErrorMetadata(new Response(JSON.stringify({
    error: 'temporarily_unavailable',
    error_description: 'client_secret=do-not-project',
    correlation_id: '9b62acbd-9c37-45f9-a030-ce66e1847ef9',
  }), { status: 503 }))
  assert.deepEqual(result, {
    code: 'temporarily_unavailable',
    requestId: '9b62acbd-9c37-45f9-a030-ce66e1847ef9',
  })
})

test('cancels an untrusted error stream as soon as the byte ceiling is crossed', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":'))
      controller.enqueue(new TextEncoder().encode('"oversized-response"}'))
    },
    cancel() { cancelled = true },
  })
  const result = await microsoftErrorMetadata(new Response(stream, {
    status: 503,
    headers: { 'Content-Length': '2', 'request-id': 'req-safe' },
  }), 8)
  assert.deepEqual(result, { code: null, requestId: 'req-safe' })
  assert.equal(cancelled, true)
})
