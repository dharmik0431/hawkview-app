// QA — does the forward correction actually correct, and is it a no-op where it must be?
//
// THE INSTRUMENT IS A SCHEMA COMPARISON, NOT A CHECKLIST. Asking "did it fix the constraint" tests
// the thing I already know to look for. Three databases are migrated by three different routes and
// their FULL schemas compared, so anything that failed to converge shows up whether or not I
// thought of it — which matters because the commit says "two in-place edits" and the migration
// directory has had more than two.
//
//   OLD    migrated at the commit before the FIRST in-place edit of this feature, then seeded with
//          rows in the old vocabulary, then brought forward with the tip's migrations.
//   MID    migrated at 6fdfa4a — the half-corrected state, where the in-place edits are in the
//          file but no database has the correction recorded — then brought forward.
//   FRESH  migrated once, at the tip. The reference every other route must arrive at.
//
// Run from the backend directory of a worktree AT THE TIP.
import { execFileSync } from 'node:child_process'
import pg from 'pg'

const HOST = 'postgresql://postgres:postgres@127.0.0.1:55432/'
const url = (db) => HOST + db + '?schema=public'

// OLD  d9de7b9 — before the FIRST in-place edit of this feature. The dispositions table does not
//      exist yet here, which is why the row-translation half uses OLD2 instead.
// OLD2 91a593e — the table exists in the form that was actually applied: column `rule_id`, CHECK
//      holding the channel vocabulary. The only state where the translation can be exercised.
// MID  6fdfa4a — the half-corrected state: the edits are in the file, no database has them.
const WORKTREE = {
  OLD: 'C:/hv-pre/backend', OLD2: 'C:/hv-pre2/backend',
  MID: 'C:/hv-par/backend', TIP: 'C:/hv-run/backend',
}

async function admin(sql) {
  const c = new pg.Client({ connectionString: HOST + 'postgres' })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}

function migrate(cwd, db) {
  try {
    const out = execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd, encoding: 'utf8', shell: true,
      env: { ...process.env, DATABASE_URL: url(db) },
    })
    return { ok: true, tail: out.trim().split('\n').slice(-2).join(' | ') }
  } catch (e) {
    return { ok: false, tail: String(e.stdout ?? '').trim().split('\n').slice(-6).join(' | ')
      + ' !! ' + String(e.stderr ?? '').trim().split('\n').slice(-4).join(' | ') }
  }
}

/** Everything about the shape of the database that a person could get wrong. */
async function snapshot(db) {
  const c = new pg.Client({ connectionString: HOST + db })
  await c.connect()
  try {
    const q = async (sql) => (await c.query(sql)).rows
    return {
      columns: await q(`SELECT table_name, column_name, data_type, is_nullable, character_maximum_length
                          FROM information_schema.columns WHERE table_schema='public'
                         ORDER BY table_name, column_name`),
      checks: await q(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
                         FROM pg_constraint WHERE contype='c'
                          AND connamespace='public'::regnamespace ORDER BY 1,2`),
      keys: await q(`SELECT conrelid::regclass::text AS tbl, conname, contype, pg_get_constraintdef(oid) AS def
                       FROM pg_constraint WHERE contype IN ('p','u','f')
                        AND connamespace='public'::regnamespace ORDER BY 1,2`),
      indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes
                         WHERE schemaname='public' ORDER BY 1,2`),
      applied: await q(`SELECT migration_name FROM _prisma_migrations
                         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                         ORDER BY migration_name`),
      failed: await q(`SELECT migration_name FROM _prisma_migrations
                        WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`),
    }
  } finally { await c.end() }
}

const differences = (a, b, key) => {
  const norm = (rows) => rows.map((r) => JSON.stringify(r)).sort()
  const [x, y] = [norm(a[key]), norm(b[key])]
  const onlyA = x.filter((r) => !y.includes(r))
  const onlyB = y.filter((r) => !x.includes(r))
  return onlyA.length + onlyB.length === 0 ? null : { onlyInFirst: onlyA, onlyInSecond: onlyB }
}

async function main() {
  const report = {}

  // ── FRESH: the reference ───────────────────────────────────────────────────────────────────
  await admin('DROP DATABASE IF EXISTS hvmigfresh')
  await admin('CREATE DATABASE hvmigfresh')
  report.freshMigrate = migrate(WORKTREE.TIP, 'hvmigfresh')

  // ── OLD: migrated before the first in-place edit, seeded, then brought forward ─────────────
  await admin('DROP DATABASE IF EXISTS hvmigold')
  await admin('CREATE DATABASE hvmigold')
  report.oldMigrate = migrate(WORKTREE.OLD, 'hvmigold')

  report.oldForward = migrate(WORKTREE.TIP, 'hvmigold')

  // ── OLD2: the state that matters for ROWS — the table as it was actually applied ───────────
  await admin('DROP DATABASE IF EXISTS hvmigold2')
  await admin('CREATE DATABASE hvmigold2')
  report.old2Migrate = migrate(WORKTREE.OLD2, 'hvmigold2')

  const old = new pg.Client({ connectionString: HOST + 'hvmigold2' })
  await old.connect()
  const ORG = '11111111-1111-1111-1111-111111111111'
  await old.query(`INSERT INTO organizations (id,name,slug,created_at,updated_at)
                   VALUES ($1,'Probe','probe',now(),now()) ON CONFLICT DO NOTHING`, [ORG])
  const columnsBefore = (await old.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='alert_rule_dispositions' ORDER BY column_name`)).rows.map((r) => r.column_name)
  const checkBefore = (await old.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid='alert_rule_dispositions'::regclass AND contype='c'`)).rows.map((r) => r.def)
  const keyColumn = columnsBefore.includes('rule_id') ? 'rule_id' : 'alert_type_id'
  for (const [id, value] of [['a', 'RING'], ['b', 'EMAIL'], ['c', 'DIGEST'], ['d', 'RECORD_ONLY']]) {
    await old.query(
      `INSERT INTO alert_rule_dispositions (id, organization_id, "${keyColumn}", disposition, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`, [ORG, 'HV-ID-AUTH-00' + id + '.v1', value])
  }
  const rowsSeeded = Number((await old.query('SELECT count(*)::int n FROM alert_rule_dispositions')).rows[0].n)
  await old.end()

  report.old2Before = { columns: columnsBefore, check: checkBefore, rowsSeeded }
  report.old2Forward = migrate(WORKTREE.TIP, 'hvmigold2')

  // ── MID: migrated at 6fdfa4a, then brought forward ─────────────────────────────────────────
  await admin('DROP DATABASE IF EXISTS hvmigmid')
  await admin('CREATE DATABASE hvmigmid')
  report.midMigrate = migrate(WORKTREE.MID, 'hvmigmid')
  report.midForward = migrate(WORKTREE.TIP, 'hvmigmid')
  // and a second run, because a migration that is not idempotent fails the day a deploy retries
  report.midForwardAgain = migrate(WORKTREE.TIP, 'hvmigmid')

  // ── THE COMPARISON ─────────────────────────────────────────────────────────────────────────
  const [fresh, oldSnap, old2Snap, mid] = await Promise.all(
    ['hvmigfresh', 'hvmigold', 'hvmigold2', 'hvmigmid'].map(snapshot))

  const parts = ['columns', 'checks', 'keys', 'indexes', 'applied']
  report.OLD_vs_FRESH = Object.fromEntries(parts.map((p) => [p, differences(oldSnap, fresh, p)]))
  report.OLD2_vs_FRESH = Object.fromEntries(parts.map((p) => [p, differences(old2Snap, fresh, p)]))
  report.MID_vs_FRESH = Object.fromEntries(parts.map((p) => [p, differences(mid, fresh, p)]))
  report.CONVERGED = {
    oldReachesFresh: parts.every((p) => report.OLD_vs_FRESH[p] === null),
    old2ReachesFresh: parts.every((p) => report.OLD2_vs_FRESH[p] === null),
    midReachesFresh: parts.every((p) => report.MID_vs_FRESH[p] === null),
  }
  report.noFailedMigrations = {
    old: oldSnap.failed.length, old2: old2Snap.failed.length, mid: mid.failed.length, fresh: fresh.failed.length,
  }

  // ── AND THE BEHAVIOUR, not just the shape ──────────────────────────────────────────────────
  const after = new pg.Client({ connectionString: HOST + 'hvmigold2' })
  await after.connect()
  const translated = (await after.query(
    `SELECT alert_type_id, disposition FROM alert_rule_dispositions ORDER BY alert_type_id`)).rows
  let actNow = 'accepted'
  try {
    await after.query(
      `INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(),$1,'security.privileged_directory_change','ACT_NOW',now())`, [ORG])
  } catch (e) { actNow = 'REFUSED ' + e.code }
  let ring = 'ACCEPTED — the old vocabulary is still writable'
  try {
    await after.query(
      `INSERT INTO alert_rule_dispositions (id, organization_id, alert_type_id, disposition, updated_at)
       VALUES (gen_random_uuid(),$1,'monitoring.recovered','RING',now())`, [ORG])
  } catch (e) { ring = 'refused ' + e.code }
  await after.end()

  report.behaviourOnTheOldDatabase = {
    rowsAfter: translated,
    rowsPreserved: translated.length === rowsSeeded,
    ACT_NOW_NOW_ACCEPTED: actNow === 'accepted',
    actNow, ringNowRefused: ring.startsWith('refused'), ring,
    // The translation the migration claims: RING->ACT_NOW, EMAIL/DIGEST->ACT_TODAY, RECORD_ONLY->itself
    TRANSLATION_AS_DOCUMENTED:
      translated.find((r) => r.alert_type_id === 'HV-ID-AUTH-00a.v1')?.disposition === 'ACT_NOW'
      && translated.find((r) => r.alert_type_id === 'HV-ID-AUTH-00b.v1')?.disposition === 'ACT_TODAY'
      && translated.find((r) => r.alert_type_id === 'HV-ID-AUTH-00c.v1')?.disposition === 'ACT_TODAY'
      && translated.find((r) => r.alert_type_id === 'HV-ID-AUTH-00d.v1')?.disposition === 'RECORD_ONLY',
  }

  console.log(JSON.stringify({ QA_MIGRATION_CONVERGE: report }, null, 2))
}

main().catch((e) => { console.error('QA MIGRATION PROBE FAILED:', e); process.exitCode = 1 })
