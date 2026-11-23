import { createRequire } from 'node:module'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { inspectSelectedNamespaceAgainstBaseline } from './haw70-upgrade-git-source.mjs'
import pins from './haw70-upgrade-source-manifest.json' with { type: 'json' }
import { assembleHaw70UpgradeStageConfig, haw70ConfigRepositoryRoot } from './haw70-upgrade-config.js'
import { inspectHaw70UpgradeTarget } from './haw70-upgrade-target.js'

/**
 * HAW-70 launch plan: UNUSED, NONEXECUTING and descriptive.
 *
 * It describes what a future, separately reviewed runner WOULD be given. It is
 * not that runner, and nothing here is a decision to run anything. No
 * application module, workflow or runtime imports it, and importing it does no
 * work.
 *
 * WHAT IT NEVER DOES. It does not load, import, spawn or version-probe the
 * Prisma CLI; create, materialize, clean or delete a staged root; create a
 * database client; connect to anything; generate, seed, migrate or build;
 * fetch, read or write a Git ref; or touch a workflow. Sanitized READ-ONLY Git
 * inspection, which the pinned source validation already performs, is the only
 * process work involved.
 *
 * WHAT IT NEVER RETURNS. No runnable child environment, no raw datasource URL,
 * no arbitrary command string, and no approved-or-ready flag. The child
 * environment appears only as a sorted KEY INVENTORY, and the target only as
 * credential-free metadata. Every plan is deeply frozen with
 * `executionAllowed: false`, including when all of its data checks pass:
 * self-validation is not authorization.
 *
 * THREE IDENTITIES, KEPT SEPARATE.
 *  1. Historical source provenance -- the pinned baseline and reviewed
 *     candidate, never repinned to a new head.
 *  2. The reviewed-main compatibility anchor -- committed policy below, not a
 *     branch name and not a caller field, required as a RAW ancestor whose
 *     complete selected namespace equals the historical baseline selection.
 *  3. The actual candidate -- current exact HEAD and tree.
 *
 * A candidate-stage plan is NOT evidence that any earlier database stage ran.
 */

type Environment = Readonly<Record<string, string | undefined>>
export type Haw70LaunchStage = 'baseline' | 'candidate'

/**
 * COMMITTED POLICY, deliberately a constant and not an input: the exact
 * protected-main commit this design was reviewed against. A later main needs a
 * fresh review of this policy, not a silent repin.
 */
export const HAW70_REVIEWED_MAIN_ANCHOR = 'eaa92ebdd5f7893b50023d819a7c3ddde56a2955'

/** Fixed, derived, never supplied. */
const PRISMA_CLI_ENTRY = 'node_modules/prisma/build/index.js'
/** The package's own declared binary, relative to its package root. */
const PRISMA_DECLARED_BIN = 'build/index.js'
const DEDICATED_CONFIG = 'prisma/haw70-upgrade.config.ts'
const PRISMA_PACKAGE = 'node_modules/prisma/package.json'
const PRISMA_CONFIG_PACKAGE = 'node_modules/@prisma/config/package.json'
const EXPECTED_TOOL_VERSION = '7.9.1'

/** The closed 33-key projection. Nothing is inherited from ambient env. */
const FIXED_PROJECTION = Object.freeze({
  CI: 'true', GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  GITHUB_REPOSITORY: 'dharmik0431/hawkview-app', GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_WORKFLOW: 'Required quality gates', GITHUB_JOB: 'backend-quality',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
  HAWKVIEW_CI_MIGRATION_PROFILE: 'haw70-upgrade',
  HAWKVIEW_RUN_HAW70_UPGRADE: '1', HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1',
  HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1',
  HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
  HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
  JITI_FS_CACHE: 'false', TZ: 'UTC', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
})
/** Carried through only after the existing guard accepted them. */
const CARRIED_KEYS = Object.freeze(['GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
/** Derived from the validated identity and stage, never from a caller field. */
const DERIVED_KEYS = Object.freeze(['GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'DATABASE_URL',
  'HAWKVIEW_HAW70_STAGE_ROOT', 'HAWKVIEW_HAW70_STAGE_NAME', 'HAWKVIEW_HAW70_STAGE_CANDIDATE'])
export const HAW70_LAUNCH_ENVIRONMENT_KEYS = Object.freeze(
  [...Object.keys(FIXED_PROJECTION), ...CARRIED_KEYS, ...DERIVED_KEYS].sort())

/** Gates this slice deliberately leaves unmet. None is satisfied by a plan. */
const UNMET_GATES = Object.freeze([
  'hosted-provenance: no approved registered hosted job has run for this head',
  'hosted-toolchain: the quality workflow selects Node 22 on Linux; the recorded runtime is this\n    machine, which is not a hosted runner whatever its version reads',
  'whole-code-and-dependency-integrity: helper and installed dependency bytes are not qualified by selected migration pins',
  'current-main-freshness: the anchor is committed policy, not proof that protected main is unchanged now',
  'database-stage: no baseline install, legacy fixture or candidate upgrade has occurred, and no database history was checked',
])

const failure = 'HAW-70 launch plan is not qualified'
function requireMatch(condition: boolean): asserts condition {
  if (!condition) throw new Error(failure)
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function readVersion(backend: string, relative: string): string {
  const parsed = JSON.parse(readFileSync(join(backend, relative), 'utf8')) as
    { version?: unknown; bin?: unknown }
  requireMatch(typeof parsed.version === 'string' && parsed.version === EXPECTED_TOOL_VERSION)
  return parsed.version as string
}

/**
 * The single public entry point. Its ONLY input is one environment snapshot.
 * No executable, argument array, path, manifest, baseline, main anchor,
 * expected digest, validation receipt or override callback is accepted, and an
 * extra key of any kind fails closed by shape.
 */
export function buildHaw70UpgradeLaunchPlan(input: { environment: Environment }) {
  try { return buildUnguarded(input) } catch { throw new Error(failure) }
}

function buildUnguarded(input: { environment: Environment }) {
  requireMatch(Boolean(input) && typeof input === 'object' && !Array.isArray(input))
  requireMatch(Object.keys(input).join(',') === 'environment')
  // One immutable snapshot of primitive string values, captured once.
  const source = input.environment
  requireMatch(Boolean(source) && typeof source === 'object' && !Array.isArray(source))
  const snapshot: Environment = Object.freeze(Object.fromEntries(Object.entries(source)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      requireMatch(typeof value === 'string')
      return [key, value as string]
    })))

  // Real validation, reused rather than re-implemented: the existing target
  // guard, then the pinned stage assembly, which reacquires source and
  // revalidates BOTH staged trees and never trusts the receipt on disk.
  const assembled = assembleHaw70UpgradeStageConfig({ environment: snapshot })
  const target = inspectHaw70UpgradeTarget({
    environment: snapshot, expectedCandidateCommit: assembled.candidateCommit,
  })
  requireMatch(assembled.executionAllowed === false && target.executionAllowed === false)

  const repositoryRoot = haw70ConfigRepositoryRoot()
  const backend = join(repositoryRoot, 'backend')
  requireMatch(lstatSync(backend).isDirectory())

  // Identity 2: committed anchor, raw ancestry and the full selected-namespace
  // comparison against the historical baseline. No fetch, no ref read.
  const anchor = inspectSelectedNamespaceAgainstBaseline({
    repositoryRoot, expectedCandidateCommit: assembled.candidateCommit,
    anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR,
  }) as Readonly<{ anchorCommit: string; anchorTree: string; candidateTree?: string; selectedFiles: number
    rawAncestorOfCandidate: boolean; matchesHistoricalBaseline: boolean; differing: readonly string[] }>
  requireMatch(anchor.rawAncestorOfCandidate === true)
  requireMatch(anchor.matchesHistoricalBaseline === true && anchor.differing.length === 0)

  const candidateTree = anchor.candidateTree
  requireMatch(typeof candidateTree === 'string' && /^[0-9a-f]{40}$/.test(candidateTree))

  // Fixed paths, DERIVED. No PATH lookup, npx, download or caller override.
  const nodeExecutable = realpathSync(process.execPath)
  requireMatch(isAbsolute(nodeExecutable) && lstatSync(nodeExecutable).isFile())
  const prismaCliEntry = join(backend, PRISMA_CLI_ENTRY)
  const dedicatedConfig = join(backend, DEDICATED_CONFIG)
  for (const path of [prismaCliEntry, dedicatedConfig]) {
    requireMatch(resolve(path) === path && lstatSync(path).isFile())
  }
  // Metadata read from package manifests only; the CLI is never imported or run.
  const prismaVersion = readVersion(backend, PRISMA_PACKAGE)
  const prismaConfigVersion = readVersion(backend, PRISMA_CONFIG_PACKAGE)
  // `bin` may be a string or a map; both shapes are read, neither is executed.
  const declared = JSON.parse(readFileSync(join(backend, PRISMA_PACKAGE), 'utf8')).bin as unknown
  const declaredBinary = typeof declared === 'string' ? declared
    : (declared && typeof declared === 'object' ? (declared as Record<string, unknown>).prisma : undefined)
  requireMatch(declaredBinary === PRISMA_DECLARED_BIN)

  // The closed projection, constructed key by key. `process.env` is never
  // spread, so an unrelated parent variable cannot be inherited.
  const projected: Record<string, string> = { ...FIXED_PROJECTION }
  for (const key of CARRIED_KEYS) {
    const value = snapshot[key]
    requireMatch(typeof value === 'string' && value.length > 0)
    projected[key] = value
  }
  projected.GITHUB_SHA = assembled.candidateCommit
  projected.GITHUB_WORKFLOW_SHA = assembled.candidateCommit
  projected.HAWKVIEW_HAW70_STAGE_NAME = assembled.stage
  projected.HAWKVIEW_HAW70_STAGE_CANDIDATE = assembled.candidateCommit
  const stageRoot = snapshot.HAWKVIEW_HAW70_STAGE_ROOT
  requireMatch(typeof stageRoot === 'string' && stageRoot.length > 0)
  projected.HAWKVIEW_HAW70_STAGE_ROOT = stageRoot
  // Held internally only; the plan returns credential-free target metadata.
  projected.DATABASE_URL = assembled.datasourceUrl
  requireMatch(projected.JITI_FS_CACHE === 'false' && projected.TZ === 'UTC')
  requireMatch(snapshot.JITI_FS_CACHE === 'false' && snapshot.TZ === 'UTC')
  const projectedKeys = Object.keys(projected).sort()
  requireMatch(projectedKeys.length === 33)
  requireMatch(projectedKeys.join(',') === HAW70_LAUNCH_ENVIRONMENT_KEYS.join(','))

  // The one fixed argument preview. Descriptive; never executed here.
  const argumentPreview = Object.freeze([prismaCliEntry, 'migrate', 'deploy', '--config', dedicatedConfig])

  return freeze({
    kind: 'haw70-upgrade-launch-plan-v1' as const,
    executionAllowed: false as const,
    stage: assembled.stage,
    candidate: { commit: assembled.candidateCommit, tree: candidateTree },
    historicalPins: {
      baselineCommit: pins.baselineCommit, reviewedCandidateCommit: pins.reviewedCandidateCommit,
      baselineSelectedFiles: pins.baselineFiles.length, candidateSelectedFiles: pins.candidateFiles.length,
    },
    reviewedMainAnchor: {
      commit: anchor.anchorCommit, tree: anchor.anchorTree, rawAncestorOfCandidate: true,
      selectedFiles: anchor.selectedFiles, matchesHistoricalBaseline: true,
    },
    paths: {
      nodeExecutable, prismaCliEntry, dedicatedConfig,
      stageSchema: assembled.schemaPath, stageMigrations: assembled.migrationsPath,
    },
    installedTools: { prismaVersion, prismaConfigVersion, prismaDeclaredBinary: PRISMA_DECLARED_BIN },
    // ACTUAL runtime facts, deliberately separate from the hosted CLAIMS below.
    runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
    hostedClaims: {
      runnerEnvironment: FIXED_PROJECTION.RUNNER_ENVIRONMENT, runnerOs: FIXED_PROJECTION.RUNNER_OS,
      workflow: FIXED_PROJECTION.GITHUB_WORKFLOW, job: FIXED_PROJECTION.GITHUB_JOB,
      runId: target.runId, runAttempt: target.runAttempt,
      note: 'environment claims only; not physical-host, approval or database proof',
    },
    argumentPreview,
    childEnvironmentKeys: projectedKeys,
    target: { host: target.target.host, port: target.target.port,
      database: target.target.database, user: target.target.user },
    unmetGates: UNMET_GATES,
  })
}
