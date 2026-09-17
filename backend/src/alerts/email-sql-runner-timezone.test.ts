import assert from 'node:assert/strict'
import test from 'node:test'
import { type PrismaService } from '../prisma/prisma.service.js'
import { emailSqlRunner } from './email-sql-runner.js'

function harness(failTimezone = false) {
  const calls: string[] = []
  let transactions = 0
  const client = {
    async $executeRawUnsafe(sql: string) {
      calls.push(sql)
      if (failTimezone && sql === "SET LOCAL TIME ZONE 'UTC'") throw new Error('UTC_INIT_FAILED')
      return 0
    },
    async $queryRawUnsafe() {
      calls.push('QUERY')
      return [{ value: 'result' }]
    },
  }
  const prisma = {
    async $transaction<T>(run: (tx: typeof client) => Promise<T>) {
      transactions += 1
      return run(client)
    },
  } as unknown as PrismaService
  return { calls, transactions: () => transactions, runner: emailSqlRunner(prisma) }
}

test('email standalone reads and writes initialize UTC on every actual transaction', async () => {
  const h = harness()
  assert.deepEqual(await h.runner.query('SELECT 1', []), [{ value: 'result' }])
  await h.runner.execute('UPDATE fixture SET value = 1', [])
  assert.equal(h.transactions(), 2)
  assert.equal(h.calls[0], "SET LOCAL TIME ZONE 'UTC'")
  assert.equal(h.calls.filter(sql => sql === "SET LOCAL TIME ZONE 'UTC'").length, 2)
  const secondUtc = h.calls.lastIndexOf("SET LOCAL TIME ZONE 'UTC'")
  assert.ok(secondUtc > h.calls.indexOf('QUERY'))
  assert.ok(secondUtc < h.calls.indexOf('UPDATE fixture SET value = 1'))
  assert.ok(h.calls.some(sql => sql.startsWith('SET LOCAL statement_timeout')))
  assert.ok(h.calls.some(sql => sql.startsWith('SET LOCAL lock_timeout')))
})

test('nested email runner work shares one UTC initialized transaction', async () => {
  const h = harness()
  await h.runner.transaction(async tx => {
    await tx.query('SELECT 1', [])
    await tx.transaction(nested => nested.execute('UPDATE fixture SET value = 2', []))
  })
  assert.equal(h.transactions(), 1)
  assert.equal(h.calls[0], "SET LOCAL TIME ZONE 'UTC'")
  assert.equal(h.calls.filter(sql => sql === "SET LOCAL TIME ZONE 'UTC'").length, 1)
})

test('email runner fails closed before product SQL when UTC initialization fails', async () => {
  const h = harness(true)
  await assert.rejects(h.runner.query('SELECT 1', []), /UTC_INIT_FAILED/)
  assert.deepEqual(h.calls, ["SET LOCAL TIME ZONE 'UTC'"])
  assert.equal(h.transactions(), 1)
})

test('UTC initialization cannot renew the original email transaction deadline', async () => {
  let now = 10_000
  let queried = false
  const client = {
    async $executeRawUnsafe(sql: string) {
      assert.equal(sql, "SET LOCAL TIME ZONE 'UTC'")
      now += 10_000
      return 0
    },
    async $queryRawUnsafe() { queried = true; return [] },
  }
  const prisma = {
    async $transaction<T>(run: (tx: typeof client) => Promise<T>) { return run(client) },
  } as unknown as PrismaService
  const runner = emailSqlRunner(prisma, 15_000, () => now, () => now)
  await assert.rejects(runner.query('SELECT 1', []))
  assert.equal(queried, false)
})
