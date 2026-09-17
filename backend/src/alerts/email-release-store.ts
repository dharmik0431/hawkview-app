import { randomUUID } from 'node:crypto'
import { type SqlRunner } from './pipeline-store.js'
import { type EmailReleaseConfig, EMAIL_ATTEMPTS } from './email-release-config.js'
import { type MessageId, type IdempotencyKey, type Body } from './email-delivery.js'
import { claimStatement, afterAttempt, backoffMs, workerId, type SendJob, type WorkerId } from './send-queue.js'
import { type WithdrawnReason } from './send-worker.js'
import { type VerifiedRecipient } from './routing-policy.js'
import { emailPayload, type FrozenEmail, type EmailProviderResult } from './resend-email-transport.js'
import { lockEmailProvider, reconcileEmailProvider } from './email-delivery-reconciliation.js'
import { notificationSeveritySql } from '../notifications/notification-severity.js'
import { claimRegularEmail, closeRegularEpoch, lockEmailReleaseScope, regularReservationGate,
  REGULAR_FINAL_GATE_SQL, type RegularEmailStatus } from './email-regular-release.js'
import { loadEmailIncidentContext, parseEmailIncidentScope } from './email-incident-context.js'

type JobRow = {
  message_id: string; idempotency_key: string; state: SendJob['state']; attempts_made: number
  max_attempts: number; not_before_at: Date | string; provider_id: string | null
}
type EnvelopeRow = {
  message_id: string; activation_id: string; organization_id: string; owner_user_id: string
  recipient_hash: string; starts_at: Date | string; expires_at: Date | string
  from_address: string; app_origin: string; recipient_address: string | null
  payload: string | null; idempotency_key: string
}
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
export interface EmailClaim { job: SendJob; by: WorkerId; config: EmailReleaseConfig }

export class EmailReleaseStore {
  regularStatus: RegularEmailStatus | null = null
  constructor(readonly runner: SqlRunner) {}

  closeRegularEpoch(activationId: string, organizationId: string, ownerUserId: string) {
    return closeRegularEpoch(this.runner, activationId, organizationId, ownerUserId)
  }

  async claim(config: EmailReleaseConfig, now: number): Promise<EmailClaim | null> {
    this.regularStatus = null
    return this.runner.transaction(async tx => {
      await lockEmailReleaseScope(tx, config.activationId, config.organizationId)
      if (config.mode === 'regular') {
        const result = await claimRegularEmail(tx, config)
        this.regularStatus = result.status
        return result.claim
      }
      if ((await tx.query(`SELECT 1 FROM alert_email_regular_epochs
        WHERE activation_id = $1::uuid OR (organization_id = $2::uuid AND closed_at IS NULL) LIMIT 1`,
      [config.activationId, config.organizationId])).length) return null
      const existing = await tx.query<EnvelopeRow>(
        'SELECT * FROM alert_email_envelopes WHERE activation_id = $1::uuid', [config.activationId])
      const envelope = existing[0]
      if (envelope && (envelope.organization_id !== config.organizationId
        || envelope.owner_user_id !== config.ownerUserId || envelope.recipient_hash !== config.recipientHash
        || iso(envelope.starts_at) !== config.startsAt || iso(envelope.expires_at) !== config.expiresAt
        || envelope.from_address !== config.from || envelope.app_origin !== config.appOrigin)) {
        throw new Error('EMAIL_ACTIVATION_IMMUTABLE')
      }
      if (!envelope) {
        const overlaps = await tx.query(`SELECT 1 FROM alert_email_envelopes
          WHERE organization_id = $1::uuid AND expires_at > $2::timestamptz LIMIT 1`,
        [config.organizationId, config.startsAt])
        if (overlaps.length) return null
      }
      const rows = envelope
        ? await tx.query<JobRow>('SELECT * FROM alert_send_jobs WHERE message_id = $1 FOR UPDATE', [envelope.message_id])
        : await tx.query<JobRow>(`SELECT j.* FROM alert_send_jobs j
            WHERE j.state IN ('READY', 'CLAIMED') AND j.attempts_made = 0
              AND j.not_before_at <= $1::timestamptz
              AND (j.claim_expires_at IS NULL OR j.claim_expires_at <= $1::timestamptz)
              AND j.created_at >= $2::timestamptz AND j.created_at < $3::timestamptz
              AND split_part(j.message_id, '|', 1) = 'incident/' || $4
              AND NOT EXISTS (SELECT 1 FROM alert_email_envelopes v WHERE v.message_id = j.message_id)
              AND EXISTS (SELECT 1 FROM notifications n WHERE n.organization_id = $4::uuid
                AND n.incident_key = substring(j.message_id FROM position('|' IN j.message_id) + 1)
                AND n.first_occurred_at >= $2::timestamptz AND n.created_at >= $2::timestamptz)
              AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.organization_id = $4::uuid
                AND n.incident_key = substring(j.message_id FROM position('|' IN j.message_id) + 1)
                AND n.first_occurred_at < $2::timestamptz)
            ORDER BY j.created_at, j.message_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [new Date(now).toISOString(), config.startsAt, config.expiresAt, config.organizationId])
      const row = rows[0]
      if (!row || !['READY', 'CLAIMED'].includes(row.state)) return null
      if (row.attempts_made >= Math.min(row.max_attempts, EMAIL_ATTEMPTS)) {
        await tx.execute(`UPDATE alert_send_jobs SET state = 'EXHAUSTED',
          claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE message_id = $1 AND state IN ('READY', 'CLAIMED')
            AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())`, [row.message_id])
        return null
      }
      const by = workerId(`email/${randomUUID()}`)
      const statement = claimStatement(row.message_id as MessageId, by, new Date(now).toISOString(), 30_000)
      if (await tx.execute(statement.sql, statement.params) !== 1) return null
      if (!envelope) {
        await tx.execute(`INSERT INTO alert_email_envelopes
          (message_id, activation_id, organization_id, owner_user_id, recipient_hash, starts_at,
           expires_at, from_address, app_origin, idempotency_key)
          VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10)`,
        [row.message_id, config.activationId, config.organizationId, config.ownerUserId,
          config.recipientHash, config.startsAt, config.expiresAt, config.from, config.appOrigin,
          `hv-email-v1-${randomUUID()}`])
      }
      return { by, config, job: {
        messageId: row.message_id as MessageId, idempotencyKey: row.idempotency_key as IdempotencyKey,
        state: row.state, attemptsMade: row.attempts_made, maxAttempts: Math.min(row.max_attempts, EMAIL_ATTEMPTS),
        notBeforeIso: iso(row.not_before_at), claim: null, providerId: null,
      } }
    })
  }

  async isSuppressed(address: string): Promise<boolean> {
    return (await this.runner.query('SELECT 1 FROM alert_suppressed_addresses WHERE address = $1', [address])).length > 0
  }

  async open(claim: EmailClaim, recipient: VerifiedRecipient, body: Body, now: number): Promise<FrozenEmail | null> {
    this.regularStatus = null
    return this.runner.transaction(async tx => {
      if (claim.config.mode === 'regular') {
        this.regularStatus = await regularReservationGate(tx, claim)
        if (this.regularStatus) return null
        const clock = await tx.query<{ at: Date | string }>('SELECT clock_timestamp() AS at', [])
        now = Date.parse(iso(clock[0].at))
      }
      const live = await tx.query(`SELECT 1 FROM alert_send_jobs
        WHERE message_id = $1 AND state = 'CLAIMED' AND claimed_by = $2
          AND attempts_made = $3 AND attempts_made < LEAST(max_attempts, 3)
          AND claim_expires_at > clock_timestamp() + interval '7 seconds' FOR UPDATE`,
      [claim.job.messageId, claim.by, claim.job.attemptsMade])
      if (live.length !== 1) throw new Error('EMAIL_CLAIM_LOST')
      if ((await tx.query('SELECT 1 FROM alert_suppressed_addresses WHERE address = $1', [recipient.address])).length) return null
      const envelopes = await tx.query<EnvelopeRow>(
        'SELECT * FROM alert_email_envelopes WHERE message_id = $1 FOR UPDATE', [claim.job.messageId])
      const row = envelopes[0]
      if (!row || Date.parse(iso(row.expires_at)) <= now) throw new Error('EMAIL_WINDOW_EXPIRED')
      if (row.recipient_address !== null && row.recipient_address !== recipient.address) throw new Error('EMAIL_RECIPIENT_CHANGED')
      // Existing accepted/uncertain/legacy payloads are retry authority: never load or upgrade their context.
      const payload = row.payload ?? emailPayload(claim.config, recipient.address, body,
        await loadEmailIncidentContext(tx, claim.job.messageId, claim.config.ownerUserId))
      if (row.payload === null) {
        await tx.execute(`UPDATE alert_email_envelopes SET recipient_address = $2,
          verified_at = $3::timestamptz, payload = $4 WHERE message_id = $1 AND payload IS NULL`,
        [claim.job.messageId, recipient.address, recipient.verifiedAt.toISOString(), payload])
      }
      const attemptNo = claim.job.attemptsMade + 1
      await tx.execute(`INSERT INTO alert_send_attempts (id, message_id, attempt_no, started_at)
        VALUES (gen_random_uuid(), $1, $2, $3::timestamptz)`,
      [claim.job.messageId, attemptNo, new Date(now).toISOString()])
      await tx.execute(`UPDATE alert_send_jobs SET attempts_made = attempts_made + 1,
        not_before_at = $3::timestamptz, updated_at = now()
        WHERE message_id = $1 AND claimed_by = $2 AND state = 'CLAIMED'`,
      [claim.job.messageId, claim.by, new Date(now + backoffMs(attemptNo)).toISOString()])
      return { key: row.idempotency_key, payload, recipient: recipient.address }
    })
  }

  async maySend(claim: EmailClaim, envelope: FrozenEmail, alertTypeId: string, defaultDisposition: string): Promise<boolean> {
    const scope = parseEmailIncidentScope(claim.job.messageId)
    if (!scope || scope.organizationId !== claim.config.organizationId || scope.alertTypeId !== alertTypeId) return false
    const rows = await this.runner.query(`SELECT 1 FROM alert_send_jobs j
      JOIN alert_email_envelopes v ON v.message_id = j.message_id
      JOIN users u ON u.id = v.owner_user_id
      JOIN memberships m ON m.user_id = u.id AND m.organization_id = v.organization_id
      JOIN organizations o ON o.id = m.organization_id
      JOIN customer_tenants t ON t.id = $8::uuid AND t.organization_id = o.id
      JOIN notification_preferences p ON p.user_id = u.id AND p.organization_id = o.id
      JOIN alert_incidents i ON i.organization_id = o.id
        AND i.incident_key = substring(j.message_id FROM position('|' IN j.message_id) + 1)
      LEFT JOIN alert_rule_dispositions d ON d.organization_id = i.organization_id AND d.alert_type_id = i.alert_type_id
      WHERE j.message_id = $1 AND j.claimed_by = $2 AND j.state = 'CLAIMED'
        AND j.attempts_made = $3 AND j.claim_expires_at > clock_timestamp() + interval '6 seconds'
        AND v.expires_at > clock_timestamp() + interval '6 seconds'
        AND v.recipient_address = $4 AND v.idempotency_key = $5
        AND v.organization_id = $9::uuid AND v.owner_user_id = $10::uuid
        AND u.disabled_at IS NULL AND lower(btrim(u.email)) = v.recipient_address
        AND m.status = 'ACTIVE' AND m.role = 'MSP_OWNER' AND o.status = 'ACTIVE'
        AND p.email_enabled = true AND p.security_enabled = true AND p.digest_mode = 'off'
        AND i.alert_type_id = $6 AND COALESCE(d.disposition, $7) IN ('ACT_NOW', 'ACT_TODAY')
        AND i.investigation = 'OPEN' AND i.condition IN ('ACTIVE', 'UNKNOWN', 'CLEARED')
        AND i.ownership IN ('ACKNOWLEDGED', 'UNACKNOWLEDGED')
        AND (i.condition <> 'CLEARED' OR i.ownership = 'UNACKNOWLEDGED')
        AND EXISTS (SELECT 1 FROM notifications n WHERE n.organization_id = o.id AND n.incident_key = i.incident_key
          AND n.customer_tenant_id = t.id AND (n.recipient_user_id IS NULL OR n.recipient_user_id = u.id)
          AND ${notificationSeveritySql('n.severity')}
            >= ${notificationSeveritySql('p.minimum_severity')})
        ${claim.config.mode === 'regular' ? REGULAR_FINAL_GATE_SQL : "AND v.release_mode = 'controlled'"}
        AND NOT EXISTS (SELECT 1 FROM alert_suppressed_addresses WHERE address = $4)`,
    [claim.job.messageId, claim.by, claim.job.attemptsMade + 1, envelope.recipient, envelope.key, alertTypeId, defaultDisposition,
      scope.customerTenantId, scope.organizationId, claim.config.ownerUserId])
    return rows.length === 1
  }

  async withdraw(claim: EmailClaim, reason: WithdrawnReason, detail: string = reason): Promise<void> {
    await this.runner.transaction(async tx => {
      const changed = await tx.execute(`UPDATE alert_send_jobs SET state = 'WITHDRAWN',
        withdrawn_at = now(), withdrawn_because = $3,
        claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE message_id = $1 AND state = 'CLAIMED' AND claimed_by = $2
          AND claim_expires_at > clock_timestamp()`, [claim.job.messageId, claim.by, reason])
      if (changed === 1) {
        await tx.execute('UPDATE alert_email_envelopes SET stop_code = $2 WHERE message_id = $1', [claim.job.messageId, detail])
        // No provider was called for this reservation. Do not invent a provider settlement.
        await tx.execute(`UPDATE alert_send_attempts SET because = 'NOT_SENT_LOCAL_VETO'
          WHERE message_id = $1 AND attempt_no = $2 AND settled_kind IS NULL`,
        [claim.job.messageId, claim.job.attemptsMade + 1])
      }
    })
  }

  async settle(claim: EmailClaim, result: EmailProviderResult, now: number): Promise<void> {
    await this.runner.transaction(async tx => {
      if (result.kind === 'ACCEPTED') await lockEmailProvider(tx, result.providerId)
      const atIso = new Date(now).toISOString()
      const settled = result.kind === 'ACCEPTED'
        ? { kind: 'ACCEPTED' as const, providerId: result.providerId as NonNullable<SendJob['providerId']>, atIso }
        : { kind: result.kind === 'PERMANENT' ? 'REFUSED_PERMANENT' as const : 'REFUSED_RETRYABLE' as const,
            because: result.code, atIso }
      const next = afterAttempt(claim.job, settled)
      const nextAt = result.kind === 'RETRYABLE'
        ? new Date(Math.max(Date.parse(next.notBeforeIso), now + Math.min(result.retryAfterMs, 3_600_000))).toISOString()
        : next.notBeforeIso
      const changed = await tx.execute(`UPDATE alert_send_jobs SET state = $4, provider_id = $5,
        not_before_at = $6::timestamptz, claimed_by = NULL, claimed_at = NULL,
        claim_expires_at = NULL, updated_at = now()
        WHERE message_id = $1 AND claimed_by = $2 AND attempts_made = $3
          AND state = 'CLAIMED' AND claim_expires_at > clock_timestamp()`,
      [claim.job.messageId, claim.by, claim.job.attemptsMade + 1, next.state,
        result.kind === 'ACCEPTED' ? result.providerId : null, nextAt])
      if (changed !== 1) throw new Error('EMAIL_CLAIM_LOST')
      // UNKNOWN remains open, never persisted as a provider refusal or delivery.
      const attempts = await tx.execute(`UPDATE alert_send_attempts SET settled_kind = $3,
        settled_at = $4::timestamptz, provider_id = $5, because = $6
        WHERE message_id = $1 AND attempt_no = $2 AND settled_kind IS NULL`,
      [claim.job.messageId, claim.job.attemptsMade + 1,
        result.kind === 'UNKNOWN' ? null : settled.kind,
        result.kind === 'UNKNOWN' ? null : atIso,
        result.kind === 'ACCEPTED' ? result.providerId : null,
        result.kind === 'ACCEPTED' ? null : result.code])
      if (attempts !== 1) throw new Error('EMAIL_ATTEMPT_LOST')
      if (result.kind === 'ACCEPTED') {
        await tx.execute(`UPDATE alert_email_envelopes SET provider_id = $2
          WHERE message_id = $1 AND (provider_id IS NULL OR provider_id = $2)`, [claim.job.messageId, result.providerId])
        await reconcileEmailProvider(tx, result.providerId)
      }
    })
  }
}
