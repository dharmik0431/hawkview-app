import { type Body } from './email-delivery.js'
import { type EmailReleaseConfig, UUID } from './email-release-config.js'
import { emailHttp, type EmailFetch } from './email-http.js'
import { allowlistedAlertEmailUrl } from './email-alert-content.js'
import { renderAlertEmail } from './email-alert-template.js'
import { type EmailIncidentContext } from './email-incident-context.js'

export interface FrozenEmail {
  readonly key: string
  readonly payload: string
  readonly recipient: string
}
export type EmailProviderResult =
  | { kind: 'ACCEPTED'; providerId: string }
  | { kind: 'UNKNOWN'; code: 'PROVIDER_OUTCOME_UNKNOWN' }
  | { kind: 'RETRYABLE'; code: 'PROVIDER_BUSY' | 'PROVIDER_RATE_LIMITED'; retryAfterMs: number }
  | { kind: 'PERMANENT'; code: 'PROVIDER_REQUEST_REJECTED' }

export function emailPayload(config: EmailReleaseConfig, address: string, body: Body, context?: EmailIncidentContext): string {
  allowlistedAlertEmailUrl(config.appOrigin)
  // Only NEW envelopes reach this renderer. The store reuses existing serialized payloads,
  // including legacy plaintext-only messages, byte-for-byte with their original provider key.
  // Preserve the legacy no-context factory. Rich new envelopes are budgeted using
  // COMPLETE serialized UTF-8 bytes, including escaping and address metadata.
  for (const limit of context ? [160, 96, 48, 24] : [160]) {
    const payload = JSON.stringify({
      from: config.from, to: [address], ...renderAlertEmail(body, 'live', context, limit),
    })
    if (!context || Buffer.byteLength(payload, 'utf8') <= 8192) return payload
  }
  throw new Error('EMAIL_CONTENT_UNAVAILABLE')
}

/** This adapter never infers an address suppression from an HTTP error. */
export async function sendResendEmail(
  config: EmailReleaseConfig, envelope: FrozenEmail, fetchImpl: EmailFetch, signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<EmailProviderResult> {
  try {
    const response = await emailHttp(fetchImpl, 'https://api.resend.com/emails', {
      method: 'POST', headers: {
        Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json',
        'Idempotency-Key': envelope.key,
      }, body: envelope.payload,
    }, signal, Math.max(1, Math.min(5_000, Math.floor(timeoutMs))))
    if (response.status >= 200 && response.status < 300) {
      return typeof response.json.id === 'string' && UUID.test(response.json.id)
        ? { kind: 'ACCEPTED', providerId: response.json.id }
        : { kind: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' }
    }
    if (response.status === 429) {
      return { kind: 'RETRYABLE', code: 'PROVIDER_RATE_LIMITED',
        retryAfterMs: resendRetryAfterMs(response.retryAfter, Date.now()) }
    }
    if (response.status >= 500 || response.status === 408) {
      return { kind: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' }
    }
    if (response.status === 409 && response.json.name === 'concurrent_idempotent_requests') {
      return { kind: 'RETRYABLE', code: 'PROVIDER_BUSY', retryAfterMs: 60_000 }
    }
    return { kind: 'PERMANENT', code: 'PROVIDER_REQUEST_REJECTED' }
  } catch { return { kind: 'UNKNOWN', code: 'PROVIDER_OUTCOME_UNKNOWN' } }
}

export function resendRetryAfterMs(raw: string | null, now: number): number {
  const value = raw?.trim() ?? ''
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000
    return Number.isSafeInteger(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER
  }
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const date = Date.parse(value)
    if (Number.isFinite(date) && Number.isFinite(now)) return Math.max(0, date - now)
  }
  return 300_000
}
