export type EmailFetch = typeof fetch
export interface EmailHttpResponse { status: number; json: Record<string, unknown>; retryAfter: string | null }

/** Bounded reads, redirects forbidden, and no response body in exceptions. */
export async function emailHttp(
  fetchImpl: EmailFetch, url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number,
): Promise<EmailHttpResponse> {
  try {
    signal.throwIfAborted()
    const response = await fetchImpl(url, {
      ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          length += part.value.byteLength
          if (length > 32_768) throw new Error('EMAIL_RESPONSE_LIMIT')
          chunks.push(part.value)
        }
      } finally { await reader.cancel().catch(() => {}) }
    }
    let json: unknown
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { json = null }
    return {
      status: response.status,
      json: json !== null && typeof json === 'object' && !Array.isArray(json)
        ? json as Record<string, unknown> : {},
      retryAfter: response.headers.get('retry-after'),
    }
  } catch { throw new Error('EMAIL_HTTP_UNAVAILABLE') }
}
