import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { inspect } from 'node:util'
import {
  assertE2DisposableUrl, backendRoot, createMigrationPlan, manifest,
  materializePlan, resolvePrismaCli, validateStageDirectory, type Migration,
} from './e2-migration-upgrade.js'

const sha = 'a'.repeat(40)
const lock = Buffer.from('provider = "postgresql"\n')
const migrations = (): Migration[] => [
  ...Array.from({ length: 63 }, (_, index) => ({
    name: '20260101000000_fixture_' + String(index).padStart(2, '0'),
    sql: Buffer.from('-- committed synthetic migration ' + index + '\n'),
  })),
  { name: '20260913200000_send_job_withdrawn', sql: Buffer.from('-- stage64\n') },
  { name: '20260914020000_identity_risk_not_assessed', sql: Buffer.from('-- stage65\n') },
  { name: '20260915140000_security_alert_support_rls', sql: Buffer.from('-- stage66\n') },
]
const environment = {
  HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1',
  HAWKVIEW_E2_RUN_MIGRATION_VERIFICATION: '1',
  TZ: 'UTC',
  HAWKVIEW_E2_DISPOSABLE_DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/hv_e2_m66_upgrade_20260915',
}

test('installed Prisma CLI resolution follows package bin metadata without executing the CLI', () => {
  const metadataPath = createRequire(import.meta.url).resolve('prisma/package.json')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { bin: string | { prisma: string } }
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.prisma
  assert.equal(resolvePrismaCli(), realpathSync(resolve(dirname(metadataPath), bin)))
})

test('Prisma CLI resolution refuses missing, malformed, wrong-package and escaping bins', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hv-prisma-bin-'))
  let serial = 0
  const fixture = (metadata: unknown): string => {
    const root = join(scratch, String(serial++), 'prisma')
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build/index.js'), '// synthetic CLI, never executed\n')
    const file = join(root, 'package.json')
    writeFileSync(file, JSON.stringify(metadata))
    return file
  }
  const valid = fixture({ name: 'prisma', bin: { prisma: 'build/index.js' } })
  assert.equal(resolvePrismaCli(valid), realpathSync(join(dirname(valid), 'build/index.js')))
  for (const metadata of [
    { name: 'other', bin: 'build/index.js' },
    { name: 'prisma' },
    { name: 'prisma', bin: { other: 'build/index.js' } },
    { name: 'prisma', bin: 'build/missing.js' },
    { name: 'prisma', bin: 'build' },
    { name: 'prisma', bin: '../outside.js' },
    { name: 'prisma', bin: resolve(scratch, 'outside.js') },
  ]) assert.throws(() => resolvePrismaCli(fixture(metadata)), /could not be resolved safely/)
  const malformed = fixture({ name: 'prisma', bin: 'build/index.js' })
  writeFileSync(malformed, '{')
  assert.throws(() => resolvePrismaCli(malformed), /could not be resolved safely/)
})

test('ambient Node preload options fail before any child or socket can be created', (t) => {
  let children = 0
  let sockets = 0
  t.mock.method(childProcess, 'spawnSync', () => { children += 1; throw new Error('Unexpected child') })
  t.mock.method(childProcess, 'execFileSync', () => { children += 1; throw new Error('Unexpected child') })
  t.mock.method(Socket.prototype, 'connect', () => { sockets += 1; throw new Error('Unexpected socket') })
  syncBuiltinESMExports()
  try {
    for (const value of ['', '--require ./unapproved.cjs', '--import ./unapproved.mjs', undefined]) {
      assert.throws(() => assertE2DisposableUrl({ ...environment, NODE_OPTIONS: value }, 'upgrade'),
        /Ambient Node preload options are forbidden/)
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(children, 0)
  assert.equal(sockets, 0)
})

test('ordered committed names and every content byte determine the complete plan digest', () => {
  const rows = migrations()
  const plan = createMigrationPlan(sha, rows, lock)
  assert.equal(plan.migrations.length, 66)
  assert.equal(plan.migrations[63]?.name, '20260913200000_send_job_withdrawn')
  assert.equal(plan.migrations[65]?.name, '20260915140000_security_alert_support_rls')
  assert.equal(createMigrationPlan(sha, [...rows].reverse(), lock).digest, plan.digest)
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const expected = createHash('sha256').update(JSON.stringify({
    candidateSha: sha, lockChecksum: hash(lock),
    migrations: rows.map(row => ({ name: row.name, checksum: hash(row.sql) })),
  })).digest('hex')
  assert.equal(plan.digest, expected)
  assert.equal(manifest(plan).baselineCount, 64)
  const changed = migrations()
  changed[11] = { ...changed[11]!, sql: Buffer.from('-- a different middle migration\n') }
  assert.notEqual(createMigrationPlan(sha, changed, lock).digest, plan.digest)
  assert.notEqual(createMigrationPlan('b'.repeat(40), rows, lock).digest, plan.digest)
})

test('wrong counts, duplicate names, missing boundaries and unpinned SHAs fail closed', () => {
  assert.throws(() => createMigrationPlan(sha, migrations().slice(1), lock))
  assert.throws(() => createMigrationPlan('HEAD', migrations(), lock))
  const duplicate = migrations()
  duplicate[1] = duplicate[0]!
  assert.throws(() => createMigrationPlan(sha, duplicate, lock))
  const changed = migrations()
  changed[63] = { ...changed[63]!, name: '20260913200000_unreviewed_boundary' }
  assert.throws(() => createMigrationPlan(sha, changed, lock))
})

test('64 and 66 are materialized outside the repository from the same immutable plan', () => {
  const plan = createMigrationPlan(sha, migrations(), lock)
  const root = materializePlan(plan)
  assert.ok(!root.startsWith(backendRoot + sep))
  assert.ok(!root.includes('node_modules'))
  const baseline = validateStageDirectory(plan, root, 64)
  validateStageDirectory(plan, root, 66)
  const middle = join(baseline, plan.migrations[11]!.name, 'migration.sql')
  assert.ok(readFileSync(middle).equals(plan.migrations[11]!.sql))
  writeFileSync(middle, '-- tampered middle SQL\n')
  assert.throws(() => validateStageDirectory(plan, root, 64), /Staged SQL differs/)
})

test('uncommitted extra files and changed manifest metadata cannot validate a baseline', () => {
  const plan = createMigrationPlan(sha, migrations(), lock)
  const extra = materializePlan(plan)
  writeFileSync(join(extra, '64', 'not-committed.sql'), '-- unexpected\n')
  assert.throws(() => validateStageDirectory(plan, extra, 64))
  const changed = materializePlan(plan)
  writeFileSync(join(changed, 'manifest.json'), JSON.stringify({ ...manifest(plan), candidateSha: 'b'.repeat(40) }))
  assert.throws(() => validateStageDirectory(plan, changed, 64))
})

test('only the separately reserved exact fresh and upgrade endpoints are admitted', () => {
  assert.equal(assertE2DisposableUrl(environment, 'upgrade').pathname, '/hv_e2_m66_upgrade_20260915')
  const fresh = { ...environment, HAWKVIEW_E2_DISPOSABLE_DATABASE_URL:
    'postgresql://postgres@127.0.0.1:55432/hv_e2_m66_fresh_20260915' }
  assert.equal(assertE2DisposableUrl(fresh, 'fresh').pathname, '/hv_e2_m66_fresh_20260915')
  assert.throws(() => assertE2DisposableUrl(fresh, 'upgrade'))
  assert.throws(() => assertE2DisposableUrl(environment, 'fresh'))
})

test('hostile routing and credential-bearing inputs fail without Socket attempts or disclosure', (t) => {
  let attempts = 0
  t.mock.method(Socket.prototype, 'connect', () => { attempts += 1; throw new Error('Unexpected socket') })
  const secret = 'synthetic-migration-parser-only'
  const values = [
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL + '?',
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL + '#',
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL + '?host=database.invalid&host=localhost',
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL + '?%68OST=database.invalid',
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL + '?options=-cTimeZone%3DUTC',
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL + '?service=other',
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL.replace('127.0.0.1', 'localhost'),
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL.replace('55432', '5432'),
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL.replace('postgres@', 'other@'),
    environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL.replace('postgres@', 'postgres:' + secret + '@'),
    'postgresql://postgres:' + secret + '@[invalid:55432/hv_e2_m66_upgrade_20260915',
  ]
  for (const value of values) {
    let error: unknown
    try { assertE2DisposableUrl({ ...environment, HAWKVIEW_E2_DISPOSABLE_DATABASE_URL: value }, 'upgrade') } catch (caught) { error = caught }
    assert.ok(error instanceof Error)
    const surfaces = [String(error), error.stack, inspect(error, { showHidden: true }), JSON.stringify(error)].join('\n')
    assert.ok(!surfaces.includes(value))
    assert.ok(!surfaces.includes(secret))
    assert.equal('cause' in error, false)
    assert.equal('input' in error, false)
  }
  assert.equal(attempts, 0)
})

test('no ambient application URL or missing opt-in/UTC can authorize a migration run', () => {
  for (const key of ['HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS', 'HAWKVIEW_E2_RUN_MIGRATION_VERIFICATION', 'TZ']) {
    assert.throws(() => assertE2DisposableUrl({ ...environment, [key]: undefined }, 'upgrade'))
    assert.throws(() => assertE2DisposableUrl({ ...environment, [key]: 'other' }, 'upgrade'))
  }
  for (const key of ['PGHOST', 'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGOPTIONS']) {
    assert.throws(() => assertE2DisposableUrl({ ...environment, [key]: 'unapproved' }, 'upgrade'))
  }
  assert.throws(() => assertE2DisposableUrl({ ...environment, DATABASE_URL: '' }, 'upgrade'))
  assert.throws(() => assertE2DisposableUrl({ ...environment, DATABASE_URL: 'not-an-approved-input' }, 'upgrade'))
})
