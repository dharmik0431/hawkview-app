// QA — THE THIRD IN-PLACE EDIT, the one dcca63e does not correct.
//
// `0a62f8d` widened `alert_send_jobs.message_id` and `idempotency_key` from VARCHAR(200) to
// VARCHAR(400) BY EDITING 20260912223000 IN PLACE. My convergence run did not exercise it: the
// route I used started before that migration existed at all, so it only ever applied the widened
// version. Reachable is not reached, and a route that never met the old file proves nothing about
// a database that did.
//
// This starts at `0a62f8d^`, where the migration exists in the form that was actually applied.
import { execFileSync } from 'node:child_process'
import pg from 'pg'

const HOST = 'postgresql://postgres:postgres@127.0.0.1:55432/'
const url = (db) => HOST + db + '?schema=public'
const OLD3 = 'C:/hv-pre3/backend'
const TIP = 'C:/hv-run/backend'

// A REAL message_id, taken verbatim from the U1 end-to-end run earlier today. Not invented to be
// long: this is what `incident/${scoped}` produces for one ordinary finding.
const REAL_MESSAGE_ID =
  'incident/11111111-1111-1111-1111-111111111111|26:hawkview-alert-incident/v1'
  + '36:security.suspected_credential_attack36:11111111-1111-1111-1111-111111111111'
  + '36:22222222-2222-2222-2222-2222222222227:ACCOUNT6:user-1'

async function admin(sql) {
  const c = new pg.Client({ connectionString: HOST + 'postgres' })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}

function migrate(cwd, db) {
  try {
    const out = execFileSync('npx', ['prisma', 'migrate', 'deploy'],
      { cwd, encoding: 'utf8', shell: true, env: { ...process.env, DATABASE_URL: url(db) } })
    return { ok: true, tail: out.trim().split('\n').pop() }
  } catch (e) {
    return { ok: false, tail: String(e.stdout ?? '').trim().split('\n').slice(-4).join(' | ') }
  }
}

const widths = async (c) => (await c.query(
  `SELECT table_name, column_name, character_maximum_length AS len
     FROM information_schema.columns
    WHERE table_schema='public' AND column_name IN ('message_id','idempotency_key')
    ORDER BY table_name, column_name`)).rows

async function tryInsert(c) {
  try {
    await c.query(
      `INSERT INTO alert_send_jobs (id, message_id, idempotency_key, state, max_attempts, not_before_at, updated_at)
       VALUES (gen_random_uuid(), $1, $1, 'READY', 3, now(), now())`, [REAL_MESSAGE_ID])
    return 'accepted'
  } catch (e) { return 'REFUSED ' + e.code + ' ' + String(e.message).slice(0, 70) }
}

async function main() {
  await admin('DROP DATABASE IF EXISTS hvmigold3')
  await admin('CREATE DATABASE hvmigold3')
  const applyOld = migrate(OLD3, 'hvmigold3')

  const c = new pg.Client({ connectionString: HOST + 'hvmigold3' })
  await c.connect()
  const before = await widths(c)
  const insertBefore = await tryInsert(c)
  await c.end()

  const forward = migrate(TIP, 'hvmigold3')

  const d = new pg.Client({ connectionString: HOST + 'hvmigold3' })
  await d.connect()
  const after = await widths(d)
  const insertAfter = await tryInsert(d)
  const failed = (await d.query(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL`)).rows
  await d.end()

  // And what a FRESH database at the tip has, as the reference.
  await admin('DROP DATABASE IF EXISTS hvmigref')
  await admin('CREATE DATABASE hvmigref')
  const applyFresh = migrate(TIP, 'hvmigref')
  const e = new pg.Client({ connectionString: HOST + 'hvmigref' })
  await e.connect()
  const reference = await widths(e)
  await e.end()

  const same = JSON.stringify(after) === JSON.stringify(reference)
  console.log(JSON.stringify({
    QA_MIGRATION_THIRD: {
      realMessageIdLength: REAL_MESSAGE_ID.length,
      applyOld, forward, applyFresh,
      failedMigrationsAfterForward: failed,
      widthsOnTheOldDatabase: { before, after },
      widthsOnAFreshDatabaseAtTheTip: reference,
      insertOfARealMessageId: { before: insertBefore, after: insertAfter },

      THE_OLD_DATABASE_WAS_TOO_NARROW: insertBefore.startsWith('REFUSED'),
      DEPLOY_REPORTED_SUCCESS: forward.ok,
      DEPLOY_ACTUALLY_WIDENED_IT: insertAfter === 'accepted',
      OLD_REACHES_THE_SAME_WIDTHS_AS_FRESH: same,
    },
  }, null, 2))
}

main().catch((e) => { console.error('QA THIRD PROBE FAILED:', e); process.exitCode = 1 })
