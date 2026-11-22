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

const record = { git: [], otherProcesses: [], writes: [], reads: [], loads: [], network: [],
  control: { process: false, write: false, load: false, network: false },
  envBefore: [], envAfter: [], ok: false, error: null }
let open = false

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

// Module evaluation: a synchronous in-thread hook, registered before anything
// under test is imported, so it sees every module the loader really loads.
nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (open) record.loads.push(url)
    else if (url.indexOf('prisma.config') !== -1) record.control.load = true
    return nextLoad(url, context)
  },
})

const net = require('node:net')
const dns = require('node:dns')
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...a) {
  if (open) record.network.push('Socket.connect'); else record.control.network = true
  throw new Error('synthetic network guard')
}
const realCreate = net.createConnection
net.createConnection = function (...a) {
  if (open) record.network.push('createConnection'); else record.control.network = true
  throw new Error('synthetic network guard')
}
const realLookup = dns.lookup
dns.lookup = function (...a) {
  if (open) record.network.push('dns.lookup'); else record.control.network = true
  throw new Error('synthetic network guard')
}

try {
  const { loadConfigFromFile } = await import(input.prismaConfigUrl)
  record.envBefore = Object.keys(process.env).sort()
  open = true
  const loaded = await loadConfigFromFile({ configFile: input.configPath, configRoot: input.backend })
  open = false
  record.envAfter = Object.keys(process.env).sort()
  record.ok = !loaded.error
  record.error = loaded.error ? String(loaded.error._tag || loaded.error) : null
  record.resolvedPath = loaded.resolvedPath || null
  record.schema = (loaded.config && loaded.config.schema) || null
  record.migrations = (loaded.config && loaded.config.migrations && loaded.config.migrations.path) || null
  record.url = (loaded.config && loaded.config.datasource && loaded.config.datasource.url) || null
  const seed = loaded.config && loaded.config.migrations ? loaded.config.migrations.seed : undefined
  record.seed = seed === undefined ? 'absent' : seed

  const { spawnSync } = await import('node:child_process')
  spawnSync('/usr/bin/true', [])
  const { writeFileSync } = await import('node:fs')
  writeFileSync(input.controlDir + '/probe.txt', 'control\\n')
  try { const { createConnection } = await import('node:net'); createConnection({ port: 1 }) } catch {}
  // The hook records the URL before the loader rejects the .ts extension in a
  // plain cold child, which is exactly what this control needs to establish.
  try { await import(input.ordinaryConfigUrl) } catch {}
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
  control: { process: boolean; write: boolean; load: boolean; network: boolean }
  envBefore: string[]; envAfter: string[]
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
    ordinaryConfigUrl: `file://${ORDINARY_CONFIG}`,
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
  assert.equal(report.control.write, true,
    'the write observer must see a real write, or the exclusion above is vacuous')
})

test('the cold witness separates the required compatibility READ from forbidden evaluation', () => {
  const report = runColdWitness()
  assert.equal(report.ok, true)

  // THE DEDICATED CONFIG WAS EVALUATED, proven by its effect rather than by the
  // module hook: jiti evaluates transpiled TypeScript outside Node's module
  // loader, so the config's own URL does not appear in `loads`. The returned
  // paths and URL can only come from that module having run.
  const expected = assembleHaw70UpgradeStageConfig({ environment: hostedClaims() })
  assert.equal(report.schema, expected.schemaPath)
  assert.equal(report.migrations, expected.migrationsPath)
  assert.equal(report.url, CI_URL)
  assert.equal(report.seed, 'absent')
  assert.equal(report.loads.some(url => url.endsWith('/prisma/haw70-upgrade.config.ts')), false,
    'documented, not desired: jiti-evaluated modules do not reach the module hook')

  // THE ORDINARY APPLICATION CONFIG WAS NOT EVALUATED. This exclusion is
  // meaningful because the control below shows the hook does record such a URL
  // when one really is imported, and because importing it would go through
  // Node's loader rather than jiti's.
  assert.deepEqual(report.loads.filter(url => /\/prisma\.config\.ts$/.test(url)), [],
    'the ordinary application config must never be evaluated')
  assert.equal(report.control.load, true,
    'the evaluation hook must see the ordinary config being imported, or the exclusion is vacuous')

  // CORRECTED CLAIM. `dotenv` IS loaded during the window, as a static
  // dependency of c12 -- the earlier "dotenv is never evaluated" wording is
  // withdrawn. What matters is that it is never APPLIED: `@prisma/config`
  // passes `dotenv: false`, and the two observations below are what establish
  // that, rather than an inference from an unchanged key set after the fact.
  const dotenvLoads = report.loads.filter(url => /(^|\/)dotenv\//.test(url))
  assert.ok(dotenvLoads.length > 0, 'dotenv is loaded by c12; this records the fact honestly')
  assert.deepEqual(report.reads.filter(entry => /(^|\/)\.env(\.|$)/.test(entry.path)), [],
    'no .env file may be read')
  assert.deepEqual(report.envAfter, report.envBefore,
    'and the environment the config saw must be unchanged across the load')

  // And the ordinary config's raw bytes WERE read, deliberately, as a pinned
  // compatibility input. Required read, forbidden evaluation: distinct
  // operations, both positively observed now instead of inferred.
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

test('jiti caches only through its PROGRAMMATIC option; the environment switch is boolean', async () => {
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

  // WITHDRAWN CLAIM, measured: a directory value in the ENVIRONMENT switch is
  // not a destination, because the installed Jiti coerces it through a boolean
  // JSON parse. The earlier "redirected destination" probe proved nothing.
  const viaEnvironment = join(probeDirectory, 'cache-env')
  mkdirSync(viaEnvironment, { recursive: true })
  const previous = process.env.JITI_FS_CACHE
  process.env.JITI_FS_CACHE = viaEnvironment
  try {
    assert.equal((await make({ moduleCache: false }).import(probeModule) as { value: number }).value, 42)
  } finally {
    if (previous === undefined) delete process.env.JITI_FS_CACHE
    else process.env.JITI_FS_CACHE = previous
  }
  assert.deepEqual(readdirSync(viaEnvironment), [],
    'a directory value in JITI_FS_CACHE is not a cache destination')
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
