import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { ConsoleSessionService, type SessionDatabase, type SessionTransaction } from './console-session.service.js'
import { ConsoleSessionController } from './console-session.controller.js'
import { IdentityAuthGuard } from './identity-auth.guard.js'
import { PUBLIC_ROUTE_KEY } from './public.decorator.js'
import type { AuthenticatedIdentity, AuthenticatedRequest } from './auth.types.js'

const instant = Date.parse('2026-10-08T07:00:00Z'), hour = 3600000
type Stored = { subject: string; authenticatedAt: Date | null; idleExpiresAt: Date; revokedAt: Date | null }
// SQL is simulated here; locking/rollback proof is prepared in the gated DB suite.
function fixture() {
  const rows = new Map<string, Stored>()
  const f = { now: instant, rows, writes: 0, calls: 0, beforeRead: async () => {}, fail: false }
  let queue = Promise.resolve()
  const db: SessionDatabase = {
    async $transaction(work, options) {
      f.calls++
      assert.deepEqual(options, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 })
      const run = queue.then(async () => {
        if (f.fail) throw Error('synthetic database unavailable')
        const snapshot = structuredClone(rows), beforeWrites = f.writes
        let locked = false
        const tx: SessionTransaction = {
          async $queryRawUnsafe<T>(sql: string, ...v: any[]): Promise<T> {
            if (sql.includes('pg_advisory_xact_lock')) {
              assert.match(v[0], /^hawkview:console-session:[a-f0-9-]{36}$/); locked = true
              await f.beforeRead(); return [] as T
            }
            assert.ok(locked)
            if (sql.includes('FROM console_sessions')) { assert.match(sql, /FOR UPDATE/); return (rows.has(v[0]) ? [structuredClone(rows.get(v[0]))] : []) as T }
            assert.equal(sql, 'SELECT clock_timestamp() AS now')
            return [{ now: new Date(f.now) }] as T
          },
          async $executeRawUnsafe(sql: string, ...v: any[]) {
            assert.ok(locked); f.writes++
            if (sql.startsWith('INSERT')) {
              assert.equal(rows.has(v[0]), false)
              rows.set(v[0], sql.includes('authenticated_at')
                ? { subject: v[1], authenticatedAt: v[2], idleExpiresAt: v[3], revokedAt: null }
                : { subject: v[1], authenticatedAt: null, idleExpiresAt: v[2], revokedAt: v[2] })
            } else if (sql.includes('SET revoked_at')) rows.get(v[0])!.revokedAt = v[1]
            else if (sql.includes('SET idle_expires_at')) rows.get(v[0])!.idleExpiresAt = v[1]
            else throw Error('unexpected SQL')
            return 1
          },
        }
        try { return await work(tx) }
        catch (error) { rows.clear(); for (const [key, row] of snapshot) rows.set(key, row); f.writes = beforeWrites; throw error }
      })
      queue = run.then(() => undefined, () => undefined)
      return run
    },
  }
  return { ...{ f, service: new ConsoleSessionService(db) }, identity: {
    subject: randomUUID(), sessionId: randomUUID(), email: 'synthetic@example.invalid', assuranceLevel: 'aal2', authenticatedAt: new Date(instant),
  } as AuthenticatedIdentity }
}
function denied(code: string) {
  return (error: any) => error.getStatus() === 401 && error.getResponse().code === code
}

test('new status anchors expiry to interactive authentication; bootstrap/status/refresh do not slide it', async () => {
  const { f, service, identity } = fixture()
  f.now += 55 * 60000
  const first = await service.check(identity)
  assert.deepEqual(first, { sessionId: identity.sessionId, serverNow: new Date(f.now).toISOString(),
    idleExpiresAt: new Date(instant + hour).toISOString(), idleTimeoutSeconds: 3600, warningSeconds: 120 })
  for (let i = 0; i < 3; i++) {
    f.now += 1000
    // A newer AMR on the same session also cannot reset a durable deadline.
    assert.equal((await service.check({ ...identity, authenticatedAt: new Date(f.now) })).idleExpiresAt, first.idleExpiresAt)
  }
  assert.equal(f.writes, 1)
})
test('only acknowledged activity on an established active session extends from server time', async () => {
  const { f, service, identity } = fixture()
  await service.check(identity); f.now += 58 * 60000
  const response = await service.activity(identity)
  assert.equal(response.idleExpiresAt, new Date(f.now + hour).toISOString())
  f.now += 30000
  assert.equal((await service.check(identity)).idleExpiresAt, response.idleExpiresAt)
  assert.equal(f.writes, 2)
})
test('first activity on a missing record only initializes the authentication-anchored deadline', async () => {
  const { f, service, identity } = fixture(); f.now += 55 * 60000
  assert.equal((await service.activity(identity)).idleExpiresAt, new Date(instant + hour).toISOString())
})
test('exact expiry rejects checks and activity forever for that record, including newer AMR', async () => {
  const { f, service, identity } = fixture(); await service.check(identity); f.now += hour
  for (const operation of [service.check.bind(service), service.activity.bind(service)]) {
    await assert.rejects(operation(identity), denied('SESSION_IDLE_EXPIRED'))
    await assert.rejects(operation({ ...identity, authenticatedAt: new Date(f.now) }), denied('SESSION_IDLE_EXPIRED'))
  }
  assert.equal(f.writes, 1)
})
for (const age of [hour, hour * 24, -1000, NaN]) test(`missing session with authentication age ${age} requires sign-in`, async () => {
  const { f, service, identity } = fixture(); identity.authenticatedAt = new Date(f.now - age)
  await assert.rejects(service.check(identity), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  await assert.rejects(service.activity(identity), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  assert.equal(f.rows.size, 0)
})
test('unverifiable AMR cannot initialize or access and malformed identity never reaches DB', async () => {
  const { f, service, identity } = fixture()
  await assert.rejects(service.check({ ...identity, authenticatedAt: undefined }), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  const before = f.calls
  await assert.rejects(service.check({ ...identity, sessionId: 'bad' }), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  assert.equal(f.calls, before)
})
for (const state of ['active', 'expired', 'missing'] as const) test(`end is idempotent for ${state} and prevents late bootstrap/activity`, async () => {
  const { f, service, identity } = fixture()
  if (state !== 'missing') await service.check(identity)
  if (state === 'expired') f.now += hour
  assert.deepEqual(await service.end({ ...identity, authenticatedAt: undefined }), { ended: true })
  const writes = f.writes
  await service.end(identity); assert.equal(f.writes, writes)
  await assert.rejects(service.check(identity), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  await assert.rejects(service.activity({ ...identity, authenticatedAt: new Date(f.now) }), denied('SESSION_REAUTHENTICATION_REQUIRED'))
})
test('same-user separate sessions remain independent; another subject cannot access or end the row', async () => {
  const { f, service, identity } = fixture(), second = { ...identity, sessionId: randomUUID() }
  await service.check(identity); await service.check(second)
  const foreign = { ...identity, subject: randomUUID() }
  for (const operation of [service.check.bind(service), service.activity.bind(service), service.end.bind(service)]) {
    await assert.rejects(operation(foreign), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  }
  await service.end(identity); f.now += 1000
  assert.equal((await service.activity(second)).sessionId, second.sessionId)
})
test('serialized concurrent end/bootstrap/activity leaves a durable revoked winner', async () => {
  const { f, service, identity } = fixture()
  const results = await Promise.allSettled([service.end(identity), service.check(identity), service.activity(identity)])
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[2].status, 'rejected')
  assert.ok(f.rows.get(identity.sessionId!)!.revokedAt)
})
test('clock is sampled after acquiring locks, so activity queued across expiry is refused', async () => {
  const { f, service, identity } = fixture(); await service.check(identity)
  f.now += hour - 1
  f.beforeRead = async () => { f.now += 1 }
  await assert.rejects(service.activity(identity), denied('SESSION_IDLE_EXPIRED'))
})
test('database failure cannot return an optimistic extension', async () => {
  const { f, service, identity } = fixture(); await service.check(identity)
  f.fail = true
  await assert.rejects(service.activity(identity), /database unavailable/)
  await assert.rejects(service.check(identity), /database unavailable/)
  assert.equal(f.rows.get(identity.sessionId!)!.idleExpiresAt.getTime(), instant + hour)
})

test('actual guard enforces session checks on ordinary APIs and wires all three operations', async () => {
  // The controller now takes the service for the self-only history read. The
  // three operations asserted below still run through the guard unchanged.
  const { f, service, identity } = fixture(), controller = new ConsoleSessionController(service)
  let verificationCalls = 0, currentIdentity = identity
  const guard = new IdentityAuthGuard(new Reflector(), { verify: async () => { verificationCalls++; return currentIdentity } } as never, service)
  const invoke = async (handler: Function, body?: unknown, query = {}) => {
    const request = { headers: { authorization: 'Bearer synthetic' }, body, query } as AuthenticatedRequest
    const context = { getHandler: () => handler, getClass: () => ConsoleSessionController,
      switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
    assert.equal(await guard.canActivate(context), true)
    return { request, response: handler.call(controller, request) }
  }
  const status = await invoke(ConsoleSessionController.prototype.status)
  assert.equal(status.response.idleExpiresAt, new Date(instant + hour).toISOString())
  f.now += 1000
  const ordinary = await invoke(function protectedHandler() { return 'protected' })
  assert.equal(ordinary.request.consoleSession?.idleExpiresAt, status.response.idleExpiresAt)
  assert.equal(f.writes, 1)
  const calls = f.calls
  for (const body of [{ timestamp: f.now }, { sessionId: randomUUID() }, { subject: randomUUID() }, [], 'activity']) {
    await assert.rejects(invoke(ConsoleSessionController.prototype.activity, body), /do not accept/)
  }
  await assert.rejects(invoke(ConsoleSessionController.prototype.end, {}, { sessionId: randomUUID() }), /do not accept/)
  assert.equal(f.calls, calls)
  const active = await invoke(ConsoleSessionController.prototype.activity, {})
  assert.equal(active.response.idleExpiresAt, new Date(f.now + hour).toISOString())
  f.now += hour
  await assert.rejects(invoke(function protectedHandler() { throw Error('must not run') }), denied('SESSION_IDLE_EXPIRED'))
  await assert.rejects(invoke(ConsoleSessionController.prototype.activity), denied('SESSION_IDLE_EXPIRED'))
  assert.deepEqual((await invoke(ConsoleSessionController.prototype.end)).response, { ended: true })
  const callsAfterEnd = f.calls
  currentIdentity = { ...identity, assuranceLevel: 'aal1', subject: randomUUID() }
  await assert.rejects(invoke(ConsoleSessionController.prototype.end), /Multi-factor/)
  assert.equal(f.calls, callsAfterEnd)
  const publicHandler = () => 'public service'
  Reflect.defineMetadata(PUBLIC_ROUTE_KEY, true, publicHandler)
  const beforePublic = verificationCalls
  assert.equal((await invoke(publicHandler)).response, 'public service')
  assert.equal(verificationCalls, beforePublic); assert.equal(f.calls, callsAfterEnd)
})

test('the actual guard denies the history handler before any history read happens', async () => {
  // What the reader returns is proven in console-session-history.test.ts against
  // the real SQL, and physically in the gated DB suite. What is proven here is
  // narrower and cannot be shown there: that a refusal arrives *before* the
  // handler runs. So the reader is replaced by a recorder — a count of zero is
  // then positive evidence of a denial, not merely an absent result.
  const { f, service, identity } = fixture()
  let reads = 0, lastCaller: string | null = null
  ;(service as unknown as { history: unknown }).history = async (caller: AuthenticatedIdentity) => {
    reads++; lastCaller = caller.subject; return { returned: 0 }
  }
  const controller = new ConsoleSessionController(service)
  let currentIdentity: AuthenticatedIdentity = identity, tokenRejected = false
  const guard = new IdentityAuthGuard(new Reflector(), { verify: async () => {
    if (tokenRejected) throw new Error('synthetic token rejected'); return currentIdentity
  } } as never, service)
  const invoke = async (body?: unknown, query: Record<string, unknown> = {}) => {
    const request = { headers: { authorization: 'Bearer synthetic' }, body, query } as AuthenticatedRequest
    const context = { getHandler: () => ConsoleSessionController.prototype.history, getClass: () => ConsoleSessionController,
      switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
    assert.equal(await guard.canActivate(context), true)
    return ConsoleSessionController.prototype.history.call(controller, request)
  }

  // 0. A caller-supplied session override on a read. This is the case that makes
  // the handler's 'read' operation metadata load-bearing: without it the guard
  // skips assertNoSessionOverrides and this body is accepted.
  for (const body of [{ sessionId: randomUUID() }, { subject: randomUUID() }, { timestamp: instant }]) {
    await assert.rejects(invoke(body), /do not accept/)
  }
  await assert.rejects(invoke(undefined, { sessionId: randomUUID() }), /do not accept/)
  assert.equal(reads, 0)

  // 1. No interactive authentication on the verified claims.
  currentIdentity = { ...identity, authenticatedAt: undefined }
  await assert.rejects(invoke(), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  assert.equal(reads, 0)

  // 2. Single-factor assurance: refused by the guard before any session work.
  const callsBeforeAal1 = f.calls
  currentIdentity = { ...identity, assuranceLevel: 'aal1' }
  await assert.rejects(invoke(), /Multi-factor/)
  assert.equal(reads, 0); assert.equal(f.calls, callsBeforeAal1)

  // 2b. Token verification itself fails: no session work, no read.
  const callsBeforeToken = f.calls
  tokenRejected = true
  await assert.rejects(invoke(), /synthetic token rejected/)
  assert.equal(reads, 0); assert.equal(f.calls, callsBeforeToken)
  tokenRejected = false

  // 3. Admitted. The handler reads for the verified caller, nobody else.
  currentIdentity = identity
  assert.deepEqual(await invoke(), { returned: 0 })
  assert.equal(reads, 1); assert.equal(lastCaller, identity.subject)

  // 4. The same admitted identity, past its inactivity window.
  f.now += hour
  await assert.rejects(invoke(), denied('SESSION_IDLE_EXPIRED'))
  assert.equal(reads, 1)

  // 5. A revoked session, with the clock wound back inside the window so that
  // revocation is the only remaining reason to refuse.
  assert.deepEqual(await service.end(identity), { ended: true })
  f.now = instant
  await assert.rejects(invoke(), denied('SESSION_REAUTHENTICATION_REQUIRED'))
  assert.equal(reads, 1)
})
