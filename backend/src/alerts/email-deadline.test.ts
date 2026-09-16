import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailDeadline } from './email-deadline.js'
import { emailSqlRunner } from './email-sql-runner.js'
import { emailAfterCollection } from './email-after-collection.js'

test('one absolute/monotonic budget shrinks, never restarts and rejects invalid clocks', () => {
  let wall = 1_000, mono = 0
  const budget = emailDeadline(7_000, () => wall, () => mono)
  assert.equal(budget.remaining(), 6_000)
  wall += 2_000; mono += 2_000
  assert.equal(budget.remaining(), 4_000)
  wall -= 3_000
  assert.equal(budget.remaining(), 4_000)
  mono += 4_001
  assert.throws(() => budget.remaining(), /EMAIL_DEADLINE_EXHAUSTED/)
  assert.throws(() => emailDeadline(NaN).transactionLimits(), /EMAIL_DEADLINE_EXHAUSTED/)
  assert.throws(() => emailDeadline(0, () => 0).transactionLimits(), /EMAIL_DEADLINE_EXHAUSTED/)
})

test('acquisition plus transaction limits shrink across sequential reads, with SET LOCAL only', async () => {
  let clock = 0, transactions = 0, queries = 0
  const limits: { maxWait: number; timeout: number }[] = []
  const settings: string[] = []
  const tx = {
    $executeRawUnsafe: async (sql: string) => { settings.push(sql); return 0 },
    $queryRawUnsafe: async () => { queries++; clock += 1_800; return [] },
  }
  const prisma = {
    $transaction: async (run: (client: typeof tx) => Promise<unknown>, options: { maxWait: number; timeout: number }) => {
      transactions++; limits.push(options); clock += 100
      return run(tx)
    },
  } as unknown as Parameters<typeof emailSqlRunner>[0]
  const runner = emailSqlRunner(prisma, 6_000, () => clock, () => clock)
  await runner.query('SELECT 1', [])
  await runner.query('SELECT 1', [])
  assert.equal(queries, 2)
  assert.ok(limits[1].timeout < limits[0].timeout)
  assert.ok(limits[1].maxWait + limits[1].timeout <= 6_000 - 1_900)
  assert.ok(settings.every(sql => sql.startsWith('SET LOCAL ')))
  clock = 6_001
  await assert.rejects(async () => runner.query('SELECT 1', []), /EMAIL_DEADLINE_EXHAUSTED/)
  assert.equal(transactions, 2)
})

test('deadline observed after pool acquisition starts no SQL', async () => {
  let clock = 0, statements = 0, released = false
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      clock = 30_000
      try { return await run({ $executeRawUnsafe: async () => { statements++; return 0 } }) }
      finally { released = true }
    },
  } as unknown as Parameters<typeof emailSqlRunner>[0]
  await assert.rejects(async () => emailSqlRunner(prisma, 25_000, () => clock, () => clock).query('SELECT 1', []),
    /EMAIL_DEADLINE_EXHAUSTED/)
  assert.equal(statements, 0)
  assert.equal(released, true)
})

test('collector result survives email failure; insufficient budget runs no email', async () => {
  const result = { collected: 1 }
  let calls = 0, given = 0
  const run = async (deadlineAt: number) => { calls++; given = deadlineAt; throw new Error('synthetic failure') }
  assert.equal(await emailAfterCollection(result, 50_000, run, () => 10_000), result)
  assert.equal(given, 35_000)
  assert.equal(calls, 1)
  for (const deadline of [10_000, 34_999, NaN, Infinity]) {
    assert.equal(await emailAfterCollection(result, deadline, run, () => 10_000), result)
  }
  assert.equal(calls, 1)
})