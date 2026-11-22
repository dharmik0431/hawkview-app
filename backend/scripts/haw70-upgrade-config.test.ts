import assert from 'node:assert/strict'
import child_process, { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import net from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync } from 'node:fs'
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

test('loading the dedicated config never evaluates the ordinary config or dotenv', async t => {
  assert.ok(existsSync(ORDINARY_CONFIG), 'the ordinary config must still exist, untouched')
  const before = { ...process.env }
  // Captured INSIDE the window, immediately after the module evaluated: dotenv
  // would have added keys to the environment the config actually saw.
  let during: string[] = []
  const loaded = await withEnvironment(hostedClaims(), async () => {
    const result = await loadConfigFromFile({ configFile: CONFIG_PATH, configRoot: backend })
    during = Object.keys(process.env).sort()
    return result
  })
  assert.equal(loaded.error, undefined)
  assert.deepEqual(during, Object.keys(hostedClaims()).sort(),
    'the loaded config must not have introduced any environment key')
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort())
  // The ordinary config's distinctive markers are absent from what loaded.
  assert.notEqual(loaded.config?.schema, 'prisma/schema.prisma')
  assert.equal(loaded.config?.migrations?.seed, undefined)
  void t
})

test('loading opens no socket, resolves no name and starts no subprocess', async () => {
  const connect = net.Socket.prototype.connect
  const createConnection = net.createConnection
  const lookup = dns.lookup
  const spawn = child_process.spawn
  const spawnSyncOriginal = child_process.spawnSync
  let network = 0
  let processes = 0
  const refuse = () => { network += 1; throw new Error('synthetic network guard') }
  net.Socket.prototype.connect = refuse as never
  net.createConnection = refuse as never
  dns.lookup = refuse as never
  child_process.spawn = ((...args: unknown[]) => { processes += 1; return (spawn as never as (...a: unknown[]) => unknown)(...args) }) as never
  child_process.spawnSync = ((...args: unknown[]) => { processes += 1; return (spawnSyncOriginal as never as (...a: unknown[]) => unknown)(...args) }) as never
  try {
    const loaded = await loadDedicatedConfig(hostedClaims())
    assert.equal(loaded.error, undefined)
    assert.equal(network, 0, 'no connection or name resolution during config loading')
    assert.equal(processes, 0, 'no migration CLI or other subprocess during config loading')
  } finally {
    net.Socket.prototype.connect = connect
    net.createConnection = createConnection
    dns.lookup = lookup
    child_process.spawn = spawn
    child_process.spawnSync = spawnSyncOriginal
  }
  // POSITIVE CONTROL: the guards really fire when exercised.
  const connect2 = net.createConnection
  let fired = 0
  net.createConnection = (() => { fired += 1; throw new Error('synthetic network guard') }) as never
  try { assert.throws(() => net.createConnection({ port: 1 }), /synthetic network guard/) }
  finally { net.createConnection = connect2 }
  assert.equal(fired, 1)
})

/* ===================== installed loader cache behaviour ===================== */

const cacheDestinations = () => [join(backend, 'node_modules', '.cache', 'jiti'),
  join(repositoryRoot, 'node_modules', '.cache', 'jiti'), join(tmpdir(), 'jiti')]
const cacheState = () => cacheDestinations().map(path =>
  `${path}:${existsSync(path) ? readdirSync(path).length : 'absent'}`)

test('jiti really does write a filesystem cache when enabled, so the measurement is not vacuous', async () => {
  // INSTRUMENT CHECK, measured rather than assumed. The installed jiti is
  // driven directly on a dependency-free module, with the destination
  // redirected to a disposable directory so nothing shared is touched.
  const { createJiti } = await import('jiti')
  const probeDirectory = realpathSync(mkdtempSync(join(scratch, 'jiti-probe-')))
  const probeModule = join(probeDirectory, 'probe.ts')
  writeFileSync(probeModule, 'export const value: number = 41 + 1\n')

  const enabled = join(probeDirectory, 'cache-enabled')
  mkdirSync(enabled, { recursive: true })
  const withCache = (createJiti as (f: string, o: unknown) => { import: (m: string) => Promise<unknown> })(
    probeModule, { fsCache: enabled, moduleCache: false, interopDefault: true })
  assert.equal((await withCache.import(probeModule) as { value: number }).value, 42)
  const written = readdirSync(enabled)
  assert.equal(written.length, 1, 'jiti must write exactly one cache entry for one transpiled module')
  assert.match(written[0], /probe\.[0-9a-f]+\.mjs$/)

  const disabled = join(probeDirectory, 'cache-disabled')
  mkdirSync(disabled, { recursive: true })
  const withoutCache = (createJiti as (f: string, o: unknown) => { import: (m: string) => Promise<unknown> })(
    probeModule, { fsCache: false, moduleCache: false, interopDefault: true })
  assert.equal((await withoutCache.import(probeModule) as { value: number }).value, 42)
  assert.deepEqual(readdirSync(disabled), [], 'and nothing when it is disabled')
})

test('the installed config loader path writes to no cache destination, measured', async () => {
  // RESOLVED BY MEASUREMENT, not assumed. c12 constructs jiti with
  // `moduleCache: false` and no `fsCache` key (c12 dist/index.mjs ~123-128),
  // so jiti's own default would apply -- and the previous test shows that
  // default mechanism really does write. Across every destination jiti can
  // choose, this loader path writes nothing for this explicit config path.
  const before = cacheState()
  const loaded = await loadDedicatedConfig(hostedClaims())
  assert.equal(loaded.error, undefined)
  assert.deepEqual(cacheState(), before,
    'no jiti cache entry may appear in either node_modules cache or the temporary directory')

  // Also with the destination explicitly redirected: still nothing, so the
  // non-writing result is a property of this path rather than of where the
  // cache happens to point.
  const redirected = realpathSync(mkdtempSync(join(scratch, 'loader-cache-')))
  const beforeRedirect = cacheState()
  const viaRedirect = await withEnvironment(hostedClaims({ JITI_FS_CACHE: redirected }), () =>
    loadConfigFromFile({ configFile: CONFIG_PATH, configRoot: backend }))
  // The assembly refuses a cache-enabled invocation by design, which is the
  // fail-closed behaviour tested separately; the module is still transpiled.
  assert.ok(viaRedirect.error, 'a cache-enabled invocation must be refused by the assembly')
  assert.deepEqual(readdirSync(redirected), [])
  assert.deepEqual(cacheState(), beforeRedirect)

  // The shared dependency tree is therefore untouched by this slice's loading.
  const shared = join(backend, 'node_modules', '.cache', 'jiti')
  if (existsSync(shared)) {
    assert.deepEqual(cacheState()[0], before[0], 'the shared jiti cache count must be unchanged')
  }
})

test('config assembly performs no filesystem write of its own', () => {
  const probe = join(scratch, 'write-probe')
  mkdirSync(probe, { recursive: true })
  const stagedBefore = readdirSync(staged.outputRoot, { recursive: true }).sort()
  const assembled = assembleHaw70UpgradeStageConfig({ environment: hostedClaims() })
  assert.equal(assembled.executionAllowed, false)
  assert.deepEqual(readdirSync(staged.outputRoot, { recursive: true }).sort(), stagedBefore,
    'assembly must not create, clean or materialise anything under the staged root')
  assert.deepEqual(readdirSync(probe), [])
  assert.equal(Object.isFrozen(assembled), true)
  assert.throws(() => { (assembled as { executionAllowed: boolean }).executionAllowed = true }, TypeError)
})
