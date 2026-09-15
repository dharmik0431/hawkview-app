import { type SqlRunner } from './pipeline-store.js'
import { type MessageId, type OperatorAddress } from './email-delivery.js'
import { suppressionUpsert } from './suppression-store.js'
import {
  TERMINAL,
  type Attempt, type Claim, type SendJob, type Settled, type WorkerId,
} from './send-queue.js'
import { type SendStore } from './send-worker.js'

/**
 * `SendStore` OVER A DATABASE — the other half that was never built.
 *
 * `drainOnce` has run against an in-memory store only. The probe's own header is explicit that
 * "the store is in memory", and `send-worker.ts` records what that cost once already: forty
 * suites green while the one real implementation would have failed on insert, because a double
 * enforces no constraint. **An interface can be satisfied by a double long after it has stopped
 * being satisfiable by a database.** So this is written against the migration's columns, and its
 * tests check those columns against the migration text rather than against my memory of it.
 *
 * NO PREDICATE LIVES HERE. `runClaim` and `runWithdraw` execute statements built in
 * `send-queue.ts`, and `suppress` delegates to `suppressionUpsert`. A store that rebuilt those
 * conditions would be a second place that decides who may send, which is the defect class this
 * whole release is about — and the claim predicate in particular is the one thing the database
 * must arbitrate alone.
 */

/** Built from the exported vocabulary, never restated. `send-queue.ts` records that adding
 *  `WITHDRAWN` to one list and not the other left a withdrawn job claimable; there is no second
 *  list here to forget. */
const TERMINAL_SQL = TERMINAL.map((state) => `'${state}'`).join(', ')

type JobRow = {
  message_id: string
  idempotency_key: string
  state: string
  attempts_made: number | string
  max_attempts: number | string
  not_before_at: Date | string
  claimed_by: string | null
  claimed_at: Date | string | null
  claim_expires_at: Date | string | null
  provider_id: string | null
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const count = (value: number | string): number =>
  typeof value === 'number' ? value : Number.parseInt(value, 10)

export function sendStoreOver(runner: SqlRunner): SendStore {
  return {
    /**
     * DELIBERATELY PERMISSIVE, because the worker re-checks eligibility and the claim is the
     * real gate. What this must not do is hand back a TERMINAL job: a withdrawn or sent message
     * reappearing in the due list is how a refusal becomes a delay.
     */
    dueJobs: async (nowIso: string, limit: number): Promise<readonly SendJob[]> => {
      const rows = await runner.query<JobRow>(
        `SELECT message_id, idempotency_key, state, attempts_made, max_attempts,
                not_before_at, claimed_by, claimed_at, claim_expires_at, provider_id
           FROM alert_send_jobs
          WHERE state NOT IN (${TERMINAL_SQL})
            AND not_before_at <= $1::timestamptz
            AND attempts_made < max_attempts
          ORDER BY not_before_at ASC
          LIMIT $2`,
        [nowIso, limit])

      return rows.map((row) => ({
        messageId: row.message_id as MessageId,
        idempotencyKey: row.idempotency_key as SendJob['idempotencyKey'],
        state: row.state as SendJob['state'],
        attemptsMade: count(row.attempts_made),
        maxAttempts: count(row.max_attempts),
        notBeforeIso: iso(row.not_before_at),
        // A claim is three columns that are meaningless apart. Rebuilt only when the holder is
        // present, so a half-written claim reads as no claim rather than as one with a null in it.
        claim: row.claimed_by === null || row.claimed_at === null || row.claim_expires_at === null
          ? null
          : ({
              by: row.claimed_by as WorkerId,
              atIso: iso(row.claimed_at),
              expiresIso: iso(row.claim_expires_at),
            } satisfies Claim),
        providerId: row.provider_id as SendJob['providerId'],
      }))
    },

    runClaim: (sql: string, params: readonly unknown[]) => runner.execute(sql, params),
    runWithdraw: (sql: string, params: readonly unknown[]) => runner.execute(sql, params),

    /** BEFORE THE SEND, so a crash mid-provider-call leaves evidence that it was tried. */
    openAttempt: async (attempt: Attempt): Promise<void> => {
      await runner.execute(
        // gen_random_uuid() IN THE STATEMENT, because alert_send_attempts.id is UUID NOT NULL
        // with NO database default -- schema.prisma's @default(uuid()) is applied by the Prisma
        // client and this is raw SQL, which never reaches it. Without this every send failed at
        // 23502 and left the job CLAIMED, which is not terminal, so it cycled rather than
        // failing once.
        `INSERT INTO alert_send_attempts (id, message_id, attempt_no, started_at)
              VALUES (gen_random_uuid(), $1, $2, $3::timestamptz)
         ON CONFLICT (message_id, attempt_no) DO NOTHING`,
        [attempt.messageId, attempt.attemptNo, attempt.startedAtIso])
    },

    /**
     * ONE TRANSACTION, because the interface exists to make it impossible to ask for one write
     * without the other: an attempt settled without its job advancing is a message that sends
     * again, and a job advanced without its attempt settled is a send with no evidence.
     */
    settleAttempt: async (attempt: Attempt, settled: Settled, job: SendJob): Promise<void> => {
      await runner.transaction(async (tx) => {
        // ROW COUNTS CHECKED, BOTH TIMES. An UPDATE that does not look at how many rows it
        // touched cannot tell "settled one" from "settled none" -- the same shape as a guard
        // that goes green because it cannot see its subject. Throwing inside the transaction
        // rolls BOTH writes back, which is the whole reason this method takes the job alongside
        // the settlement: a settled attempt whose job did not advance sends again.
        const attemptRows = await tx.execute(
          `UPDATE alert_send_attempts
              SET settled_kind = $3, settled_at = $4::timestamptz,
                  provider_id = $5, because = $6
            WHERE message_id = $1 AND attempt_no = $2`,
          [
            attempt.messageId, attempt.attemptNo, settled.kind, settled.atIso,
            settled.kind === 'ACCEPTED' ? settled.providerId : null,
            settled.kind === 'ACCEPTED' ? null : settled.because,
          ])
        if (attemptRows !== 1) {
          throw new Error('settleAttempt: expected 1 attempt row, updated ' + attemptRows)
        }

        // THE CLAIM AND THE RETRY CLOCK TRAVEL WITH THE STATE. afterAttempt computes the next
        // job -- a cleared claim once the attempt is over, and a later not_before_at for a
        // retry. Persisting the state without them leaves a job that is READY again while still
        // recorded as held by a worker that has finished, and a retry that is due immediately
        // rather than after its backoff. Both were dropped on the floor here.
        const jobRows = await tx.execute(
          `UPDATE alert_send_jobs
              SET state = $2, attempts_made = $3, provider_id = COALESCE($4, provider_id),
                  not_before_at = $5::timestamptz,
                  claimed_by = $6, claimed_at = $7::timestamptz, claim_expires_at = $8::timestamptz,
                  updated_at = now()
            WHERE message_id = $1`,
          [
            job.messageId, job.state, job.attemptsMade,
            settled.kind === 'ACCEPTED' ? settled.providerId : null,
            job.notBeforeIso,
            job.claim?.by ?? null, job.claim?.atIso ?? null, job.claim?.expiresIso ?? null,
          ])
        if (jobRows !== 1) {
          throw new Error('settleAttempt: expected 1 job row, updated ' + jobRows)
        }
      })
    },

    /** Delegated, so the upsert's conflict handling lives in one place. */
    suppress: async (
      address: OperatorAddress, messageId: MessageId, because: string, atIso: string,
    ): Promise<void> => {
      // HARD_BOUNCE carries its messageId because the type requires provenance for a
      // machine-made suppression -- MANUAL is the only arm allowed to omit it.
      const statement = suppressionUpsert(
        { address: String(address), reason: 'HARD_BOUNCE', because, messageId: String(messageId) },
        atIso)
      await runner.execute(statement.sql, statement.params)
    },
  }
}
