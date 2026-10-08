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
}
