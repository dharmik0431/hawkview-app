import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Does the shipped schema actually carry the safety properties the migration
 * comment claims?
 *
 * A migration is the one kind of change that cannot be rolled back by reverting
 * a commit, and this one touches the table holding the credential that reads
 * every customer tenant. The real check runs against Postgres and lives in
 * `secret-store.database-integration.test.ts`. This one needs nothing and runs
 * everywhere, because the two properties that matter are visible in the text:
 * the column is backfilled, and the default does not survive.
 */

const migrationsDirectory = new URL('../../prisma/migrations/', import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, '$1')

const shippedSql = (): string => readdirSync(migrationsDirectory)
  .filter((entry) => !entry.endsWith('.toml'))
  .sort()
  .map((entry) => {
    try { return readFileSync(join(migrationsDirectory, entry, 'migration.sql'), 'utf8') }
    catch { return '' }
  })
  .join('\n')

const schema = (): string =>
  readFileSync(new URL('../../prisma/schema.prisma', import.meta.url)
    .pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')

test('existing rows are labelled rather than left without a version', () => {
  const sql = shippedSql()

  // POSITIVE CONTROL FIRST: the migrations were actually read. Without this every
  // assertion below passes on an empty string.
  assert.ok(sql.length > 1_000, 'migration SQL was not read')

  assert.match(
    sql,
    /ADD COLUMN "key_version" INTEGER NOT NULL DEFAULT 1/,
    'the column must be added WITH a default, or the two existing rows end up unlabelled')
})

test('THE DEFAULT DOES NOT SURVIVE THE MIGRATION', () => {
  // The subtle half. A default that stays means a future writer which forgets the
  // version gets a row LABELLED version 1 while its bytes are sealed with version
  // 2 — and a mislabelled row is exactly as unreadable as an unlabelled one,
  // except that it is discovered much later. With no default such a writer
  // violates NOT NULL and fails immediately.
  const sql = shippedSql()
  assert.match(
    sql,
    /ALTER COLUMN "key_version" DROP DEFAULT/,
    'the backfill default must be dropped once it has done its job')

  // And the ordering matters: dropped AFTER it is added, or it never backfills.
  const added = sql.indexOf('ADD COLUMN "key_version"')
  const dropped = sql.indexOf('ALTER COLUMN "key_version" DROP DEFAULT')
  assert.ok(added >= 0 && dropped > added, 'the default must be dropped after the column is added')
})

test('the model agrees with the column: no default on the application side either', () => {
  // If Prisma carried a default, the application could omit the version and the
  // database would never see the omission — putting the hole back one layer up.
  const model = schema().match(/model EncryptedSecret \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(model.length > 0, 'the EncryptedSecret model was not found')

  const line = model.split('\n').find((entry) => entry.trim().startsWith('keyVersion'))
  assert.ok(line, 'the model must carry keyVersion')
  assert.equal(line.includes('@default'), false, 'keyVersion must not have a Prisma default')
  assert.match(line, /@map\("key_version"\)/)

  // POSITIVE CONTROL: another field in the same model DOES carry a default, so
  // the assertion above is about this field rather than a parser that finds none.
  assert.ok(model.includes('@default(now())'), 'the control field was not found')
})

test('a version below one cannot be stored', () => {
  const sql = shippedSql()
  assert.match(sql, /CHECK \("key_version" >= 1\)/)
})
