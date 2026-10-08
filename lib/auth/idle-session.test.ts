import assert from 'node:assert/strict'
import test from 'node:test'
import { IdleSessionController, IdleSessionError, idleIdentity } from './idle-session.ts'

const user = { subject: '11111111-2222-4333-8444-555555555555', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
const token = (identity = user) => `header.${btoa(JSON.stringify({ sub: identity.subject, session_id: identity.sessionId }))}.signature`
const HOUR = 3600000
function world(shared = new Map<string, string>()) {
  let now = Date.parse('2026-10-08T13:00:00Z')
  let serverDeadline = now + HOUR
  let fails = false
  const calls: string[] = []
  const controller = new IdleSessionController({
    now: () => now,
    read: (key) => shared.get(key) ?? null,
    write: (key, value) => { shared.set(key, value) },
    request: async (action) => {
      calls.push(action)
      if (fails) throw new Error('offline')
      if (action === 'end') return { ended: true }
      if (now >= serverDeadline) throw new IdleSessionError()
      if (action === 'activity') serverDeadline = now + HOUR
      return { sessionId: user.sessionId, serverNow: new Date(now).toISOString(), idleExpiresAt: new Date(serverDeadline).toISOString(), idleTimeoutSeconds: 3600, warningSeconds: 120 }
    },
  })
  return { controller, calls, shared, advance: (ms: number) => { now += ms }, offline: () => { fails = true }, deadline: () => serverDeadline }
}

test('unattended session warns at 58 minutes and expires at 60 despite repeated status reads', async () => {
  const w = world()
  await w.controller.ensure(user, token())
  let expired = 0
  w.controller.onExpired(() => expired++)
  for (let i = 0; i < 58; i++) { w.advance(60000); await w.controller.resume() }
  assert.equal(w.controller.view().phase, 'warning')
  assert.equal(w.controller.view().remainingSeconds, 120)
  w.advance(120000)
  await assert.rejects(w.controller.ensure(user, token()), IdleSessionError)
  assert.equal(w.controller.view().phase, 'expired')
  w.controller.tick()
  w.controller.tick()
  assert.equal(expired, 1)
  assert.equal(w.calls.filter((action) => action === 'end').length, 1)
  assert.equal(w.calls.includes('activity'), false)
})

test('accepted interaction extends the deadline, failed interaction does not', async () => {
  const w = world()
  await w.controller.ensure(user, token())
  w.advance(30 * 60000)
  await w.controller.activity()
  assert.equal(w.controller.view().remainingSeconds, 3600)
  w.advance(30 * 60000)
  w.offline()
  await assert.rejects(w.controller.activity(), /offline/)
  assert.equal(w.controller.view().remainingSeconds, 1800)
  w.advance(30 * 60000)
  w.controller.tick()
  assert.equal(w.controller.view().phase, 'expired')
})

test('tab reads a shared accepted extension, then shares expiry across tabs', async () => {
  const storage = new Map<string, string>()
  const a = world(storage), b = world(storage)
  await a.controller.ensure(user, token())
  await b.controller.ensure(user, token())
  a.advance(30 * 60000); b.advance(30 * 60000)
  await a.controller.activity()
  b.controller.tick()
  assert.equal(b.controller.view().remainingSeconds, 3600)
  a.controller.expire()
  b.controller.tick()
  assert.equal(b.controller.view().phase, 'expired')
  assert.equal(b.calls.filter((action) => action === 'end').length, 1)
})

test('sleep and reopening cannot create a fresh hour from an expired stored deadline', async () => {
  const w = world()
  await w.controller.ensure(user, token())
  w.controller.suspend()
  assert.equal(w.controller.view().phase, 'checking')
  w.advance(24 * HOUR)
  await w.controller.resume()
  assert.equal(w.controller.view().phase, 'expired')
  const reopen = world(w.shared)
  reopen.advance(24 * HOUR)
  await assert.rejects(reopen.controller.ensure(user, token()), IdleSessionError)
  assert.equal(reopen.calls.includes('status'), false)
})

test('clock rollback fails closed and background hidden input cannot extend', async () => {
  const w = world()
  await w.controller.ensure(user, token())
  w.controller.suspend()
  await w.controller.activity()
  assert.equal(w.calls.includes('activity'), false)
  w.advance(-1000)
  w.controller.tick()
  assert.equal(w.controller.view().phase, 'expired')
})

test('late receipt cannot restore an expired session or a different same-user session', async () => {
  let now = 0
  let resolve!: (v: unknown) => void
  const c = new IdleSessionController({ now: () => now, read: () => null, write: () => {},
    request: (action) => action === 'end' ? Promise.resolve({ ended: true }) : new Promise((r) => { resolve = r }) })
  const pending = c.ensure(user, token())
  c.expire()
  resolve({ sessionId: user.sessionId, serverNow: new Date(0).toISOString(), idleExpiresAt: new Date(HOUR).toISOString(), idleTimeoutSeconds: 3600, warningSeconds: 120 })
  await assert.rejects(pending, IdleSessionError)
  assert.equal(c.view().phase, 'expired')
  const next = { ...user, sessionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
  c.bind(next, token(next))
  await assert.rejects(c.ensure(user, token()), /Sign in again/)
  assert.equal(c.currentIdentity()?.sessionId, next.sessionId)
  now += HOUR
})

test('old in-flight request cannot commit into a new session for the same user', async () => {
  let resolve!: (v: unknown) => void
  const c = new IdleSessionController({ now: () => 0, read: () => null, write: () => {}, request: () => new Promise((r) => { resolve = r }) })
  const pending = c.ensure(user, token())
  const next = { ...user, sessionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
  c.bind(next, token(next))
  resolve({ sessionId: user.sessionId, serverNow: new Date(0).toISOString(), idleExpiresAt: new Date(HOUR).toISOString(), idleTimeoutSeconds: 3600, warningSeconds: 120 })
  await assert.rejects(pending, IdleSessionError)
  assert.equal(c.currentIdentity()?.sessionId, next.sessionId)
  assert.equal(c.view().phase, 'checking')
})

test('missing or mismatched policy receipts fail closed without extending', async () => {
  for (const receipt of [null, {}, { sessionId: 'different' }]) {
    const c = new IdleSessionController({ now: () => 0, read: () => null, write: () => {}, request: async () => receipt })
    await assert.rejects(c.ensure(user, token()), /verify the session timeout/)
    assert.equal(c.view().phase, 'checking')
    assert.equal(c.view().verificationFailed, true)
  }
})

test('token decoding supplies only a local session selector and rejects malformed claims', () => {
  assert.deepEqual(idleIdentity(token()), user)
  for (const invalid of ['', 'x.y.z', token({ ...user, subject: 'not-a-user' })]) assert.equal(idleIdentity(invalid), null)
})
