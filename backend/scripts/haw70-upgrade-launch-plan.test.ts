import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { after } from 'node:test'
import { materializeHaw70UpgradeSource } from './haw70-upgrade-materializer.mjs'
import { inspectSelectedNamespaceAgainstBaseline } from './haw70-upgrade-git-source.mjs'
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' }
import {
  HAW70_LAUNCH_ENVIRONMENT_KEYS, HAW70_REVIEWED_MAIN_ANCHOR, buildHaw70UpgradeLaunchPlan,
} from './haw70-upgrade-launch-plan.js'

/**
 * Focused NONEXECUTING tests for the unused launch-plan builder. Nothing here
 * launches a child command, imports or version-probes the Prisma CLI, opens a
 * database, connects, migrates, builds or touches a workflow. The hosted
 * strings are synthetic test data and qualify nothing.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'haw70-launch-plan-test-')))
after(() => rmSync(scratch, { recursive: true, force: true }))
const backend = realpathSync(join(import.meta.dirname, '..'))
const repositoryRoot = realpathSync(join(backend, '..'))
const CI_URL = 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci'
const CONFIG_PATH = join(backend, 'prisma', 'haw70-upgrade.config.ts')
const CLI_ENTRY = join(backend, 'node_modules', 'prisma', 'build', 'index.js')

const git = (...args: string[]) => {
  const result = spawnSync('/usr/bin/git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const head = git('rev-parse', 'HEAD')
const headTree = git('rev-parse', 'HEAD^{tree}')

const stageParent = realpathSync(mkdtempSync(join(scratch, 'stage-')))
const staged = materializeHaw70UpgradeSource(
  { repositoryRoot, expectedCandidateCommit: head, scratchParent: stageParent }) as { outputRoot: string }

const REF = 'refs/heads/codex/haw70-launch-plan-20261123'
function snapshot(overrides: Record<string, string | undefined> = {}) {
  return {
    CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'dharmik0431/hawkview-app', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_WORKFLOW: 'Required quality gates',
    GITHUB_JOB: 'backend-quality', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    GITHUB_REF: REF,
    GITHUB_WORKFLOW_REF: `dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@${REF}`,
    GITHUB_RUN_ID: '44978604441', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head,
    HAWKVIEW_CI_MIGRATION_PROFILE: 'haw70-upgrade', HAWKVIEW_RUN_HAW70_UPGRADE: '1',
    HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1', TZ: 'UTC',
    HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
    HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
    DATABASE_URL: CI_URL, JITI_FS_CACHE: 'false',
    HAWKVIEW_HAW70_STAGE_ROOT: staged.outputRoot, HAWKVIEW_HAW70_STAGE_NAME: 'candidate',
    HAWKVIEW_HAW70_STAGE_CANDIDATE: head,
    ...overrides,
  } as Record<string, string | undefined>
}
type Plan = ReturnType<typeof buildHaw70UpgradeLaunchPlan>
const build = (overrides: Record<string, string | undefined> = {}): Plan =>
  buildHaw70UpgradeLaunchPlan({ environment: snapshot(overrides) })

/* ============================== valid proposals ============================== */

test('valid baseline and candidate proposals yield a frozen, nonexecuting plan', () => {
  for (const stage of ['baseline', 'candidate'] as const) {
    const plan = build({ HAWKVIEW_HAW70_STAGE_NAME: stage })
    assert.equal(plan.kind, 'haw70-upgrade-launch-plan-v1')
    assert.equal(plan.executionAllowed, false, 'a plan is never an authorization')
    assert.equal(plan.stage, stage)

    // Three identities, kept separate and not collapsed onto the new head.
    assert.equal(plan.candidate.commit, head)
    assert.equal(plan.candidate.tree, headTree)
    assert.equal(plan.historicalPins.baselineCommit, pins.baselineCommit)
    assert.equal(plan.historicalPins.reviewedCandidateCommit, pins.reviewedCandidateCommit)
    assert.equal(plan.historicalPins.baselineSelectedFiles, 85)
    assert.equal(plan.historicalPins.candidateSelectedFiles, 99)
    assert.notEqual(plan.historicalPins.reviewedCandidateCommit, plan.candidate.commit)
    assert.equal(plan.reviewedMainAnchor.commit, HAW70_REVIEWED_MAIN_ANCHOR)
    assert.equal(plan.reviewedMainAnchor.rawAncestorOfCandidate, true)
    assert.equal(plan.reviewedMainAnchor.matchesHistoricalBaseline, true)
    assert.equal(plan.reviewedMainAnchor.selectedFiles, 85)
    assert.notEqual(plan.reviewedMainAnchor.commit, plan.candidate.commit)

    // Derived fixed paths, and the validated stage paths for THIS stage.
    assert.equal(plan.paths.prismaCliEntry, CLI_ENTRY)
    assert.equal(plan.paths.dedicatedConfig, CONFIG_PATH)
    assert.equal(plan.paths.nodeExecutable, realpathSync(process.execPath))
    assert.ok(plan.paths.stageSchema.endsWith(`/${stage}/schema.prisma`))
    assert.ok(plan.paths.stageMigrations.endsWith(`/${stage}/migrations`))
    assert.ok(existsSync(plan.paths.stageSchema) && statSync(plan.paths.stageMigrations).isDirectory())

    // The one fixed argument preview, descriptive only.
    assert.deepEqual([...plan.argumentPreview],
      [CLI_ENTRY, 'migrate', 'deploy', '--config', CONFIG_PATH])

    // Exactly the 33 allowed keys, as an inventory.
    assert.equal(plan.childEnvironmentKeys.length, 33)
    assert.deepEqual([...plan.childEnvironmentKeys], [...HAW70_LAUNCH_ENVIRONMENT_KEYS])
    assert.ok(plan.childEnvironmentKeys.includes('DATABASE_URL'), 'the key is inventoried')

    // Credential-free target metadata, and five explicit unmet gates.
    assert.deepEqual(plan.target, { host: '127.0.0.1', port: 5432, database: 'hawkview_ci', user: 'hawkview_ci' })
    assert.equal(plan.unmetGates.length, 5)
    assert.ok(plan.unmetGates.some(gate => gate.startsWith('database-stage')))
    assert.ok(plan.unmetGates.some(gate => gate.startsWith('hosted-toolchain')))

    // Deeply frozen, and not mutable into an authorization.
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.paths) && Object.isFrozen(plan.argumentPreview))
    assert.throws(() => { (plan as { executionAllowed: boolean }).executionAllowed = true }, TypeError)
    assert.throws(() => { (plan.argumentPreview as string[]).push('--force') }, TypeError)
  }
})

test('no runnable environment, raw URL, command string or readiness flag is returned', () => {
  const plan = build()
  const serialized = JSON.stringify(plan)
  // No raw datasource URL and no credential, anywhere in the serialization.
  assert.equal(serialized.includes('://'), false)
  assert.equal(serialized.includes('hawkview_ci:hawkview_ci'), false)
  assert.equal(serialized.includes(CI_URL), false)
  // The child environment is an inventory of names, never values.
  for (const key of plan.childEnvironmentKeys) assert.equal(typeof key, 'string')
  assert.equal('childEnvironment' in (plan as object), false)
  assert.equal('env' in (plan as object), false)
  // No single command string that could be handed to a shell.
  assert.equal(serialized.includes('migrate deploy'), false)
  // No approval-shaped field of any kind.
  for (const field of ['approved', 'ready', 'readyToExecute', 'canExecute', 'authorized']) {
    assert.equal(field in (plan as object), false, field)
  }
  assert.equal(plan.executionAllowed, false)
})

/* ================================== refusals ================================== */

test('no caller may supply an executable, argument, path, digest, anchor or receipt', () => {
  const base = { environment: snapshot() }
  for (const extra of [
    { executable: '/bin/sh' }, { args: ['migrate', 'reset'] }, { argumentPreview: [] },
    { configPath: '/tmp/other.config.ts' }, { schema: '/tmp/schema.prisma' },
    { manifest: { baselineFiles: [], candidateFiles: [] } }, { baselineCommit: pins.baselineCommit },
    { mainAnchor: HAW70_REVIEWED_MAIN_ANCHOR }, { expectedDigest: 'a'.repeat(64) },
    { receipt: { kind: 'forged' } }, { onPlan: () => undefined }, { executionAllowed: true },
  ]) {
    assert.throws(() => buildHaw70UpgradeLaunchPlan({ ...base, ...extra } as never),
      /not qualified/, JSON.stringify(Object.keys(extra)))
  }
  for (const shape of [undefined, null, [], 'environment', { environment: null }, { environment: [] },
    { environment: { CI: 1 } }]) {
    assert.throws(() => buildHaw70UpgradeLaunchPlan(shape as never), /not qualified/, String(shape))
  }
})

test('wrong identity, hosted claims, cache flag or timezone refuse before any CLI or loader work', () => {
  const other = '0'.repeat(40)
  for (const [label, overrides] of [
    ['wrong candidate in the handoff', { HAWKVIEW_HAW70_STAGE_CANDIDATE: other }],
    ['wrong hosted sha', { GITHUB_SHA: other }],
    ['wrong workflow sha', { GITHUB_WORKFLOW_SHA: other }],
    ['wrong url', { DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/other' }],
    ['missing run id', { GITHUB_RUN_ID: undefined }],
    ['malformed ref', { GITHUB_REF: 'refs/heads/..bad' }],
    ['wrong workflow', { GITHUB_WORKFLOW: 'Something else' }],
    ['not hosted', { RUNNER_ENVIRONMENT: 'self-hosted' }],
    ['wrong cache flag', { JITI_FS_CACHE: 'true' }],
    ['absent cache flag', { JITI_FS_CACHE: undefined }],
    ['wrong timezone', { TZ: 'America/New_York' }],
    ['unsupported stage', { HAWKVIEW_HAW70_STAGE_NAME: 'upgrade' }],
    ['extra namespaced handoff field', { HAWKVIEW_HAW70_STAGE_SCHEMA: '/tmp/s.prisma' }],
    // Known forbidden routing and preload controls, per the existing guard.
    ['ambient PG routing', { PGHOST: '127.0.0.1' }],
    ['ambient prisma control', { PRISMA_MIGRATE_SKIP_GENERATE: '1' }],
    ['ambient preload', { NODE_OPTIONS: '--require /tmp/evil.js' }],
    ['ambient dotenv control', { DOTENV_CONFIG_PATH: '/tmp/.env' }],
    ['alternate datasource', { SHADOW_DATABASE_URL: CI_URL }],
    ['npm script shell', { npm_config_script_shell: '/bin/sh' }],
  ] as Array<[string, Record<string, string | undefined>]>) {
    assert.throws(() => build(overrides), /not qualified/, label)
  }
  // POSITIVE CONTROL: the unmodified snapshot still builds, so the refusals
  // above are the checks and not a broken fixture.
  assert.equal(build().executionAllowed, false)
})

test('unrelated parent variables are never projected, and a poisoned PATH cannot move the preview', () => {
  // These are not in the guard's forbidden set, so they are accepted and must
  // simply never be forwarded or echoed.
  const plan = build({
    HTTPS_PROXY: 'http://attacker.invalid:8080', HTTP_PROXY: 'http://attacker.invalid:8080',
    GITHUB_TOKEN: 'synthetic-token-value', HOME: '/tmp/synthetic-home',
    UNRELATED_PARENT_TOKEN: 'synthetic-unrelated-value',
  })
  assert.equal(plan.childEnvironmentKeys.length, 33)
  assert.deepEqual([...plan.childEnvironmentKeys], [...HAW70_LAUNCH_ENVIRONMENT_KEYS])
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'GITHUB_TOKEN', 'HOME', 'UNRELATED_PARENT_TOKEN',
    'NODE_OPTIONS', 'NODE_PATH']) {
    assert.equal(plan.childEnvironmentKeys.includes(key), false, key)
  }
  const serialized = JSON.stringify(plan)
  for (const value of ['attacker.invalid', 'synthetic-token-value', 'synthetic-unrelated-value',
    '/tmp/synthetic-home']) {
    assert.equal(serialized.includes(value), false, value)
  }
  // A hostile ambient PATH cannot change the fixed preview, because ambient
  // environment is never read: PATH is projected as a fixed value.
  const previousPath = process.env.PATH
  process.env.PATH = '/tmp/evil:/usr/bin:/bin'
  try {
    const poisoned = build()
    assert.deepEqual([...poisoned.argumentPreview], [CLI_ENTRY, 'migrate', 'deploy', '--config', CONFIG_PATH])
    assert.equal(poisoned.paths.prismaCliEntry, CLI_ENTRY)
    assert.equal(JSON.stringify(poisoned).includes('/tmp/evil'), false)
  } finally { process.env.PATH = previousPath }
})

test('tampered staged bytes refuse, including a baseline proposal with a damaged candidate tree', () => {
  const copy = join(scratch, 'tampered-stage')
  spawnSync('/bin/cp', ['-R', staged.outputRoot, copy])
  const tampered = realpathSync(copy)
  // POSITIVE CONTROL: the faithful copy still plans.
  assert.equal(build({ HAWKVIEW_HAW70_STAGE_ROOT: tampered }).executionAllowed, false)
  const migration = readdirSync(join(tampered, 'candidate', 'migrations'), { withFileTypes: true })
    .find(entry => entry.isDirectory())!
  writeFileSync(join(tampered, 'candidate', 'migrations', migration.name, 'migration.sql'),
    '-- tampered after staging\n')
  for (const stage of ['candidate', 'baseline'] as const) {
    assert.throws(() => build({ HAWKVIEW_HAW70_STAGE_ROOT: tampered, HAWKVIEW_HAW70_STAGE_NAME: stage }),
      /not qualified/, `${stage} must refuse a damaged candidate tree`)
  }
})

/* ========================= the reviewed-main anchor check ========================= */

test('the anchor check requires raw ancestry and the exact historical baseline selection', () => {
  // POSITIVE: the committed anchor on the real repository.
  const real = inspectSelectedNamespaceAgainstBaseline({ repositoryRoot,
    expectedCandidateCommit: head, anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR }) as never as
    Record<string, unknown>
  assert.equal(real.executionAllowed, false)
  assert.equal(real.rawAncestorOfCandidate, true)
  assert.equal(real.matchesHistoricalBaseline, true)
  assert.equal(real.selectedFiles, 85)
  assert.deepEqual(real.differing, [])
  assert.equal(real.candidateTree, headTree)

  // ABSENT ANCESTRY: a well-formed object name that is not a raw ancestor of
  // the candidate (including one that does not resolve at all).
  for (const anchorCommit of ['f'.repeat(40), 'e'.repeat(40), '0'.repeat(40)]) {
    assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot,
      expectedCandidateCommit: head, anchorCommit }),
    /not a raw ancestor|Git verification failed/, anchorCommit)
  }
  // WRONG HEAD, and shape refusals: no manifest or extra field is accepted.
  assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot,
    expectedCandidateCommit: '0'.repeat(40), anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR }))
  assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot,
    expectedCandidateCommit: head, anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR,
    manifest: { baselineFiles: [] } } as never), /Unexpected adapter input/)

  // A WIDER SELECTED NAMESPACE: the reviewed historical candidate is a raw
  // ancestor and carries all 85 baseline paths, but its selected namespace
  // holds 14 more. The namespace is enumerated, not merely read path by path,
  // so the extra files are refused instead of ignored.
  assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot,
    expectedCandidateCommit: head, anchorCommit: pins.reviewedCandidateCommit }),
  /Selected namespace differs from manifest/)
})

test('changed selected bytes at an ancestor are reported, never silently repinned', () => {
  // A synthetic fixture is the only way to reach this branch: every real
  // ancestor either matches the pinned baseline exactly or has a different
  // path set. Objects are written into a SHARED clone, so the real
  // repository, its branches and its worktrees are never touched, and no
  // checkout, hook, remote or network is involved.
  const drift = join(scratch, 'drift-clone')
  const run = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8', input: '' })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  run('clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, drift)
  const root = realpathSync(drift)
  const inClone = (...args: string[]) => run('-C', root, ...args)
  const anchorTree = inClone('rev-parse', `${HAW70_REVIEWED_MAIN_ANCHOR}^{tree}`)

  // Change the bytes of ONE pinned baseline file; keep its path and mode.
  const victim = [...pins.baselineFiles].map(file => file.path).sort()[0]
  const original = inClone('cat-file', 'blob', `${HAW70_REVIEWED_MAIN_ANCHOR}:${victim}`)
  const blob = spawnSync('/usr/bin/git', ['-C', root, 'hash-object', '-w', '--stdin', '--path', victim],
    { encoding: 'utf8', input: `${original}\n-- drifted selected byte\n` })
  assert.equal(blob.status, 0, blob.stderr)
  const index = join(scratch, 'drift-index')
  const withIndex = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', ['-C', root, ...args],
      { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: index } })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  withIndex('read-tree', anchorTree)
  withIndex('update-index', '--cacheinfo', `100644,${blob.stdout.trim()},${victim}`)
  const driftedTree = withIndex('write-tree')
  assert.notEqual(driftedTree, anchorTree)
  const identity = ['-c', 'user.name=haw70-test', '-c', 'user.email=haw70-test@invalid',
    '-c', 'commit.gpgsign=false']
  const driftedAnchor = run('-C', root, ...identity, 'commit-tree', driftedTree,
    '-p', HAW70_REVIEWED_MAIN_ANCHOR, '-m', 'drifted selected bytes')
  const cloneHead = run('-C', root, ...identity, 'commit-tree', driftedTree, '-p', driftedAnchor,
    '-m', 'descendant')
  inClone('update-ref', 'refs/heads/haw70-drift-probe', cloneHead)
  inClone('symbolic-ref', 'HEAD', 'refs/heads/haw70-drift-probe')
  assert.equal(inClone('rev-parse', 'HEAD'), cloneHead)

  // POSITIVE CONTROL: in the same clone the untouched anchor still matches, so
  // the clone itself is not what produces the difference below.
  const faithful = inspectSelectedNamespaceAgainstBaseline({ repositoryRoot: root,
    expectedCandidateCommit: cloneHead, anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR }) as never as
    Record<string, unknown>
  assert.equal(faithful.matchesHistoricalBaseline, true)
  assert.deepEqual(faithful.differing, [])

  // The drifted ancestor keeps the exact 85-path namespace, so it passes
  // enumeration and is caught by the per-file mode and digest comparison.
  const drifted = inspectSelectedNamespaceAgainstBaseline({ repositoryRoot: root,
    expectedCandidateCommit: cloneHead, anchorCommit: driftedAnchor }) as never as
    Record<string, unknown>
  assert.equal(drifted.rawAncestorOfCandidate, true)
  assert.equal(drifted.selectedFiles, 85)
  assert.equal(drifted.matchesHistoricalBaseline, false, 'changed bytes must be reported')
  assert.deepEqual(drifted.differing, [victim])
  assert.equal(drifted.executionAllowed, false)
  assert.notEqual(drifted.anchorTree, faithful.anchorTree)
})

/* ============================ tools, runtime, inactivity ============================ */

test('installed tool metadata is read, never executed, and kept apart from hosted claims', () => {
  const plan = build()
  const packageJson = JSON.parse(readFileSync(
    join(backend, 'node_modules', 'prisma', 'package.json'), 'utf8')) as Record<string, unknown>
  assert.equal(plan.installedTools.prismaVersion, packageJson.version)
  assert.equal(plan.installedTools.prismaVersion, '7.9.1')
  assert.equal(plan.installedTools.prismaConfigVersion, '7.9.1')
  assert.equal(plan.installedTools.prismaDeclaredBinary, 'build/index.js')

  // ACTUAL runtime facts, recorded separately from the synthetic claims.
  assert.equal(plan.runtime.nodeVersion, process.version)
  assert.equal(plan.runtime.platform, process.platform)
  assert.equal(plan.hostedClaims.runnerOs, 'Linux')
  assert.equal(plan.hostedClaims.runnerEnvironment, 'github-hosted')
  assert.match(plan.hostedClaims.note, /claims only/)
  // A LOCAL run is never hosted qualification. The plan keeps the two apart
  // and states the gate unconditionally, whatever this machine happens to be.
  const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'quality-gates.yml'), 'utf8')
  assert.match(workflow, /node-version:\s*'?22/)
  assert.notEqual(plan.runtime.platform, plan.hostedClaims.runnerOs.toLowerCase(),
    'this machine is not the claimed runner operating system')
  assert.ok(plan.unmetGates.some(gate => /hosted-toolchain/.test(gate) && /Node 22/.test(gate)),
    'the hosted toolchain gate is stated whatever the local runtime is')
  // Every gate is stated as UNMET, and nothing claims any of them satisfied.
  assert.deepEqual(plan.unmetGates.map(gate => gate.split(':')[0]).sort(),
    ['current-main-freshness', 'database-stage', 'hosted-provenance', 'hosted-toolchain',
      'whole-code-and-dependency-integrity'])
  assert.match(plan.hostedClaims.note, /not physical-host, approval or database proof/)
  for (const field of ['hostedToolchainMet', 'provenanceVerified', 'databaseReady', 'gatesMet']) {
    assert.equal(field in (plan as object), false, field)
  }
  assert.equal(plan.executionAllowed, false)
})

test('building a plan writes nothing and leaves the staged root untouched', () => {
  const integrity = () => readdirSync(staged.outputRoot, { recursive: true }).sort().map(entry => {
    const path = join(staged.outputRoot, String(entry))
    const stat = statSync(path)
    return stat.isDirectory() ? `${entry}|dir|${(stat.mode & 0o7777).toString(8)}`
      : `${entry}|${stat.size}|${createHash('sha256').update(readFileSync(path)).digest('hex')}`
  })
  const before = integrity()
  const probe = join(scratch, 'write-probe')
  mkdirSync(probe, { recursive: true })
  assert.equal(build().executionAllowed, false)
  assert.deepEqual(integrity(), before, 'no staged file may be created, removed or overwritten')
  assert.deepEqual(readdirSync(probe), [])
})

test('a cold child observes only permitted read-only Git, with no launch of the planned command', () => {
  const directory = realpathSync(mkdtempSync(join(scratch, 'inactivity-')))
  const reportPath = join(directory, 'report.json')
  const inputPath = join(directory, 'input.json')
  writeFileSync(inputPath, JSON.stringify({ environment: snapshot(), reportPath,
    planModule: `file://${join(import.meta.dirname, 'haw70-upgrade-launch-plan.js')}` }))
  const runner = join(directory, 'runner.mjs')
  writeFileSync(runner, `
import { createRequire } from 'node:module'
const require = createRequire(${JSON.stringify(`file://${import.meta.dirname}/x.mjs`)})
const input = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const rawWrite = require('node:fs').writeFileSync
const record = { git: [], other: [], writes: [], importedOnly: true, exec: null, error: null }
let open = false
const cp = require('node:child_process')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[name]
  if (typeof real !== 'function') continue
  cp[name] = function (file, args, ...rest) {
    const entry = { name, file: String(file), args: Array.isArray(args) ? args.map(String) : [] }
    if (open) (entry.file === '/usr/bin/git' ? record.git : record.other).push(entry)
    return real.call(this, file, args, ...rest)
  }
}
const fs = require('node:fs')
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync']) {
  const real = fs[name]
  if (typeof real !== 'function') continue
  fs[name] = function (target, ...rest) {
    if (open) record.writes.push({ name, path: String(target) })
    return real.call(this, target, ...rest)
  }
}
try {
  // IMPORT ONLY: an inert import must do no work at all.
  const mod = await import(input.planModule)
  record.importedOnly = record.git.length === 0 && record.other.length === 0 && record.writes.length === 0
  open = true
  const plan = mod.buildHaw70UpgradeLaunchPlan({ environment: input.environment })
  open = false
  record.exec = plan.executionAllowed
  record.keys = plan.childEnvironmentKeys.length
  record.preview = plan.argumentPreview.slice(1)
} catch (error) {
  open = false
  record.error = String(error && error.message ? error.message : error)
} finally { rawWrite(input.reportPath, JSON.stringify(record, null, 1)) }
`)
  const result = spawnSync(process.execPath, ['--import', 'tsx', runner, inputPath],
    { encoding: 'utf8', timeout: 180_000, cwd: backend })
  assert.equal(result.signal, null, `the child must exit on its own: ${result.stderr}`)
  assert.ok(existsSync(reportPath), `no report: ${result.stderr}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    git: Array<{ file: string; args: string[] }>; other: unknown[]; writes: unknown[]
    importedOnly: boolean; exec: unknown; keys: number; preview: string[]; error: string | null }
  assert.equal(report.error, null, String(report.error))
  assert.equal(report.importedOnly, true, 'importing the builder must perform no work')
  assert.equal(report.exec, false)
  assert.equal(report.keys, 33)
  assert.deepEqual(report.preview, ['migrate', 'deploy', '--config', CONFIG_PATH])

  // Read-only Git really is used, and is the ONLY process work.
  assert.ok(report.git.length > 0, 'pinned validation must be observed using read-only Git')
  for (const call of report.git) {
    assert.equal(call.file, '/usr/bin/git')
    const subcommand = call.args.find(argument =>
      !argument.startsWith('-') && !argument.includes('=') && !argument.includes('/')) ?? ''
    assert.ok(['rev-parse', 'cat-file', 'ls-tree', 'for-each-ref', 'config'].includes(subcommand), subcommand)
  }
  // The planned command is never launched, and nothing else is either.
  assert.deepEqual(report.other, [], 'no non-Git subprocess may run, and least of all the planned CLI')
  assert.deepEqual(report.writes, [], 'planning writes nothing')
})
