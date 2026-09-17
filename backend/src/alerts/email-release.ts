import { emailReleaseConfiguration, type EmailReleaseConfig } from './email-release-config.js'
import { type EmailFetch } from './email-http.js'
import { EmailReleaseStore } from './email-release-store.js'
import { currentStateFrom } from './current-state.js'
import { messageSourceOf } from './message-source.js'
import { verifiedEmailRecipient } from './verified-email-recipient.js'
import { type VerifiedRecipient } from './routing-policy.js'
import { alertType } from './alert-catalog.js'
import { sendResendEmail } from './resend-email-transport.js'
import { emailDeadline } from './email-deadline.js'
import { notificationSeveritySql } from '../notifications/notification-severity.js'
import type { SqlRunner } from './pipeline-store.js'

/** The initial visibility gate, also exercised directly against disposable PostgreSQL. */
export async function emailNotificationVisible(
  runner: SqlRunner, organizationId: string, incidentKey: string, ownerUserId: string,
): Promise<boolean> {
  const rows = await runner.query([
    'SELECT 1 FROM notifications n',
    'JOIN notification_preferences p ON p.organization_id = n.organization_id AND p.user_id = $3::uuid',
    'WHERE n.organization_id = $1::uuid AND n.incident_key = $2',
    "AND p.email_enabled = true AND p.security_enabled = true AND p.digest_mode = 'off'",
    `AND ${notificationSeveritySql('n.severity')} >= ${notificationSeveritySql('p.minimum_severity')}`,
    'LIMIT 1',
  ].join(' '), [organizationId, incidentKey, ownerUserId])
  return rows.length > 0
}

export interface EmailRunReport {
  status: 'DISABLED' | 'INVALID_CONFIGURATION' | 'OUTSIDE_ACTIVATION_WINDOW' | 'NO_BUDGET'
    | 'NO_WORK' | 'WITHDRAWN' | 'SUPPRESSED' | 'ACCEPTED' | 'UNKNOWN' | 'RETRYABLE' | 'PERMANENT' | 'FAILED_SAFE'
  attempted: number
}
function configurationStillMatches(
  env: Readonly<Record<string, string | undefined>>, config: EmailReleaseConfig, now: number,
): boolean {
  const fresh = emailReleaseConfiguration(env, now)
  return fresh.enabled && (Object.keys(config) as (keyof EmailReleaseConfig)[])
    .every(key => fresh.config[key] === config[key])
}

/** No distributed atomicity promise: final Auth, then local veto, then bounded handoff. */
export async function runEmailRelease(options: {
  store: EmailReleaseStore; env: Readonly<Record<string, string | undefined>>
  deadlineAt: number; fetchImpl: EmailFetch; now?: () => number
}): Promise<EmailRunReport> {
  const now = options.now ?? Date.now
  const configuration = emailReleaseConfiguration(options.env, now())
  if (!configuration.enabled) return { status: configuration.reason, attempted: 0 }
  if (!Number.isFinite(options.deadlineAt) || options.deadlineAt - now() < 10_000) {
    return { status: 'NO_BUDGET', attempted: 0 }
  }
  const deadlineAt = Math.min(options.deadlineAt, now() + 25_000)
  const budget = emailDeadline(deadlineAt, now)
  const boundedFetch: EmailFetch = (input, init) => {
    budget.remaining()
    return options.fetchImpl(input, init)
  }
  const config = configuration.config
  let attempted = 0
  try {
    const signal = AbortSignal.timeout(budget.remaining())
    const claim = await options.store.claim(config, now())
    if (!claim) return { status: 'NO_WORK', attempted: 0 }
    let recipient: VerifiedRecipient | null = null
    const recipients = verifiedEmailRecipient(options.store.runner, config, boundedFetch, signal, now)
    const state = currentStateFrom(options.store.runner, async organizationId => {
      budget.remaining()
      recipient = await recipients(organizationId)
      return recipient
    })
    const source = messageSourceOf({ ...state,
      disposition: async (organizationId, type) => {
        budget.remaining()
        const declaration = alertType(type)
        if (declaration.category !== 'SECURITY') return 'RECORD_ONLY'
        const severity = await state.disposition(organizationId, type) ?? declaration.severity
        return severity === 'ACT_NOW' || severity === 'ACT_TODAY' ? severity : 'RECORD_ONLY'
      },
      visibility: async ref => {
        budget.remaining()
        return await emailNotificationVisible(options.store.runner, ref.organizationId, ref.incidentKey, config.ownerUserId)
          ? 'SURFACED' : 'CONTENT_UNAVAILABLE'
      },
    })
    budget.remaining()
    const resolution = await source.resolve(claim.job)
    if (!resolution.send || !recipient) {
      await options.store.withdraw(claim, resolution.send ? 'NO_VERIFIED_RECIPIENT' : resolution.because)
      return { status: 'WITHDRAWN', attempted: 0 }
    }
    if (await options.store.isSuppressed(resolution.to)) {
      await options.store.withdraw(claim, 'NO_VERIFIED_RECIPIENT', 'ADDRESS_SUPPRESSED')
      return { status: 'SUPPRESSED', attempted: 0 }
    }
    if (budget.remaining() < 15_000) return { status: 'NO_BUDGET', attempted: 0 }
    const envelope = await options.store.open(claim, recipient, resolution.body, now())
    if (!envelope) {
      await options.store.withdraw(claim, 'NO_VERIFIED_RECIPIENT', 'ADDRESS_SUPPRESSED')
      return { status: 'SUPPRESSED', attempted: 0 }
    }
    // Authoritative identity and approved lifecycle checks AFTER durable reservation.
    budget.remaining()
    const current = await source.resolve(claim.job)
    if (!current.send || current.to !== envelope.recipient) {
      await options.store.withdraw(claim, current.send ? 'NO_VERIFIED_RECIPIENT' : current.because, 'NOT_SENT_LOCAL_VETO')
      return { status: 'WITHDRAWN', attempted: 0 }
    }
    if (!configurationStillMatches(options.env, config, now())) {
      await options.store.withdraw(claim, 'ALERT_TYPE_DISABLED', 'CONFIGURATION_CHANGED')
      return { status: 'WITHDRAWN', attempted: 0 }
    }
    // Local DB authorization/suppression/claim veto is the LAST I/O before Resend.
    if (budget.remaining() < 8_000) return { status: 'NO_BUDGET', attempted: 0 }
    const typeCount = current.body.find(line => line.kind === 'TYPE_COUNT')
    if (!typeCount) throw new Error('EMAIL_CONTENT_UNAVAILABLE')
    if (!await options.store.maySend(claim, envelope, typeCount.alertTypeId, alertType(typeCount.alertTypeId).severity)) {
      await options.store.withdraw(claim, 'NO_VERIFIED_RECIPIENT', 'FINAL_LOCAL_VETO')
      return { status: 'WITHDRAWN', attempted: 0 }
    }
    if (!configurationStillMatches(options.env, config, now())) {
      await options.store.withdraw(claim, 'ALERT_TYPE_DISABLED', 'CONFIGURATION_CHANGED')
      return { status: 'WITHDRAWN', attempted: 0 }
    }
    const remaining = budget.remaining()
    if (remaining < 8_000) return { status: 'NO_BUDGET', attempted: 0 }
    attempted = 1
    const result = await sendResendEmail(config, envelope, boundedFetch, signal, Math.min(5_000, remaining - 3_000))
    await options.store.settle(claim, result, now())
    return { status: result.kind, attempted }
  } catch { return { status: 'FAILED_SAFE', attempted } }
}
