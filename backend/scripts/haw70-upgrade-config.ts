import { fileURLToPath } from 'node:url'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { validateHaw70UpgradeStagedSource } from './haw70-upgrade-materializer.mjs'
import { inspectHaw70UpgradeTarget } from './haw70-upgrade-target.js'

/**
 * HAW-70 dedicated staged-migration configuration assembly.
 *
 * UNUSED BY DESIGN. No application module, runner or workflow imports this.
 * Assembly is VALIDATION ONLY: it creates no directory, materializes nothing,
 * cleans nothing up, opens no database client, socket or migration CLI, starts
 * no application and writes no file. It returns absolute paths and one exact
 * target URL, and only after every check below has already passed.
 *
 * WHY A DEDICATED CONFIG. `backend/prisma.config.ts` imports dotenv, selects
 * the complete candidate migration directory and declares a seed hook, so it
 * can neither select a stage nor be trusted to route a staged upgrade. This
 * module replaces none of that: the ordinary config is left exactly as it is
 * and is NEVER evaluated or imported as application configuration. Its raw
 * bytes ARE read and hashed, deliberately, as one of the pinned compatibility
 * inputs of the source validation below. Required read, forbidden evaluation.
 *
 * SOURCE AUTHORITY. A caller may identify only a staged root, the exact
 * candidate commit and which stage it wants, through one narrow environment
 * namespace. It may not supply schema or migration paths, a baseline ref, a
 * target URL, an executable, a manifest, a digest or a validation receipt.
 * Repository and config paths come from this committed module's own location;
 * stage paths come from pinned source that is reacquired and revalidated here,
 * never from the receipt on disk.
 *
 * WHAT THIS IS NOT. A passing assembly is not hosting, not an empty database,
 * not a completed stage and not permission to execute anything. The target
 * guard checks environment CLAIMS and a routing blocklist; it is not the
 * complete allowlist, and the ordered baseline-install / fixture /
 * candidate-upgrade / verification state machine belongs to a future runner
 * that does not exist yet.
 */

type Environment = Readonly<Record<string, string | undefined>>
export type Haw70UpgradeStage = 'baseline' | 'candidate'

/** The entire permitted caller surface. Nothing else is read from it. */
const HANDOFF_PREFIX = 'HAWKVIEW_HAW70_STAGE_'
const HANDOFF_ROOT = `${HANDOFF_PREFIX}ROOT`
const HANDOFF_NAME = `${HANDOFF_PREFIX}NAME`
const HANDOFF_CANDIDATE = `${HANDOFF_PREFIX}CANDIDATE`
const HANDOFF_KEYS = Object.freeze([HANDOFF_CANDIDATE, HANDOFF_NAME, HANDOFF_ROOT])
const STAGES = Object.freeze(['baseline', 'candidate'])
/**
 * The installed Prisma config loader passes `moduleCache: false` to Jiti but no
 * `fsCache` override, and Jiti's documented default is filesystem caching into
 * `node_modules/.cache/jiti` or a temporary directory.
 *
 * The flag must therefore ALREADY be in the environment before the invoking
 * process starts loading, because Jiti is constructed first. The check below
 * is NOT a safeguard against cache writes: by the time this module evaluates,
 * any write the loader was going to make has already happened. It only refuses
 * to ASSEMBLE for an invoker that did not apply the setting, so a forgetful
 * invoker gets no configuration rather than a silently cached one. Preventing
 * the write itself is the invoker's responsibility, not this module's.
 *
 * Note also that this is a boolean switch: the installed Jiti parses
 * `JITI_FS_CACHE` as JSON through a boolean coercion, so a directory value is
 * not a destination. A custom destination exists only as the programmatic
 * `fsCache` option.
 */
const LOADER_FS_CACHE = 'JITI_FS_CACHE'
const failure = 'HAW-70 staged configuration is not qualified'

function requireMatch(condition: boolean): void {
  if (!condition) throw new Error(failure)
}

/** This committed module's own location is the only path authority. */
const moduleDirectory = () => dirname(fileURLToPath(import.meta.url))
export const haw70ConfigRepositoryRoot = (): string => {
  const root = realpathSync(resolve(moduleDirectory(), '..', '..'))
  requireMatch(isAbsolute(root) && lstatSync(root).isDirectory())
  return root
}

/**
 * Exactly three namespaced fields, and nothing else in that namespace. An
 * unknown, extra, malformed or empty field is refused rather than ignored.
 */
export function readHaw70StageHandoff(environment: Environment): {
  outputRoot: string; stage: Haw70UpgradeStage; candidateCommit: string
} {
  // Wrapped so a filesystem error, a parser message or a caller value can
  // never escape as a diagnostic, exactly as the target guard does.
  try { return readStageHandoffUnguarded(environment) } catch { throw new Error(failure) }
}

function readStageHandoffUnguarded(environment: Environment): {
  outputRoot: string; stage: Haw70UpgradeStage; candidateCommit: string
} {
  requireMatch(Boolean(environment) && typeof environment === 'object' && !Array.isArray(environment))
  const present = Object.keys(environment)
    .filter(key => key.startsWith(HANDOFF_PREFIX) && environment[key] !== undefined).sort()
  requireMatch(present.join(',') === HANDOFF_KEYS.join(','))

  const outputRoot = environment[HANDOFF_ROOT]!
  const stage = environment[HANDOFF_NAME]!
  const candidateCommit = environment[HANDOFF_CANDIDATE]!
  requireMatch(/^[0-9a-f]{40}$/.test(candidateCommit))
  requireMatch(STAGES.includes(stage))
  // A canonical, existing, real directory. No traversal component survives
  // `resolve`/`realpathSync` equality, and a symlinked root is refused.
  requireMatch(typeof outputRoot === 'string' && isAbsolute(outputRoot)
    && resolve(outputRoot) === outputRoot && !outputRoot.endsWith('/'))
  requireMatch(realpathSync(outputRoot) === outputRoot && lstatSync(outputRoot).isDirectory())
  return { outputRoot, stage: stage as Haw70UpgradeStage, candidateCommit }
}

/**
 * One immutable snapshot, taken by the caller and never re-read here. Every
 * check below and the returned URL come from this same snapshot, so a mutation
 * of ambient environment after validation cannot change what was approved.
 */
export function assembleHaw70UpgradeStageConfig(input: { environment: Environment }): Readonly<{
  kind: 'haw70-upgrade-stage-config-v1'
  executionAllowed: false
  stage: Haw70UpgradeStage
  candidateCommit: string
  schemaPath: string
  migrationsPath: string
  datasourceUrl: string
}> {
  // One generic refusal. A validator message, filesystem error or supplied
  // value must never reach a caller or a log through this boundary.
  try { return assembleUnguarded(input) } catch { throw new Error(failure) }
}

function assembleUnguarded(input: { environment: Environment }) {
  requireMatch(Boolean(input) && typeof input === 'object' && !Array.isArray(input))
  requireMatch(Object.keys(input).join(',') === 'environment')
  const snapshot: Environment = Object.freeze({ ...input.environment })

  const handoff = readHaw70StageHandoff(snapshot)
  // Refuse to assemble unless the invoker had already disabled the loader's
  // filesystem cache before loading began. This cannot undo a write that the
  // loader may already have made; see LOADER_FS_CACHE above.
  requireMatch(snapshot[LOADER_FS_CACHE] === 'false')

  // Environment claims and routing blocklist, against the exact identity the
  // handoff names. Credential-free metadata by design; the URL below is taken
  // from the snapshot this call already validated, never rebuilt from it.
  const target = inspectHaw70UpgradeTarget({
    environment: snapshot, expectedCandidateCommit: handoff.candidateCommit,
  })
  requireMatch(target.executionAllowed === false)
  requireMatch(target.candidateCommit === handoff.candidateCommit)

  // Pinned source is reacquired and BOTH staged trees are revalidated here.
  // The receipt on disk is compared against an independently reconstructed
  // expectation inside this call; it is never the authority.
  const validated = validateHaw70UpgradeStagedSource({
    repositoryRoot: haw70ConfigRepositoryRoot(),
    expectedCandidateCommit: handoff.candidateCommit,
    outputRoot: handoff.outputRoot,
  }) as {
    executionAllowed: boolean
    receipt: { candidateCommit: string; stages: Record<string, { schema: string; migrationLock: string }> }
  }
  requireMatch(validated.executionAllowed === false)
  requireMatch(validated.receipt.candidateCommit === handoff.candidateCommit)

  const stage = validated.receipt.stages[handoff.stage]
  requireMatch(Boolean(stage) && typeof stage.schema === 'string' && typeof stage.migrationLock === 'string')
  // Both staged trees were validated above; only the selected one is returned.
  for (const name of STAGES) requireMatch(Boolean(validated.receipt.stages[name]))

  const schemaPath = join(handoff.outputRoot, stage.schema)
  const migrationsPath = dirname(join(handoff.outputRoot, stage.migrationLock))
  requireMatch(lstatSync(schemaPath).isFile() && lstatSync(migrationsPath).isDirectory())
  requireMatch(schemaPath.startsWith(`${handoff.outputRoot}/`)
    && migrationsPath.startsWith(`${handoff.outputRoot}/`))

  const datasourceUrl = snapshot.DATABASE_URL
  requireMatch(typeof datasourceUrl === 'string' && datasourceUrl.length > 0)

  return Object.freeze({
    kind: 'haw70-upgrade-stage-config-v1' as const,
    executionAllowed: false as const,
    stage: handoff.stage,
    candidateCommit: handoff.candidateCommit,
    schemaPath,
    migrationsPath,
    datasourceUrl: datasourceUrl!,
  })
}
