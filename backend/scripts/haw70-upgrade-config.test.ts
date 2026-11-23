import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import child_process, { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import net from 'node:net'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { after, type TestContext } from 'node:test'
import { loadConfigFromFile } from '@prisma/config'
import { materializeHaw70UpgradeSource } from './haw70-upgrade-materializer.mjs'
import { assembleHaw70UpgradeStageConfig, readHaw70StageHandoff } from './haw70-upgrade-config.js'

/**
 * Focused NONCONNECTING tests for the inactive dedicated configuration.
 *
 * The installed `@prisma/config` loader is driven at its real entry point with
 * an explicit path, so real module resolution and the TypeScript helper import
 * chain are exercised rather than simulated. No database, socket, migration
 * CLI or application startup is involved, and the hosted environment strings
 * below are synthetic TEST DATA: they are never used to run a local physical
 * PostgreSQL, and a passing load qualifies no execution.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'haw70-config-test-')))
after(() => rmSync(scratch, { recursive: true, force: true }))
const backend = realpathSync(join(import.meta.dirname, '..'))
const repositoryRoot = realpathSync(join(backend, '..'))
const CONFIG_PATH = join(backend, 'prisma', 'haw70-upgrade.config.ts')
const ORDINARY_CONFIG = join(backend, 'prisma.config.ts')
const CI_URL = 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci'

const git = (...args: string[]) => {
  const result = spawnSync('/usr/bin/git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const head = git('rev-parse', 'HEAD')

/** One real staged root, produced by the pinned materializer. */
const stageParent = realpathSync(mkdtempSync(join(scratch, 'stage-')))
const staged = materializeHaw70UpgradeSource(
  { repositoryRoot, expectedCandidateCommit: head, scratchParent: stageParent }) as
  { outputRoot: string; receipt: { stages: Record<string, { schema: string; migrationLock: string }> } }

/** Synthetic hosted claims the existing guard accepts. Test data only. */
function hostedClaims(overrides: Record<string, string | undefined> = {}) {
  const ref = 'refs/heads/codex/haw70-dedicated-config-20261122'
  return {
    CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'dharmik0431/hawkview-app', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_WORKFLOW: 'Required quality gates',
    GITHUB_JOB: 'backend-quality', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_TYPE: 'branch', GITHUB_REF: ref,
    GITHUB_WORKFLOW_REF: `dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@${ref}`,
    GITHUB_RUN_ID: '44978604441', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head,
    HAWKVIEW_CI_MIGRATION_PROFILE: 'haw70-upgrade', HAWKVIEW_RUN_HAW70_UPGRADE: '1',
    HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1', TZ: 'UTC',
    HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
    HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
    DATABASE_URL: CI_URL,
    JITI_FS_CACHE: 'false',
    HAWKVIEW_HAW70_STAGE_ROOT: staged.outputRoot,
    HAWKVIEW_HAW70_STAGE_NAME: 'candidate',
    HAWKVIEW_HAW70_STAGE_CANDIDATE: head,
    ...overrides,
  } as Record<string, string | undefined>
}

/**
 * Replaces process.env for one load, then restores it exactly. The loader is
 * ASYNCHRONOUS and the config module is evaluated while its promise is
 * pending, so the work must be AWAITED inside the window: a synchronous
 * wrapper restores the environment first and the module then sees the real
 * one, which silently turns every case into the same refusal.
 */
async function withEnvironment<T>(
  values: Record<string, string | undefined>, work: () => T | Promise<T>,
): Promise<T> {
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  try { return await work() } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

const loadDedicatedConfig = (values: Record<string, string | undefined>) =>
  withEnvironment(values, () => loadConfigFromFile({ configFile: CONFIG_PATH, configRoot: backend }));

/* ============================== assembly helper ============================== */

test('the handoff namespace accepts exactly three fields and refuses everything else', () => {
  const valid = { HAWKVIEW_HAW70_STAGE_ROOT: staged.outputRoot,
    HAWKVIEW_HAW70_STAGE_NAME: 'candidate', HAWKVIEW_HAW70_STAGE_CANDIDATE: head }
  // POSITIVE CONTROL first, so the refusals below are not vacuous.
  assert.deepEqual(readHaw70StageHandoff(valid),
    { outputRoot: staged.outputRoot, stage: 'candidate', candidateCommit: head })
  assert.equal(readHaw70StageHandoff({ ...valid, HAWKVIEW_HAW70_STAGE_NAME: 'baseline' }).stage, 'baseline')

  for (const [label, mutate] of [
    ['missing root', { HAWKVIEW_HAW70_STAGE_ROOT: undefined }],
    ['missing stage', { HAWKVIEW_HAW70_STAGE_NAME: undefined }],
    ['missing candidate', { HAWKVIEW_HAW70_STAGE_CANDIDATE: undefined }],
    ['extra namespaced field', { HAWKVIEW_HAW70_STAGE_SCHEMA: '/tmp/schema.prisma' }],
    ['extra path override', { HAWKVIEW_HAW70_STAGE_MIGRATIONS: '/tmp/migrations' }],
    ['extra url override', { HAWKVIEW_HAW70_STAGE_URL: CI_URL }],
    ['unsupported stage', { HAWKVIEW_HAW70_STAGE_NAME: 'upgrade' }],
    ['empty stage', { HAWKVIEW_HAW70_STAGE_NAME: '' }],
    ['short candidate', { HAWKVIEW_HAW70_STAGE_CANDIDATE: 'abc' }],
    ['uppercase candidate', { HAWKVIEW_HAW70_STAGE_CANDIDATE: head.toUpperCase() }],
    ['relative root', { HAWKVIEW_HAW70_STAGE_ROOT: 'relative/stage' }],
    ['traversal root', { HAWKVIEW_HAW70_STAGE_ROOT: `${staged.outputRoot}/../${'x'}` }],
    ['trailing slash root', { HAWKVIEW_HAW70_STAGE_ROOT: `${staged.outputRoot}/` }],
    ['absent root', { HAWKVIEW_HAW70_STAGE_ROOT: join(scratch, 'does-not-exist') }],
    ['file as root', { HAWKVIEW_HAW70_STAGE_ROOT: join(staged.outputRoot, 'receipt.json') }],
  ] as Array<[string, Record<string, string | undefined>]>) {
    assert.throws(() => readHaw70StageHandoff({ ...valid, ...mutate }), /not qualified/, label)
  }
})

test('assembly refuses a loader whose filesystem cache was not disabled first', () => {
  for (const value of [undefined, 'true', '1', '', 'FALSE']) {
    assert.throws(() => assembleHaw70UpgradeStageConfig(
      { environment: hostedClaims({ JITI_FS_CACHE: value }) }), /not qualified/, String(value))
  }
  // POSITIVE CONTROL: the same claims with it disabled do assemble.
  assert.equal(assembleHaw70UpgradeStageConfig({ environment: hostedClaims() }).executionAllowed, false)
})

test('assembly refuses wrong identities, tampered stages and ambient routing overrides', () => {
  const other = '0'.repeat(40)
  for (const [label, overrides] of [
    ['wrong candidate in the handoff', { HAWKVIEW_HAW70_STAGE_CANDIDATE: other }],
    ['handoff and head disagree', { GITHUB_SHA: other }],
    ['workflow sha disagrees', { GITHUB_WORKFLOW_SHA: other }],
    ['wrong url', { DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/other' }],
    ['url with a different host', { DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@db.example:5432/hawkview_ci' }],
    ['ambient PG routing', { PGHOST: '127.0.0.1' }],
    ['ambient prisma control', { PRISMA_MIGRATE_SKIP_GENERATE: '1' }],
    ['ambient preload', { NODE_OPTIONS: '--require ./evil.js' }],
    ['ambient dotenv control', { DOTENV_CONFIG_PATH: '/tmp/.env' }],
    ['alternate datasource', { SHADOW_DATABASE_URL: CI_URL }],
    ['missing hosted marker', { RUNNER_ENVIRONMENT: undefined }],
    ['wrong workflow', { GITHUB_WORKFLOW: 'Something else' }],
    ['non-UTC', { TZ: 'America/New_York' }],
  ] as Array<[string, Record<string, string | undefined>]>) {
    assert.throws(() => assembleHaw70UpgradeStageConfig(
      { environment: hostedClaims(overrides) }), /not qualified/, label)
  }
})

test('assembly refuses a tampered or stale staged root, and validates both stages', () => {
  const copy = join(scratch, 'tampered')
  spawnSync('/bin/cp', ['-R', staged.outputRoot, copy]);
  const tampered = realpathSync(copy)
  for (const entry of readdirSync(tampered, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) spawnSync('/bin/chmod', ['700', join(entry.parentPath ?? tampered, entry.name)])
  }
  spawnSync('/bin/chmod', ['700', tampered])
  // POSITIVE CONTROL: a faithful copy in an isolated place still assembles.
  assert.equal(assembleHaw70UpgradeStageConfig({ environment: hostedClaims(
    { HAWKVIEW_HAW70_STAGE_ROOT: tampered }) }).executionAllowed, false)
  // Now tamper with a staged migration, which the receipt cannot excuse.
  const victim = join(tampered, 'candidate', 'migrations',
    dirname(staged.receipt.stages.candidate.migrationLock) === 'candidate/migrations' ? '' : '')
  const migration = readdirSync(join(tampered, 'candidate', 'migrations'), { withFileTypes: true })
    .find(entry => entry.isDirectory())!
  writeFileSync(join(tampered, 'candidate', 'migrations', migration.name, 'migration.sql'),
    '-- tampered after staging\n')
  assert.throws(() => assembleHaw70UpgradeStageConfig({ environment: hostedClaims(
    { HAWKVIEW_HAW70_STAGE_ROOT: tampered }) }), /not qualified/)
  void victim
  // A BASELINE selection is refused by the same tampered CANDIDATE tree, so
  // both staged trees really are validated rather than only the selected one.
  assert.throws(() => assembleHaw70UpgradeStageConfig({ environment: hostedClaims(
    { HAWKVIEW_HAW70_STAGE_ROOT: tampered, HAWKVIEW_HAW70_STAGE_NAME: 'baseline' }) }), /not qualified/)
})

/* ========================= the real installed loader ========================= */

test('the installed loader returns the validated absolute stage paths and the exact guarded target', async () => {
  for (const stage of ['baseline', 'candidate'] as const) {
    const loaded = await loadDedicatedConfig(hostedClaims({ HAWKVIEW_HAW70_STAGE_NAME: stage }))
    assert.equal(loaded.error, undefined, JSON.stringify(loaded.error))
    assert.equal(loaded.resolvedPath, CONFIG_PATH, 'the explicit path must be what resolved')
    const config = loaded.config!
    const expected = assembleHaw70UpgradeStageConfig(
      { environment: hostedClaims({ HAWKVIEW_HAW70_STAGE_NAME: stage }) })
    assert.equal(config.schema, expected.schemaPath)
    assert.equal(config.migrations?.path, expected.migrationsPath)
    assert.equal((config.datasource as { url?: string } | undefined)?.url, CI_URL)
    // Absolute, inside the staged root, and the stage actually selected.
    assert.ok(config.schema!.startsWith(`${staged.outputRoot}/`))
    assert.ok(config.schema!.endsWith(`/${stage}/schema.prisma`))
    assert.ok(config.migrations!.path!.endsWith(`/${stage}/migrations`))
    assert.ok(existsSync(config.schema!) && statSync(config.migrations!.path!).isDirectory())
    // No seed hook, which is what distinguishes this from the ordinary config.
    assert.equal(config.migrations?.seed, undefined)
  }
})

test('a refused environment fails the real load, and cannot fall back to a default config', async () => {
  const loaded = await loadDedicatedConfig(hostedClaims({ GITHUB_SHA: '0'.repeat(40) }))
  assert.ok(loaded.error, 'a refused assembly must surface as a load error')
  assert.notEqual(loaded.config?.schema, 'prisma/schema.prisma')
  // POSITIVE CONTROL for the whole harness: a missing config path is a
  // DIFFERENT, recognisable outcome, so an import or loader failure cannot
  // masquerade as one of the refusals above.
  const absent = await withEnvironment(hostedClaims(), () =>
    loadConfigFromFile({ configFile: join(backend, 'prisma', 'does-not-exist.config.ts'), configRoot: backend }))
  assert.ok(absent.error, 'a missing explicit config must be an error, not a silent default')
  const good = await loadDedicatedConfig(hostedClaims())
  assert.equal(good.error, undefined)
  assert.equal(good.resolvedPath, CONFIG_PATH)
})

/* ===================== cold-child side-effect observation ===================== */

/**
 * The previous three side-effect witnesses were insufficient and are WITHDRAWN,
 * not patched over:
 *
 *  - the subprocess observer replaced methods on the default `child_process`
 *    object AFTER the Git adapter had already taken a named `spawnSync`
 *    binding, so the mandatory read-only Git acquisition was invisible and the
 *    asserted "zero subprocesses" was false confidence;
 *  - `JITI_FS_CACHE` is parsed through a boolean JSON coercion in the installed
 *    Jiti, so a directory value is NOT a destination and that probe redirected
 *    nothing;
 *  - directory entry counts on a warm shared cache cannot exclude an overwrite,
 *    a cache hit or a write-then-delete, and Jiti additionally has a transient
 *    `{TMP_DIR}/jiti-esm` fallback that no count covered;
 *  - unchanged environment keys and an absent seed hook cannot establish that
 *    dotenv or the ordinary config was never evaluated.
 *
 * The replacement runs in a COLD child with `JITI_FS_CACHE=false` already in
 * the environment before the process starts, installs every observer BEFORE
 * importing anything under test, delegates each real operation unchanged, and
 * proves each instrument with a positive control reaching the same binding.
 * The Git calls are REQUIRED and asserted nonzero: that is what makes the
 * process observer non-vacuous.
 */

const witnessSource = (): string => `
import { createRequire } from 'node:module'
const require = createRequire(${JSON.stringify(`file://${import.meta.dirname}/x.mjs`)})
const nodeModule = require('node:module')
const input = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const rawWrite = require('node:fs').writeFileSync
const sha256 = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex')

const record = { git: [], otherProcesses: [], writes: [], reads: [], asyncReads: [], unlinks: [],
  loads: [], evaluated: [], network: [],
  control: { process: false, write: false, load: false, network: false, asyncRead: false,
    envValueChange: false },
  initialization: { compiles: 0, loads: 0 },
  envDigestBefore: null, envDigestAfter: null, ok: false, error: null }
let open = false
const envDigest = () => sha256(Object.keys(process.env).sort()
  .map(key => key + '=' + String(process.env[key])).join('\\n'))

const cp = require('node:child_process')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[name]
  if (typeof real !== 'function') continue
  cp[name] = function (file, args, ...rest) {
    const entry = { name, file: String(file), args: Array.isArray(args) ? args.map(String) : [] }
    if (open) (entry.file === '/usr/bin/git' ? record.git : record.otherProcesses).push(entry)
    else if (entry.file === '/usr/bin/true') record.control.process = true
    return real.call(this, file, args, ...rest)
  }
}

const fs = require('node:fs')
const WRITES = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync',
  'renameSync', 'copyFileSync', 'writeSync', 'truncateSync', 'ftruncateSync', 'chmodSync',
  'utimesSync', 'mkdtempSync', 'symlinkSync', 'linkSync']
for (const name of WRITES) {
  const real = fs[name]
  if (typeof real !== 'function') continue
  fs[name] = function (target, ...rest) {
    const path = typeof target === 'string' ? target : '<fd:' + String(target) + '>'
    if (open) record.writes.push({ name, path })
    else if (path.indexOf(input.controlDir) === 0) record.control.write = true
    return real.call(this, target, ...rest)
  }
}
const realOpen = fs.openSync
fs.openSync = function (path, flags, ...rest) {
  const writing = typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0
    : typeof flags === 'string' && /[wa+]/.test(flags)
  if (open) (writing ? record.writes : record.reads).push({ name: 'openSync', path: String(path), writing })
  return realOpen.call(this, path, flags, ...rest)
}
// The installed c12 reads dotenv content through fs.promises.readFile, which an
// openSync observer cannot see. Cover the synchronous and asynchronous read
// routes, and the asynchronous unlink the Jiti transient fallback uses.
const realReadSync = fs.readFileSync
fs.readFileSync = function (path, ...rest) {
  if (open && typeof path === 'string') record.reads.push({ name: 'readFileSync', path, writing: false })
  return realReadSync.call(this, path, ...rest)
}
for (const [holder, name, bucket] of [[fs, 'readFile', 'asyncReads'], [fs.promises, 'readFile', 'asyncReads'],
  [fs, 'unlink', 'unlinks'], [fs.promises, 'unlink', 'unlinks'], [fs, 'rm', 'unlinks'], [fs.promises, 'rm', 'unlinks'],
  [fs.promises, 'writeFile', 'writes'], [fs.promises, 'mkdir', 'writes']]) {
  const real = holder[name]
  if (typeof real !== 'function') continue
  holder[name] = function (path, ...rest) {
    const value = String(path)
    if (open) record[bucket].push({ name: (holder === fs.promises ? 'promises.' : '') + name, path: value })
    else if (value.indexOf(input.controlDir) === 0) record.control.asyncRead = true
    return real.call(this, path, ...rest)
  }
}

const net = require('node:net')
const dns = require('node:dns')
net.Socket.prototype.connect = function () {
  if (open) record.network.push('Socket.connect'); else record.control.network = true
  throw new Error('synthetic network guard')
}
net.createConnection = function () {
  if (open) record.network.push('createConnection'); else record.control.network = true
  throw new Error('synthetic network guard')
}
dns.lookup = function () {
  if (open) record.network.push('dns.lookup'); else record.control.network = true
  throw new Error('synthetic network guard')
}

// Native ESM module loading.
nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (open) { record.loads.push(url); record.initialization.loads += 1 }
    return nextLoad(url, context)
  },
})
// THE ACTUAL TypeScript evaluation route. Jiti transpiles and evaluates through
// vm.runInThisContext with the module's own filename, and CommonJS dependencies
// through Module.prototype._compile. The native load hook above cannot see
// either, which is why the previous exclusion control was off-route.
const vm = require('node:vm')
for (const name of ['runInThisContext', 'runInContext', 'compileFunction']) {
  const real = vm[name]
  if (typeof real !== 'function') continue
  vm[name] = function (code, ...rest) {
    const options = rest.find(value => value && typeof value === 'object'
      && (value.filename || value.identifier))
    const filename = (options && (options.filename || options.identifier)) || '(anonymous)'
    if (open) record.evaluated.push({ via: 'vm.' + name, filename: String(filename) })
    else if (String(filename).indexOf('prisma.config') !== -1) record.control.load = true
    return real.call(this, code, ...rest)
  }
}
const realCompile = nodeModule.prototype._compile
nodeModule.prototype._compile = function (content, filename, ...rest) {
  if (open) { record.evaluated.push({ via: '_compile', filename: String(filename) }); record.initialization.compiles += 1 }
  else if (String(filename).indexOf('prisma.config') !== -1) record.control.load = true
  return realCompile.call(this, content, filename, ...rest)
}

try {
  // The window OPENS BEFORE the loader is imported, so dependency
  // initialisation is inside it, not silently ahead of it.
  record.envDigestBefore = envDigest()
  open = true
  const { loadConfigFromFile } = await import(input.prismaConfigUrl)
  record.initialization.afterImport = { compiles: record.initialization.compiles, loads: record.initialization.loads }
  const loaded = await loadConfigFromFile({ configFile: input.configPath, configRoot: input.backend })
  record.envDigestAfter = envDigest()
  open = false
  record.ok = !loaded.error
  record.error = loaded.error ? String(loaded.error._tag || loaded.error) : null
  record.resolvedPath = loaded.resolvedPath || null
  record.schema = (loaded.config && loaded.config.schema) || null
  record.migrations = (loaded.config && loaded.config.migrations && loaded.config.migrations.path) || null
  record.url = (loaded.config && loaded.config.datasource && loaded.config.datasource.url) || null
  const seed = loaded.config && loaded.config.migrations ? loaded.config.migrations.seed : undefined
  record.seed = seed === undefined ? 'absent' : seed

  // SAME-ROUTE control: load the ORDINARY config through the very same
  // installed loader, so the evaluation observer is proven on the route that
  // would actually evaluate it. Recorded separately from the window above.
  if (input.sameRouteControl) {
    const probe = []
    const realRun = vm.runInThisContext
    vm.runInThisContext = function (code, ...rest) {
      const options = rest.find(v => v && typeof v === 'object' && (v.filename || v.identifier))
      probe.push(String((options && (options.filename || options.identifier)) || ''))
      return realRun.call(this, code, ...rest)
    }
    try { await loadConfigFromFile({ configFile: input.ordinaryConfigPath, configRoot: input.backend }) }
    catch {} finally { vm.runInThisContext = realRun }
    record.sameRouteEvaluated = probe.filter(name => name.indexOf('prisma.config') !== -1)
  }

  const { spawnSync } = await import('node:child_process')
  spawnSync('/usr/bin/true', [])
  const { writeFileSync } = await import('node:fs')
  writeFileSync(input.controlDir + '/probe.txt', 'control\\n')
  try { const { createConnection } = await import('node:net'); createConnection({ port: 1 }) } catch {}
  // Asynchronous read control, against an isolated synthetic fixture only.
  await fs.promises.readFile(input.controlDir + '/probe.txt', 'utf8')
  // Existing-VALUE change control: the digest must move when a value changes,
  // not only when a key appears.
  const beforeChange = envDigest()
  const key = Object.keys(process.env)[0]
  const previous = process.env[key]
  process.env[key] = String(previous) + '-synthetic-control'
  record.control.envValueChange = envDigest() !== beforeChange
  process.env[key] = previous
} catch (error) {
  open = false
  record.error = String(error && error.message ? error.message : error)
} finally {
  rawWrite(input.reportPath, JSON.stringify(record, null, 1))
}
`

type WitnessReport = {
  git: Array<{ name: string; file: string; args: string[] }>
  otherProcesses: Array<{ name: string; file: string; args: string[] }>
  writes: Array<{ name: string; path: string }>
  reads: Array<{ name: string; path: string; writing: boolean }>
  loads: string[]
  network: string[]
  asyncReads: Array<{ name: string; path: string }>
  unlinks: Array<{ name: string; path: string }>
  evaluated: Array<{ via: string; filename: string }>
  sameRouteEvaluated?: string[]
  control: { process: boolean; write: boolean; load: boolean; network: boolean
    asyncRead: boolean; envValueChange: boolean }
  initialization: { compiles: number; loads: number; afterImport?: { compiles: number; loads: number } }
  envDigestBefore: string | null; envDigestAfter: string | null
  ok: boolean; error: string | null; resolvedPath: string | null
  schema: string | null; migrations: string | null; url: string | null; seed: unknown
}

function runColdWitness(overrides: Record<string, string | undefined> = {}): WitnessReport {
  const directory = realpathSync(mkdtempSync(join(scratch, 'witness-')))
  const controlDir = join(directory, 'control')
  mkdirSync(controlDir)
  const reportPath = join(directory, 'report.json')
  const inputPath = join(directory, 'input.json')
  const runner = join(directory, 'witness.mjs')
  writeFileSync(inputPath, JSON.stringify({
    configPath: CONFIG_PATH, backend, controlDir, reportPath,
    ordinaryConfigPath: ORDINARY_CONFIG, sameRouteControl: true,
    prismaConfigUrl: `file://${createRequire(import.meta.url).resolve('@prisma/config')}`,
  }))
  writeFileSync(runner, witnessSource())
  const environment = hostedClaims(overrides)
  // JITI_FS_CACHE is already in this environment, so it is in place before the
  // child process starts and therefore before any loader initialisation.
  assert.equal(environment.JITI_FS_CACHE, overrides.JITI_FS_CACHE ?? 'false')
  const result = spawnSync(process.execPath, [runner, inputPath], {
    encoding: 'utf8', timeout: 180_000,
    env: Object.fromEntries(Object.entries({ ...environment, PATH: '/usr/bin:/bin' })
      .filter(([, value]) => value !== undefined)) as Record<string, string>,
  })
  assert.equal(result.signal, null, `the witness child must exit on its own: ${result.stderr}`)
  assert.equal(result.status, 0, `witness child failed: ${result.stderr}`)
  assert.ok(existsSync(reportPath), `no witness report was written: ${result.stderr}`)
  return JSON.parse(readFileSync(reportPath, 'utf8')) as WitnessReport
}

test('the cold witness observes the required read-only Git work and nothing else', () => {
  const report = runColdWitness()
  assert.equal(report.error, null)
  assert.equal(report.ok, true, 'the load itself must succeed, or the window proves nothing')
  assert.equal(report.resolvedPath, CONFIG_PATH)
  assert.equal(report.url, CI_URL)

  // REQUIRED, not merely permitted: pinned source acquisition must shell out to
  // Git, so a zero count would mean the observer is blind rather than that the
  // loader is quiet. That is exactly what the withdrawn witness got wrong.
  assert.ok(report.git.length > 0, 'the mandatory Git validation must be observed')
  for (const call of report.git) {
    assert.equal(call.file, '/usr/bin/git')
    assert.equal(call.args.includes('--no-pager'), true)
    const subcommand = call.args.find(argument =>
      !argument.startsWith('-') && !argument.includes('=') && !argument.includes('/')) ?? ''
    assert.ok(['rev-parse', 'cat-file', 'ls-tree', 'for-each-ref', 'config'].includes(subcommand),
      `only read-only Git subcommands are permitted, saw ${subcommand} in ${JSON.stringify(call.args)}`)
  }
  assert.deepEqual(report.otherProcesses, [], 'no subprocess other than read-only Git may run')
  assert.deepEqual(report.network, [], 'no connection or name resolution during loading')
  // POSITIVE CONTROLS through the same bindings.
  assert.equal(report.control.process, true,
    'the process observer must see a non-Git spawn, or the exclusion above is vacuous')
  assert.equal(report.control.network, true,
    'the network observer must see a real attempt, or the exclusion above is vacuous')

  // INITIALISATION IS INSIDE THE WINDOW. The window now opens before the
  // loader is imported, and this proves the import really did land inside it:
  // dependency initialisation compiled modules while recording was open.
  assert.ok(report.initialization.afterImport, 'the import must have completed inside the window')
  assert.ok(report.initialization.afterImport!.compiles > 0,
    'dependency initialisation must be observed, or it could fall outside the window unseen')
  assert.ok(report.initialization.afterImport!.loads > 0)
})

test('the cold witness observes no cache or stray filesystem write with the flag already false', () => {
  const report = runColdWitness()
  assert.equal(report.ok, true)
  // Observed MUTATIONS, not directory counts: an overwrite, a transient write
  // and a write-then-delete are each visible here and invisible to a count.
  const forbidden = report.writes.filter(write =>
    /node_modules\/\.cache/.test(write.path) || /\/jiti(-esm)?(\/|$)/.test(write.path))
  assert.deepEqual(forbidden, [], 'no write to any jiti cache or esm-fallback destination')
  assert.deepEqual(report.writes, [],
    `config loading performed no filesystem mutation at all; observed ${JSON.stringify(report.writes)}`)
  // The installed Jiti transient fallback cleans up with an asynchronous
  // unlink, which a write observer alone would miss; it is covered explicitly.
  assert.deepEqual(report.unlinks, [],
    `no deletion occurred either; observed ${JSON.stringify(report.unlinks)}`)
  assert.equal(report.control.write, true,
    'the write observer must see a real write, or the exclusion above is vacuous')
  // STATED LIMIT: this covers the synchronous write family, promises.writeFile,
  // promises.mkdir and the unlink/rm routes. It is not an exhaustive Node API
  // monitor, so the conclusion is bounded to those observed routes plus the
  // source reading that Jiti's cache and transient paths use them.
})

test('the cold witness separates the required compatibility READ from forbidden evaluation', () => {
  const report = runColdWitness()
  assert.equal(report.ok, true)

  // THE ACTUAL EVALUATION ROUTE. Jiti transpiles TypeScript and evaluates it
  // through `vm.runInThisContext` with the module's own filename; the native
  // ESM load hook cannot see that, which is why the previous control was
  // off-route and its stronger implication is withdrawn.
  const evaluatedFiles = report.evaluated.map(entry => entry.filename)
  assert.ok(evaluatedFiles.some(name => name.endsWith('/prisma/haw70-upgrade.config.ts')),
    `the dedicated config must be observed evaluating on the real route: ${JSON.stringify(report.evaluated.slice(-4))}`)
  assert.equal(report.evaluated.find(entry =>
    entry.filename.endsWith('/prisma/haw70-upgrade.config.ts'))!.via, 'vm.runInThisContext')

  // THE ORDINARY APPLICATION CONFIG WAS NOT EVALUATED, on that same route.
  assert.deepEqual(evaluatedFiles.filter(name => /\/prisma\.config\.ts$/.test(name)), [],
    'the ordinary application config must never be evaluated')
  // SAME-ROUTE POSITIVE CONTROL: loading the ordinary config through the very
  // same installed loader IS observed, so the exclusion is not vacuous and the
  // control exercises the route that would actually evaluate it.
  assert.ok(report.sameRouteEvaluated && report.sameRouteEvaluated.length > 0,
    'the evaluation observer must see the ordinary config when the real loader evaluates it')
  for (const name of report.sameRouteEvaluated!) assert.match(name, /\/prisma\.config\.ts$/)

  // Effects corroborate the evaluation independently of the observer.
  const expected = assembleHaw70UpgradeStageConfig({ environment: hostedClaims() })
  assert.equal(report.schema, expected.schemaPath)
  assert.equal(report.migrations, expected.migrationsPath)
  assert.equal(report.url, CI_URL)
  assert.equal(report.seed, 'absent')

  // CORRECTED CLAIM. `dotenv` IS loaded during the window, as a static
  // dependency of c12; "dotenv is never evaluated" stays withdrawn. What is
  // established is that it never APPLIES environment configuration, now
  // observed on the route the installed c12 actually uses for dotenv content
  // -- `fs.promises.readFile` -- rather than on `openSync` alone.
  assert.ok(report.loads.some(url => /(^|\/)dotenv\//.test(url))
    || report.evaluated.some(entry => /(^|\/)dotenv\//.test(entry.filename)),
  'dotenv is loaded by c12; this records the fact honestly')
  const envFileReads = [...report.reads, ...report.asyncReads]
    .filter(entry => /(^|\/)\.env(\.[^/]*)?$/.test(entry.path))
  assert.deepEqual(envFileReads, [], 'no .env file may be read on any observed route')
  assert.equal(report.control.asyncRead, true,
    'the asynchronous read observer must see a real promises.readFile, or the above is vacuous')

  // ENVIRONMENT VALUES, not just keys: a digest over sorted key=value pairs,
  // computed inside the child and reported as a digest only, so no ambient
  // value is disclosed.
  assert.ok(report.envDigestBefore && report.envDigestAfter)
  assert.equal(report.envDigestAfter, report.envDigestBefore,
    'the environment the config saw must be unchanged in value as well as in key set')
  assert.equal(report.control.envValueChange, true,
    'changing an EXISTING value must move the digest, or the comparison is key-only')

  // And the ordinary config's raw bytes WERE read, deliberately, as a pinned
  // compatibility input. Required read, forbidden evaluation: distinct, and
  // both now observed on their real routes.
  const read = report.reads.find(entry => entry.path === ORDINARY_CONFIG)
  assert.ok(read, 'source validation must still read the ordinary config as a compatibility input')
  assert.equal(read!.writing, false)
})

test('a refused environment is observed failing with no write and only read-only Git', () => {
  const report = runColdWitness({ GITHUB_SHA: '0'.repeat(40) })
  assert.equal(report.ok, false, 'the refused environment must not load')
  assert.deepEqual(report.writes, [], 'a refusal must not write anything either')
  assert.deepEqual(report.otherProcesses, [])
  assert.deepEqual(report.network, [])
  for (const call of report.git) assert.equal(call.file, '/usr/bin/git')
})

test('jiti caches through its explicitly configured programmatic option, in a disposable fixture', async () => {
  // INSTRUMENT CHECK in a disposable fixture, never against a shared cache.
  const { createJiti } = await import('jiti')
  const probeDirectory = realpathSync(mkdtempSync(join(scratch, 'jiti-probe-')))
  const probeModule = join(probeDirectory, 'probe.ts')
  writeFileSync(probeModule, 'export const value: number = 41 + 1\n')
  const make = (options: unknown) => (createJiti as (f: string, o: unknown) =>
    { import: (m: string) => Promise<unknown> })(probeModule, options)

  const enabled = join(probeDirectory, 'cache-enabled')
  mkdirSync(enabled, { recursive: true })
  assert.equal((await make({ fsCache: enabled, moduleCache: false }).import(probeModule) as
    { value: number }).value, 42)
  const written = readdirSync(enabled)
  assert.equal(written.length, 1, 'the programmatic option really does write one cache entry')
  assert.match(written[0], /probe\.[0-9a-f]+\.mjs$/)

  const disabled = join(probeDirectory, 'cache-disabled')
  mkdirSync(disabled, { recursive: true })
  assert.equal((await make({ fsCache: false, moduleCache: false }).import(probeModule) as
    { value: number }).value, 42)
  assert.deepEqual(readdirSync(disabled), [], 'and nothing when it is disabled')

  // The earlier "redirected destination" probe is REMOVED, not re-run. It set a
  // directory string as JITI_FS_CACHE and created jiti with no explicit
  // fsCache, so the installed jiti was free to choose its own default --
  // including `os.tmpdir()/jiti` when the scratch module has no sibling
  // node_modules. Locating the module in scratch did not contain that
  // destination, so the probe was not confined as claimed.
  //
  // The fact it was meant to show needs no probe: in the installed
  // `jiti/dist/jiti.cjs`, JITI_FS_CACHE is read through `_booleanEnv` ->
  // `_jsonEnv` -> `JSON.parse`, so a raw directory path fails to parse and
  // falls back to the boolean default. A string destination exists only as the
  // programmatic `fsCache` option, which is what the two controls above use.
  // That is a source observation and is reported as such, not as a measurement.
})

test('config assembly performs no filesystem write of its own', () => {
  const probe = join(scratch, 'write-probe')
  mkdirSync(probe, { recursive: true })
  // Names AND bytes AND modes: a filename comparison cannot see an overwrite
  // of a staged file that keeps its name.
  const integrity = () => readdirSync(staged.outputRoot, { recursive: true }).sort()
    .map(entry => {
      const path = join(staged.outputRoot, String(entry))
      const stat = statSync(path)
      return stat.isDirectory() ? `${entry}|dir|${(stat.mode & 0o7777).toString(8)}`
        : `${entry}|${stat.size}|${(stat.mode & 0o7777).toString(8)}|${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    })
  const before = integrity()
  const assembled = assembleHaw70UpgradeStageConfig({ environment: hostedClaims() })
  assert.equal(assembled.executionAllowed, false)
  assert.deepEqual(integrity(), before,
    'assembly must not create, clean, overwrite or materialise anything under the staged root')
  assert.deepEqual(readdirSync(probe), [])
  assert.equal(Object.isFrozen(assembled), true)
  assert.throws(() => { (assembled as { executionAllowed: boolean }).executionAllowed = true }, TypeError)
})
