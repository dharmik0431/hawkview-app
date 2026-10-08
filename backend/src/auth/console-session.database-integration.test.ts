import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { ConsoleSessionService, type SessionDatabase, type SessionTransaction } from './console-session.service.js'
import type { AuthenticatedIdentity } from './auth.types.js'

const skip = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1'
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const denial = (code: string) => (error: any) => error.getStatus() === 401 && error.getResponse().code === code

test('console inactivity deadlines with actual migrated PostgreSQL transactions', { skip, timeout: 45000 }, async t => {
  const url = assertDisposableTestDatabase(), schema = 'console_idle_' + randomUUID().replaceAll('-', '')
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 })
  const observer = await pool.connect()
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }, { schema }) })
  let created = false
  try {
    await observer.query(`CREATE SCHEMA ${schema}`); created = true
    await observer.query(`SET search_path TO ${schema},public`)
    // Requires the draft migration applied to the explicitly disposable DB by
    // the authorized migration job. Never synthesizes a weaker table shape.
    await observer.query(`CREATE TABLE ${schema}.console_sessions (LIKE public.console_sessions INCLUDING ALL)`)
    const host = (onBegin?: (pid: number) => void, beforeCommit?: () => void): SessionDatabase => ({
      $transaction: (work, options) => prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${schema},public`)
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'")
        if (onBegin) onBegin((await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid)
        const result = await work(tx as SessionTransaction)
        beforeCommit?.()
        return result
      }, options),
    })
    const service = new ConsoleSessionService(host())
    const now = async () => (await observer.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const identity = async (): Promise<AuthenticatedIdentity> => ({ subject: randomUUID(), sessionId: randomUUID(),
      email: 'synthetic@example.invalid', assuranceLevel: 'aal2', authenticatedAt: new Date((await now()).getTime() - 300000) })
    const stored = async (id: string) => (await observer.query('SELECT * FROM console_sessions WHERE session_id=$1::uuid', [id])).rows

    await t.test('migration keeps the authority backend-only with RLS and no anonymous/authenticated grants', async () => {
      const meta = (await observer.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.console_sessions'::regclass")).rows[0]
      assert.equal(meta.relrowsecurity, true)
      for (const { rolname } of (await observer.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal((await observer.query("SELECT has_table_privilege($1,'public.console_sessions',$2) AS allowed", [rolname, privilege])).rows[0].allowed, false)
        }
      }
    })
    await t.test('concurrent initialization creates one authentication-anchored record; reads never refresh it', async () => {
      const id = await identity()
      const [a, b] = await Promise.all([service.check(id), service.check(id)])
      assert.equal(a.idleExpiresAt, new Date(id.authenticatedAt!.getTime() + 3600000).toISOString())
      assert.equal(b.idleExpiresAt, a.idleExpiresAt); assert.equal((await stored(id.sessionId!)).length, 1)
      const before = await stored(id.sessionId!)
      await service.check({ ...id, authenticatedAt: await now() })
      assert.deepEqual(await stored(id.sessionId!), before)
      const active = await service.activity(id)
      assert.equal(Date.parse(active.idleExpiresAt) - Date.parse(active.serverNow), 3600000)
    })
    await t.test('missing old/unverifiable sessions cannot be bootstrapped and expiry cannot be revived by newer AMR', async () => {
      const id = await identity()
      for (const authenticatedAt of [undefined, new Date((await now()).getTime() - 86400000)]) {
        await assert.rejects(service.check({ ...id, authenticatedAt }), denial('SESSION_REAUTHENTICATION_REQUIRED'))
        assert.equal((await stored(id.sessionId!)).length, 0)
      }
      await service.check(id)
      await observer.query("UPDATE console_sessions SET idle_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE session_id=$1::uuid", [id.sessionId])
      await assert.rejects(service.activity({ ...id, authenticatedAt: await now() }), denial('SESSION_IDLE_EXPIRED'))
      await assert.rejects(service.check(id), denial('SESSION_IDLE_EXPIRED'))
      assert.deepEqual(await service.end(id), { ended: true })
    })
    for (const seeded of [false, true]) await t.test(`concurrent end and activity/bootstrap retain revocation, existing=${seeded}`, async () => {
      const id = await identity(); if (seeded) await service.check(id)
      const results = await Promise.allSettled([service.activity(id), service.end(id), service.check(id)])
      assert.equal(results[1].status, 'fulfilled')
      assert.ok((await stored(id.sessionId!))[0].revoked_at)
      const before = await stored(id.sessionId!)
      await service.end(id); assert.deepEqual(await stored(id.sessionId!), before)
      await assert.rejects(service.activity(id), denial('SESSION_REAUTHENTICATION_REQUIRED'))
      await assert.rejects(service.check(id), denial('SESSION_REAUTHENTICATION_REQUIRED'))
    })
    await t.test('subject/session binding isolates devices and refuses a foreign subject', async () => {
      const a = await identity(), b = { ...a, sessionId: randomUUID() }
      await service.check(a); await service.check(b)
      const foreign = { ...a, subject: randomUUID() }
      for (const operation of [service.check.bind(service), service.activity.bind(service), service.end.bind(service)]) {
        await assert.rejects(operation(foreign), denial('SESSION_REAUTHENTICATION_REQUIRED'))
      }
      await service.end(a); await service.activity(b)
      assert.equal((await stored(b.sessionId!))[0].revoked_at, null)
    })
    await t.test('failed commit does not acknowledge or persist initialization or activity', async () => {
      const id = await identity(), broken = new ConsoleSessionService(host(undefined, () => { throw Error('synthetic commit failure') }))
      await assert.rejects(broken.check(id), /synthetic commit/)
      assert.deepEqual(await stored(id.sessionId!), [])
      await service.check(id); const before = await stored(id.sessionId!)
      await assert.rejects(broken.activity(id), /synthetic commit/)
      assert.deepEqual(await stored(id.sessionId!), before)
    })
    await t.test('activity blocked across expiry uses the post-lock clock and cannot extend', async () => {
      const id = await identity(); await service.check(id)
      const blocker = await pool.connect(), entered = gate<number>()
      let pending: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`hawkview:console-session:${id.sessionId}`])
        const worker = new ConsoleSessionService(host(pid => entered.resolve(pid)))
        pending = worker.activity(id)
        // Attach a rejection handler at dispatch; every exit below drains work.
        const settled = pending.then(value => ({ value }), error => ({ error }))
        const pid = await Promise.race([entered.promise, settled.then(() => { throw Error('worker settled before transaction entry') })])
        let blocked = false
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
          blocked = (await observer.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
          if (blocked) break
          await Promise.race([new Promise(resolve => setTimeout(resolve, 5)), settled.then(() => { throw Error('worker was not blocked') })])
        }
        assert.ok(blocked, 'independent session lock must block activity')
        // This deadline is AFTER the worker transaction started but BEFORE it
        // obtains the lock. CURRENT_TIMESTAMP would wrongly admit that worker.
        await blocker.query(`UPDATE ${schema}.console_sessions SET idle_expires_at=clock_timestamp() WHERE session_id=$1::uuid`, [id.sessionId])
        await blocker.query('COMMIT')
        await assert.rejects(pending, denial('SESSION_IDLE_EXPIRED'))
      } finally {
        await blocker.query('ROLLBACK').catch(() => {})
        await Promise.allSettled([pending]); blocker.release()
      }
    })
  } finally {
    await prisma.$disconnect()
    if (created) await observer.query(`DROP SCHEMA ${schema} CASCADE`)
    observer.release(); await pool.end()
  }
})
