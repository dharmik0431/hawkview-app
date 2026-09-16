import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { messageId, type MessageId, type ProviderMessageId } from './email-delivery.js'
import { type OutcomeRow } from './delivery-events.js'
import { type AuthenticEvent } from './email-delivery.js'
import { emailSqlRunner } from './email-sql-runner.js'
import { recordEmailProviderEvent } from './email-delivery-reconciliation.js'

/**
 * WHERE A DELIVERY OUTCOME BECOMES DURABLE.
 *
 * THE GAP THIS CLOSES: a hard bounce already suppressed an address durably, so after a restart
 * the system knew a mailbox was dead and could not say which message proved it. The remedy
 * survived and the evidence did not.
 *
 * Raw SQL rather than the Prisma model API, matching `pipeline-store.ts` — the CHECK constraints
 * in the migration are the real contract and a client that bypassed them would be a second place
 * that decides what a valid row is.
 */

/** Raw SQL without naming the client. `PrismaService` and a `$transaction` client both satisfy it. */
export interface SqlRunner {
  query<T>(sql: string, params: readonly unknown[]): Promise<T>
  execute(sql: string, params: readonly unknown[]): Promise<number>
}

@Injectable()
export class DeliveryOutcomeStore {
  private readonly runner: SqlRunner

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    this.runner = {
      query: (sql, params) => prisma.$queryRawUnsafe(sql, ...params),
      execute: (sql, params) => prisma.$executeRawUnsafe(sql, ...params),
    }
  }

  /** Which message the provider's id belongs to, or null.
   *
   * READS THE ATTEMPT, NOT THE JOB. A job's `provider_id` is overwritten by a later attempt, so a
   * webhook about attempt 1 arriving after attempt 2 succeeded would match the wrong send — or
   * none. The attempt row is per attempt and is never rewritten, which is what makes it the
   * lookup that stays correct. */
  async messageForProvider(providerId: ProviderMessageId): Promise<MessageId | null> {
    const rows = await this.runner.query<readonly { message_id: string }[]>(
      'SELECT message_id FROM alert_send_attempts WHERE provider_id = $1 LIMIT 1',
      [providerId],
    )
    const found = rows[0]
    return found === undefined ? null : messageId(found.message_id)
  }

  /** Record one verified event, matched or not.
   *
   * IDEMPOTENT ON THE PROVIDER EVENT. Resend retries a webhook it believes failed, so the same
   * event arrives more than once; without `ON CONFLICT DO NOTHING` a count of delivered messages
   * would depend on how often the provider retried us. The conflict target is the unique index
   * on (provider_id, kind, occurred_at) — not provider_id alone, because one message legitimately
   * produces DELIVERED and later COMPLAINED and a key collapsing those would discard the
   * complaint, which is the event that changes behaviour. */
  async record(row: OutcomeRow, authentic?: { eventId: string; event: AuthenticEvent }): Promise<void> {
    if (authentic) await recordEmailProviderEvent(emailSqlRunner(this.prisma), authentic.eventId, authentic.event)
    await this.runner.execute(
      [
        'INSERT INTO alert_delivery_outcomes',
        '  (id, provider_id, message_id, kind, bounce, because, occurred_at)',
        'VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::timestamptz)',
        'ON CONFLICT (provider_id, kind, occurred_at) DO NOTHING',
      ].join('\n'),
      [row.providerId, row.messageId, row.kind, row.bounce, row.because, row.occurredAtIso],
    )
  }

  /* `countRejection` WAS HERE AND IS DELETED, NOT DEPRECATED.
   *
   * It performed a shared-row SQL upsert for every request whose signature failed. That bounded
   * the ROW COUNT at 24x2 and left the DATABASE WORK unbounded — and the work is what an
   * unauthenticated caller actually consumes. Neither the address limiter nor the subject limiter
   * protects this route, so the correction is that the attacker path does no persistence at all:
   * the route returns 400 before reaching a store, and the count lives in `webhook-rejection-count.ts`
   * as an in-process integer.
   *
   * THE `alert_webhook_rejections` TABLE IT WROTE TO IS NOW UNUSED. Its migration is not
   * rewritten — forward-only holds — so dropping it is a further forward migration and a decision
   * for whoever owns the schema. An unused table is a second home for a fact and should not
   * simply be left standing; flagged rather than taken, because this branch's grant was one model
   * for delivery outcomes.
   */
}
