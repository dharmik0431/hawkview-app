import { randomUUID } from 'node:crypto'

export type MicrosoftFailureClass =
  | 'AUTHENTICATION_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'THROTTLED'
  | 'MICROSOFT_TRANSIENT'
  | 'NETWORK_TIMEOUT'
  | 'DELTA_RESET_REQUIRED'
  | 'CAPACITY_GUARD'
  | 'INVALID_MICROSOFT_RESPONSE'
  | 'HAWKVIEW_INTERNAL'

export type MicrosoftFailureProjection = {
  failureClass: MicrosoftFailureClass
  reasonCode: string
  status: number | null
  microsoftCode: string | null
  requestId: string | null
  retryable: boolean
  customerAction: 'NONE' | 'RECONNECT' | 'REVIEW_PERMISSIONS' | 'CONTACT_SUPPORT'
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const AUTHENTICATION_CODES = new Set([
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'consent_required',
  'AADSTS65001',
  'AADSTS70001',
  'AADSTS70002',
  'AADSTS7000215',
  'AADSTS7000222',
  'AADSTS7000112',
].map((code) => code.toLowerCase()))

function boundedCode(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value)
    ? value
    : null
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export async function microsoftErrorMetadata(response: Response, maximumBytes = 16 * 1024) {
  const headerRequestId =
    boundedCode(response.headers.get('request-id')) ??
    boundedCode(response.headers.get('client-request-id')) ??
    boundedCode(response.headers.get('x-ms-request-id'))
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { code: null, requestId: headerRequestId }
  }
  try {
    if (!response.body) return { code: null, requestId: headerRequestId }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maximumBytes) {
          await reader.cancel().catch(() => undefined)
          return { code: null, requestId: headerRequestId }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(bytes)
    const body = JSON.parse(text) as unknown
    if (!plainRecord(body)) return { code: null, requestId: headerRequestId }
    const nested = plainRecord(body.error) ? body.error : null
    const code = boundedCode(nested?.code) ?? boundedCode(body.error)
    const requestId =
      headerRequestId ??
      boundedCode(body.correlation_id) ??
      boundedCode(nested?.['innerError'] && plainRecord(nested.innerError) ? nested.innerError['request-id'] : null)
    return { code, requestId }
  } catch {
    return { code: null, requestId: headerRequestId }
  }
}

function statusFromMessage(message: string) {
  const match = /\b(?:HTTP\s*)?(401|403|410|429|500|502|503|504)\b/i.exec(message)
  return match ? Number(match[1]) : null
}

function codeFromMessage(message: string) {
  const match = /\b(AADSTS\d{5,}|syncStateNotFound|resyncChangesApplyDifferences|resyncChangesUploadDifferences)\b/i.exec(message)
  return boundedCode(match?.[1])
}

export class MicrosoftRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly microsoftCode: string | null,
    readonly requestId: string | null,
  ) {
    super(message)
    this.name = 'MicrosoftRequestError'
  }
}

export function classifyMicrosoftFailure(
  error: unknown,
  safeMessage = error instanceof Error ? error.message : '',
): MicrosoftFailureProjection {
  const status = error instanceof MicrosoftRequestError
    ? error.status
    : statusFromMessage(safeMessage)
  const microsoftCode = error instanceof MicrosoftRequestError
    ? error.microsoftCode
    : codeFromMessage(safeMessage)
  const requestId = error instanceof MicrosoftRequestError ? error.requestId : null
  const normalizedCode = microsoftCode?.toLowerCase() ?? ''

  if (
    status === 410 ||
    normalizedCode === 'syncstatenotfound' ||
    normalizedCode.startsWith('resyncchanges')
  ) {
    return {
      failureClass: 'DELTA_RESET_REQUIRED', reasonCode: 'MICROSOFT_DELTA_RESET_REQUIRED',
      status, microsoftCode, requestId, retryable: true, customerAction: 'NONE',
    }
  }
  if (status === 429) {
    return {
      failureClass: 'THROTTLED', reasonCode: 'MICROSOFT_THROTTLED',
      status, microsoftCode, requestId, retryable: true, customerAction: 'NONE',
    }
  }
  if (status !== null && status >= 500 && status <= 599) {
    return {
      failureClass: 'MICROSOFT_TRANSIENT', reasonCode: 'MICROSOFT_TRANSIENT',
      status, microsoftCode, requestId, retryable: true, customerAction: 'NONE',
    }
  }
  if (status === 401 || AUTHENTICATION_CODES.has(normalizedCode)) {
    return {
      failureClass: 'AUTHENTICATION_REQUIRED', reasonCode: 'MICROSOFT_AUTHENTICATION_REQUIRED',
      status, microsoftCode, requestId, retryable: false, customerAction: 'RECONNECT',
    }
  }
  if (status === 403) {
    return {
      failureClass: 'PERMISSION_REQUIRED', reasonCode: 'MICROSOFT_PERMISSION_REQUIRED',
      status, microsoftCode, requestId, retryable: false, customerAction: 'REVIEW_PERMISSIONS',
    }
  }
  if (/\bAbortError\b|timed?\s*out|network|fetch failed|ECONNRESET|ENOTFOUND/i.test(safeMessage)) {
    return {
      failureClass: 'NETWORK_TIMEOUT', reasonCode: 'MICROSOFT_NETWORK_TIMEOUT',
      status, microsoftCode, requestId, retryable: true, customerAction: 'NONE',
    }
  }
  if (/bounded collection|record limit|page limit|response-size|wall-clock deadline|capacity/i.test(safeMessage)) {
    return {
      failureClass: 'CAPACITY_GUARD', reasonCode: 'HAWKVIEW_CAPACITY_GUARD',
      status, microsoftCode, requestId, retryable: false, customerAction: 'CONTACT_SUPPORT',
    }
  }
  if (/invalid response|invalid .* link|repeated .* link|did not return/i.test(safeMessage)) {
    return {
      failureClass: 'INVALID_MICROSOFT_RESPONSE', reasonCode: 'MICROSOFT_INVALID_RESPONSE',
      status, microsoftCode, requestId, retryable: false, customerAction: 'CONTACT_SUPPORT',
    }
  }
  return {
    failureClass: 'HAWKVIEW_INTERNAL', reasonCode: 'HAWKVIEW_INTERNAL_FAILURE',
    status, microsoftCode, requestId, retryable: false, customerAction: 'CONTACT_SUPPORT',
  }
}

export function customerCollectionFailureMessage(
  resourceLabel: string,
  failure: MicrosoftFailureProjection,
  hasBaseline: boolean,
) {
  const retained = hasBaseline
    ? ' HawkView retained the last successful data.'
    : ' HawkView has not completed the first collection yet.'
  if (failure.failureClass === 'THROTTLED') {
    return `Microsoft temporarily limited ${resourceLabel} requests.${retained} HawkView will retry automatically.`
  }
  if (failure.failureClass === 'MICROSOFT_TRANSIENT' || failure.failureClass === 'NETWORK_TIMEOUT') {
    return `Microsoft temporarily could not provide ${resourceLabel} data.${retained} HawkView will retry automatically.`
  }
  if (failure.failureClass === 'AUTHENTICATION_REQUIRED') {
    return `Microsoft rejected the tenant authorization required for ${resourceLabel}. Reconnect the Microsoft tenant.`
  }
  if (failure.failureClass === 'PERMISSION_REQUIRED') {
    return `Microsoft denied access to ${resourceLabel}. Review the required Microsoft permissions or workload role.`
  }
  if (failure.failureClass === 'DELTA_RESET_REQUIRED') {
    return `Microsoft requires HawkView to rebuild the ${resourceLabel} synchronization baseline. HawkView will retry automatically.`
  }
  if (failure.failureClass === 'CAPACITY_GUARD') {
    return `HawkView stopped the ${resourceLabel} refresh at a safety limit and retained the previous data. Contact HawkView support if this continues.`
  }
  return `HawkView could not safely refresh ${resourceLabel}.${retained} HawkView support should investigate if this continues.`
}

export function isRetryableMicrosoftStatus(status: number) {
  return RETRYABLE_STATUSES.has(status)
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, Math.min(date - now, 10_000))
}

export async function fetchMicrosoftWithRetry(
  url: string,
  init: RequestInit,
  options: {
    label: string
    timeoutMs?: number
    deadlineAt?: number
    maxAttempts?: number
    retryUnsafeMethod?: boolean
    fetchImpl?: typeof fetch
    wait?: (milliseconds: number) => Promise<void>
  },
) {
  const method = String(init.method ?? 'GET').toUpperCase()
  const mayRetry = method === 'GET' || method === 'HEAD' || options.retryUnsafeMethod === true
  const attempts = mayRetry ? Math.max(1, Math.min(options.maxAttempts ?? 3, 3)) : 1
  const fetchImpl = options.fetchImpl ?? fetch
  const wait = options.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const { signal: _discardedSignal, ...stableInit } = init
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = options.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : options.deadlineAt - Date.now()
    if (remaining <= 0) {
      throw new MicrosoftRequestError(
        `${options.label} reached its bounded collection deadline.`, null, null, null,
      )
    }
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30_000, remaining))
    const headers = new Headers(stableInit.headers)
    if (!headers.has('client-request-id')) headers.set('client-request-id', randomUUID())
    try {
      const response = await fetchImpl(url, {
        ...stableInit,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!isRetryableMicrosoftStatus(response.status) || attempt === attempts - 1) {
        return response
      }
      await response.body?.cancel().catch(() => undefined)
      const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'))
      await wait(retryAfter ?? (attempt + 1) * 500)
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1) break
      await wait((attempt + 1) * 500)
    }
  }

  const message = lastError instanceof Error ? lastError.message : `${options.label} request failed.`
  throw new MicrosoftRequestError(message, null, null, null)
}
