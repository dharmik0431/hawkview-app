import { randomUUID } from 'node:crypto'
import { type SqlRunner } from './pipeline-store.js'
import { type EmailReleaseConfig, emailHash, UUID } from './email-release-config.js'
import { type EmailClaim } from './email-release-store.js'
import { type MessageId, type IdempotencyKey } from './email-delivery.js'
import { claimStatement, workerId, type SendJob } from './send-queue.js'
import { ELIGIBLE_OWNER_SQL } from './verified-email-recipient.js'
import { parseEmailIncidentScope } from './email-incident-context.js'
import { notificationSeveritySql } from '../notifications/notification-severity.js'
import { ALERT_CATALOG } from './alert-catalog.js'

export type RegularEmailStatus = 'REGULAR_EPOCH_CLOSED' | 'REGULAR_EPOCH_CONFLICT'
  | 'REGULAR_RECIPIENT_UNAVAILABLE' | 'REGULAR_LEASE_HELD' | 'REGULAR_RATE_LIMITED'
  | 'REGULAR_STALE' | 'REGULAR_RETRY_EXPIRED'
export const REGULAR_HOUR_MS = 3_600_000
export const REGULAR_NEW_LIMIT = 6
export const REGULAR_ATTEMPT_LIMIT = 12
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
type Epoch = {
  activation_id: string; organization_id: string; owner_user_id: string; recipient_hash: string
  from_address: string; app_origin: string; declared_cutoff: Date | string
  effective_cutoff: Date | string; created_at: Date | string; closed_at: Date | string | null
}
type Job = {
  message_id: string; idempotency_key: string; state: SendJob['state']; attempts_made: number
  max_attempts: number; not_before_at: Date | string; provider_id: string | null; created_at: Date | string
  envelope_id: string | null; expires_at: Date | string | null
}
type Result = { claim: EmailClaim | null; status: RegularEmailStatus | null }

/** Stable lock order, including activation IDs attempted across different organizations. */
export async function lockEmailReleaseScope(tx: SqlRunner, activationId: string, organizationId: string) {
  await tx.query('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))',
    ['hawkview-email-activation-id/' + activationId])
  await tx.query('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))',
    ['hawkview-email-activation/' + organizationId])
}
function matches(epoch: Epoch, config: EmailReleaseConfig) {
  return epoch.organization_id === config.organizationId && epoch.owner_user_id === config.ownerUserId
    && epoch.recipient_hash === config.recipientHash && epoch.from_address === config.from
    && epoch.app_origin === config.appOrigin && iso(epoch.declared_cutoff) === config.startsAt
}
async function epochFor(tx: SqlRunner, config: EmailReleaseConfig, at: string): Promise<Epoch | RegularEmailStatus> {
  const rows = await tx.query<Epoch>('SELECT * FROM alert_email_regular_epochs WHERE activation_id = $1::uuid',
    [config.activationId])
  if (rows[0]) {
    if (!matches(rows[0], config)) return 'REGULAR_EPOCH_CONFLICT'
    return rows[0].closed_at === null ? rows[0] : 'REGULAR_EPOCH_CLOSED'
  }
  const conflict = await tx.query(`SELECT 1 FROM alert_email_envelopes
    WHERE activation_id = $1::uuid OR (organization_id = $2::uuid
      AND release_mode = 'controlled' AND expires_at > $3::timestamptz) LIMIT 1`,
  [config.activationId, config.organizationId, at])
  if (conflict.length) return 'REGULAR_EPOCH_CONFLICT'
  const prior = await tx.query<Epoch>(`SELECT * FROM alert_email_regular_epochs
    WHERE organization_id = $1::uuid ORDER BY effective_cutoff DESC LIMIT 1`, [config.organizationId])
  if (prior[0] && (prior[0].closed_at === null
    || Date.parse(config.startsAt) < Date.parse(iso(prior[0].closed_at)))) return 'REGULAR_EPOCH_CONFLICT'
  const created = await tx.query<Epoch>(`INSERT INTO alert_email_regular_epochs
    (activation_id, organization_id, owner_user_id, recipient_hash, from_address, app_origin,
      declared_cutoff, effective_cutoff, created_at)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz,
      GREATEST($7::timestamptz, $8::timestamptz), $8::timestamptz) RETURNING *`,
  [config.activationId, config.organizationId, config.ownerUserId, config.recipientHash,
    config.from, config.appOrigin, config.startsAt, at])
  if (!created[0]) throw new Error('EMAIL_EPOCH_UNAVAILABLE')
  return created[0]
}

/** Durable no-send classification, never a fabricated provider result. */
async function stopJob(tx: SqlRunner, messageId: string, code: RegularEmailStatus, by: string | null = null) {
  await tx.execute(`UPDATE alert_send_jobs SET state = 'WITHDRAWN', withdrawn_at = clock_timestamp(),
    withdrawn_because = 'MESSAGE_CONTENT_UNAVAILABLE', email_stop_code = $2,
    claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
    WHERE message_id = $1 AND state IN ('READY', 'CLAIMED')
      AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp() OR claimed_by = $3)`,
  [messageId, code, by])
  await tx.execute('UPDATE alert_email_envelopes SET stop_code = $2 WHERE message_id = $1', [messageId, code])
}
async function deferJob(tx: SqlRunner, messageId: string, by: string | null, at: string) {
  await tx.execute(`UPDATE alert_send_jobs SET state = 'READY', email_stop_code = 'REGULAR_RATE_LIMITED',
    not_before_at = GREATEST(not_before_at, $3::timestamptz + interval '1 minute'),
    claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
    WHERE message_id = $1 AND state IN ('READY', 'CLAIMED')
      AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp() OR claimed_by = $2)`,
  [messageId, by, at])
}
const boundary = "GREATEST(e.effective_cutoff, p.updated_at, COALESCE(d.updated_at, e.effective_cutoff))"

/** Additional conditions inside the existing last-I/O authorization query. */
export const REGULAR_FINAL_GATE_SQL = `AND v.release_mode = 'regular'
  AND EXISTS (SELECT 1 FROM alert_email_regular_epochs e
    WHERE e.activation_id = v.regular_epoch_id AND e.closed_at IS NULL
      AND e.organization_id = v.organization_id AND e.owner_user_id = v.owner_user_id
      AND e.recipient_hash = v.recipient_hash AND e.from_address = v.from_address AND e.app_origin = v.app_origin
      AND j.created_at >= ${boundary}
      AND EXISTS (SELECT 1 FROM notifications rn WHERE rn.organization_id = o.id AND rn.incident_key = i.incident_key
        AND rn.first_occurred_at >= ${boundary} AND rn.created_at >= ${boundary})
      AND NOT EXISTS (SELECT 1 FROM notifications rn WHERE rn.organization_id = o.id AND rn.incident_key = i.incident_key
        AND (rn.first_occurred_at < ${boundary} OR rn.created_at < ${boundary})))`

async function evidenceEligible(tx: SqlRunner, config: EmailReleaseConfig, epoch: Epoch, job: Job, fresh: boolean, at: string) {
  const scope = parseEmailIncidentScope(job.message_id)
  if (!scope || scope.organizationId !== config.organizationId) return false
  const declaration = ALERT_CATALOG.find(entry => entry.id === scope.alertTypeId)
  if (!declaration || declaration.category !== 'SECURITY') return false
  const key = job.message_id.slice(job.message_id.indexOf('|') + 1)
  const rows = await tx.query<{ eligible: boolean }>(`SELECT
      bool_and(n.customer_tenant_id = $4::uuid
        AND n.first_occurred_at >= GREATEST($5::timestamptz, p.updated_at, COALESCE(d.updated_at, $5::timestamptz))
        AND n.created_at >= GREATEST($5::timestamptz, p.updated_at, COALESCE(d.updated_at, $5::timestamptz))
        AND $6::timestamptz >= GREATEST($5::timestamptz, p.updated_at, COALESCE(d.updated_at, $5::timestamptz))
        AND (NOT $7::boolean OR (n.first_occurred_at >= $8::timestamptz - interval '1 hour'
          AND n.first_occurred_at <= $8::timestamptz AND n.created_at <= $8::timestamptz
          AND $6::timestamptz >= $8::timestamptz - interval '1 hour'
          AND $6::timestamptz <= $8::timestamptz))) AND
      bool_or(${notificationSeveritySql('n.severity')} >= ${notificationSeveritySql('p.minimum_severity')}) AS eligible
    FROM notifications n
    JOIN customer_tenants t ON t.id = n.customer_tenant_id AND t.organization_id = n.organization_id
    JOIN notification_preferences p ON p.organization_id = n.organization_id AND p.user_id = $3::uuid
    JOIN alert_incidents i ON i.organization_id = n.organization_id AND i.incident_key = n.incident_key
      AND i.alert_type_id = n.alert_type_id
    LEFT JOIN alert_rule_dispositions d ON d.organization_id = n.organization_id AND d.alert_type_id = n.alert_type_id
    WHERE n.organization_id = $1::uuid AND n.incident_key = $2
      AND (n.recipient_user_id IS NULL OR n.recipient_user_id = $3::uuid)
      AND p.email_enabled = true AND p.security_enabled = true AND p.digest_mode = 'off'
      AND COALESCE(d.disposition, $9) IN ('ACT_NOW', 'ACT_TODAY')
      AND i.investigation = 'OPEN' AND i.condition IN ('ACTIVE', 'UNKNOWN', 'CLEARED')
      AND i.ownership IN ('ACKNOWLEDGED', 'UNACKNOWLEDGED')
      AND (i.condition <> 'CLEARED' OR i.ownership = 'UNACKNOWLEDGED')`,
  [config.organizationId, key, config.ownerUserId, scope.customerTenantId, iso(epoch.effective_cutoff),
    iso(job.created_at), fresh, at, declaration.severity])
  return rows.length === 1 && rows[0].eligible === true
}

/** Caller holds activation-ID then organization lock for the entire transaction. */
export async function claimRegularEmail(tx: SqlRunner, config: EmailReleaseConfig): Promise<Result> {
  const clock = await tx.query<{ at: Date | string }>('SELECT clock_timestamp() AS at', [])
  const at = iso(clock[0].at)
  const epoch = await epochFor(tx, config, at)
  if (typeof epoch === 'string') return { claim: null, status: epoch }
  // This durable queue lease survives COMMIT; an advisory transaction lock alone does not.
  const live = await tx.query(`SELECT 1 FROM alert_send_jobs WHERE state = 'CLAIMED'
    AND claim_expires_at > clock_timestamp()
    AND split_part(message_id, '|', 1) = 'incident/' || $1 LIMIT 1`, [config.organizationId])
  if (live.length) return { claim: null, status: 'REGULAR_LEASE_HELD' }
  const owners = await tx.query<{ email: string }>(ELIGIBLE_OWNER_SQL, [config.organizationId, config.ownerUserId])
  if (owners.length !== 1 || emailHash(owners[0].email) !== config.recipientHash) {
    return { claim: null, status: 'REGULAR_RECIPIENT_UNAVAILABLE' }
  }
  const jobs = await tx.query<Job>(`SELECT j.*, v.message_id AS envelope_id, v.expires_at
    FROM alert_send_jobs j LEFT JOIN alert_email_envelopes v ON v.message_id = j.message_id
    WHERE j.state IN ('READY', 'CLAIMED') AND j.not_before_at <= $1::timestamptz
      AND (j.claim_expires_at IS NULL OR j.claim_expires_at <= $1::timestamptz)
      AND split_part(j.message_id, '|', 1) = 'incident/' || $2
      AND ((v.release_mode = 'regular' AND v.regular_epoch_id = $3::uuid)
        OR (v.message_id IS NULL AND j.attempts_made = 0 AND j.created_at >= $4::timestamptz))
    ORDER BY (v.message_id IS NOT NULL) DESC, j.created_at, j.message_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
  [at, config.organizationId, config.activationId, iso(epoch.effective_cutoff)])
  const row = jobs[0]
  if (!row) return { claim: null, status: null }
  if (row.attempts_made >= Math.min(row.max_attempts, 3)
    || (row.expires_at && Date.parse(iso(row.expires_at)) <= Date.parse(at) + 15_000)) {
    await stopJob(tx, row.message_id, 'REGULAR_RETRY_EXPIRED')
    return { claim: null, status: 'REGULAR_RETRY_EXPIRED' }
  }
  if (!await evidenceEligible(tx, config, epoch, row, !row.envelope_id, at)) {
    await stopJob(tx, row.message_id, 'REGULAR_STALE')
    return { claim: null, status: 'REGULAR_STALE' }
  }
  if (!row.envelope_id) {
    const count = await tx.query<{ total: number }>(`SELECT count(*)::int AS total FROM alert_email_envelopes
      WHERE organization_id = $1::uuid AND created_at >= $2::timestamptz - interval '1 hour'`,
    [config.organizationId, at])
    if (count[0].total >= REGULAR_NEW_LIMIT) {
      await deferJob(tx, row.message_id, null, at)
      return { claim: null, status: 'REGULAR_RATE_LIMITED' }
    }
  }
  const by = workerId('email/' + randomUUID())
  const statement = claimStatement(row.message_id as MessageId, by, at, 30_000)
  if (await tx.execute(statement.sql, statement.params) !== 1) return { claim: null, status: 'REGULAR_LEASE_HELD' }
  if (!row.envelope_id) {
    await tx.execute(`INSERT INTO alert_email_envelopes
      (message_id, activation_id, regular_epoch_id, release_mode, organization_id, owner_user_id,
        recipient_hash, starts_at, expires_at, from_address, app_origin, idempotency_key, created_at)
      VALUES ($1, $2::uuid, $2::uuid, 'regular', $3::uuid, $4::uuid, $5, $6::timestamptz,
        $6::timestamptz + interval '1 hour', $7, $8, $9, $6::timestamptz)`,
    [row.message_id, config.activationId, config.organizationId, config.ownerUserId,
      config.recipientHash, at, config.from, config.appOrigin, 'hv-email-v1-' + randomUUID()])
  }
  await tx.execute('UPDATE alert_send_jobs SET email_stop_code = NULL WHERE message_id = $1', [row.message_id])
  return { status: null, claim: { config, by, job: {
    messageId: row.message_id as MessageId, idempotencyKey: row.idempotency_key as IdempotencyKey,
    state: row.state, attemptsMade: row.attempts_made, maxAttempts: Math.min(row.max_attempts, 3),
    notBeforeIso: iso(row.not_before_at), claim: null, providerId: null,
  } } }
}

/** Runs in the SAME transaction as the existing durable attempt reservation. */
export async function regularReservationGate(tx: SqlRunner, claim: EmailClaim): Promise<RegularEmailStatus | null> {
  await lockEmailReleaseScope(tx, claim.config.activationId, claim.config.organizationId)
  const rows = await tx.query<Epoch>('SELECT * FROM alert_email_regular_epochs WHERE activation_id = $1::uuid',
    [claim.config.activationId])
  const epoch = rows[0]
  if (!epoch || !matches(epoch, claim.config) || epoch.closed_at !== null) {
    await stopJob(tx, claim.job.messageId, 'REGULAR_EPOCH_CLOSED', claim.by)
    return 'REGULAR_EPOCH_CLOSED'
  }
  const clock = await tx.query<{ at: Date | string }>('SELECT clock_timestamp() AS at', [])
  const at = iso(clock[0].at)
  const jobs = await tx.query<Job>(`SELECT j.*, v.message_id AS envelope_id, v.expires_at
    FROM alert_send_jobs j JOIN alert_email_envelopes v ON v.message_id = j.message_id
    WHERE j.message_id = $1 AND j.state = 'CLAIMED' AND j.claimed_by = $2
      AND j.claim_expires_at > clock_timestamp() + interval '7 seconds'
      AND v.release_mode = 'regular' AND v.regular_epoch_id = $3::uuid FOR UPDATE OF j`,
  [claim.job.messageId, claim.by, claim.config.activationId])
  const job = jobs[0]
  if (!job) throw new Error('EMAIL_CLAIM_LOST')
  if (!job.expires_at || Date.parse(iso(job.expires_at)) <= Date.parse(at) + 15_000) {
    await stopJob(tx, job.message_id, 'REGULAR_RETRY_EXPIRED', claim.by)
    return 'REGULAR_RETRY_EXPIRED'
  }
  if (!await evidenceEligible(tx, claim.config, epoch, job, false, at)) {
    await stopJob(tx, job.message_id, 'REGULAR_STALE', claim.by)
    return 'REGULAR_STALE'
  }
  const count = await tx.query<{ total: number }>(`SELECT count(*)::int AS total
    FROM alert_send_attempts a JOIN alert_email_envelopes v ON v.message_id = a.message_id
    WHERE v.organization_id = $1::uuid AND a.started_at >= $2::timestamptz - interval '1 hour'`,
  [claim.config.organizationId, at])
  if (count[0].total >= REGULAR_ATTEMPT_LIMIT) {
    await deferJob(tx, job.message_id, claim.by, at)
    return 'REGULAR_RATE_LIMITED'
  }
  return null
}

export async function closeRegularEpoch(runner: SqlRunner, activationId: string, organizationId: string, ownerUserId: string) {
  if (![activationId, organizationId, ownerUserId].every(id => UUID.test(id))) return false
  return runner.transaction(async tx => {
    await lockEmailReleaseScope(tx, activationId, organizationId)
    const changed = await tx.execute(`UPDATE alert_email_regular_epochs SET closed_at = clock_timestamp()
      WHERE activation_id = $1::uuid AND organization_id = $2::uuid AND owner_user_id = $3::uuid
        AND closed_at IS NULL`, [activationId, organizationId, ownerUserId])
    if (changed === 1) return true
    const rows = await tx.query(`SELECT 1 FROM alert_email_regular_epochs
      WHERE activation_id = $1::uuid AND organization_id = $2::uuid AND owner_user_id = $3::uuid
        AND closed_at IS NOT NULL`, [activationId, organizationId, ownerUserId])
    return rows.length === 1
  })
}
