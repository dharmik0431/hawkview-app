import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Client, Pool, type ClientBase, type PoolConfig } from 'pg'
import { initializePrismaUtcSession } from './prisma-utc-session.js'

type Statement = { text: string; query_timeout: number }
type Reply = { rows: { timezone: string }[] }
const utc = (): Reply => ({ rows: [{ timezone: 'UTC' }] })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('UTC connection initialization uses constant SQL, readback and a shared finite query budget', async () => {
  const calls: Statement[] = []
  const client = { async query(query: Statement) { calls.push(query); return utc() } }
  await initializePrismaUtcSession(client as unknown as ClientBase)
  assert.deepEqual(calls.map(call => call.text), [
    "SET TIME ZONE 'UTC'", "SELECT current_setting('TimeZone') AS timezone",
  ])
  assert.ok(calls.every(call => call.query_timeout > 0 && call.query_timeout <= 5_000))
  assert.ok(calls[1]!.query_timeout <= calls[0]!.query_timeout)
})

test('UTC connection initialization rejects a non-UTC readback', async () => {
  const client = { async query() { return { rows: [{ timezone: 'Asia/Kolkata' }] } } }
  await assert.rejects(initializePrismaUtcSession(client as unknown as ClientBase),
    { message: 'DATABASE_UTC_SESSION_INITIALIZATION_FAILED' })
})

test('UTC connection initialization redacts driver failure details', async () => {
  const client = { async query() { throw new Error('connection details must not escape') } }
  await assert.rejects(initializePrismaUtcSession(client as unknown as ClientBase), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'DATABASE_UTC_SESSION_INITIALIZATION_FAILED')
    assert.equal(error.cause, undefined)
    return true
  })
})

function poolHarness(runQuery: (query: Statement) => Promise<Reply>, extra: PoolConfig = {}) {
  const created: { config: PoolConfig; closed: boolean; queries: Statement[] }[] = []
  class FakeClient extends EventEmitter {
    readonly record: (typeof created)[number]
    constructor(config: PoolConfig) {
      super()
      this.record = { config, closed: false, queries: [] }
      created.push(this.record)
    }
    connect(callback: (error?: Error) => void) { callback() }
    query(query: Statement) { this.record.queries.push(query); return runQuery(query) }
    end(callback?: () => void) {
      this.record.closed = true
      this.emit('end')
      callback?.()
      return Promise.resolve()
    }
  }
  const pool = new Pool({
    ...extra, Client: FakeClient as unknown as typeof Client,
    onConnect: initializePrismaUtcSession, idleTimeoutMillis: 0,
  })
  return { pool, created }
}

test('installed pg-pool awaits the UTC hook before handing out a client', async () => {
  let releaseInitialization!: () => void
  const held = new Promise<void>(resolve => { releaseInitialization = resolve })
  const { pool } = poolHarness(async query => {
    if (query.text.startsWith('SET')) await held
    return utc()
  })
  let acquired = false
  const pending = pool.connect().then(client => { acquired = true; return client })
  try {
    await tick()
    assert.equal(acquired, false)
    releaseInitialization()
    const client = await pending
    assert.equal(acquired, true)
    client.release()
  } finally { releaseInitialization(); await pool.end() }
})

test('installed pg-pool closes and refuses a client whose UTC hook fails', async () => {
  const { pool, created } = poolHarness(async () => { throw new Error('unusable initialization') })
  try {
    await assert.rejects(pool.connect(), { message: 'DATABASE_UTC_SESSION_INITIALIZATION_FAILED' })
    assert.equal(created.length, 1)
    assert.equal(created[0]!.closed, true)
    assert.equal(pool.totalCount, 0)
  } finally { await pool.end() }
})

test('all concurrent and recreated pool clients initialize without rewriting connection options', async () => {
  const connectionString = 'postgresql://disposable@localhost/utc_fixture?application_name=preserved'
  const { pool, created } = poolHarness(async () => utc(), {
    connectionString, application_name: 'preserved', max: 2, maxUses: 1,
  })
  try {
    const [first, second] = await Promise.all([pool.connect(), pool.connect()])
    assert.equal(created.length, 2)
    first.release()
    second.release()
    const third = await pool.connect()
    third.release()
    assert.equal(created.length, 3)
    for (const client of created) {
      assert.equal(client.config.connectionString, connectionString)
      assert.equal(client.config.application_name, 'preserved')
      assert.deepEqual(client.queries.map(query => query.text), [
        "SET TIME ZONE 'UTC'", "SELECT current_setting('TimeZone') AS timezone",
      ])
    }
  } finally { await pool.end() }
})
