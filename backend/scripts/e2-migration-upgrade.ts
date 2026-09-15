import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { parseDisposablePostgresUrl } from '../src/prisma/native-alert-test-database.js'

export type Environment = Readonly<Record<string, string | undefined>>
export type Mode = 'upgrade' | 'fresh'
export type Stage = 64 | 66
export type Migration = { name: string; sql: Buffer }
export type Plan = {
  candidateSha: string
  migrations: Array<Migration & { checksum: string }>
  lock: Buffer
  digest: string
}
export const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = dirname(backendRoot)
const names = {
  upgrade: '/hv_e2_m66_upgrade_20260915',
  fresh: '/hv_e2_m66_fresh_20260915',
} as const
const last = [
  '20260913200000_send_job_withdrawn',
  '20260914020000_identity_risk_not_assessed',
  '20260915140000_security_alert_support_rls',
] as const
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function requireSafe(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

export function assertE2DisposableUrl(environment: Environment, mode: Mode): URL {
  requireSafe(!('NODE_OPTIONS' in environment), 'Ambient Node preload options are forbidden')
  requireSafe(environment.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
    && environment.HAWKVIEW_E2_RUN_MIGRATION_VERIFICATION === '1',
  'Explicit disposable migration opt-ins required')
  requireSafe(environment.TZ === 'UTC', 'UTC process required')
  requireSafe(environment.DATABASE_URL === undefined, 'Inherited application database URL is forbidden')
  for (const key of [
    'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY',
  ]) requireSafe(environment[key] === undefined, 'Ambient PostgreSQL connection settings are forbidden')
  requireSafe(environment.PGOPTIONS === undefined || environment.PGOPTIONS === '-c TimeZone=UTC',
    'Only fixed UTC driver options are permitted')
  requireSafe(environment.PGCONNECT_TIMEOUT === undefined || environment.PGCONNECT_TIMEOUT === '5',
    'Only the bounded fixture connection timeout is permitted')
  const url = parseDisposablePostgresUrl(environment.HAWKVIEW_E2_DISPOSABLE_DATABASE_URL)
  requireSafe(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1'
    && url.port === '55432' && url.pathname === names[mode]
    && url.username === 'postgres' && url.password === '',
  'Reserved migration fixture target required')
  return url
}

export function createMigrationPlan(candidateSha: string, migrations: readonly Migration[], lock: Buffer): Plan {
  requireSafe(/^[a-f0-9]{40}$/.test(candidateSha), 'Exact candidate SHA required')
  const ordered = [...migrations].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  requireSafe(ordered.length === 66 && new Set(ordered.map(row => row.name)).size === 66,
    'Exactly 66 distinct committed migrations required')
  requireSafe(ordered.every(row => /^\d{14}_[a-z0-9_]+$/.test(row.name)), 'Invalid migration name')
  requireSafe(last.every((name, index) => ordered[63 + index]?.name === name),
    'Committed migration boundaries differ from the reviewed 64-to-66 plan')
  const rows = ordered.map(row => ({ ...row, checksum: sha256(row.sql) }))
  const digest = sha256(JSON.stringify({
    candidateSha, lockChecksum: sha256(lock),
    migrations: rows.map(({ name, checksum }) => ({ name, checksum })),
  }))
  return { candidateSha, migrations: rows, lock, digest }
}

function git(args: string[]): Buffer {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + repositoryRoot, '-C', repositoryRoot, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    throw new Error('Committed candidate source could not be read')
  }
}

export function loadCommittedMigrationPlan(environment: Environment): Plan {
  const candidateSha = environment.HAWKVIEW_E2_CANDIDATE_SHA ?? ''
  requireSafe(/^[a-f0-9]{40}$/.test(candidateSha), 'Exact candidate SHA required')
  requireSafe(git(['rev-parse', 'HEAD']).toString('utf8').trim() === candidateSha,
    'Checkout must match the explicitly reviewed candidate')
  requireSafe(git(['status', '--porcelain=v1', '--untracked-files=normal']).length === 0,
    'Migration verification requires a clean committed candidate')
  const prefix = 'backend/prisma/migrations/'
  const files = git(['ls-tree', '-r', '--name-only', candidateSha, '--', prefix])
    .toString('utf8').trim().split(/\r?\n/)
  const paths = files.filter(path => /^backend\/prisma\/migrations\/[^/]+\/migration.sql$/.test(path))
  const rows = paths.map(path => ({
    name: path.slice(prefix.length, -'/migration.sql'.length),
    sql: git(['show', candidateSha + ':' + path]),
  }))
  const lock = git(['show', candidateSha + ':' + prefix + 'migration_lock.toml'])
  return createMigrationPlan(candidateSha, rows, lock)
}

export function manifest(plan: Plan) {
  return {
    version: 'hawkview-migration-evidence/v1', candidateSha: plan.candidateSha,
    manifestDigest: plan.digest, migrationCount: 66, baselineCount: 64,
    lockChecksum: sha256(plan.lock),
    migrations: plan.migrations.map(({ name, checksum }) => ({ name, checksum })),
  }
}

export function materializePlan(plan: Plan): string {
  const temporary = realpathSync(tmpdir())
  const repository = realpathSync(repositoryRoot)
  requireSafe(temporary !== repository && !temporary.startsWith(repository + sep),
    'Migration scratch must be outside the repository')
  const root = mkdtempSync(join(tmpdir(), 'hv-e2-migration-'))
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest(plan), null, 2) + '\n')
  for (const stage of [64, 66] as const) {
    const directory = join(root, String(stage))
    mkdirSync(directory)
    writeFileSync(join(directory, 'migration_lock.toml'), plan.lock)
    for (const row of plan.migrations.slice(0, stage)) {
      const target = join(directory, row.name)
      mkdirSync(target)
      writeFileSync(join(target, 'migration.sql'), row.sql)
    }
  }
  return root
}

export function validateStageDirectory(plan: Plan, root: string, stage: Stage): string {
  const temporary = realpathSync(tmpdir())
  const real = realpathSync(root)
  requireSafe(real.startsWith(temporary + sep) && basename(real).startsWith('hv-e2-migration-'),
    'Only a freshly materialized temporary plan is accepted')
  requireSafe(!lstatSync(root).isSymbolicLink(), 'Plan symlinks are forbidden')
  requireSafe(lstatSync(join(real, 'manifest.json')).isFile()
    && !lstatSync(join(real, 'manifest.json')).isSymbolicLink(), 'Only a regular manifest is accepted')
  assert.deepEqual(JSON.parse(readFileSync(join(real, 'manifest.json'), 'utf8')), manifest(plan),
    'Plan manifest differs from committed candidate')
  const directory = join(real, String(stage))
  requireSafe(!lstatSync(directory).isSymbolicLink(), 'Stage symlinks are forbidden')
  const expected = plan.migrations.slice(0, stage)
  const entries = readdirSync(directory).sort()
  assert.deepEqual(entries, [...expected.map(row => row.name), 'migration_lock.toml'].sort())
  requireSafe(!lstatSync(join(directory, 'migration_lock.toml')).isSymbolicLink(),
    'Migration lock symlinks are forbidden')
  requireSafe(sha256(readFileSync(join(directory, 'migration_lock.toml'))) === sha256(plan.lock),
    'Migration lock differs from committed candidate')
  for (const row of expected) {
    const parent = join(directory, row.name)
    const file = join(parent, 'migration.sql')
    requireSafe(!lstatSync(parent).isSymbolicLink() && lstatSync(file).isFile()
      && !lstatSync(file).isSymbolicLink(), 'Only regular committed migration files are accepted')
    assert.deepEqual(readdirSync(parent), ['migration.sql'])
    requireSafe(sha256(readFileSync(file)) === row.checksum, 'Staged SQL differs from committed candidate')
  }
  return directory
}

export function configurationForStage(environment: Environment) {
  const mode = environment.HAWKVIEW_E2_MODE
  requireSafe(mode === 'upgrade' || mode === 'fresh', 'Migration mode required')
  const url = assertE2DisposableUrl(environment, mode as Mode)
  const stage = environment.HAWKVIEW_E2_MIGRATION_STAGE
  requireSafe(stage === '64' || stage === '66', 'Migration stage must be 64 or 66')
  requireSafe(stage !== '64' || mode === 'upgrade', 'Baseline is reserved for the upgrade fixture')
  const plan = loadCommittedMigrationPlan(environment)
  const directory = validateStageDirectory(plan, environment.HAWKVIEW_E2_PLAN_DIRECTORY ?? '', Number(stage) as Stage)
  return { schema: join(backendRoot, 'prisma/schema.prisma'), migrations: { path: directory }, datasource: { url: url.toString() } }
}

export function disposableConnectionOptions(url: URL) {
  return {
    host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    user: url.username, password: () => '', ssl: false,
    connectionTimeoutMillis: 5000, options: '-c TimeZone=UTC',
  }
}

export function resolvePrismaCli(packageJson = createRequire(import.meta.url).resolve('prisma/package.json')): string {
  try {
    const metadataPath = realpathSync(packageJson)
    requireSafe(basename(metadataPath) === 'package.json', 'Prisma package metadata required')
    const packageRoot = dirname(metadataPath)
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { name?: unknown; bin?: unknown }
    requireSafe(metadata.name === 'prisma', 'Expected installed Prisma package')
    const declared = typeof metadata.bin === 'string' ? metadata.bin
      : metadata.bin && typeof metadata.bin === 'object'
        ? (metadata.bin as Record<string, unknown>).prisma : undefined
    requireSafe(typeof declared === 'string' && declared.length > 0, 'Declared Prisma CLI bin required')
    const bin = declared as string
    requireSafe(!isAbsolute(bin) && !bin.split(/[\\/]/).includes('..'), 'Relative package-local CLI bin required')
    const target = resolve(packageRoot, bin)
    requireSafe(target.startsWith(packageRoot + sep), 'CLI bin must remain within its package')
    const real = realpathSync(target)
    requireSafe(real.startsWith(packageRoot + sep) && lstatSync(real).isFile(),
      'Existing package-local CLI file required')
    return real
  } catch {
    throw new Error('Installed Prisma CLI bin could not be resolved safely')
  }
}

function childEnvironment(environment: Environment, mode: Mode, root: string): NodeJS.ProcessEnv {
  const profile = join(root, 'empty-profile')
  mkdirSync(profile)
  const child: NodeJS.ProcessEnv = {}
  for (const key of [
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TMP', 'TEMP', 'TMPDIR', 'HV_VERIFY_ROOT',
    'HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS', 'HAWKVIEW_E2_RUN_MIGRATION_VERIFICATION',
    'HAWKVIEW_E2_DISPOSABLE_DATABASE_URL', 'HAWKVIEW_E2_CANDIDATE_SHA',
  ]) if (environment[key] !== undefined) child[key] = environment[key]
  return {
    ...child, HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    TZ: 'UTC', PGOPTIONS: '-c TimeZone=UTC', PGCONNECT_TIMEOUT: '5',
    CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1',
    HAWKVIEW_E2_MODE: mode, HAWKVIEW_E2_PLAN_DIRECTORY: root,
  }
}

async function assertEmptyFixture(url: URL): Promise<void> {
  const client = new pg.Client(disposableConnectionOptions(url))
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    const { rows: [state] } = await client.query(
      "SELECT current_database() AS database, current_user AS role, inet_server_port() AS port, current_setting('server_version_num') AS version, current_setting('TimeZone') AS timezone, (SELECT count(*)::integer FROM information_schema.tables WHERE table_schema='public') AS tables")
    requireSafe(state.database === url.pathname.slice(1) && state.role === 'postgres'
      && state.port === 55432 && Math.floor(Number(state.version) / 10000) === 15
      && state.timezone === 'UTC' && state.tables === 0,
    'Reserved empty PostgreSQL 15 fixture required before migrations')
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
}

async function main(mode: string | undefined) {
  requireSafe(mode === 'upgrade' || mode === 'fresh', 'Mode must be upgrade or fresh')
  const url = assertE2DisposableUrl(process.env, mode as Mode)
  const plan = loadCommittedMigrationPlan(process.env)
  const root = materializePlan(plan)
  await assertEmptyFixture(url)
  const child = childEnvironment(process.env, mode as Mode, root)
  const require = createRequire(import.meta.url)
  const loader = pathToFileURL(require.resolve('tsx')).href
  const prisma = resolvePrismaCli()
  const run = (args: string[], stage: Stage, legacyDigest?: string): string => {
    validateStageDirectory(plan, root, stage)
    const result = spawnSync(process.execPath, ['--import', loader, ...args], {
      cwd: backendRoot, env: { ...child, HAWKVIEW_E2_MIGRATION_STAGE: String(stage),
        ...(legacyDigest ? { HAWKVIEW_E2_LEGACY_DIGEST: legacyDigest } : {}) },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    })
    requireSafe(!result.error && result.status === 0, 'Disposable migration phase failed')
    return result.stdout
  }
  const deploy = (stage: Stage) => run([prisma, 'migrate', 'deploy', '--config', join(backendRoot, 'prisma.e2-migration-check.config.ts')], stage)
  const verify = (phase: string, stage: Stage, legacyDigest?: string) => {
    const output = run([join(backendRoot, 'scripts/e2-migration-vocabulary-check.ts'), phase], stage, legacyDigest)
    const lines = output.trim().split(/\r?\n/).filter(line => line.startsWith('{'))
    requireSafe(lines.length === 1, 'Exactly one sanitized verification record required')
    const record = JSON.parse(lines[0]!) as Record<string, unknown>
    requireSafe(record.mode === phase && record.status === 'PASS'
      && record.candidateSha === plan.candidateSha && record.manifestDigest === plan.digest
      && record.migrations === stage, 'Verification record does not describe this candidate')
    console.log(JSON.stringify(record))
    return record
  }
  if (mode === 'upgrade') {
    deploy(64)
    const seeded = verify('seed-upgrade', 64)
    requireSafe(typeof seeded.legacyDigest === 'string' && /^[a-f0-9]{64}$/.test(seeded.legacyDigest),
      'Seeded row fingerprint required')
    deploy(66)
    verify('verify-upgrade', 66, seeded.legacyDigest as string)
  } else {
    deploy(66)
    verify('verify-fresh', 66)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(() => {
    console.error(JSON.stringify({ status: 'FAILED', code: 'DISPOSABLE_MIGRATION_VERIFICATION_FAILED' }))
    process.exitCode = 1
  })
}
