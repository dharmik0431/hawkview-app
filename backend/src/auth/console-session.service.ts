import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import type { AuthenticatedIdentity } from './auth.types.js'

export const CONSOLE_IDLE_SECONDS = 3600
export const CONSOLE_WARNING_SECONDS = 120
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Denial = 'SESSION_IDLE_EXPIRED' | 'SESSION_REAUTHENTICATION_REQUIRED'
export type ConsoleSessionStatus = {
  sessionId: string; serverNow: string; idleExpiresAt: string
  idleTimeoutSeconds: 3600; warningSeconds: 120
}
export interface SessionTransaction {
  $queryRawUnsafe<T>(sql: string, ...values: any[]): Promise<T>
  $executeRawUnsafe(sql: string, ...values: any[]): Promise<number>
}
export interface SessionDatabase {
  $transaction<T>(work: (tx: SessionTransaction) => Promise<T>, options: {
    isolationLevel: 'ReadCommitted'; maxWait: number; timeout: number
  }): Promise<T>
}
type Row = { subject: string; idleExpiresAt: Date; revokedAt: Date | null }

/** Self-only recorded session history, as of one server clock sample.
 *
 * No identifier, subject, token or email leaves this boundary: the session id is
 * used internally to mark the caller's own row and is then dropped. */
export type ConsoleSessionHistoryState = 'revoked' | 'expired' | 'idle-eligible' | 'unknown'
export type ConsoleSessionHistoryRow = {
  authenticatedAt: string | null
  idleExpiresAt: string
  revokedAt: string | null
  createdAt: string
  state: ConsoleSessionHistoryState
  isCurrent: boolean
}
export type ConsoleSessionHistory = {
  responseVersion: 'console-session-history/v1'
  generatedAt: string
  returned: number
  truncated: boolean
  sessions: ConsoleSessionHistoryRow[]
}
export const CONSOLE_SESSION_HISTORY_LIMIT = 50
type HistoryRow = {
  now: Date
  sessionId: string | null
  authenticatedAt: Date | null
  idleExpiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date | null
}
const usableDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime())

function reject(code: Denial): never {
  throw new UnauthorizedException({ statusCode: 401, code, message: code === 'SESSION_IDLE_EXPIRED'
    ? 'Your console session expired after inactivity. Sign in again.' : 'A fresh console sign-in is required.' })
}

/** Only verified JWT identity enters this boundary. No token, email or client
 * activity timestamp is stored. Session tombstones deliberately have no cleanup. */
@Injectable()
export class ConsoleSessionService {
  constructor(@Inject(PrismaService) private readonly db: SessionDatabase) {}

  check(identity: AuthenticatedIdentity) { return this.access(identity, false) }
  activity(identity: AuthenticatedIdentity) { return this.access(identity, true) }

  private ids(identity: AuthenticatedIdentity) {
    if (!UUID.test(identity.subject) || typeof identity.sessionId !== 'string' || !UUID.test(identity.sessionId)) {
      reject('SESSION_REAUTHENTICATION_REQUIRED')
    }
    return { subject: identity.subject.toLowerCase(), sessionId: identity.sessionId.toLowerCase() }
  }

  private async locked<T>(sessionId: string, work: (tx: SessionTransaction, row: Row | undefined, now: Date) => Promise<T>) {
    return this.db.$transaction(async tx => {
      // Covers absent rows too: end-before-bootstrap and activity/expiry cannot
      // race into creating or reviving a session. Separate sessions never share a key.
      await tx.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1, 0))', `hawkview:console-session:${sessionId}`)
      const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT subject::text AS subject,
        idle_expires_at AS "idleExpiresAt", revoked_at AS "revokedAt"
        FROM console_sessions WHERE session_id=$1::uuid FOR UPDATE`, sessionId)
      // Read after lock acquisition, never the transaction-start clock: a request
      // that waited past expiry must fail, even if it arrived while still active.
      const [{ now }] = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now')
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('CONSOLE_SESSION_CLOCK_UNAVAILABLE')
      return work(tx, rows[0], now)
    }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 })
  }

  private async access(identity: AuthenticatedIdentity, activity: boolean): Promise<ConsoleSessionStatus> {
    const { sessionId, subject } = this.ids(identity)
    return this.locked(sessionId, async (tx, row, now) => {
      let expires: Date
      const authenticatedAt = identity.authenticatedAt
      if (!(authenticatedAt instanceof Date) || !Number.isFinite(authenticatedAt.getTime()) || authenticatedAt.getTime() > now.getTime()) {
        reject('SESSION_REAUTHENTICATION_REQUIRED')
      }
      if (row) {
        if (row.subject !== subject || row.revokedAt !== null) reject('SESSION_REAUTHENTICATION_REQUIRED')
        if (row.idleExpiresAt.getTime() <= now.getTime()) reject('SESSION_IDLE_EXPIRED')
        expires = row.idleExpiresAt
      } else {
        if (now.getTime() - authenticatedAt.getTime() >= CONSOLE_IDLE_SECONDS * 1000) {
          reject('SESSION_REAUTHENTICATION_REQUIRED')
        }
        expires = new Date(authenticatedAt.getTime() + CONSOLE_IDLE_SECONDS * 1000)
        await tx.$executeRawUnsafe(`INSERT INTO console_sessions
          (session_id,subject,authenticated_at,idle_expires_at,created_at,updated_at)
          VALUES ($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,$5::timestamptz,$5::timestamptz)`,
        sessionId, subject, authenticatedAt, expires, now)
      }
      // A missing record starts at authentication + 1h, even if the very first
      // call was activity. Only an already-established active record extends.
      if (activity && row) {
        expires = new Date(now.getTime() + CONSOLE_IDLE_SECONDS * 1000)
        await tx.$executeRawUnsafe(`UPDATE console_sessions SET idle_expires_at=$2::timestamptz, updated_at=$3::timestamptz
          WHERE session_id=$1::uuid`, sessionId, expires, now)
      }
      return { sessionId, serverNow: now.toISOString(), idleExpiresAt: expires.toISOString(),
        idleTimeoutSeconds: CONSOLE_IDLE_SECONDS, warningSeconds: CONSOLE_WARNING_SECONDS }
    })
  }

  async end(identity: AuthenticatedIdentity): Promise<{ ended: true }> {
    const { sessionId, subject } = this.ids(identity)
    await this.locked(sessionId, async (tx, row, now) => {
      if (row && row.subject !== subject) reject('SESSION_REAUTHENTICATION_REQUIRED')
      if (row?.revokedAt) return
      if (row) {
        await tx.$executeRawUnsafe(`UPDATE console_sessions SET revoked_at=$2::timestamptz, updated_at=$2::timestamptz
          WHERE session_id=$1::uuid`, sessionId, now)
      } else {
        // Retain a tombstone even for an old/unverifiable session never used by
        // this API, so a late bootstrap cannot create it after local sign-out.
        await tx.$executeRawUnsafe(`INSERT INTO console_sessions
          (session_id,subject,idle_expires_at,revoked_at,created_at,updated_at)
          VALUES ($1::uuid,$2::uuid,$3::timestamptz,$3::timestamptz,$3::timestamptz,$3::timestamptz)`, sessionId, subject, now)
      }
    })
    return { ended: true }
  }

  /** Self-only recorded session history for the verified caller.
   *
   * This reader adds no writes: no advisory lock, no FOR UPDATE, no UPDATE or
   * INSERT. That claim covers this method only — the guard's existing bootstrap
   * and activity effects run before it and are unchanged.
   *
   * One statement samples one clock and reads at most LIMIT+1 rows, so the extra
   * row is what proves truncation without a second COUNT. The clock comes from a
   * CTE joined with LEFT JOIN LATERAL ... ON true, so a caller with no recorded
   * sessions still receives a server time instead of an empty result that would
   * have to be dated somewhere else. */
  async history(identity: AuthenticatedIdentity): Promise<ConsoleSessionHistory> {
    const { subject, sessionId } = this.ids(identity)
    const rows = await this.db.$transaction(
      async tx =>
        tx.$queryRawUnsafe<HistoryRow[]>(
          `WITH clock AS (SELECT clock_timestamp() AS now)
           SELECT clock.now AS "now",
                  s.session_id::text AS "sessionId",
                  s.authenticated_at AS "authenticatedAt",
                  s.idle_expires_at AS "idleExpiresAt",
                  s.revoked_at AS "revokedAt",
                  s.created_at AS "createdAt"
           FROM clock
           LEFT JOIN LATERAL (
             SELECT session_id, authenticated_at, idle_expires_at, revoked_at, created_at
             FROM console_sessions
             WHERE subject=$1::uuid
             ORDER BY created_at DESC, session_id DESC
             LIMIT ${CONSOLE_SESSION_HISTORY_LIMIT + 1}
           ) s ON true`,
          subject
        ),
      { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 }
    )

    const now = rows[0]?.now
    // An unusable clock makes the whole response unreadable. We never substitute
    // our own time: every state below is stated relative to this one sample.
    if (!usableDate(now)) throw new Error('CONSOLE_SESSION_CLOCK_UNAVAILABLE')

    const recorded = rows.filter(row => row.sessionId !== null)
    const returned = recorded.slice(0, CONSOLE_SESSION_HISTORY_LIMIT)

    // Fail the whole response closed rather than emit a row we could not read.
    // A required timestamp that is unusable must never become an empty string,
    // and a NON-NULL but unusable nullable timestamp must never become `null`:
    // that would turn "we could not read this" into "this was not recorded",
    // which is the absence-versus-refusal confusion this product refuses to make.
    for (const row of returned) {
      const readable =
        usableDate(row.createdAt) &&
        usableDate(row.idleExpiresAt) &&
        (row.authenticatedAt === null || usableDate(row.authenticatedAt)) &&
        (row.revokedAt === null || usableDate(row.revokedAt))
      if (!readable) throw new Error('CONSOLE_SESSION_HISTORY_UNREADABLE')
    }

    return {
      responseVersion: 'console-session-history/v1',
      generatedAt: now.toISOString(),
      returned: returned.length,
      truncated: recorded.length > CONSOLE_SESSION_HISTORY_LIMIT,
      sessions: returned.map(row => ({
        authenticatedAt: row.authenticatedAt === null ? null : (row.authenticatedAt as Date).toISOString(),
        idleExpiresAt: (row.idleExpiresAt as Date).toISOString(),
        revokedAt: row.revokedAt === null ? null : (row.revokedAt as Date).toISOString(),
        createdAt: (row.createdAt as Date).toISOString(),
        state: this.historyState(row, now),
        // Without a signed session id nothing is marked current. An
        // undeterminable identity must not produce a positive claim.
        isCurrent: row.sessionId !== null && row.sessionId.toLowerCase() === sessionId,
      })),
    }
  }

  /** Four states, each decided only from recorded evidence as of `now`.
   *
   * Elapsed time never implies revocation, and a contradictory record is never
   * labelled eligible — it is `unknown`, which the panel renders as unreconciled
   * rather than as absence of access. */
  private historyState(row: HistoryRow, now: Date): ConsoleSessionHistoryState {
    // Rows reaching here are already readable: unusable timestamps fail the whole
    // response closed before mapping. What remains is coherence as of `now`.
    const created = row.createdAt as Date
    const idleExpires = row.idleExpiresAt as Date

    // A record cannot have come into existence after the clock sample that is
    // describing it. Future evidence is readable but not true as of now.
    if (created.getTime() > now.getTime()) return 'unknown'
    if (usableDate(row.authenticatedAt) && row.authenticatedAt.getTime() > now.getTime()) {
      return 'unknown'
    }

    if (usableDate(row.revokedAt)) {
      // A revocation before the row existed, or dated after the clock sample,
      // is incoherent — revocation is never inferred, only read.
      const revoked = row.revokedAt.getTime()
      return revoked >= created.getTime() && revoked <= now.getTime() ? 'revoked' : 'unknown'
    }

    if (created.getTime() > idleExpires.getTime()) return 'unknown'
    if (usableDate(row.authenticatedAt) && row.authenticatedAt.getTime() > idleExpires.getTime()) {
      return 'unknown'
    }
    if (now.getTime() >= idleExpires.getTime()) return 'expired'
    // Eligibility requires an actual authentication: a live deadline on a row
    // that never authenticated is unreconciled, not eligible.
    return usableDate(row.authenticatedAt) ? 'idle-eligible' : 'unknown'
  }
}
