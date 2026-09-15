import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { sendStoreOver } from './send-store.js'
import { type SqlRunner } from './pipeline-store.js'
import { TERMINAL } from './send-queue.js'

/**
 * The same honesty as current-state.test.ts: a double proves the MAPPING and the STATEMENT
 * TEXT, never that the statements run. send-worker.ts records what that gap cost once -- forty
 * green suites while the one real implementation would have failed on insert, because a double
 * enforces no constraint. So the columns are checked against the migration DDL, which sits on
 * the other side of the seam, and execution is proved by the grading run.
 */

type Call = { sql: string; params: readonly unknown[] }
const recording = (rows: readonly unknown[] = []) => {
  const calls: Call[] = []
  const runner: SqlRunner = {
    query: async <T,>(sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params }); return rows as readonly T[]
    },
    execute: async (sql: string, params: readonly unknown[]) => { calls.push({ sql, params }); return 1 },
    transaction: async <T,>(run: (tx: SqlRunner) => Promise<T>) => {
      calls.push({ sql: 'BEGIN', params: [] })
      const out = await run(runner)
      calls.push({ sql: 'COMMIT', params: [] })
      return out
    },
  }
  return { runner, calls }
}
const JOB_ROW = {
  message_id: 'incident/org|key', idempotency_key: 'incident/org|key', state: 'READY',
  attempts_made: '0', max_attempts: '3', not_before_at: new Date('2026-09-13T09:00:00.000Z'),
  claimed_by: null, claimed_at: null, claim_expires_at: null, provider_id: null,
}
const anyJob = { messageId: 'm', idempotencyKey: 'm', state: 'SENT', attemptsMade: 1,
  maxAttempts: 3, notBeforeIso: '', claim: null, providerId: null }
const anAttempt = { messageId: 'm', attemptNo: 1, startedAtIso: '2026-09-13T09:00:00.000Z', settled: null }

test('dueJobs excludes every terminal state, built from the exported vocabulary', async () => {
  // Not a restated list: if a new terminal state is added to TERMINAL this keeps passing only
  // because the query was built from it. send-queue.ts records that adding WITHDRAWN to one
  // list and not the other left a withdrawn job claimable.
  const { runner, calls } = recording([JOB_ROW])
  await sendStoreOver(runner).dueJobs('2026-09-13T12:00:00.000Z', 10)
  assert.ok(TERMINAL.length >= 5, 'the terminal vocabulary shrank; this guard may be vacuous')
  for (const state of TERMINAL) {
    assert.ok(calls[0].sql.includes("'" + state + "'"),
      state + ' is terminal but the due query does not exclude it')
  }
})

test('COUNT and timestamp columns are converted, not passed through', async () => {
  // Postgres returns counts as strings through most drivers. Unconverted they reach arithmetic
  // as NaN, and a job whose attemptsMade is NaN never exceeds its maximum.
  const { runner } = recording([JOB_ROW])
  const [job] = await sendStoreOver(runner).dueJobs('2026-09-13T12:00:00.000Z', 10)
  assert.equal(job.attemptsMade, 0)
  assert.equal(job.maxAttempts, 3)
  assert.equal(job.notBeforeIso, '2026-09-13T09:00:00.000Z')
})

test('a half-written claim reads as NO claim, not a claim with nulls in it', async () => {
  // Three columns meaningless apart. A claim rebuilt from two of them carries a null holder,
  // and a claim with no holder is how a job gets taken twice.
  for (const partial of [
    { claimed_by: 'w1', claimed_at: null, claim_expires_at: null },
    { claimed_by: null, claimed_at: new Date(), claim_expires_at: new Date() },
    { claimed_by: 'w1', claimed_at: new Date(), claim_expires_at: null },
  ]) {
    const { runner } = recording([{ ...JOB_ROW, ...partial }])
    const [job] = await sendStoreOver(runner).dueJobs('2026-09-13T12:00:00.000Z', 10)
    assert.equal(job.claim, null, JSON.stringify(partial))
  }
})

test('a complete claim is reconstructed', async () => {
  const { runner } = recording([{
    ...JOB_ROW, claimed_by: 'worker-1',
    claimed_at: new Date('2026-09-13T09:05:00.000Z'),
    claim_expires_at: new Date('2026-09-13T09:10:00.000Z'),
  }])
  const [job] = await sendStoreOver(runner).dueJobs('2026-09-13T12:00:00.000Z', 10)
  assert.ok(job.claim)
  assert.equal(job.claim.by, 'worker-1')
  assert.equal(job.claim.expiresIso, '2026-09-13T09:10:00.000Z')
})

test('settleAttempt writes the attempt and the job inside ONE transaction', async () => {
  // The interface exists to make it impossible to ask for one without the other: an attempt
  // settled without its job advancing sends again, and a job advanced without its attempt
  // settled is a send with no evidence.
  const { runner, calls } = recording()
  await sendStoreOver(runner).settleAttempt(
    anAttempt as never,
    { kind: 'ACCEPTED', providerId: 'p-1' as never, atIso: '2026-09-13T09:00:01.000Z' },
    anyJob as never)

  assert.equal(calls[0].sql, 'BEGIN')
  assert.equal(calls[calls.length - 1].sql, 'COMMIT')
  const inside = calls.slice(1, -1)
  assert.ok(inside.some((c) => c.sql.includes('alert_send_attempts')), 'the attempt was not settled')
  assert.ok(inside.some((c) => c.sql.includes('alert_send_jobs')), 'the job was not advanced')
})

test('a refusal records its reason and no provider id', async () => {
  const { runner, calls } = recording()
  await sendStoreOver(runner).settleAttempt(
    anAttempt as never,
    { kind: 'REFUSED_PERMANENT', atIso: '2026-09-13T09:00:01.000Z', because: 'mailbox refused' },
    { ...anyJob, state: 'GAVE_UP' } as never)

  const attempt = calls.find((c) => c.sql.includes('alert_send_attempts'))
  assert.ok(attempt)
  assert.ok(attempt.params.includes('mailbox refused'))
  assert.ok(attempt.params.includes(null), 'a refusal must not carry a provider id')
})

test('DDL GUARD: every column this store names exists in the migrations', () => {
  // The check a double cannot make, and the one that catches the mistake I made writing
  // current-state.ts: a query naming a column that is not there passes every test above.
  const ddl = ['20260912223000_alert_send_jobs', '20260913200000_send_job_withdrawn']
    .map((m) => readFileSync(
      new URL('../../prisma/migrations/' + m + '/migration.sql', import.meta.url), 'utf8'))
    .join('\n')
  const source = readFileSync(new URL('./send-store.ts', import.meta.url), 'utf8')

  for (const column of [
    'message_id', 'idempotency_key', 'state', 'attempts_made', 'max_attempts',
    'not_before_at', 'claimed_by', 'claimed_at', 'claim_expires_at', 'provider_id',
    'attempt_no', 'started_at', 'settled_kind', 'settled_at', 'because',
  ]) {
    assert.ok(ddl.includes('"' + column + '"'), column + ' is not declared in the migrations')
    assert.ok(source.includes(column), column + ' is unused; this guard checks a dropped column')
  }

  // Negative control: a plausible name that is NOT in the schema. Without it the loop above
  // would pass against a DDL that happened to contain every string.
  assert.ok(!ddl.includes('"sent_at"'), 'the control column now exists; this guard is stale')
})

test('INSERT GUARD: every column the database requires is supplied', () => {
  // THE OTHER DIRECTION, and the blind spot that let a real defect through. The guard above
  // checks the columns this module READS. It says nothing about the columns the database
  // demands on write, and a statement omitting a NOT NULL column with no default passes every
  // test that inspects a recording double -- the double accepts any string.
  //
  // send-worker.ts already wrote this down: "an interface can be satisfied by a double long
  // after it has stopped being satisfiable by a database." The comment could not fire. This can.
  //
  // The trap is specifically Prisma-shaped. schema.prisma declares
  //   id String @id @default(uuid())
  // which is a CLIENT-side default -- Prisma supplies it. The migration declares
  //   "id" UUID NOT NULL
  // with no database default at all. Raw SQL through SqlRunner bypasses Prisma entirely, so the
  // schema file reads as though the column is handled while the database refuses the insert.
  const ddl = readFileSync(new URL(
    '../../prisma/migrations/20260912223000_alert_send_jobs/migration.sql', import.meta.url), 'utf8')
  const source = readFileSync(new URL('./send-store.ts', import.meta.url), 'utf8')

  const table = 'alert_send_attempts'
  const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS "public"."' + table + '"')
  assert.notEqual(start, -1, 'no CREATE TABLE found for ' + table)
  const body = ddl.slice(ddl.indexOf('(', start) + 1, ddl.indexOf('\n);', start))

  const required = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .filter((line) => line.includes('NOT NULL') && !line.includes('DEFAULT'))
    .map((line) => line.slice(1, line.indexOf('"', 1)))
  assert.ok(required.length > 0, 'parsed no required columns; this guard would pass vacuously')

  const insertAt = source.indexOf('INSERT INTO ' + table)
  assert.notEqual(insertAt, -1, 'no INSERT into ' + table + ' found in the store')
  const supplied = source
    .slice(source.indexOf('(', insertAt) + 1, source.indexOf(')', insertAt))
    .split(',')
    .map((name) => name.trim())

  for (const column of required) {
    assert.ok(
      supplied.includes(column),
      column + ' is NOT NULL with no database default, and the INSERT does not supply it. ' +
      'Every send fails at openAttempt with 23502, and the job is left CLAIMED -- which is not ' +
      'terminal -- so it cycles rather than failing once. schema.prisma\u2019s @default(uuid()) is ' +
      'a Prisma-side default and does not apply to raw SQL.')
  }
})
