import { type AuthenticEvent } from './email-delivery.js'
import { type SqlRunner } from './pipeline-store.js'

export async function lockEmailProvider(tx: SqlRunner, providerId: string): Promise<void> {
  await tx.query('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`hawkview-email-provider/${providerId}`])
}

/** Caller holds the provider lock. Only frozen recipient provenance can suppress an address. */
export async function reconcileEmailProvider(tx: SqlRunner, providerId: string): Promise<void> {
  await tx.execute(`INSERT INTO alert_delivery_outcomes
      (id, provider_id, message_id, kind, bounce, because, occurred_at)
    SELECT gen_random_uuid(), e.provider_id, v.message_id, e.kind, e.bounce, NULL, e.occurred_at
      FROM alert_email_events e JOIN alert_email_envelopes v ON v.provider_id = e.provider_id
     WHERE e.provider_id = $1
    ON CONFLICT (provider_id, kind, occurred_at) DO NOTHING`, [providerId])
  await tx.execute(`INSERT INTO alert_suppressed_addresses
      (address, reason, because, message_id, first_suppressed_at, last_seen_at)
    SELECT DISTINCT ON (v.recipient_address)
      v.recipient_address, CASE WHEN e.kind = 'COMPLAINED' THEN 'COMPLAINT' ELSE 'HARD_BOUNCE' END,
      'AUTHENTICATED_PROVIDER_EVENT', v.message_id, e.occurred_at, e.occurred_at
      FROM alert_email_events e JOIN alert_email_envelopes v ON v.provider_id = e.provider_id
     WHERE e.provider_id = $1 AND v.recipient_address IS NOT NULL
       AND (e.kind = 'COMPLAINED' OR (e.kind = 'BOUNCED' AND e.bounce = 'HARD'))
     ORDER BY v.recipient_address, e.occurred_at
    ON CONFLICT (address) DO UPDATE
      SET last_seen_at = GREATEST(alert_suppressed_addresses.last_seen_at, EXCLUDED.last_seen_at)`, [providerId])
}

export async function recordEmailProviderEvent(
  runner: SqlRunner, eventId: string, event: AuthenticEvent,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(eventId) || event.providerId.length > 200) {
    throw new Error('EMAIL_EVENT_INVALID')
  }
  await runner.transaction(async tx => {
    // Acceptance and early webhooks serialize on the same provider ID.
    await lockEmailProvider(tx, event.providerId)
    await tx.execute(`INSERT INTO alert_email_events
      (event_id, provider_id, kind, bounce, occurred_at)
      VALUES ($1, $2, $3, $4, $5::timestamptz) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, event.providerId, event.kind,
      // Resend's email.bounced event documents permanent recipient-server rejection.
      event.kind === 'BOUNCED' ? event.bounce ?? 'HARD' : null, event.atIso])
    await reconcileEmailProvider(tx, event.providerId)
  })
}