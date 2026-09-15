import assert from 'node:assert/strict'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { sendStoreOver } from './send-store.js'
import { type SqlRunner } from './pipeline-store.js'

/**
 * **`sendStoreOver` AGAINST A REAL DATABASE — the test it has never had.**
 *
 * Its unit tests drive a recording double and assert on the SQL string. That is why an INSERT the
 * database refuses lived in a module whose suite was green: a double accepts any statement, and
 * `openAttempt` omits `alert_send_attempts.id`, which is UUID NOT NULL with no database default.
 *
 * The absence is quieter than the defect. A SKIPPED test that would pass tells you nothing; a
 * module with NO database test does not appear in any count at all. The 34 database-integration
 * tests in this suite were run against a real migrated database with this defect present and all
 * 34 passed, because not one of them touches this path. Enabling the database flag in CI was
 * worth doing and would not have caught it.
 *
 * **EXPECT `openAttempt` TO FAIL HERE UNTIL THE INSERT IS FIXED.** That is the point of writing
 * it now rather than alongside the fix: the instrument should exist before the repair, so the
 * repair is measured rather than asserted.
 */

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

/** The same guard the other suites use, for the same reason: this writes and deletes. */
function disposableUrl(): string {
  const url = assertDisposableTestDatabase()
  // NO QUERY PARAMETERS, AND THIS IS NOT TIDINESS. libpq honours `?host=` and `?hostaddr=` in a
  // connection URI and they OVERRIDE the authority — so a URL whose hostname reads 127.0.0.1 can
  // connect somewhere else entirely, and every check below would pass while doing it. The guard
  // has to refuse what it cannot see through.
  assert.equal(url.search, '', 'No query parameters: host= and hostaddr= override the authority')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA or repository CI database only')
  return url.toString()
}

const MIGRATION = '20260912223000_alert_send_jobs'

/** A runner over one connection. No transaction nesting: `settleAttempt` opens the only one. */
const runnerOver = (client: pg.Client): SqlRunner => ({
  query: async <T,>(sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rows as readonly T[],
  execute: async (sql: string, params: readonly unknown[]) =>
    (await client.query(sql, [...params])).rowCount ?? 0,
  transaction: async <T,>(run: (tx: SqlRunner) => Promise<T>) => {
    await client.query('BEGIN')
    try {
      const out = await run(runnerOver(client))
      await client.query('COMMIT')
      return out
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  },
})

async function withClient(work: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: disposableUrl() })
  await client.connect()
  try {
    // THE PREREQUISITE, CHECKED FIRST AND NAMED. prisma.config.ts pins schema and
    // migrations.path relative to cwd and overrides --schema, which has already produced a
    // clean-looking run that applied 61 of 63 migrations. If this database stopped short, every
    // assertion below fails for a reason that has nothing to do with the store.
    const applied = await client.query(
      'SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL',
      [MIGRATION])
    assert.equal(applied.rowCount, 1, MIGRATION + ' is not applied to this database.')
    await work(client)
  } finally {
    await client.end()
  }
}

/** Exactly the shape the pipeline inserts: a queued job and nothing else.
 *
 * WITHDRAWAL PROVENANCE IS NOT OPTIONAL. `alert_send_jobs_withdrawal_check` is a BICONDITIONAL:
 * state = 'WITHDRAWN' if and only if withdrawn_at and withdrawn_because are present. My first
 * version of this fixture set the state alone and the database refused it on first contact --
 * a fixture defect inside the very test written to close this coverage gap, caught by the
 * constraint doing exactly what it was added to do. A double would have accepted it forever. */
async function insertReadyJob(client: pg.Client, state = 'READY'): Promise<string> {
  const id = randomUUID()
  const message = 'incident/' + randomUUID() + '|synthetic-rule|synthetic-subject'
  const withdrawn = state === 'WITHDRAWN'
  await client.query(
    'INSERT INTO alert_send_jobs (id, message_id, idempotency_key, state, attempts_made,' +
    ' max_attempts, not_before_at, updated_at, withdrawn_at, withdrawn_because)' +
    ' VALUES ($1, $2, $3, $4, 0, 3, now(), now(), $5, $6)',
    [id, message, 'key-' + id, state,
      withdrawn ? new Date() : null,
      withdrawn ? 'ALERT_TYPE_DISABLED' : null])
  return message
}

/* A NOTIFICATION HELPER USED TO LIVE HERE AND IT WAS WRONG THREE WAYS: it ran OUTSIDE the
 * cleanup-protected block, so its rows survived a failure and contaminated the next run; its
 * INSERT omitted the required `category` column; and its organization id was random, against a
 * foreign key that would have refused it. The fixture would have failed on a fully migrated
 * schema BEFORE openAttempt was exercised at all -- a fixture defect inside the test written
 * to close the gap that let the missing-id defect through, for the second time.
 *
 * It is GONE rather than repaired, because these tests exercise the STORE -- dueJobs,
 * openAttempt, settlement -- and none of them reads `notifications`. Building valid synthetic
 * parents for a table nothing here touches is risk with no coverage attached. A test that
 * exercises `visibility` needs them and must construct them properly, inside cleanup. */

const cleanup = async (client: pg.Client, message: string) => {
  await client.query('DELETE FROM alert_send_attempts WHERE message_id = $1', [message])
  await client.query('DELETE FROM alert_send_jobs WHERE message_id = $1', [message])
}

test('openAttempt actually writes a row', { skip: !enabled, timeout: 30_000 }, async () => {
  // THE ONE THAT MATTERS. It fails with 23502 until the insert supplies an id, and no unit test
  // in this module can see that, because a recording double accepts the statement either way.
  await withClient(async (client) => {
    const message = await insertReadyJob(client)
    try {
      await sendStoreOver(runnerOver(client)).openAttempt(
        { messageId: message, attemptNo: 1, startedAtIso: new Date().toISOString(), settled: null } as never)

      const rows = await client.query(
        'SELECT attempt_no FROM alert_send_attempts WHERE message_id = $1', [message])
      assert.equal(rows.rowCount, 1, 'openAttempt reported success and wrote no row')
    } finally {
      await cleanup(client, message)
    }
  })
})

test('dueJobs reads a queued job and refuses a terminal one', { skip: !enabled, timeout: 30_000 }, async () => {
  // Proves the SELECT names columns that exist and that the terminal exclusion is enforced by
  // the database rather than only present in the string.
  await withClient(async (client) => {
    const ready = await insertReadyJob(client)
    const withdrawn = await insertReadyJob(client, 'WITHDRAWN')
    try {
      const jobs = await sendStoreOver(runnerOver(client)).dueJobs(new Date().toISOString(), 100)
      const ids = jobs.map((job) => job.messageId as string)
      assert.ok(ids.includes(ready), 'a READY job was not returned as due')
      assert.ok(!ids.includes(withdrawn), 'a WITHDRAWN job was offered for claiming')
    } finally {
      await cleanup(client, ready)
      await cleanup(client, withdrawn)
    }
  })
})
