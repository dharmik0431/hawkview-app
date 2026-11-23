import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
 * Focused NONEXECUTING tests for the unused launch-plan builder.
 *
 * "Nonexecuting" is a claim about the SUBJECT, not about this file. The tests
 * themselves do run processes, and saying otherwise would be false: they spawn
 * `/usr/bin/git` for identity checks, `/bin/cp` and `/bin/chmod` to build
 * throwaway fixtures, and Node children for the cold-child witness. What none
 * of them ever does is import, version-probe or launch the Prisma CLI, open a
 * database, connect anywhere, migrate, build, register a workflow, or launch
 * the synthetic non-Git command used as the blocking control. Every write is
 * confined to a disposable mkdtemp directory. The hosted strings are synthetic
 * test data and qualify nothing.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'haw70-launch-plan-test-')))
after(() => rmSync(scratch, { recursive: true, force: true }))
const backend = realpathSync(join(import.meta.dirname, '..'))
const repositoryRoot = realpathSync(join(backend, '..'))
const CI_URL = 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci'
const CONFIG_PATH = join(backend, 'prisma', 'haw70-upgrade.config.ts')
const CLI_ENTRY = join(backend, 'node_modules', 'prisma', 'build', 'index.js')

const SPAWN_TIMEOUT_MS = 60_000
const git = (...args: string[]) => {
  const result = spawnSync('/usr/bin/git', ['-C', repositoryRoot, ...args],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const head = git('rev-parse', 'HEAD')
const headTree = git('rev-parse', 'HEAD^{tree}')

const stageParent = realpathSync(mkdtempSync(join(scratch, 'stage-')))
const staged = materializeHaw70UpgradeSource(
  { repositoryRoot, expectedCandidateCommit: head, scratchParent: stageParent }) as { outputRoot: string }

/**
 * INDEPENDENT POLICY ORACLE.
 *
 * These are transcribed from the ACCEPTED DESIGN -- the 33-key table and the
 * compatibility anchor in haw70-bc2d825-runner-preflight-design-20261123.md,
 * SHA-256 fd19db5ef72f1c942691e64a396509b1a668a42c1fd215e69d71929166248b1a --
 * and NOT derived from the implementation. Comparing the result only against
 * the module's own exported list would let a one-for-one substitution change
 * both sides and still pass, so the literal below is the oracle and the
 * exported list is checked against it rather than trusted as it.
 */
const REVIEWED_ENVIRONMENT_KEYS = Object.freeze([
  'CI', 'GITHUB_ACTIONS',
  'RUNNER_ENVIRONMENT', 'RUNNER_OS',
  'GITHUB_REPOSITORY', 'GITHUB_SERVER_URL', 'GITHUB_API_URL',
  'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_EVENT_NAME', 'GITHUB_REF_TYPE',
  'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA',
  'GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
  'HAWKVIEW_CI_MIGRATION_PROFILE',
  'HAWKVIEW_RUN_HAW70_UPGRADE', 'HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS',
  'HAWKVIEW_CI_DISPOSABLE_POSTGRES',
  'HAWKVIEW_HAW70_TENANT_DELETE_WITNESS', 'HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS',
  'HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS',
  'HAWKVIEW_HAW70_STAGE_ROOT', 'HAWKVIEW_HAW70_STAGE_NAME', 'HAWKVIEW_HAW70_STAGE_CANDIDATE',
  'DATABASE_URL',
  'JITI_FS_CACHE', 'TZ', 'PATH', 'LANG', 'LC_ALL',
])
const REVIEWED_KEYS_SORTED = Object.freeze([...REVIEWED_ENVIRONMENT_KEYS].sort())
/** The agreed compatibility anchor, as a literal. A compatible older ancestor
 *  is not an automatically accepted repin. */
const REVIEWED_ANCHOR = 'eaa92ebdd5f7893b50023d819a7c3ddde56a2955'
/**
 * The historical provenance identities, also literals from the same design
 * section. Comparing these to the implementation's own manifest would repeat
 * exactly the self-derived-oracle defect this slice is correcting.
 */
const REVIEWED_PINS = Object.freeze({
  baselineCommit: '8928934406fdcaf5fdb911d2003ac03439b05145',
  reviewedCandidateCommit: 'a88af992b4ee156a8abf9c1a64c3725055acc42a',
  baselineSelectedFiles: 85,
  candidateSelectedFiles: 99,
  manifestDigest: 'dead85bebbe03f5f7b83843d5d24e37996488d3f77074902d6d1d9ff00d9cab4',
})

test('the reviewed policy oracle is itself well formed', () => {
  assert.equal(REVIEWED_ENVIRONMENT_KEYS.length, 33, 'the design specifies exactly 33 keys')
  assert.equal(new Set(REVIEWED_ENVIRONMENT_KEYS).size, 33, 'no duplicate key in the transcription')
  for (const oid of [REVIEWED_ANCHOR, REVIEWED_PINS.baselineCommit,
    REVIEWED_PINS.reviewedCandidateCommit, REVIEWED_PINS.manifestDigest]) {
    assert.match(oid, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/)
  }
  // The literals are distinct identities, not three names for one commit.
  assert.equal(new Set([REVIEWED_ANCHOR, REVIEWED_PINS.baselineCommit,
    REVIEWED_PINS.reviewedCandidateCommit]).size, 3)
  // NOTE on the limit of this test: it checks the transcription is well formed,
  // NOT that it matches the design. Correspondence to the design table was
  // established by reading that document, and re-checked by an independent
  // reviewer, which is human/review evidence rather than something this process
  // can assert about a file outside the repository.
})

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
    // Compared to the LITERAL design identities. The committed manifest is then
    // checked against those same literals rather than trusted as the oracle.
    assert.equal(plan.historicalPins.baselineCommit, REVIEWED_PINS.baselineCommit)
    assert.equal(plan.historicalPins.reviewedCandidateCommit, REVIEWED_PINS.reviewedCandidateCommit)
    assert.equal(plan.historicalPins.baselineSelectedFiles, REVIEWED_PINS.baselineSelectedFiles)
    assert.equal(plan.historicalPins.candidateSelectedFiles, REVIEWED_PINS.candidateSelectedFiles)
    assert.equal(pins.baselineCommit, REVIEWED_PINS.baselineCommit)
    assert.equal(pins.reviewedCandidateCommit, REVIEWED_PINS.reviewedCandidateCommit)
    assert.equal(pins.baselineFiles.length, REVIEWED_PINS.baselineSelectedFiles)
    assert.equal(pins.candidateFiles.length, REVIEWED_PINS.candidateSelectedFiles)
    assert.equal(createHash('sha256').update(readFileSync(
      join(import.meta.dirname, 'haw70-upgrade-source-manifest.json'))).digest('hex'),
    REVIEWED_PINS.manifestDigest, 'the pinned manifest must be the reviewed bytes')
    assert.notEqual(plan.historicalPins.reviewedCandidateCommit, plan.candidate.commit)
    assert.equal(plan.reviewedMainAnchor.commit, REVIEWED_ANCHOR)
    assert.equal(HAW70_REVIEWED_MAIN_ANCHOR, REVIEWED_ANCHOR, 'the pinned constant must not drift')
    // This field is a literal `true` in the adapter -- it throws instead of
    // reporting false -- so asserting it here records the shape, and the real
    // evidence that ancestry is enforced is the throwing behaviour exercised by
    // the anchor test below, including a resolvable non-ancestor.
    assert.equal(plan.reviewedMainAnchor.rawAncestorOfCandidate, true)
    assert.equal(plan.reviewedMainAnchor.matchesHistoricalBaseline, true)
    assert.equal(plan.reviewedMainAnchor.selectedFiles, 85)
    assert.notEqual(plan.reviewedMainAnchor.commit, plan.candidate.commit)

    // Derived fixed paths, and the validated stage paths for THIS stage.
    assert.equal(plan.paths.prismaCliEntry, CLI_ENTRY)
    assert.equal(plan.paths.dedicatedConfig, CONFIG_PATH)
    assert.equal(plan.paths.nodeExecutable, realpathSync(process.execPath))
    // The EXACT absolute paths a future runner would be handed, not a suffix:
    // a path rooted anywhere else would satisfy an endsWith check.
    assert.equal(plan.paths.stageSchema, join(staged.outputRoot, stage, 'schema.prisma'))
    assert.equal(plan.paths.stageMigrations, join(staged.outputRoot, stage, 'migrations'))
    assert.ok(existsSync(plan.paths.stageSchema) && statSync(plan.paths.stageMigrations).isDirectory())

    // The one fixed argument preview, descriptive only.
    assert.deepEqual([...plan.argumentPreview],
      [CLI_ENTRY, 'migrate', 'deploy', '--config', CONFIG_PATH])

    // Exactly the 33 allowed keys, as an inventory.
    // Compared against the LITERAL reviewed policy, not the module's own list.
    assert.equal(plan.childEnvironmentKeys.length, 33)
    assert.deepEqual([...plan.childEnvironmentKeys], [...REVIEWED_KEYS_SORTED])
    // The implementation's exported list is checked against the oracle too, so
    // a substitution cannot quietly move both sides together.
    assert.deepEqual([...HAW70_LAUNCH_ENVIRONMENT_KEYS], [...REVIEWED_KEYS_SORTED])
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
  // The child environment is an inventory of names, never values. `typeof key
  // === 'string'` would be true of a value too, so it proves nothing and is not
  // asserted; what is asserted is that no VALUE from the snapshot appears.
  const snapshotValues = Object.values(snapshot()).filter(
    (value): value is string => typeof value === 'string' && value.length > 3)
  for (const value of snapshotValues) {
    if (plan.childEnvironmentKeys.includes(value)) {
      assert.fail(`a value leaked into the key inventory: ${value}`)
    }
  }
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
  // POSITIVE CONTROL, which this test previously lacked entirely: the same
  // single-field input without any extra field still builds.
  assert.equal(buildHaw70UpgradeLaunchPlan(base).executionAllowed, false)
})

test('wrong identity, hosted claims, cache flag or timezone refuse before any CLI or loader work', () => {
  // POSITIVE CONTROL FIRST, as the accepted design requires, so a fixture that
  // was already broken could not masquerade as nineteen passing refusals. The
  // same control is repeated at the end, after the table.
  assert.equal(build().executionAllowed, false, 'the unmodified snapshot must build before the table')
  const other = '0'.repeat(40)
  for (const [label, overrides] of [
    ['wrong candidate in the handoff', { HAWKVIEW_HAW70_STAGE_CANDIDATE: other }],
    ['wrong hosted sha', { GITHUB_SHA: other }],
    ['wrong workflow sha', { GITHUB_WORKFLOW_SHA: other }],
    ['wrong url', { DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/other' }],
    ['missing run id', { GITHUB_RUN_ID: undefined }],
    // Both ref fields are moved together, so this row is refused by the
    // REF-SHAPE rule it is named for rather than by the cross-field
    // consistency rule, which the previous one-field version tripped first.
    ['malformed ref (shape, kept self-consistent)', { GITHUB_REF: 'refs/heads/..bad',
      GITHUB_WORKFLOW_REF: 'dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@refs/heads/..bad' }],
    ['inconsistent ref pair', { GITHUB_REF: 'refs/heads/other' }],
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
  assert.deepEqual([...plan.childEnvironmentKeys], [...REVIEWED_KEYS_SORTED])
  // A per-key `includes(...) === false` loop here would be implied by the
  // deepEqual above and could not fail independently, so it is not asserted.
  // What does carry weight is that none of the VALUES appears anywhere.
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
  spawnSync('/bin/cp', ['-R', staged.outputRoot, copy], { timeout: SPAWN_TIMEOUT_MS })
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
  // ---- ancestry, on a cheap purpose-built history -------------------------
  // A nonexistent anchor makes `assertRawAncestors` walk the candidate's whole
  // ancestry, one `git cat-file commit` SUBPROCESS per commit, up to its 4096
  // bound. Doing that three times here cost thousands of processes and was the
  // measured source of intermittent `cat-file` failures across this suite.
  // So the ancestry cases run against a two-commit synthetic history whose
  // tree IS the anchor's tree -- the selected namespace therefore equals the
  // pinned baseline exactly -- built in a throwaway shared clone. The real
  // repository, its branches and its worktrees are untouched, and the
  // full-cost real-anchor case above is retained as the meaningful one.
  const fixture = join(scratch, 'ancestry-fixture')
  const runFixture = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })
    assert.equal(result.signal, null, `timed out: git ${args.join(' ')}`)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  runFixture('clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, fixture)
  const fixtureRoot = realpathSync(fixture)
  const inFixture = (...args: string[]) => runFixture('-C', fixtureRoot, ...args)
  const anchorTree = inFixture('rev-parse', `${REVIEWED_ANCHOR}^{tree}`)
  const asAuthor = ['-c', 'user.name=haw70-test', '-c', 'user.email=haw70-test@invalid',
    '-c', 'commit.gpgsign=false']
  const base = inFixture(...asAuthor, 'commit-tree', anchorTree, '-m', 'fixture base')
  const tip = inFixture(...asAuthor, 'commit-tree', anchorTree, '-p', base, '-m', 'fixture tip')
  const offBranch = inFixture(...asAuthor, 'commit-tree', anchorTree, '-p', base, '-m', 'off branch')
  inFixture('update-ref', 'refs/heads/haw70-fixture', tip)
  inFixture('symbolic-ref', 'HEAD', 'refs/heads/haw70-fixture')
  assert.equal(inFixture('rev-parse', 'HEAD'), tip)
  assert.notEqual(offBranch, base)

  // POSITIVE CONTROL FIRST: `base` is an ancestor of the tip and carries the
  // anchor's own tree, so the whole check succeeds on this fixture.
  const fixtureControl = inspectSelectedNamespaceAgainstBaseline({ repositoryRoot: fixtureRoot,
    expectedCandidateCommit: tip, anchorCommit: base }) as never as Record<string, unknown>
  assert.equal(fixtureControl.rawAncestorOfCandidate, true)
  assert.equal(fixtureControl.matchesHistoricalBaseline, true)
  assert.equal(fixtureControl.selectedFiles, REVIEWED_PINS.baselineSelectedFiles)
  assert.deepEqual(fixtureControl.differing, [])

  // (i) A RESOLVABLE commit that is NOT an ancestor. This is the case that
  //     establishes the ancestry rule; an unresolvable name cannot, because it
  //     would be refused for merely not existing.
  assert.equal(inFixture('cat-file', '-t', offBranch), 'commit',
    'the off-branch commit must genuinely exist')
  assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot: fixtureRoot,
    expectedCandidateCommit: tip, anchorCommit: offBranch }),
  /not a raw ancestor/, 'a resolvable non-ancestor must be refused for ancestry')

  // (ii) An absent name. Measured, not assumed: this reports the SAME message,
  //      because the ancestry walk simply never reaches it -- which is exactly
  //      why case (i) above is the one that proves anything. One row suffices
  //      for one behaviour.
  assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot: fixtureRoot,
    expectedCandidateCommit: tip, anchorCommit: 'f'.repeat(40) }),
  /not a raw ancestor/)

  // WRONG HEAD, and shape refusals: no manifest or extra field is accepted.
  // Each carries a matcher, so an unrelated failure cannot satisfy the row.
  assert.throws(() => inspectSelectedNamespaceAgainstBaseline({ repositoryRoot,
    expectedCandidateCommit: '0'.repeat(40), anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR }),
  /Actual HEAD differs from expected candidate|Git verification failed/)
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
      { encoding: 'utf8', input: '', timeout: SPAWN_TIMEOUT_MS })
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
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, input: `${original}\n-- drifted selected byte\n` })
  assert.equal(blob.status, 0, blob.stderr)
  const index = join(scratch, 'drift-index')
  const withIndex = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', ['-C', root, ...args],
      { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env: { ...process.env, GIT_INDEX_FILE: index } })
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
  // PORTABLE CONTRACT. The recorded facts must equal this process's actual
  // facts, and the hosted gates must stay unmet WHETHER OR NOT those facts
  // happen to match the synthetic claims. Running on Linux under Node 22 is
  // not a failure of this test and is not hosted qualification either; the
  // gate is about absent approved hosted evidence, not about the machine.
  const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'quality-gates.yml'), 'utf8')
  assert.match(workflow, /node-version:\s*'?22/)
  assert.ok(plan.unmetGates.some(gate => /^hosted-toolchain/.test(gate)),
    'the hosted toolchain gate is stated')
  assert.ok(plan.unmetGates.some(gate => /^hosted-provenance/.test(gate)),
    'the hosted provenance gate is stated')
  // The portability claim, actually asserted rather than only mentioned in a
  // message: the gate set is INVARIANT. It is identical for a run whose actual
  // facts match the synthetic claims and one whose facts differ, because it is
  // a frozen constant rather than a function of the runtime. That is the whole
  // property -- and it is also the limit: these gates are a source constant, so
  // this shows they cannot be relaxed by the environment, not that some runtime
  // check certified them.
  const gatesHere = [...plan.unmetGates]
  const gatesOtherStage = [...build({ HAWKVIEW_HAW70_STAGE_NAME: 'baseline' }).unmetGates]
  assert.deepEqual(gatesOtherStage, gatesHere, 'the gate set must not vary with the input')
  const claimsMatchActual = process.platform === 'linux' && process.version.startsWith('v22.')
  assert.equal(gatesHere.length, 5,
    `five gates stand whether or not the actual facts match the claims (they ${claimsMatchActual ? 'do' : 'do not'} here)`)
  // The gate text must say the approved evidence is ABSENT. Asserting the
  // absence of one exact spelling would test a spelling, so the positive
  // requirement is the assertion and the negative one is a secondary guard
  // against the specific wording the review rejected.
  const toolchain = plan.unmetGates.find(gate => /^hosted-toolchain/.test(gate)) as string
  assert.match(toolchain, /no approved hosted\s+evidence for this head exists/)
  assert.equal(/is not a hosted runner|cannot be (a )?hosted/.test(toolchain), false,
    'the gate must not disqualify the machine, only record absent evidence')
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

test('building a plan changes no staged entry, by name, mode or bytes', () => {
  // Names, DIRECTORY modes, REGULAR-FILE modes, sizes and bytes. The previous
  // fingerprint omitted regular-file modes, so a permission change alone would
  // have passed unnoticed while the test still claimed permissions intact.
  // `lstatSync`, not `statSync`: a regular file replaced by a symlink to
  // byte-identical content would otherwise fingerprint the same, since stat
  // resolves the link.
  const fingerprint = (root: string) => readdirSync(root, { recursive: true }).sort().map(entry => {
    const target = join(root, String(entry))
    const stat = lstatSync(target)
    const mode = (stat.mode & 0o7777).toString(8)
    if (stat.isSymbolicLink()) return `${entry}|link|${mode}|${readlinkSync(target)}`
    return stat.isDirectory() ? `${entry}|dir|${mode}`
      : `${entry}|file|${mode}|${stat.size}|${createHash('sha256').update(readFileSync(target)).digest('hex')}`
  })

  // POSITIVE CONTROL that the fingerprint is actually mode-sensitive: on a
  // throwaway copy, changing one regular file's permissions alone must change
  // it. Without this the "permissions intact" claim is untested.
  const copy = join(scratch, 'mode-sensitivity')
  spawnSync('/bin/cp', ['-R', staged.outputRoot, copy], { timeout: SPAWN_TIMEOUT_MS })
  const copied = realpathSync(copy)
  const sensitivityBefore = fingerprint(copied)
  const victim = readdirSync(copied, { recursive: true }).map(String)
    .find(entry => statSync(join(copied, entry)).isFile())!
  spawnSync('/bin/chmod', ['640', join(copied, victim)], { timeout: SPAWN_TIMEOUT_MS })
  const sensitivityAfter = fingerprint(copied)
  assert.notDeepEqual(sensitivityAfter, sensitivityBefore,
    'the fingerprint must notice a mode-only change')
  // The difference must be the victim's line and nothing else. (An entry-count
  // comparison would be true by construction, since chmod adds no entries.)
  const changedLines = sensitivityAfter.filter((line, index) => line !== sensitivityBefore[index])
  assert.equal(changedLines.length, 1, 'exactly one entry may differ')
  assert.ok(changedLines[0].startsWith(`${victim}|file|`), changedLines[0])
  // SECOND CONTROL: a regular file swapped for a symlink to byte-identical
  // content must also register, which `statSync` would have missed.
  const swapped = readFileSync(join(copied, victim))
  const aside = join(copied, `${victim}.original`)
  writeFileSync(aside, swapped)
  rmSync(join(copied, victim))
  symlinkSync(aside, join(copied, victim))
  const afterSwap = fingerprint(copied)
  assert.ok(afterSwap.some(line => line.startsWith(`${victim}|link|`)),
    'a symlink substitution must be visible in the fingerprint')
  assert.notDeepEqual(afterSwap, sensitivityAfter)

  // The actual claim, on the real staged tree.
  const before = fingerprint(staged.outputRoot)
  assert.ok(before.length > 0 && before.some(line => line.includes('|file|')),
    'the fingerprint must cover at least one regular file')
  assert.equal(build().executionAllowed, false)
  assert.deepEqual(fingerprint(staged.outputRoot), before,
    'no staged entry may change in name, mode or bytes')
  // This is a statement about the staged tree only. It is NOT a claim that
  // nothing anywhere was written: that claim belongs to the witness below and
  // is bounded by the operations it lists. An unrelated empty directory would
  // be no evidence at all and is deliberately not used here.
})

/* ========================== the inactivity witness ========================== */

/**
 * COVERED OPERATIONS. A focused witness, not an exhaustive OS monitor.
 *
 *   node:child_process  spawn, spawnSync, exec, execSync, execFile,
 *                       execFileSync, fork
 *   node:fs             writeFileSync, appendFileSync, mkdirSync, rmSync,
 *                       rmdirSync, unlinkSync, renameSync, copyFileSync, and
 *                       openSync when a write-capable flag is used
 *   node:fs/promises    writeFile, appendFile, mkdir, rm, unlink, rename,
 *                       copyFile (and the same methods on fs.promises)
 *
 * NOT covered, and therefore NOT claimed: native addons, worker threads,
 * process.binding, descriptors opened before the patch, and any API not listed
 * above. For those, the evidence is source reading, which is reasoning, not
 * runtime observation. This witness does not conflate the two.
 *
 * Two properties make the central negative claim meaningful rather than
 * vacuous. First, recording is ACTIVE BEFORE the builder is imported and every
 * event is retained with the phase it occurred in -- nothing is discarded.
 * Second, both observers are PROVEN IN THE SAME RUN by same-route controls: a
 * module that writes while being imported, and a module whose `node:fs` named
 * ESM binding was established BEFORE the patch, exactly as the installed tsx
 * loader's own binding is. So an empty import phase means "nothing seen by an
 * observer demonstrated to see" rather than "nothing recorded".
 */

type WitnessEvent = { phase: string; kind: string; name: string; detail: string
  args?: string[]; blocked?: boolean }
type WitnessReport = { error: string | null; events: WitnessEvent[]; sync: boolean
  harnessPrefix: string; cacheDisabled: boolean
  blockedMessage: string | null; sentinelExists: boolean | null
  controlIsExecutable: boolean | null; delegated: number | null; delegatedNonGit: number | null
  attemptedDelegation: number | null
  attemptedDetail: Array<{ phase: string; name: string; file: string }> | null
  inheritedKeys: string[]; exec: unknown; keys: number | null
  preview: string[] | null }

const RUNNER = `
import { createRequire } from 'node:module'
const require = createRequire(process.argv[1])
const { syncBuiltinESMExports } = require('node:module')
const fs = require('node:fs')
const cp = require('node:child_process')
const nodePath = require('node:path')

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const SYNC = !process.argv.includes('--no-sync')
const GIT = '/usr/bin/git'
// The loader's own transpile-cache root, as THIS child sees it. Reported so the
// parent attributes harness writes using the child's value, never a guess.
const harnessPrefix = nodePath.join(fs.realpathSync(require('node:os').tmpdir()), 'tsx-')

// Originals captured BEFORE any patch, so the report write and the capability
// stat are never confused with observed activity.
const origWrite = fs.writeFileSync
const origExists = fs.existsSync
const origStat = fs.statSync

// Establish a node:fs NAMED ESM binding before patching, the same way the
// installed tsx loader does. This is the hard case the witness must cover.
const probe = await import(input.probeUrl)

let phase = 'preload'
const events = []
// Every call that actually REACHES the native function is recorded here.
const delegated = []
// Every call that reaches the INERT delegate below is recorded here. While the
// refusal stands this array must stay empty, because the guard throws first.
// The deliberate guard-bypass control removes that throw, and the attempt then
// lands here -- recorded, and with no process started.
const attempted = []
const note = (kind, name, detail) => { events.push({ phase, kind, name, detail }) }

// The ONE place the native subprocess function is ever invoked, and the only
// thing beneath the refusal above. It re-checks the target, so a non-Git
// command cannot reach the native function even when the guard is removed: it
// gets an INERT result instead, and the attempt is recorded AT THIS ENTRY,
// before anything else happens. Permitted read-only Git still runs for real,
// which is what keeps the builder's Git observation meaningful.
function inertResult() {
  const empty = Buffer.alloc(0)
  return { pid: -1, status: null, signal: null, stdout: empty, stderr: empty,
    output: [null, empty, empty],
    error: new Error('inert delegate: no process was started') }
}
function delegate(name, target, real, self, args) {
  if (target !== GIT) {
    attempted.push({ phase: phase, name: name, file: target })
    return inertResult()
  }
  delegated.push({ phase: phase, name: name, file: target })
  return real.apply(self, args)
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[name]
  if (typeof real !== 'function') continue
  cp[name] = function (file, ...rest) {
    const target = String(file)
    const entry = { phase: phase, kind: 'spawn', name: name, detail: target,
      args: Array.isArray(rest[0]) ? rest[0].map(String) : [], blocked: false }
    events.push(entry)
    if (target !== GIT) {
      // RECORDED AND BLOCKED BEFORE DELEGATION: a launch regression cannot run
      // the forbidden command first and be noticed afterwards.
      entry.blocked = true
      throw new Error('BLOCKED non-Git launch: ' + name + ' ' + target)
    }
    return delegate(name, target, real, this, [file, ...rest])
  }
}

for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync',
  'unlinkSync', 'renameSync', 'copyFileSync']) {
  const real = fs[name]
  if (typeof real !== 'function') continue
  fs[name] = function (target, ...rest) {
    note('write', name, String(target))
    return real.call(this, target, ...rest)
  }
}

const realOpen = fs.openSync
const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_APPEND | fs.constants.O_TRUNC
fs.openSync = function (target, flags, ...rest) {
  const writable = typeof flags === 'number'
    ? (flags & WRITE_BITS) !== 0
    : typeof flags === 'string' && flags !== 'r' && flags !== 'rs'
  if (writable) note('write', 'openSync', String(target) + ' [' + String(flags) + ']')
  return realOpen.call(this, target, flags, ...rest)
}

const patched = new Set()
for (const holder of [fs.promises, require('node:fs/promises')]) {
  if (!holder || patched.has(holder)) continue
  patched.add(holder)
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) {
    const real = holder[name]
    if (typeof real !== 'function') continue
    holder[name] = function (target, ...rest) {
      note('write', 'promises.' + name, String(target))
      return real.call(this, target, ...rest)
    }
  }
}

// Push the patched CommonJS exports into the builtins' named ESM bindings.
// Without this, a module that already imported node:fs keeps the original
// function and the observer silently sees nothing. The --no-sync run is the
// deliberate control for exactly that.
if (SYNC) syncBuiltinESMExports()

const out = { error: null, events: events, sync: SYNC, harnessPrefix: harnessPrefix,
  cacheDisabled: process.env.TSX_DISABLE_CACHE === '1', blockedMessage: null,
  sentinelExists: null, controlIsExecutable: null, delegated: null, delegatedNonGit: null,
  attemptedDelegation: null, attemptedDetail: null,
  inheritedKeys: Object.keys(process.env).sort(), exec: null, keys: null, preview: null }
try {
  phase = 'control-binding'
  probe.write(nodePath.join(input.dir, 'binding-control.txt'), 'control')

  phase = 'control-import'
  await import(input.sideEffectUrl)

  phase = 'import'
  const mod = await import(input.planUrl)

  phase = 'build'
  const plan = mod.buildHaw70UpgradeLaunchPlan({ environment: input.environment })
  out.exec = plan.executionAllowed
  out.keys = plan.childEnvironmentKeys.length
  out.preview = plan.argumentPreview.slice(1)

  phase = 'control-launch'
  // The command is REAL and capable -- it exists and is executable, checked by
  // stat, not by running it -- and would create its sentinel if it ever ran.
  // It is deliberately NEVER launched, here or anywhere: the task forbids
  // launching the control command, so capability is established without
  // execution and the refusal is proven structurally by the delegation log.
  try {
    const mode = origStat('/bin/sh').mode
    out.controlIsExecutable = (mode & 0o111) !== 0
  } catch (error) { out.controlIsExecutable = false }
  try {
    cp.spawnSync('/bin/sh', ['-c', 'printf x > "' + input.sentinel + '"'])
    out.blockedMessage = 'NOT BLOCKED'
  } catch (error) {
    out.blockedMessage = String(error && error.message ? error.message : error)
  }
  out.sentinelExists = origExists(input.sentinel)
} catch (error) {
  out.error = String(error && error.message ? error.message : error)
} finally {
  phase = 'done'
  out.delegated = delegated.length
  out.delegatedNonGit = delegated.filter(entry => entry.file !== GIT).length
  out.attemptedDelegation = attempted.length
  out.attemptedDetail = attempted
  origWrite(input.reportPath, JSON.stringify(out, null, 1))
}
`

const PROBE = `
import { writeFileSync } from 'node:fs'
// The named binding is established when THIS module is imported, which the
// runner does before patching anything.
export function write(target, body) { writeFileSync(target, body) }
`

const SIDE_EFFECT = `
import { writeFileSync } from 'node:fs'
// A write performed WHILE THIS MODULE IS BEING IMPORTED. If the import-phase
// observer were disabled, this would go unrecorded and the builder's own
// import-phase claim would be worthless.
writeFileSync(new URL('./import-side-effect.txt', import.meta.url), 'written during evaluation')
`

/**
 * The TEST HARNESS itself writes while importing a TypeScript module: the tsx
 * loader caches its transpile output under `${os.tmpdir()}/tsx-<uid>`. The
 * first corrected run surfaced exactly that, which the earlier vacuous witness
 * could never have shown. Those writes are the HARNESS, not the subject, so
 * they are never silently discarded: every event is reported raw and then
 * attributed, and the subject's budget is zero.
 */
/**
 * Attribution is deliberately narrow: a write counts as the loader's only if it
 * is INSIDE the cache's own `tsx-<uid>/` directory. A subject write merely
 * named like the cache root -- `.../tsx-sneaky.txt` -- is still the subject.
 * The two assertions that carry the negative claim are unattributed anyway, so
 * attribution can only ever relax the corroborating test, never the claim.
 */
const attribute = (report: WitnessReport, event: WitnessEvent) => {
  if (event.kind !== 'write') return 'subject'
  const inCacheDirectory = new RegExp(
    `^${report.harnessPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+(/|$)`)
  return inCacheDirectory.test(event.detail) ? 'harness-loader' : 'subject'
}

function runWitness(label: string, options: { noSync?: boolean; cacheOff?: boolean } = {}): WitnessReport {
  const dir = realpathSync(mkdtempSync(join(scratch, `witness-${label}-`)))
  writeFileSync(join(dir, 'runner.mjs'), RUNNER)
  writeFileSync(join(dir, 'probe.mjs'), PROBE)
  writeFileSync(join(dir, 'side-effect.mjs'), SIDE_EFFECT)
  const reportPath = join(dir, 'report.json')
  const inputPath = join(dir, 'input.json')
  writeFileSync(inputPath, JSON.stringify({
    dir, reportPath,
    environment: snapshot(),
    planUrl: `file://${join(import.meta.dirname, 'haw70-upgrade-launch-plan.js')}`,
    probeUrl: `file://${join(dir, 'probe.mjs')}`,
    sideEffectUrl: `file://${join(dir, 'side-effect.mjs')}`,
    sentinel: join(dir, 'blocked-launch.txt'),
  }))
  const argv = ['--import', 'tsx', join(dir, 'runner.mjs'), inputPath]
  if (options.noSync) argv.push('--no-sync')
  // A PRIVATE, EMPTY temporary root per child. The loader's cache is therefore
  // always cold, so a cache-enabled run must genuinely write rather than hit a
  // cache warmed by an earlier run in this suite.
  const childTmp = join(dir, 'tmp')
  mkdirSync(childTmp, { recursive: true })
  // A SANITIZED environment, built from an allowlist rather than inherited.
  // An ambient NODE_OPTIONS would otherwise preload arbitrary code into the
  // observer itself and could also change how the loader registers its hooks.
  const environment: Record<string, string> = {
    PATH: '/usr/bin:/bin', HOME: childTmp, TMPDIR: childTmp,
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
  }
  if (options.cacheOff) environment.TSX_DISABLE_CACHE = '1'
  const result = spawnSync(process.execPath, argv,
    { encoding: 'utf8', timeout: 240_000, cwd: backend, env: environment })
  assert.equal(result.signal, null, `the child must exit on its own: ${result.stderr}`)
  assert.ok(existsSync(reportPath), `no report from the ${label} child: ${result.stderr}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as WitnessReport
  keep(`witness-${label}.json`, report)
  return report
}

const inPhase = (report: WitnessReport, phase: string) =>
  report.events.filter(event => event.phase === phase)

/**
 * ONE cache-disabled witness child, shared by the tests that read it. Each
 * child performs the full pinned validation -- about 324 read-only Git
 * subprocesses -- so running an identical second child bought no extra
 * evidence and measurably increased load; a duplicate run is what failed under
 * contention while the others passed. The launch control and the import
 * observation happen in the same child, so one report answers both.
 */
let sharedSyncedReport: WitnessReport | undefined
const syncedWitness = () => (sharedSyncedReport ??= runWitness('synced', { cacheOff: true }))

/**
 * Where to keep the raw witness reports for review. Default: the suite's own
 * disposable scratch, removed on exit. An operator may point this at a durable
 * directory to capture the evidence; it changes nothing that is asserted, and
 * the suite writes only where it is pointed.
 */
const requestedEvidenceDir = process.env.HAW70_WITNESS_EVIDENCE_DIR
const WITNESS_EVIDENCE_DIR = requestedEvidenceDir
  && existsSync(requestedEvidenceDir) && statSync(requestedEvidenceDir).isDirectory()
  ? realpathSync(requestedEvidenceDir)
  : scratch
const keep = (name: string, body: unknown) =>
  writeFileSync(join(WITNESS_EVIDENCE_DIR, name), JSON.stringify(body, null, 1))

test('the witness observers are proven, then the builder is observed doing nothing on import', () => {
  const report = syncedWitness()
  assert.equal(report.error, null, String(report.error))
  assert.equal(report.sync, true)

  // ---- the observers, proven in this same run -------------------------------
  // (a) a module that writes WHILE BEING IMPORTED is recorded, with the
  //     import-time phase label. So the import phase is genuinely watched.
  const importControl = inPhase(report, 'control-import')
  assert.ok(importControl.length >= 1,
    'an import-time write must be observed, or an empty import phase proves nothing')
  assert.ok(importControl.some(event => /import-side-effect\.txt$/.test(event.detail)))
  // (b) a node:fs NAMED ESM binding established BEFORE the patch is observed,
  //     which is the case the installed tsx loader creates for itself.
  const bindingControl = inPhase(report, 'control-binding')
  assert.ok(bindingControl.length >= 1,
    'a pre-existing named ESM binding must be observed after syncBuiltinESMExports')
  assert.ok(bindingControl.some(event => event.name === 'writeFileSync'
    && /binding-control\.txt$/.test(event.detail)))

  // ---- the claim: importing the builder does no observed work ---------------
  // With the loader's transpile cache disabled, the import phase is empty
  // outright. Nothing is filtered to get there.
  const importPhase = inPhase(report, 'import')
  assert.deepEqual(importPhase.filter(event => attribute(report, event) === 'subject'), [],
    'importing the builder must perform none of the covered operations')
  assert.deepEqual(importPhase, [],
    'with the loader cache disabled the import phase is empty outright')

  // ---- the build: read-only Git only, and no writes at all ------------------
  const build = inPhase(report, 'build')
  const spawns = build.filter(event => event.kind === 'spawn')
  assert.ok(spawns.length > 0, 'the pinned validation must be observed using read-only Git')
  for (const call of spawns) {
    assert.equal(call.detail, '/usr/bin/git', 'every observed launch must be Git')
    assert.equal(call.blocked, false)
    // The adapter's argument layout is fixed, so the subcommand is read BY
    // POSITION rather than by guessing which token looks like one: six global
    // arguments, then `-C <root>`, then the subcommand.
    const args = call.args ?? []
    assert.equal(args[0], '--no-pager')
    assert.equal(args[8], '-C', `unexpected Git argument layout: ${args.join(' ')}`)
    const subcommand = args[10] ?? ''
    assert.ok(['rev-parse', 'cat-file', 'ls-tree', 'for-each-ref', 'config'].includes(subcommand),
      `unexpected Git subcommand: ${subcommand}`)
    // `config` is the one allowed subcommand that CAN write, so its read-only
    // form is pinned exactly rather than admitted by name.
    if (subcommand === 'config') {
      assert.deepEqual(args.slice(10), ['config', '--local', '--name-only', '--get-regexp',
        '^(extensions.partialclone|remote..*.promisor)$'],
      `a config call must be the pinned read-only query: ${args.slice(10).join(' ')}`)
    }
  }
  assert.deepEqual(build.filter(event => event.kind === 'write'), [],
    'planning must perform none of the covered write operations')

  // ---- a TOTAL audit, not merely a per-phase one ----------------------------
  // Across EVERY phase, the only writes attributable to anything other than the
  // two deliberate controls must be none. A builder that deferred a write into
  // a later phase would be caught here even though the phase-scoped assertions
  // above would not see it.
  const deliberate = /\/(binding-control|import-side-effect)\.txt$/
  const unexplained = report.events.filter(event => event.kind === 'write'
    && attribute(report, event) === 'subject' && !deliberate.test(event.detail))
  assert.deepEqual(unexplained, [],
    'no write outside the two deliberate controls may occur in any phase')
  assert.equal(report.events.filter(event => event.kind === 'write'
    && deliberate.test(event.detail)).length, 2, 'exactly the two control writes')

  // ---- the plan itself is still the inert, frozen description ---------------
  assert.equal(report.exec, false)
  assert.equal(report.keys, 33)
  assert.deepEqual(report.preview, ['migrate', 'deploy', '--config', CONFIG_PATH])
})

test('the import-phase observer sees real import-time writes on the actual loader route', () => {
  // The STRONGEST same-route control available: with the tsx transpile cache
  // ENABLED, importing the TypeScript builder makes the loader itself write,
  // through `fs.promises`, during the import phase. Observing those writes
  // proves the import-phase observer is live on the real route rather than
  // only on a synthetic module. They are the harness's writes, so they are
  // attributed and reported, never counted against the subject.
  const report = runWitness('cache-on', { cacheOff: false })
  assert.equal(report.error, null, String(report.error))

  const importPhase = inPhase(report, 'import')
  const harness = importPhase.filter(event => attribute(report, event) === 'harness-loader')
  const subject = importPhase.filter(event => attribute(report, event) === 'subject')

  // THE PORTABLE ASSERTION: enabling the loader's cache must not make the
  // SUBJECT write. This holds on every Node version.
  assert.deepEqual(subject, [], 'none of the import-phase writes belong to the builder')

  // THE CORROBORATION, which is environment-dependent and therefore NOT
  // required. Whether an in-process fs patch can see the loader's own cache
  // writes depends on how this Node version runs loader hooks: with
  // `module.register` they execute on a separate loader thread, where this
  // observer does not exist. So the import-phase observer's PROOF is the
  // in-thread synthetic control in the previous test, which always applies;
  // observing the real loader route is additional evidence when available, and
  // its absence is reported rather than asserted away.
  if (harness.length === 0) {
    keep('import-route-observation.json', { observed: false, nodeVersion: process.version,
      note: 'loader hooks ran where this in-process observer cannot see them; '
        + 'the in-thread control in the preceding test carries the proof' })
  } else {
    assert.ok(harness.some(event => /^promises\./.test(event.name)),
      'when the loader route IS visible it writes through fs.promises')
    keep('import-route-observation.json', { observed: true, nodeVersion: process.version,
      writes: harness.length })
  }
  for (const event of harness) assert.ok(event.detail.startsWith(report.harnessPrefix), event.detail)
  assert.equal(report.cacheDisabled, false, 'this control requires the loader cache enabled')
  // Record what the harness did, so the attribution is auditable rather than
  // an invisible filter.
  keep('harness-loader-writes.json', harness)
})

test('a non-Git launch is recorded and blocked before delegation, and the command was capable', () => {
  // The same child as the import observation above: its launch control runs
  // after its build, so one report carries both.
  const report = syncedWitness()
  assert.equal(report.error, null, String(report.error))

  // The attempt is a harmless synthetic command, never the Prisma CLI.
  const attempts = inPhase(report, 'control-launch').filter(event => event.kind === 'spawn')
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].detail, '/bin/sh')
  assert.equal(attempts[0].blocked, true, 'the attempt must be refused, not merely noticed')
  assert.match(String(report.blockedMessage), /BLOCKED non-Git launch: spawnSync \/bin\/sh/)

  // It did not run: its sentinel does not exist.
  assert.equal(report.sentinelExists, false, 'a blocked launch must not have had an effect')
  // And the command was genuinely capable: `/bin/sh` exists with executable
  // bits, established by stat. It is never launched -- not even once to show it
  // could be -- because launching the control command is out of bounds for this
  // task. The refusal is instead proven STRUCTURALLY below.
  assert.equal(report.controlIsExecutable, true,
    'the refused command must be a real executable, or its failure proves nothing')

  // ---- inertness, which must hold in the MUTATED control run too -----------
  // These two are asserted first and deliberately: they are the properties the
  // guard-bypass control must NOT break. Its own saved report is expected to
  // show the same two values, which is how that control proves it started no
  // process rather than merely failing somewhere.
  assert.equal(report.delegatedNonGit, 0,
    'no non-Git command may ever reach the native subprocess function')
  assert.equal(report.sentinelExists, false,
    'no control process may ever create its sentinel')

  // ---- the refusal itself, which the guard-bypass control must break -------
  // `delegated` records every call that reached the native function, and
  // `attemptedDelegation` records every call that reached the inert delegate
  // beneath the refusal. While the refusal stands the latter must be zero,
  // because the guard throws before the delegate is reached.
  assert.ok((report.delegated ?? 0) > 0, 'real Git work must have been delegated')
  assert.equal(report.attemptedDelegation, 0,
    'the inert delegate must be unreachable while the refusal stands')
  assert.deepEqual(report.attemptedDetail, [])

  // No forbidden launch was RECORDED in any other phase either. Stated as a
  // recorded-event claim, which is weaker than the delegation proof above and
  // is why both are asserted.
  const escapedRecords = report.events.filter(event => event.kind === 'spawn'
    && event.detail !== '/usr/bin/git' && event.phase !== 'control-launch')
  assert.deepEqual(escapedRecords, [])
})

test('without syncBuiltinESMExports the filesystem observer is blind — the control that proves it', () => {
  // A DELIBERATE EXPECTED FAILURE, kept as a control. The patched CommonJS
  // export object does not retroactively change a named ESM binding that was
  // already established, so without the sync the pre-existing-binding write is
  // invisible. This is why the synced run's empty import phase is evidence and
  // the earlier witness's was not.
  const report = runWitness('unsynced', { noSync: true, cacheOff: true })
  assert.equal(report.error, null, String(report.error))
  assert.equal(report.sync, false)
  assert.deepEqual(inPhase(report, 'control-binding'), [],
    'the pre-existing named binding is NOT observed without the sync')
  // The subprocess observer is unaffected, which is why the original witness's
  // Git observation was real while its write observation was unproven.
  assert.ok(inPhase(report, 'build').some(event => event.kind === 'spawn'),
    'the subprocess route does not depend on the sync')
})
