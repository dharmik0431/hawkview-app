import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  ConsoleSessionService,
  CONSOLE_SESSION_HISTORY_LIMIT,
  type SessionDatabase,
  type SessionTransaction,
} from './console-session.service.js'
import { ConsoleSessionController } from './console-session.controller.js'
import type { AuthenticatedIdentity, AuthenticatedRequest } from './auth.types.js'

const instant = Date.parse('2026-10-09T12:00:00Z')
const minute = 60000
const hour = 3600000

type Stored = {
  sessionId: string
  subject: string
  authenticatedAt: Date | null
  idleExpiresAt: unknown
  revokedAt: unknown
  createdAt: unknown
}

/** Models only the single history statement.
 *
 * Deliberately hostile to writes and locks: any advisory lock, any `FOR UPDATE`
 * and any `$executeRawUnsafe` fails the test outright, so "this reader adds no
 * writes" is proved by the double rather than asserted in prose. */
function fixture() {
  const stored: Stored[] = []
  const f = { now: instant, stored, statements: [] as string[], binds: [] as any[][], clockBroken: false }
  const db: SessionDatabase = {
    async $transaction(work, options) {
      assert.deepEqual(options, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 })
      const tx: SessionTransaction = {
        async $queryRawUnsafe<T>(sql: string, ...values: any[]): Promise<T> {
          f.statements.push(sql)
          f.binds.push(values)
          assert.ok(!sql.includes('pg_advisory_xact_lock'), 'history must not take the advisory lock')
          assert.ok(!/FOR UPDATE/i.test(sql), 'history must not lock rows')
          const now = f.clockBroken ? new Date(NaN) : new Date(f.now)

          // SQL-SEMANTIC WITNESS. The returned rows honour the predicate the
          // statement actually contains, rather than filtering unconditionally.
          // That is what makes the isolation mutation real: delete the subject
          // predicate from the reader and another subject's rows genuinely
          // arrive here and fail the isolation assertion, instead of tripping a
          // shape assertion before any row is produced. SQL shape is asserted
          // separately, in its own test, so it cannot pre-empt this one.
          const scoped = /WHERE\s+subject=\$1::uuid/.test(sql)
          const ordered = /ORDER BY created_at DESC, session_id DESC/.test(sql)
          const limited = new RegExp(`LIMIT ${CONSOLE_SESSION_HISTORY_LIMIT + 1}`).test(sql)
          const selected = scoped ? stored.filter(row => row.subject === values[0]) : [...stored]
          const sequenced = ordered
            ? [...selected].sort((left, right) => {
                const byCreated = Number(right.createdAt) - Number(left.createdAt)
                return byCreated !== 0 ? byCreated : (left.sessionId < right.sessionId ? 1 : -1)
              })
            : selected
          const mine = limited ? sequenced.slice(0, CONSOLE_SESSION_HISTORY_LIMIT + 1) : sequenced
          if (mine.length === 0) {
            // The LATERAL join still yields the clock with null session columns.
            return [{
              now, sessionId: null, authenticatedAt: null,
              idleExpiresAt: null, revokedAt: null, createdAt: null,
            }] as T
          }
          return mine.map(row => ({
            now,
            sessionId: row.sessionId,
            authenticatedAt: row.authenticatedAt,
            idleExpiresAt: row.idleExpiresAt,
            revokedAt: row.revokedAt,
            createdAt: row.createdAt,
          })) as T
        },
        async $executeRawUnsafe() {
          assert.fail('the history reader must not write')
        },
      }
      return work(tx)
    },
  }
  const subject = randomUUID()
  const sessionId = randomUUID()
  const identity: AuthenticatedIdentity = {
    subject, sessionId, email: 'synthetic@example.invalid', assuranceLevel: 'aal2',
    authenticatedAt: new Date(instant - hour),
  }
  const add = (over: Partial<Stored> = {}) => {
    const row: Stored = {
      sessionId: randomUUID(),
      subject,
      authenticatedAt: new Date(instant - hour),
      idleExpiresAt: new Date(instant + hour),
      revokedAt: null,
      createdAt: new Date(instant - hour),
      ...over,
    }
    stored.push(row)
    return row
  }
  return { f, service: new ConsoleSessionService(db), identity, subject, sessionId, add }
}

test('reads only the verified caller subject and takes no identity input', async () => {
  // Behavioural isolation. The witness above honours whatever predicate the
  // statement carries, so removing it from the reader lets the other subject's
  // row reach this assertion and fail it.
  const { service, identity, subject, f, add } = fixture()
  add()
  const other = randomUUID()
  f.stored.push({
    sessionId: randomUUID(), subject: other, authenticatedAt: new Date(instant),
    idleExpiresAt: new Date(instant + hour), revokedAt: null, createdAt: new Date(instant),
  })
  const result = await service.history(identity)
  assert.equal(result.returned, 1, 'another subject’s row must not be returned')
  assert.equal(result.sessions.length, 1)
  assert.deepEqual(f.binds, [[subject]])
  assert.equal(f.statements.length, 1, 'exactly one statement, no separate count')
})

test('the statement keeps the shape the witness interprets', async () => {
  // Shape lives in its own test so it can never pre-empt the isolation one.
  const { service, identity, f, add } = fixture()
  add()
  await service.history(identity)
  const [sql] = f.statements
  assert.match(sql, /FROM console_sessions/)
  assert.match(sql, /WHERE\s+subject=\$1::uuid/)
  assert.match(sql, /ORDER BY created_at DESC, session_id DESC/)
  assert.match(sql, new RegExp(`LIMIT ${CONSOLE_SESSION_HISTORY_LIMIT + 1}`))
  assert.match(sql, /LEFT JOIN LATERAL/)
  assert.ok(!/FOR UPDATE/i.test(sql))
  assert.ok(!sql.includes('pg_advisory_xact_lock'))
})

test('zero recorded sessions still return a server clock, not an empty result', async () => {
  const { service, identity } = fixture()
  const result = await service.history(identity)
  assert.equal(result.responseVersion, 'console-session-history/v1')
  assert.equal(result.generatedAt, new Date(instant).toISOString())
  assert.equal(result.returned, 0)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.sessions, [])
})

test('never serialises a session id, subject, token or email', async () => {
  const { service, identity, add } = fixture()
  add()
  const result = await service.history(identity)
  const serialized = JSON.stringify(result)
  assert.equal(Object.keys(result.sessions[0]).sort().join(','),
    'authenticatedAt,createdAt,idleExpiresAt,isCurrent,revokedAt,state')
  assert.ok(!serialized.includes(identity.subject))
  assert.ok(!serialized.includes(identity.sessionId!))
  assert.ok(!serialized.includes('@example.invalid'))
})

test('exactly 50 rows is not truncated; 51 reports 50 and truncated', async () => {
  const fifty = fixture()
  for (let i = 0; i < CONSOLE_SESSION_HISTORY_LIMIT; i++) fifty.add()
  const atLimit = await fifty.service.history(fifty.identity)
  assert.equal(atLimit.returned, 50)
  assert.equal(atLimit.truncated, false)

  const over = fixture()
  for (let i = 0; i < CONSOLE_SESSION_HISTORY_LIMIT + 1; i++) over.add()
  const beyond = await over.service.history(over.identity)
  assert.equal(beyond.returned, 50)
  assert.equal(beyond.truncated, true)
  assert.equal(beyond.sessions.length, 50)
})

test('marks the caller current only for the signed session id', async () => {
  // Distinct createdAt values so the expected order is deterministic rather
  // than dependent on how the witness breaks a tie.
  const { service, identity, sessionId, add } = fixture()
  add({ sessionId, createdAt: new Date(instant - minute) })
  add({ createdAt: new Date(instant - hour) })
  const result = await service.history(identity)
  assert.deepEqual(result.sessions.map(row => row.isCurrent), [true, false])
  assert.equal(result.sessions.filter(row => row.isCurrent).length, 1)
})

test('four states read only recorded evidence', async () => {
  const revoked = fixture()
  revoked.add({ revokedAt: new Date(instant - minute) })
  assert.equal((await revoked.service.history(revoked.identity)).sessions[0].state, 'revoked')

  // A tombstone that never authenticated is still a coherent revocation.
  const tombstone = fixture()
  tombstone.add({ authenticatedAt: null, revokedAt: new Date(instant - minute) })
  assert.equal((await tombstone.service.history(tombstone.identity)).sessions[0].state, 'revoked')

  const expired = fixture()
  expired.add({ idleExpiresAt: new Date(instant - minute) })
  assert.equal((await expired.service.history(expired.identity)).sessions[0].state, 'expired')

  const eligible = fixture()
  eligible.add()
  assert.equal((await eligible.service.history(eligible.identity)).sessions[0].state, 'idle-eligible')

  // A live deadline on a row that never authenticated is unreconciled.
  const never = fixture()
  never.add({ authenticatedAt: null })
  assert.equal((await never.service.history(never.identity)).sessions[0].state, 'unknown')
})

test('the exact idle deadline is expired, not eligible', async () => {
  const { service, identity, add } = fixture()
  add({ idleExpiresAt: new Date(instant) })
  assert.equal((await service.history(identity)).sessions[0].state, 'expired')
})

test('future evidence is unknown and never a confident state', async () => {
  // Regression for the first review finding: these three previously read as
  // idle-eligible, idle-eligible and revoked.
  const created = fixture()
  created.add({ createdAt: new Date(instant + hour), idleExpiresAt: new Date(instant + 2 * hour) })
  assert.equal((await created.service.history(created.identity)).sessions[0].state, 'unknown')

  const authenticated = fixture()
  authenticated.add({ authenticatedAt: new Date(instant + minute) })
  assert.equal((await authenticated.service.history(authenticated.identity)).sessions[0].state, 'unknown')

  const revocation = fixture()
  revocation.add({ revokedAt: new Date(instant + minute) })
  assert.equal((await revocation.service.history(revocation.identity)).sessions[0].state, 'unknown')
})

test('revocation recorded before the row existed is unknown', async () => {
  const { service, identity, add } = fixture()
  add({ createdAt: new Date(instant - minute), revokedAt: new Date(instant - hour) })
  assert.equal((await service.history(identity)).sessions[0].state, 'unknown')
})

test('elapsed time alone never produces revoked', async () => {
  const { service, identity, add } = fixture()
  add({ idleExpiresAt: new Date(instant - hour), revokedAt: null })
  assert.equal((await service.history(identity)).sessions[0].state, 'expired')
})

test('unreadable required timestamps fail the response closed', async () => {
  // Regression for the second review finding: these previously produced a
  // successful DTO carrying an empty date string.
  for (const broken of [{ createdAt: new Date(NaN) }, { idleExpiresAt: new Date(NaN) }, { createdAt: null }]) {
    const { service, identity, add } = fixture()
    add(broken as Partial<Stored>)
    await assert.rejects(service.history(identity), /CONSOLE_SESSION_HISTORY_UNREADABLE/)
  }
})

test('an unreadable nullable timestamp is not silently absent evidence', async () => {
  for (const broken of [{ authenticatedAt: new Date(NaN) }, { revokedAt: new Date(NaN) }]) {
    const { service, identity, add } = fixture()
    add(broken as Partial<Stored>)
    await assert.rejects(service.history(identity), /CONSOLE_SESSION_HISTORY_UNREADABLE/)
  }
})

test('an unusable server clock makes the response unreadable', async () => {
  const { service, identity, f, add } = fixture()
  add()
  f.clockBroken = true
  await assert.rejects(service.history(identity), /CONSOLE_SESSION_CLOCK_UNAVAILABLE/)
})

test('a missing or malformed signed session id is denied, not answered', async () => {
  const { service, identity } = fixture()
  await assert.rejects(
    service.history({ ...identity, sessionId: undefined }),
    (error: any) => error.response?.code === 'SESSION_REAUTHENTICATION_REQUIRED'
  )
  await assert.rejects(
    service.history({ ...identity, subject: 'not-a-uuid' }),
    (error: any) => error.response?.code === 'SESSION_REAUTHENTICATION_REQUIRED'
  )
})

test('the controller reads the verified request.auth, not the status DTO', async () => {
  const { service, identity, subject, f, add } = fixture()
  add()
  const controller = new ConsoleSessionController(service)
  // consoleSession carries no subject; passing a conflicting one must be ignored.
  const request = {
    auth: identity,
    consoleSession: { sessionId: randomUUID(), serverNow: '', idleExpiresAt: '' },
  } as unknown as AuthenticatedRequest
  const result = await controller.history(request)
  assert.equal(result.returned, 1)
  assert.deepEqual(f.binds, [[subject]])
})
