import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { messageId } from './email-delivery.js'
import { withdrawStatement } from './send-queue.js'
import { WITHDRAWN_REASONS } from './send-worker.js'

/**
 * **THE WITHDRAWAL, EXECUTED AGAINST A REAL DATABASE.**
 *
 * `send-queue.test.ts` compares the statement and the vocabulary against the MIGRATION TEXT. That
 * was the cheapest instrument available without a cluster and it is not this: text agreement shows
 * the code and the schema name the same things, never that the write succeeds. **Everything here
 * runs SQL and reads the row back.**
 *
 * Two questions, and the second one is the one that can break somebody else:
 *   1. Does a withdrawal actually persist, and do the constraints refuse the lies they were added
 *      to refuse? A CHECK that exists in a file and a CHECK that is enforced by the running
 *      database are different claims.
 *   2. **Does the pipeline's unchanged `READY` insert still succeed?** `alert_send_jobs` is
 *      inserted by the pipeline and only transitioned here, so a column added wrong stops every
 *      send from being queued — a failure that looks nothing like "withdrawals are broken".
 *
 * NOTHING HERE IS A TENANT, A PERSON OR A REAL ADDRESS. `alert_send_jobs` carries no organisation
 * and no recipient — a message id and a budget — so a synthetic row is the whole fixture.
 */

const enabled = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'

/** The same guard the identity-risk suites use, for the same reason: this writes and deletes. */
function disposableUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? '')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Disposable loopback DB only')
  assert.match(url.pathname, /test|qa|^\/hawkview_ci$/i, 'Explicit test/QA or repository CI database only')
  return url.toString()
}

const MIGRATION = '20260913200000_send_job_withdrawn'

async function withClient(work: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: disposableUrl() })
  await client.connect()
  try {
    // **THE PREREQUISITE, CHECKED FIRST AND NAMED.** `backend/prisma.config.ts` pins `schema` and
    // `migrations.path` relative to cwd and OVERRIDES `--schema`, which has already produced a
    // clean-looking run that applied 61 of 63 migrations. If this database stopped short of the
    // withdrawal migration, every assertion below would fail for a reason that has nothing to do
    // with the withdrawal — so the harness says so itself rather than letting the symptom lie.
    const applied = await client.query(
      'SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL', [MIGRATION])
    assert.equal(applied.rowCount, 1,
      `${MIGRATION} is not applied to this database. Check the APPLIED COUNT against the migrations directory — prisma.config.ts overrides --schema, so a run from the wrong cwd migrates a different tree and exits clean.`)
    await work(client)
  } finally {
    await client.end()
  }
}

/** Exactly the shape the pipeline inserts: a queued job and nothing else. No claim, no provider,
 * and neither withdrawal column mentioned. */
async function insertReadyJob(client: pg.Client, id = randomUUID()): Promise<string> {
  const message = `incident/${randomUUID()}|synthetic-rule|synthetic-subject`
  await client.query(
    `INSERT INTO alert_send_jobs
       (id, message_id, idempotency_key, state, attempts_made, max_attempts, not_before_at, updated_at)
     VALUES ($1, $2, $3, 'READY', 0, 3, now(), now())`,
    [id, message, `key-${id}`])
  return message
}

const readJob = async (client: pg.Client, message: string) =>
  (await client.query('SELECT * FROM alert_send_jobs WHERE message_id = $1', [message])).rows[0]

/** Runs `work` inside a savepoint and returns the database's error, so a CHECK violation can be
 * asserted without poisoning the surrounding transaction. */
async function refusedBy(client: pg.Client, work: () => Promise<unknown>): Promise<string> {
  await client.query('SAVEPOINT probe')
  try {
    await work()
    await client.query('RELEASE SAVEPOINT probe')
    return ''
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe')
    return error instanceof Error ? `${(error as { constraint?: string }).constraint ?? ''}:${error.message}` : String(error)
  }
}

// ---------------------------------------------------------------------------------------

test('A WITHDRAWAL PERSISTS, and the row says what happened', { skip: !enabled, timeout: 30_000 }, () =>
  withClient(async client => {
    await client.query('BEGIN')
    try {
      const message = await insertReadyJob(client)
      const at = new Date().toISOString()
      const statement = withdrawStatement(messageId(message), 'ALERT_TYPE_DISABLED', at)

      const result = await client.query(statement.sql, [...statement.params])

      assert.equal(result.rowCount, statement.expectedRowCount, 'the guarded UPDATE matched the live job')
      const row = await readJob(client, message)
      assert.equal(row.state, 'WITHDRAWN')
      assert.equal(row.withdrawn_because, 'ALERT_TYPE_DISABLED')
      assert.ok(row.withdrawn_at instanceof Date, 'the time is durable, not implied by the state')
      // Cleared in the same write, or the claim provenance CHECK would have refused the row.
      assert.equal(row.claimed_by, null)
      assert.equal(row.claimed_at, null)
      assert.equal(row.claim_expires_at, null)
      // Untouched: a withdrawal is not a cancellation and must not read as one.
      assert.equal(row.cancelled_by, null)
      assert.equal(row.cancelled_at, null)
    } finally {
      await client.query('ROLLBACK')
    }
  }))

test('THE PIPELINE CAN STILL QUEUE A JOB, before and after a withdrawal exists', { skip: !enabled, timeout: 30_000 }, () =>
  withClient(async client => {
    // THE ONE THAT BREAKS SOMEBODY ELSE. A NOT NULL on either new column would fail this, and the
    // symptom would be "nothing is ever queued" rather than anything about withdrawals.
    await client.query('BEGIN')
    try {
      const before = await insertReadyJob(client)
      assert.equal((await readJob(client, before)).state, 'READY')

      const statement = withdrawStatement(messageId(before), 'NO_VERIFIED_RECIPIENT', new Date().toISOString())
      await client.query(statement.sql, [...statement.params])

      // Again AFTER a withdrawn row exists in the table, so this cannot pass by the table being empty.
      const after = await insertReadyJob(client)
      const row = await readJob(client, after)
      assert.equal(row.state, 'READY')
      assert.equal(row.withdrawn_at, null, 'an ordinary insert names neither column')
      assert.equal(row.withdrawn_because, null)
    } finally {
      await client.query('ROLLBACK')
    }
  }))

test('THE BICONDITIONAL IS ENFORCED BY THE RUNNING DATABASE, not just present in a file', { skip: !enabled, timeout: 30_000 }, () =>
  withClient(async client => {
    await client.query('BEGIN')
    try {
      const message = await insertReadyJob(client)

      // WITHDRAWN with no reason: the half that stops a lie being recorded.
      const naked = await refusedBy(client, () => client.query(
        `UPDATE alert_send_jobs SET state = 'WITHDRAWN' WHERE message_id = $1`, [message]))
      assert.match(naked, /alert_send_jobs_withdrawal_check/, 'a withdrawal with no reason was accepted')

      // A reason with no withdrawal: the half that stops a half-finished UPDATE surviving as a row
      // that reads as live and carries a withdrawal.
      const orphan = await refusedBy(client, () => client.query(
        `UPDATE alert_send_jobs SET withdrawn_at = now(), withdrawn_because = 'ALERT_TYPE_DISABLED' WHERE message_id = $1`, [message]))
      assert.match(orphan, /alert_send_jobs_withdrawal_check/, 'a reason on a live job was accepted')

      // The control: the row is still exactly as inserted, so the refusals above refused something.
      assert.equal((await readJob(client, message)).state, 'READY')
    } finally {
      await client.query('ROLLBACK')
    }
  }))

test('EVERY MODELLED REASON IS ACCEPTED AND AN INVENTED ONE IS REFUSED', { skip: !enabled, timeout: 30_000 }, () =>
  withClient(async client => {
    // Both directions. Accepting all four proves the vocabulary is not narrower than the code;
    // refusing a fifth proves the CHECK is doing anything at all.
    await client.query('BEGIN')
    try {
      for (const reason of WITHDRAWN_REASONS) {
        const message = await insertReadyJob(client)
        const statement = withdrawStatement(messageId(message), reason, new Date().toISOString())
        const result = await client.query(statement.sql, [...statement.params])
        assert.equal(result.rowCount, 1, `the schema refused ${reason}, which the resolver can produce`)
        assert.equal((await readJob(client, message)).withdrawn_because, reason)
      }

      const message = await insertReadyJob(client)
      const invented = await refusedBy(client, () => client.query(
        `UPDATE alert_send_jobs SET state='WITHDRAWN', withdrawn_at=now(), withdrawn_because='SOMETHING_ELSE' WHERE message_id=$1`,
        [message]))
      assert.match(invented, /alert_send_jobs_withdrawn_reason_check/, 'an unmodelled reason was accepted')
    } finally {
      await client.query('ROLLBACK')
    }
  }))

test('A TERMINAL JOB IS NOT RELABELLED, and zero rows is how the worker learns that', { skip: !enabled, timeout: 30_000 }, () =>
  withClient(async client => {
    await client.query('BEGIN')
    try {
      const message = await insertReadyJob(client)
      // SENT carries its evidence — the sent_check is biconditional on provider_id.
      await client.query(
        `UPDATE alert_send_jobs SET state='SENT', provider_id='p-synthetic', attempts_made=1 WHERE message_id=$1`, [message])

      const statement = withdrawStatement(messageId(message), 'INCIDENT_NO_LONGER_ACTIONABLE', new Date().toISOString())
      const result = await client.query(statement.sql, [...statement.params])

      assert.equal(result.rowCount, 0, 'a sent message must never be relabelled as withdrawn')
      const row = await readJob(client, message)
      assert.equal(row.state, 'SENT', 'and the row is untouched')
      assert.equal(row.withdrawn_because, null)
    } finally {
      await client.query('ROLLBACK')
    }
  }))

test('THE WIDENED STATE VOCABULARY IS LIVE', { skip: !enabled, timeout: 30_000 }, () =>
  withClient(async client => {
    // The state CHECK is dropped and re-added by each widening. This is the assertion that the
    // LAST definition is the one in force, rather than an earlier one that never heard of
    // WITHDRAWN — a distinction the migration text cannot make.
    await client.query('BEGIN')
    try {
      const message = await insertReadyJob(client)
      const nonsense = await refusedBy(client, () => client.query(
        `UPDATE alert_send_jobs SET state='NOT_A_STATE' WHERE message_id=$1`, [message]))
      assert.match(nonsense, /alert_send_jobs_state_check/, 'the state CHECK is not enforced at all')

      const statement = withdrawStatement(messageId(message), 'MESSAGE_CONTENT_UNAVAILABLE', new Date().toISOString())
      assert.equal((await client.query(statement.sql, [...statement.params])).rowCount, 1,
        'WITHDRAWN is refused by the live state CHECK, so the widening did not reach this database')
    } finally {
      await client.query('ROLLBACK')
    }
  }))
