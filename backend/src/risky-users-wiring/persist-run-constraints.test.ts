import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_STATUS } from './persist-run.js'

/** Does the database actually accept what the writer emits?
 *
 * THIS IS THE TEST THAT WAS MISSING, and its absence is why a real defect stayed
 * green. `persist-run` is tested against a structural double, which was right
 * when nothing called the writer — a double cannot enforce a CHECK constraint,
 * and the comment saying so was accurate. It stopped being accurate the moment
 * the cycle started calling it.
 *
 * `identity_risk_evaluation_runs` carries
 *   CHECK (status IN ('RUNNING','COMPLETED','FAILED'))
 * so `COMPLETED_EVALUATION_CORE` raised 23514 on every tenant of every cycle, on
 * any database with the shipped migrations. Found before merge rather than in
 * production, and only because someone read the constraint rather than the test
 * results.
 *
 * A real-Postgres test is the stronger check and is the right home for this; it
 * lives in `persist-run.database-integration.test.ts` and needs a disposable
 * cluster. THIS one needs nothing and runs everywhere, which is the point: the
 * defect is a constant and a constraint drifting apart, and that is visible
 * without a database at all.
 */

const migrationsDirectory = new URL('../../prisma/migrations/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** Every migration's SQL, in the order the deploy applies them. */
const shippedSql = (): string => readdirSync(migrationsDirectory)
  .filter(entry => !entry.endsWith('.toml'))
  .sort()
  .map(entry => {
    try { return readFileSync(join(migrationsDirectory, entry, 'migration.sql'), 'utf8') }
    catch { return '' }
  })
  .join('\n')

test('the status the writer emits is one the shipped migrations admit', () => {
  const sql = shippedSql()

  // POSITIVE CONTROL FIRST: the migrations were actually read. Without this the
  // assertion below passes on an empty string, which is the vacuity that has
  // bitten four tests today.
  assert.ok(sql.length > 1_000, 'migration SQL was not read')
  assert.match(sql, /identity_risk_runs_status_check/, 'the constraint this is about was not found')

  // The last definition of the constraint wins, because migrations apply in
  // order and a later one replaces an earlier one.
  const definitions = [...sql.matchAll(/ADD CONSTRAINT "identity_risk_runs_status_check"[\s\S]*?;/g)]
  assert.ok(definitions.length > 0, 'no status constraint definition found')
  const current = definitions.at(-1)![0]

  assert.ok(
    current.includes(`'${RUN_STATUS}'`),
    `the shipped constraint does not admit ${RUN_STATUS}; persisting a run would raise 23514 on every tenant`)

  // And the old value survives — widening the constraint must not evict the
  // status the live engine writes on all 2,008 existing rows.
  assert.ok(current.includes("'COMPLETED'"), 'the live engine status must remain admitted')
})

test('the new status carries the same completed-at guarantee as the old one', () => {
  // The live completion check reads
  //   (status = 'COMPLETED' AND completed_at IS NOT NULL) OR status <> 'COMPLETED'
  // so any NEW status satisfies the second arm trivially and inherits no
  // guarantee at all. That does not crash the reader — it returns NO_RUN on a
  // null completedAt — which makes the consequence worse than a crash: a run
  // that completed would be reported as never having run, and an evaluated
  // tenant would be indistinguishable from one that never was.
  const sql = shippedSql()
  const definitions = [...sql.matchAll(/ADD CONSTRAINT "identity_risk_runs_completion_check"[\s\S]*?;/g)]
  assert.ok(definitions.length > 0, 'no completion constraint definition found')
  const current = definitions.at(-1)![0]

  assert.ok(
    current.includes(`'${RUN_STATUS}'`),
    `${RUN_STATUS} is admitted but carries no completed-at guarantee; a completed run would read as never having run`)
  // Both arms must name it, or one of them leaves the hole open.
  assert.equal(
    (current.match(new RegExp(`'${RUN_STATUS}'`, 'g')) ?? []).length, 2,
    'the status must appear in both arms of the completion check')
})
