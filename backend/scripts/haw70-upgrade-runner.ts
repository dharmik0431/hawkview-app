import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assembleHaw70UpgradeStageConfig, haw70ConfigRepositoryRoot } from './haw70-upgrade-config.js'
import { inspectHaw70UpgradeTarget } from './haw70-upgrade-target.js'
import { HAW70_LAUNCH_ENVIRONMENT_KEYS, buildHaw70UpgradeLaunchPlan } from './haw70-upgrade-launch-plan.js'
import { materializeHaw70UpgradeSource, validateHaw70UpgradeStagedSource } from './haw70-upgrade-materializer.mjs'
import { inspectSelectedNamespaceAgainstBaseline } from './haw70-upgrade-git-source.mjs'
import {
  HAW70_WITNESS_QUERIES, Haw70WitnessMismatch, assertAuthorityBackfill,
  assertBaselineHistoryRetained, assertExactHistory, assertHistoryAdditions,
  assertCleanupPostconditions, assertLegacyTagsNull, assertNoOp, assertRowsUnchanged,
  assertUpgradedCatalog,
  buildHaw70LegacyFixture,
} from './haw70-upgrade-witness.js'
import type { Haw70AuthorityRow, Haw70FixtureIdentifiers, Haw70HistoryRow, Haw70SnapshotTagRow } from './haw70-upgrade-witness.js'

/**
 * HAW-70 STAGED UPGRADE DRIVER — real, and deliberately UNREGISTERED.
 *
 * This is not another descriptive planner. It performs the actual ordered
 * transition: empty target, baseline deployment, verified baseline history,
 * committed legacy fixture, candidate deployment, verified
 * history/backfill/preservation/catalog, a second deployment proving a no-op,
 * and cleanup of only its own fixture rows.
 *
 * WHAT IT IS NOT. No application module, workflow or package command imports
 * or calls it; importing it does nothing. It is intended ONLY for a future,
 * separately reviewed `workflow_dispatch` profile `haw70-upgrade` against the
 * existing guarded disposable PostgreSQL 16 loopback service. That profile is
 * NOT registered today. Environment strings are CLAIMS; they are not proof of
 * hosting and not owner authorization, and ordinary CI success does not
 * authorize a physical profile.
 *
 * CLEAN-PROCESS REQUIREMENT, for whoever registers this later. A late check
 * cannot undo a preload. `JITI_FS_CACHE=false` and the absence of
 * `NODE_OPTIONS`, `NODE_PATH`, `DOTENV_CONFIG_*` and proxy variables must hold
 * BEFORE this process starts, because by the time this module runs, any
 * `--require`/`--import` preload has already executed. The registered step
 * must therefore start a clean process with an allowlisted environment; this
 * driver verifies what it can observe and refuses otherwise, which is not the
 * same as having prevented a preload.
 *
 * SUCCESS MEANS exactly "staged migration qualification completed". It is never
 * production activation, nor writer, recovery or reader proof.
 */

/* ================================ boundary ================================ */

export type Haw70Stage = 'baseline' | 'candidate'

export interface Haw70DeployRequest {
  readonly stage: Haw70Stage
  readonly attempt: 1 | 2
  /** The driver-owned staged root. The adapter projects it into the child. */
  readonly stageRoot: string
  readonly candidateCommit: string
}

export interface Haw70DeployOutcome {
  readonly status: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly outputBytes: number
  /** The exact argv the adapter used, so a test can observe it. */
  readonly argv: readonly string[]
  /** The child's environment KEYS only. Values never leave the adapter. */
  readonly environmentKeys: readonly string[]
}

export interface Haw70Session {
  query(name: string, sql: string, parameters?: readonly unknown[]):
    Promise<readonly Record<string, unknown>[]>
  close(): Promise<void>
}

/**
 * The ONLY seam between the ordered stages and the outside world. The public
 * production entry constructs this itself and accepts no substitute, so a
 * production caller cannot inject a hook that fakes a crossed stage. Tests
 * drive the core with a fake boundary instead, which is a different code path.
 */
/** What the driver asks the boundary to qualify before it connects. */
export interface Haw70QualifyRequest {
  readonly stage: Haw70Stage
  readonly stageRoot: string
  readonly candidateCommit: string
}

export interface Haw70UpgradeBoundary {
  /**
   * READ-ONLY installed-tool qualification, run after the driver owns and
   * validates its stage and BEFORE `connect`.
   *
   * It used to happen only inside `deploy`, which did block a bad CLI from
   * launching -- but by then the adapter had already constructed a client,
   * connected, and queried the target. A wrong or missing Prisma version is
   * now discovered before any physical connection.
   */
  qualify(request: Haw70QualifyRequest): Promise<void>
  deploy(request: Haw70DeployRequest): Promise<Haw70DeployOutcome>
  connect(): Promise<Haw70Session>
}

export type Haw70Phase =
  | 'validate-context' | 'validate-source' | 'materialize' | 'qualify-tools'
  | 'connect' | 'target-empty' | 'baseline-deploy' | 'baseline-history' | 'legacy-fixture'
  | 'candidate-deploy' | 'candidate-history' | 'preservation' | 'backfill'
  | 'catalog' | 'no-op-deploy' | 'no-op-verify' | 'cleanup' | 'completed'

export interface Haw70UpgradeOutcome {
  readonly kind: 'haw70-staged-upgrade-outcome-v1'
  readonly completed: boolean
  readonly phase: Haw70Phase
  /** A fixed safe label. Never a credential, URL, row value or raw error. */
  readonly failure: string | null
  readonly candidateCommit: string | null
  readonly counts: {
    readonly baselineMigrations: number
    readonly candidateMigrations: number
    readonly additions: number
    readonly fixtureTenants: number
    readonly fixtureSnapshots: number
    readonly authorityRows: number
    readonly deployments: number
  }
  /** Protocol rows deliberately left behind, named for the reviewer. */
  readonly retained: readonly string[]
}

const PHASES: readonly Haw70Phase[] = Object.freeze([
  'validate-context', 'validate-source', 'materialize', 'qualify-tools', 'connect',
  'target-empty', 'baseline-deploy', 'baseline-history', 'legacy-fixture', 'candidate-deploy',
  'candidate-history', 'preservation', 'backfill', 'catalog', 'no-op-deploy',
  'no-op-verify', 'cleanup', 'completed',
])

/**
 * Ordered phase list, exported so a test can pin the order rather than infer it.
 * It MUST match the order `executeHaw70UpgradeStages` assigns `phase`, because
 * a reader resolves a returned `phase` against this list to decide which
 * stages already succeeded. It previously listed `connect` and `target-empty`
 * BEFORE `materialize`, while the body materializes first, so a returned
 * `phase: 'materialize'` read as "connected, target proved empty" when neither
 * had happened. Source order is `materialize`, then `connect`, then
 * `target-empty`.
 */
export const HAW70_UPGRADE_PHASES = PHASES

const MIGRATION_ENTRY = /^[0-9]{14}_[a-z0-9_]+$/
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** Prisma records the checksum of the migration file's raw bytes. */
/**
 * The TRUNCATE-refusal triggers the STAGED CANDIDATE SQL declares, read from
 * the staged bytes rather than hardcoded.
 *
 * MEASURED, NOT ASSUMED. `backend/prisma/migrations` hashes to
 * `e6df95ba81d71a7bc9670b283b256279ac901397` at BOTH the reviewed pin
 * `a88af992b4ee156a8abf9c1a64c3725055acc42a` and the current source, 94
 * migrations each, and a88af992 is in fact the commit that ADDS the
 * truncate-refusal migration -- it is the pinned baseline
 * `8928934406fdcaf5fdb911d2003ac03439b05145` and the main anchor
 * `eaa92ebdd5f7893b50023d819a7c3ddde56a2955` that lack it, at tree
 * `fb1451eb09db43004f7e31f205e9e8a9f4b1385d` with 80 migrations. An earlier
 * version of this comment claimed the opposite and was simply wrong.
 *
 * So a hardcoded set would be correct TODAY. It is still derived, because the
 * candidate this driver stages comes from the `GITHUB_SHA` claim rather than
 * from the pin, so the expectation must answer to the bytes that were actually
 * staged; a literal set would go silently wrong the first time a candidate
 * changes trigger DDL. Deriving also catches a migration that creates the
 * trigger but omits `ENABLE ALWAYS`, which would leave the refusal inert in
 * replica mode -- the one thing that migration exists to prevent.
 */
function expectedTruncateGuards(stageRoot: string, stage: Haw70Stage):
readonly { relation: string; trigger: string; always: boolean }[] {
  return expectedTriggerInventory(stageRoot, stage).filter(row => row.truncate)
    .map(row => Object.freeze({ relation: row.relation, trigger: row.trigger, always: row.always }))
}

export interface Haw70TriggerDeclaration {
  readonly relation: string
  readonly trigger: string
  readonly fn: string
  readonly truncate: boolean
  readonly forEachRow: boolean
  readonly always: boolean
  /** 'BEFORE' or 'AFTER', as written. */
  readonly timing: string
  /** The non-TRUNCATE events, normalized to INSERT+UPDATE+DELETE order. */
  readonly events: string
}

/**
 * PURE. Applies one migration's trigger statements to an accumulating map, so
 * the CREATE, DROP and ENABLE ALWAYS arms can be exercised directly with
 * authored SQL. Nothing in the committed candidate set drops a trigger, so
 * without this export that arm would have no coverage at all.
 *
 * The event list may carry several events, as in
 * `BEFORE UPDATE OR DELETE OR TRUNCATE`, which a TRUNCATE-only pattern misses
 * while `pg_trigger` still reports the TRUNCATE bit for it.
 */
export function haw70ApplyTriggerDeclarations(
  into: Map<string, Haw70TriggerDeclaration>, sql: string): void {
  const create = /CREATE\s+TRIGGER\s+"?([a-z0-9_]+)"?\s+(BEFORE|AFTER)\s+([A-Za-z_,\s]+?)\s+ON\s+(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?([\s\S]*?);/gi
  for (let m = create.exec(sql); m !== null; m = create.exec(sql)) {
    const events = m[3]
    const tail = m[5]
    const fn = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?([a-z0-9_]+)"?/i.exec(tail)
    into.set(`${m[4]}:${m[1]}`, Object.freeze({
      relation: m[4], trigger: m[1], fn: fn === null ? '' : fn[1],
      truncate: /\bTRUNCATE\b/i.test(events),
      forEachRow: /FOR\s+EACH\s+ROW/i.test(tail), always: false,
      timing: m[2].toUpperCase(),
      // Normalized to the catalog's own order, so the comparison is about the
      // event SET and not about how the migration spelled it.
      events: ['INSERT', 'UPDATE', 'DELETE']
        .filter(event => new RegExp(`\\b${event}\\b`, 'i').test(events)).join('+'),
    }))
  }
  const dropped = /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+ON\s+(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
  for (let m = dropped.exec(sql); m !== null; m = dropped.exec(sql)) {
    into.delete(`${m[2]}:${m[1]}`)
  }
  const always = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+ENABLE\s+ALWAYS\s+TRIGGER\s+"?([a-z0-9_]+)"?/gi
  for (let m = always.exec(sql); m !== null; m = always.exec(sql)) {
    const key = `${m[1]}:${m[2]}`
    const row = into.get(key)
    if (row !== undefined) into.set(key, Object.freeze({ ...row, always: true }))
  }
}

/** Every trigger the staged SQL declares, with its relation, function, events
 * and enablement, derived from the staged bytes for the same reason the
 * TRUNCATE guards are, which is stated in full above `expectedTruncateGuards`:
 * the candidate comes from the `GITHUB_SHA` claim rather than from the pin, so
 * the expectation must answer to the bytes actually staged. (The pin and the
 * current source have the SAME migration tree today -- an earlier version of
 * this comment claimed they differed, which was wrong.) */
function expectedTriggerInventory(stageRoot: string, stage: Haw70Stage):
readonly Haw70TriggerDeclaration[] {
  const root = join(stageRoot, stage, 'migrations')
  const created = new Map<string, Haw70TriggerDeclaration>()
  // Sorted, so a later migration's ENABLE ALWAYS lands after its CREATE.
  const directories = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9]{14}_/.test(entry.name))
    .map(entry => entry.name).sort()
  for (const name of directories) {
    haw70ApplyTriggerDeclarations(created, readFileSync(join(root, name, 'migration.sql'), 'utf8'))
  }
  return Object.freeze([...created.values()]
    .sort((a, b) => `${a.relation}:${a.trigger}`.localeCompare(`${b.relation}:${b.trigger}`)))
}

function expectedMigrations(stageRoot: string, stage: Haw70Stage):
readonly { name: string; checksum: string }[] {
  const root = join(stageRoot, stage, 'migrations')
  const names = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && MIGRATION_ENTRY.test(entry.name))
    .map(entry => entry.name).sort()
  return Object.freeze(names.map(name => Object.freeze({
    name, checksum: sha256(readFileSync(join(root, name, 'migration.sql'))),
  })))
}

/* ============================== the pure core ============================== */

/**
 * The ordered stages. Every DATABASE and MIGRATION-CHILD effect is routed
 * through `boundary`, which is what makes the local tests nonconnecting.
 *
 * It is NOT side-effect free. It owns a scratch root -- `mkdtempSync` under the
 * OS temp directory -- and materializes the staged source into it, which writes
 * files and runs git. It never deletes that root; the materializer documents
 * those trees as never reused or deleted. So a run that reaches `materialize`
 * leaves one staged tree behind per invocation, by design and not through the
 * boundary.
 *
 * It is exported for tests ONLY. The production entry below never forwards a
 * caller-supplied boundary into it, so this export confers no authority on a
 * production caller: it is a separate path that reaches no real database.
 */
export async function executeHaw70UpgradeStages(
  environment: Readonly<Record<string, string | undefined>>,
  boundary: Haw70UpgradeBoundary,
): Promise<Haw70UpgradeOutcome> {
  let phase: Haw70Phase = 'validate-context'
  let session: Haw70Session | null = null
  let deployments = 0
  const counts = { baselineMigrations: 0, candidateMigrations: 0, additions: 0,
    fixtureTenants: 0, fixtureSnapshots: 0, authorityRows: 0, deployments: 0 }
  const retained: string[] = []
  let candidateCommit: string | null = null

  const rows = async <T>(name: string, sql: string, parameters?: readonly unknown[]):
  Promise<readonly T[]> => {
    if (session === null) throw new Haw70WitnessMismatch('session availability')
    return await session.query(name, sql, parameters) as unknown as readonly T[]
  }

  /**
   * Closes the owned session exactly once and reports a failure instead of
   * throwing, so the caller decides whether it replaces an earlier failure or
   * becomes the outcome. Returns null when there was nothing to close or the
   * close succeeded.
   */
  let closed = false
  const closeOwnedSession = async (): Promise<string | null> => {
    if (session === null || closed) return null
    closed = true
    try { await session.close(); return null } catch { return 'owned session close' }
  }

  try {
    // ---- 1. context and target, BEFORE any stage exists ------------------
    //
    // SELF-CONTAINED BOOTSTRAP. This used to call
    // `assembleHaw70UpgradeStageConfig` here, which requires all three
    // `HAWKVIEW_HAW70_STAGE_*` keys AND an already-materialized, validated
    // root -- while the driver only creates its own root later. A first
    // invocation with the intended profile, exact source and empty target
    // therefore refused unless some external caller had already performed a
    // redundant materialization and handed its stage in. That made the driver
    // dependent on an unplanned bootstrap and on a second authority path.
    //
    // The candidate now comes from the hosted claim the target guard already
    // validates, the stage is created here, and the handoff is DERIVED from
    // the owned root and then assembled and revalidated. No caller receipt,
    // bypass or workflow-side bootstrap is accepted.
    for (const name of Object.keys(environment)) {
      if (name.startsWith('HAWKVIEW_HAW70_STAGE_') && environment[name] !== undefined) {
        throw new Haw70WitnessMismatch('external stage handoff')
      }
    }
    const claimedCandidate = environment.GITHUB_SHA
    if (typeof claimedCandidate !== 'string' || !/^[0-9a-f]{40}$/.test(claimedCandidate)) {
      throw new Haw70WitnessMismatch('candidate claim shape')
    }
    if (environment.GITHUB_WORKFLOW_SHA !== claimedCandidate) {
      throw new Haw70WitnessMismatch('candidate claim agreement')
    }
    candidateCommit = claimedCandidate
    const target = inspectHaw70UpgradeTarget({
      environment, expectedCandidateCommit: claimedCandidate,
    })
    if (target.candidateCommit !== claimedCandidate) {
      throw new Haw70WitnessMismatch('candidate identity agreement')
    }

    phase = 'validate-source'
    const repositoryRoot = haw70ConfigRepositoryRoot()
    const anchor = inspectSelectedNamespaceAgainstBaseline({
      repositoryRoot, expectedCandidateCommit: claimedCandidate,
      anchorCommit: HAW70_REVIEWED_MAIN_ANCHOR,
    }) as { rawAncestorOfCandidate: boolean; matchesHistoricalBaseline: boolean
      differing: readonly string[] }
    if (anchor.rawAncestorOfCandidate !== true) throw new Haw70WitnessMismatch('main anchor ancestry')
    if (anchor.matchesHistoricalBaseline !== true || anchor.differing.length !== 0) {
      throw new Haw70WitnessMismatch('main anchor selected bytes')
    }

    // ---- 2. own a scratch root and materialize the reviewed source -------
    phase = 'materialize'
    const scratchParent = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'haw70-upgrade-')))
    const staged = materializeHaw70UpgradeSource({
      repositoryRoot, expectedCandidateCommit: claimedCandidate, scratchParent,
    }) as { outputRoot: string; executionAllowed: boolean }
    if (staged.executionAllowed !== false) throw new Haw70WitnessMismatch('descriptive invariant')
    const stageRoot = staged.outputRoot
    const revalidate = (): void => {
      const again = validateHaw70UpgradeStagedSource({
        repositoryRoot, expectedCandidateCommit: claimedCandidate, outputRoot: stageRoot,
      }) as { executionAllowed: boolean }
      if (again.executionAllowed !== false) throw new Haw70WitnessMismatch('descriptive invariant')
    }
    revalidate()

    // The handoff the driver OWNS, derived from the root it just created and
    // then put through the same assembler an external handoff would face, so
    // the owned root is held to the identical canonical-path, byte-validation
    // and target-agreement rules.
    const derivedEnvironment = Object.freeze({
      ...environment,
      HAWKVIEW_HAW70_STAGE_ROOT: stageRoot,
      HAWKVIEW_HAW70_STAGE_NAME: 'candidate',
      HAWKVIEW_HAW70_STAGE_CANDIDATE: claimedCandidate,
    })
    const assembled = assembleHaw70UpgradeStageConfig({ environment: derivedEnvironment })
    if (assembled.executionAllowed !== false) throw new Haw70WitnessMismatch('descriptive invariant')
    if (assembled.candidateCommit !== claimedCandidate) {
      throw new Haw70WitnessMismatch('derived handoff agreement')
    }
    if (assembled.stage !== 'candidate') throw new Haw70WitnessMismatch('derived handoff stage')
    const baselineExpected = expectedMigrations(stageRoot, 'baseline')
    const candidateExpected = expectedMigrations(stageRoot, 'candidate')
    counts.baselineMigrations = baselineExpected.length
    counts.candidateMigrations = candidateExpected.length
    if (baselineExpected.length !== 80) throw new Haw70WitnessMismatch('baseline migration inventory')
    if (candidateExpected.length !== 94) throw new Haw70WitnessMismatch('candidate migration inventory')
    const additions = candidateExpected.map(entry => entry.name)
      .filter(name => !baselineExpected.some(base => base.name === name))
    counts.additions = additions.length
    if (additions.length !== 14) throw new Haw70WitnessMismatch('pending migration inventory')

    // ---- 3. connect, and refuse a target that is not empty ---------------
    // Installed tooling, BEFORE the first connection. The stage is owned and
    // validated by this point, so the qualification sees the real paths.
    phase = 'qualify-tools'
    await boundary.qualify({ stage: 'baseline', stageRoot, candidateCommit: claimedCandidate })

    phase = 'connect'
    session = await boundary.connect()

    phase = 'target-empty'
    const identity = await rows<{ database: string; user: string; port: number
      version_num: string; time_zone: string }>('serverIdentity', HAW70_WITNESS_QUERIES.serverIdentity)
    if (identity.length !== 1) throw new Haw70WitnessMismatch('server identity')
    const server = identity[0]
    if (server.database !== target.target.database || server.user !== target.target.user) {
      throw new Haw70WitnessMismatch('server identity agreement')
    }
    if (Number(server.port) !== target.target.port) throw new Haw70WitnessMismatch('server port agreement')
    if (!(Number(server.version_num) >= 160000 && Number(server.version_num) < 170000)) {
      throw new Haw70WitnessMismatch('server major version')
    }
    if (server.time_zone !== 'UTC') throw new Haw70WitnessMismatch('server time zone')
    const emptiness = await rows<{ public_objects: string; history_present: boolean }>(
      'targetEmptiness', HAW70_WITNESS_QUERIES.targetEmptiness)
    if (emptiness.length !== 1) throw new Haw70WitnessMismatch('target emptiness')
    if (emptiness[0].history_present !== false) throw new Haw70WitnessMismatch('pre-existing migration history')
    if (Number(emptiness[0].public_objects) !== 0) throw new Haw70WitnessMismatch('pre-existing application objects')

    // ---- 4. baseline deployment and exact history ------------------------
    phase = 'baseline-deploy'
    revalidate()
    const baselineRun = await boundary.deploy({ stage: 'baseline', attempt: 1,
      stageRoot, candidateCommit: assembled.candidateCommit })
    deployments += 1
    requireClean(baselineRun, 'baseline deployment')

    phase = 'baseline-history'
    const baselineHistory = await rows<Haw70HistoryRow>('history', HAW70_WITNESS_QUERIES.history)
    assertExactHistory(baselineHistory, baselineExpected, 'baseline history')
    const savedBaselineHistory = baselineHistory.map(row => ({ ...row }))

    // ---- 5. the committed legacy fixture ---------------------------------
    phase = 'legacy-fixture'
    const identifiers = freshFixtureIdentifiers()
    const fixtureTenants = [identifiers.tenants.withSnapshots, identifiers.tenants.sibling,
      identifiers.tenants.otherOrganization]
    counts.fixtureTenants = fixtureTenants.length
    counts.fixtureSnapshots = identifiers.snapshots.length
    await rows('begin', 'BEGIN')
    for (const statement of buildHaw70LegacyFixture(identifiers)) {
      await rows(`fixture:${statement.name}`, statement.sql, statement.parameters)
    }
    await rows('commit', 'COMMIT')
    // Read back AFTER the commit, so visibility is established independently
    // of the inserting transaction rather than assumed from a return value.
    const savedSnapshots = await rows<Record<string, unknown>>('fixtureSnapshots',
      HAW70_WITNESS_QUERIES.fixtureSnapshots, [[identifiers.tenants.withSnapshots]])
    if (savedSnapshots.length !== identifiers.snapshots.length) {
      throw new Haw70WitnessMismatch('fixture snapshot visibility')
    }
    const savedTenants = await rows<Record<string, unknown>>('fixtureTenants',
      HAW70_WITNESS_QUERIES.fixtureTenants, [fixtureTenants])
    if (savedTenants.length !== fixtureTenants.length) {
      throw new Haw70WitnessMismatch('fixture tenant visibility')
    }
    const savedSyncStates = await rows<Record<string, unknown>>('fixtureSyncStates',
      HAW70_WITNESS_QUERIES.fixtureSyncStates, [[identifiers.syncState]])
    if (savedSyncStates.length !== 1) throw new Haw70WitnessMismatch('fixture sibling visibility')

    // ---- 6. candidate deployment and its verifications -------------------
    phase = 'candidate-deploy'
    revalidate()
    const candidateRun = await boundary.deploy({ stage: 'candidate', attempt: 1,
      stageRoot, candidateCommit: assembled.candidateCommit })
    deployments += 1
    requireClean(candidateRun, 'candidate deployment')

    phase = 'candidate-history'
    const candidateHistory = await rows<Haw70HistoryRow>('history', HAW70_WITNESS_QUERIES.history)
    assertExactHistory(candidateHistory, candidateExpected, 'candidate history')
    assertBaselineHistoryRetained(savedBaselineHistory, candidateHistory)
    assertHistoryAdditions(savedBaselineHistory, candidateHistory, additions)

    phase = 'preservation'
    assertRowsUnchanged(savedSnapshots, await rows<Record<string, unknown>>('fixtureSnapshots',
      HAW70_WITNESS_QUERIES.fixtureSnapshots, [[identifiers.tenants.withSnapshots]]),
    'fixture snapshot preservation')
    assertRowsUnchanged(savedTenants, await rows<Record<string, unknown>>('fixtureTenants',
      HAW70_WITNESS_QUERIES.fixtureTenants, [fixtureTenants]), 'fixture tenant preservation')
    assertRowsUnchanged(savedSyncStates, await rows<Record<string, unknown>>('fixtureSyncStates',
      HAW70_WITNESS_QUERIES.fixtureSyncStates, [[identifiers.syncState]]),
    'fixture sibling preservation')
    assertLegacyTagsNull(await rows<Haw70SnapshotTagRow>('snapshotTags',
      HAW70_WITNESS_QUERIES.snapshotTags, [[identifiers.tenants.withSnapshots]]),
    identifiers.snapshots.length)

    phase = 'backfill'
    const authorities = await rows<Haw70AuthorityRow>('authorities',
      HAW70_WITNESS_QUERIES.authorities, [fixtureTenants])
    counts.authorityRows = authorities.length
    assertAuthorityBackfill(authorities, [
      { tenant: identifiers.tenants.withSnapshots, organization: identifiers.organizations.primary },
      { tenant: identifiers.tenants.sibling, organization: identifiers.organizations.primary },
      { tenant: identifiers.tenants.otherOrganization, organization: identifiers.organizations.secondary },
    ])

    phase = 'catalog'
    // ONE reader, used for the catalog assertion AND for both sides of the
    // no-op comparison. Writing the object out twice let the two drift: the
    // privilege rows were added to this side only, so the before/after
    // receipt compared a shape against a different shape and the happy path
    // failed at the no-op check. A shared reader cannot drift.
    const readCatalog = async (): Promise<Record<string, unknown>> => ({
      exactIndex: await rows<never>('exactIndex', HAW70_WITNESS_QUERIES.exactIndex),
      constraints: await rows<never>('constraints', HAW70_WITNESS_QUERIES.constraints),
      authorityRelation: await rows<never>('authorityRelation', HAW70_WITNESS_QUERIES.authorityRelation),
      privileges: await rows<never>('privileges', HAW70_WITNESS_QUERIES.privileges),
      triggers: await rows<never>('triggers', HAW70_WITNESS_QUERIES.triggers),
      writerTriggers: await rows<never>('writerTriggers', HAW70_WITNESS_QUERIES.writerTriggers),
      observationSequence: await rows<never>('observationSequence',
        HAW70_WITNESS_QUERIES.observationSequence),
    })
    const catalog = await readCatalog()
    const inventory = expectedTriggerInventory(stageRoot, 'candidate')
    assertUpgradedCatalog(catalog as never, {
      truncateGuards: inventory.filter(row => row.truncate)
        .map(row => ({ relation: row.relation, trigger: row.trigger, always: row.always })),
      writerTriggers: inventory.filter(row => !row.truncate
        && HAW70_WRITER_TRIGGER_RELATIONS.includes(row.relation))
        .map(row => ({ relation: row.relation, trigger: row.trigger, fn: row.fn,
          timing: row.timing, mode: row.forEachRow ? 'ROW' : 'STATEMENT',
          events: row.events })),
    })

    // ---- 7. the same candidate again must change nothing -----------------
    //
    // CAPTURED BEFORE THE REPEAT DEPLOYMENT. Reading both sides afterwards
    // would compare the post-deployment state with itself and pass whatever
    // the second deployment did.
    const readLegacyState = async (): Promise<Record<string, unknown>> => ({
      snapshots: await rows<Record<string, unknown>>('fixtureSnapshots',
        HAW70_WITNESS_QUERIES.fixtureSnapshots, [[identifiers.tenants.withSnapshots]]),
      tags: await rows<Haw70SnapshotTagRow>('snapshotTags',
        HAW70_WITNESS_QUERIES.snapshotTags, [[identifiers.tenants.withSnapshots]]),
      tenants: await rows<Record<string, unknown>>('fixtureTenants',
        HAW70_WITNESS_QUERIES.fixtureTenants, [fixtureTenants]),
      syncStates: await rows<Record<string, unknown>>('fixtureSyncStates',
        HAW70_WITNESS_QUERIES.fixtureSyncStates, [[identifiers.syncState]]),
    })
    const legacyBefore = await readLegacyState()

    phase = 'no-op-deploy'
    revalidate()
    const repeatRun = await boundary.deploy({ stage: 'candidate', attempt: 2,
      stageRoot, candidateCommit: assembled.candidateCommit })
    deployments += 1
    requireClean(repeatRun, 'repeat deployment')

    phase = 'no-op-verify'
    // THE WHOLE OBSERVED STATE, not history/authorities/catalog alone. The
    // earlier receipt omitted the snapshots, the legacy tags, the tenant rows
    // and the sibling sync-state row, so a second deployment that changed a
    // legacy payload or deleted the sibling row while leaving history,
    // authorities and catalog untouched still completed.
    assertNoOp({ history: candidateHistory, authorities, catalog, legacy: legacyBefore }, {
      history: await rows<Haw70HistoryRow>('history', HAW70_WITNESS_QUERIES.history),
      authorities: await rows<Haw70AuthorityRow>('authorities',
        HAW70_WITNESS_QUERIES.authorities, [fixtureTenants]),
      catalog: await readCatalog(),
      legacy: await readLegacyState(),
    })

    // ---- 8. remove ONLY the driver's own ordinary fixture rows -----------
    // Ordered child-first. No trigger is disabled, nothing is truncated, no
    // schema is dropped or reset and no migration history is touched.
    //
    // EVERY DELETE RETURNS ITS ROWS, and the postconditions are then read
    // back. The earlier form discarded all three results and emitted fixed
    // retention strings, so a delete that removed nothing -- or one that left
    // the wrong tombstone -- still reported success.
    phase = 'cleanup'
    const deletedSnapshots = await rows<{ id: string }>('cleanup:snapshots',
      'DELETE FROM "tenant_health_snapshots" WHERE "customer_tenant_id" = ANY($1::uuid[]) RETURNING "id"',
      [fixtureTenants])
    const deletedSyncStates = await rows<{ id: string }>('cleanup:syncStates',
      'DELETE FROM "sync_states" WHERE "id" = ANY($1::uuid[]) RETURNING "id"',
      [[identifiers.syncState]])
    const deletedTenants = await rows<{ id: string }>('cleanup:tenants',
      'DELETE FROM "customer_tenants" WHERE "id" = ANY($1::uuid[]) RETURNING "id"',
      [fixtureTenants])

    // THE EXPECTED FINAL LIFECYCLE STATE, derived from the committed triggers
    // rather than assumed to be uniform.
    //
    // Backfill wrote revision 1 for all three. Cleanup then deletes, in order:
    // snapshots (no non-TRUNCATE trigger on that relation, so no effect),
    // the sibling's sync-state row, and the three tenants.
    //
    // `tenant_health_sync_state_delete_invalidate`
    // (20261114191500) advances `source_revision + 1` for the matching
    // authority WHERE `authority.live`, so the SIBLING alone goes 1 -> 2 while
    // still live. `tenant_health_tombstone_on_tenant_delete` (20261113021500)
    // then advances every deleted tenant's authority and marks it dead, so the
    // sibling reaches 3 and the other two reach 2.
    //
    // The incarnation is the one the backfill minted and must be unchanged: a
    // tombstone carrying a different incarnation is a different authority.
    const mintedIncarnation = (tenant: string): string => {
      const row = authorities.find(entry => entry.customer_tenant_id === tenant)
      if (row === undefined) throw new Haw70WitnessMismatch('authority backfill missing tenant')
      return row.incarnation
    }
    const expectedTombstones = [
      { organization: identifiers.organizations.primary,
        tenant: identifiers.tenants.withSnapshots,
        incarnation: mintedIncarnation(identifiers.tenants.withSnapshots), revision: '2' },
      // The sibling owns the deleted sync-state row, so it invalidates first.
      { organization: identifiers.organizations.primary,
        tenant: identifiers.tenants.sibling,
        incarnation: mintedIncarnation(identifiers.tenants.sibling), revision: '3' },
      { organization: identifiers.organizations.secondary,
        tenant: identifiers.tenants.otherOrganization,
        incarnation: mintedIncarnation(identifiers.tenants.otherOrganization), revision: '2' },
    ]

    // DELIBERATELY RETAINED, and now VERIFIED to be what was intended:
    //  - the authority rows survive tenant deletion by design. The committed
    //    tombstone trigger sets `live = false`, clears the exact pointer,
    //    zeroes the observation sequence and increments the revision, so the
    //    retained rows must be exactly those tombstones, at the revisions the
    //    committed triggers produce: 3 for the sibling whose sync-state row
    //    cleanup deleted, 2 for the other two.
    //  - the two fixture organizations are kept BECAUSE deleting them would
    //    cascade those tombstones away. Removing a tombstone through a
    //    declared cascade is a reviewer's decision, not this driver's.
    assertCleanupPostconditions({
      deletedSnapshots: deletedSnapshots.length,
      deletedSyncStates: deletedSyncStates.length,
      deletedTenants: deletedTenants.length,
      remainingSnapshots: (await rows<Record<string, unknown>>('fixtureSnapshots',
        HAW70_WITNESS_QUERIES.fixtureSnapshots, [fixtureTenants])).length,
      remainingSyncStates: (await rows<Record<string, unknown>>('fixtureSyncStates',
        HAW70_WITNESS_QUERIES.fixtureSyncStates, [[identifiers.syncState]])).length,
      remainingTenants: (await rows<Record<string, unknown>>('fixtureTenants',
        HAW70_WITNESS_QUERIES.fixtureTenants, [fixtureTenants])).length,
      authorities: await rows<Haw70AuthorityRow>('authorities',
        HAW70_WITNESS_QUERIES.authorities, [fixtureTenants]),
      organizations: await rows<Record<string, unknown>>('fixtureOrganizations',
        HAW70_WITNESS_QUERIES.fixtureOrganizations,
        [[identifiers.organizations.primary, identifiers.organizations.secondary]]),
    }, { snapshots: identifiers.snapshots.length, syncStates: 1,
      tenants: fixtureTenants.length, organizations: 2, tombstones: expectedTombstones })
    retained.push('tenant_health_source_authorities: three verified tombstones, live=false, '
      + 'pointer null, sequence 0, revisions 2/3/2 for with-snapshots/sibling/other-organization')
    retained.push('organizations: the two fixture organizations, kept so the tombstones are not cascaded away')
    retained.push('sync-state deletion advanced the sibling authority 1->2 before tenant deletion '
      + 'advanced all three, which is why the sibling tombstone is at revision 3')

    phase = 'completed'
    counts.deployments = deployments
    // CLOSING IS PART OF SUCCEEDING. The owned session is closed here, before
    // the successful result exists, so a close failure becomes the outcome
    // instead of being discarded under a `completed: true` the caller would
    // otherwise believe.
    const closeFailure = await closeOwnedSession()
    if (closeFailure !== null) {
      return freezeOutcome({ completed: false, phase: 'cleanup', failure: closeFailure,
        candidateCommit, counts, retained })
    }
    return freezeOutcome({ completed: true, phase, failure: null, candidateCommit, counts, retained })
  } catch (error) {
    counts.deployments = deployments
    // A FIXED SAFE OUTCOME. Only a witness check name is ever surfaced; any
    // other error becomes a generic label, so no credential, URL, row value,
    // environment value or raw child/database message can escape.
    const failure = error instanceof Haw70WitnessMismatch
      ? error.check : 'refused before completion'
    // The FIRST failure is preserved: a close failure on an already-failing
    // path must not replace the reason the run failed.
    await closeOwnedSession()
    return freezeOutcome({ completed: false, phase, failure, candidateCommit, counts, retained })
  } finally {
    // A safety net only. `closeOwnedSession` is idempotent, so the ordinary
    // paths above have already closed and this does nothing on them.
    await closeOwnedSession()
  }

}

function requireClean(outcome: Haw70DeployOutcome, check: string): void {
  if (outcome.timedOut) throw new Haw70WitnessMismatch(`${check} timeout`)
  if (outcome.signal !== null) throw new Haw70WitnessMismatch(`${check} signal`)
  if (outcome.status !== 0) throw new Haw70WitnessMismatch(`${check} exit status`)
  if (outcome.outputBytes > DEPLOY_OUTPUT_CAP) throw new Haw70WitnessMismatch(`${check} output bound`)
}

function freezeOutcome(parts: Omit<Haw70UpgradeOutcome, 'kind'>): Haw70UpgradeOutcome {
  return Object.freeze({ kind: 'haw70-staged-upgrade-outcome-v1' as const, ...parts,
    counts: Object.freeze({ ...parts.counts }), retained: Object.freeze([...parts.retained]) })
}

/** Freshly owned identifiers, so no later suite can collide with this fixture. */
function freshFixtureIdentifiers(): Haw70FixtureIdentifiers {
  return Object.freeze({
    organizations: Object.freeze({ primary: randomUUID(), secondary: randomUUID() }),
    tenants: Object.freeze({ withSnapshots: randomUUID(), sibling: randomUUID(),
      otherOrganization: randomUUID() }),
    microsoftTenants: Object.freeze({ withSnapshots: randomUUID(), sibling: randomUUID(),
      otherOrganization: randomUUID() }),
    snapshots: Object.freeze([randomUUID(), randomUUID(), randomUUID()]) as
      Haw70FixtureIdentifiers['snapshots'],
    syncState: randomUUID(),
  })
}

/**
 * The relations the source-writer inventory is scoped to, kept identical to
 * the `writerTriggers` query's own IN list.
 *
 * The earlier three-relation list omitted exactly the relations the HAW-70
 * invalidators are installed on. `sync_states` matters most: its delete
 * invalidator is what advances the sibling authority during cleanup, so the
 * inventory previously could not observe the mechanism the cleanup assertion
 * depends on.
 */
export const HAW70_WRITER_TRIGGER_RELATIONS: readonly string[] = Object.freeze([
  'customer_tenants', 'directory_audit_logs', 'sync_states', 'tenant_entra_snapshots',
  'tenant_health_snapshots', 'tenant_health_source_authorities',
])

export const HAW70_REVIEWED_MAIN_ANCHOR = 'eaa92ebdd5f7893b50023d819a7c3ddde56a2955'
const DEPLOY_OUTPUT_CAP = 1 << 20
const DEPLOY_TIMEOUT_MS = 300_000
const PRISMA_CLI_ENTRY = 'node_modules/prisma/build/index.js'
const DEDICATED_CONFIG = 'prisma/haw70-upgrade.config.ts'

/* ========================== fixed production adapter ========================== */

/**
 * THE EXECUTABLE SOURCE this driver is qualified to run as, declared rather
 * than discovered. These are the tracked files that decide what the physical
 * run does: the driver, its fixture and assertions, the validators it trusts
 * and the dedicated configuration the child loads.
 *
 * The selected migration manifest deliberately does NOT cover them -- that
 * manifest pins MIGRATION provenance -- so a modified runner or witness with
 * an untouched schema and migrations would otherwise pass every source check
 * and still change what executes.
 */
export const HAW70_EXECUTABLE_SOURCE = Object.freeze([
  'backend/prisma/haw70-upgrade.config.ts',
  'backend/scripts/haw70-upgrade-config.ts',
  'backend/scripts/haw70-upgrade-git-source.mjs',
  'backend/scripts/haw70-upgrade-launch-plan.ts',
  'backend/scripts/haw70-upgrade-materializer.mjs',
  'backend/scripts/haw70-upgrade-runner.ts',
  'backend/scripts/haw70-upgrade-source-manifest.json',
  // TRANSITIVE, and executed by this path: `haw70-upgrade-git-source.mjs`
  // imports `verifyMigrationSourceSnapshots` from the source plan, and
  // `haw70-upgrade-target.ts` imports `assertDisposableTestDatabase` from the
  // native target helper through its `.js` runtime specifier. Neither is in
  // the migration selection, so modifying either would otherwise escape this
  // inspection while the physical runner still loads it.
  'backend/scripts/haw70-upgrade-source-plan.mjs',
  'backend/scripts/haw70-upgrade-target.ts',
  'backend/scripts/haw70-upgrade-witness.ts',
  'backend/src/prisma/native-alert-test-database.ts',
])

/**
 * PURE. Parses `git status --porcelain=v1 -z`-style records already split into
 * lines and returns the declared paths that are not clean.
 *
 * Exported and kept free of process work so the refusal logic is testable
 * without a repository: a test authors the status text and reads the verdict,
 * rather than asserting that some source string is present.
 */
export function haw70DirtyExecutableSource(
  statusLines: readonly string[]): readonly string[] {
  const declared = new Set<string>(HAW70_EXECUTABLE_SOURCE)
  const dirty = new Set<string>()
  for (const line of statusLines) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    // A rename record carries `old -> new`; both sides are considered.
    for (const candidate of rest.split(' -> ')) {
      const path = candidate.replace(/^"|"$/g, '')
      if (declared.has(path)) dirty.add(`${code.trim()} ${path}`)
    }
  }
  return Object.freeze([...dirty].sort())
}

/**
 * Runs the read-only status query and applies the pure parser above. An
 * untracked declared file counts as dirty: a file git does not record cannot
 * be the reviewed source.
 */
/**
 * The CLOSED Git environment, identical in intent to the one the established
 * read-only adapter uses in `haw70-upgrade-git-source.mjs`.
 *
 * Without it this inspection inherited ambient `process.env`, so an ambient
 * `GIT_DIR` or `GIT_WORK_TREE` could point it at a DIFFERENT working tree
 * while the file-existence checks still looked at the intended directory --
 * a clean report about the wrong repository. It also re-enabled
 * configuration-sensitive behaviour the adapter deliberately suppresses, such
 * as an fsmonitor hook and index refreshing.
 */
const HAW70_GIT_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
})

/** The fixed read-only status argv, exported so a test can observe it. */
export function haw70StatusCommand(repositoryRoot: string): Readonly<{
  executable: string; argv: readonly string[]; env: Readonly<Record<string, string>> }> {
  return Object.freeze({
    executable: '/usr/bin/git',
    argv: Object.freeze(['--no-pager', '--no-replace-objects',
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.untrackedCache=false',
      '-C', repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--',
      ...HAW70_EXECUTABLE_SOURCE]),
    env: HAW70_GIT_ENVIRONMENT,
  })
}

function inspectHaw70ExecutableSource(repositoryRoot: string): readonly string[] {
  const command = haw70StatusCommand(repositoryRoot)
  // GUARDED. `spawnSync` itself can throw -- a missing executable, a resource
  // limit, or an interception in a test harness -- and an unqualified source
  // check that throws turns the entry's declared refusal into a rejection with
  // a stack trace. An unavailable status is treated as drift, never as clean.
  let result: { status: number | null; stdout?: string }
  try {
    result = spawnSync(command.executable, [...command.argv],
      { encoding: 'utf8', env: { ...command.env }, shell: false,
        timeout: 15_000, maxBuffer: 1 << 20 })
  } catch { return Object.freeze(['status unavailable']) }
  if (result.status !== 0 || typeof result.stdout !== 'string') return Object.freeze(['status unavailable'])
  const missing = HAW70_EXECUTABLE_SOURCE
    .filter(path => { try { return !lstatSync(join(repositoryRoot, path)).isFile() } catch { return true } })
    .map(path => `absent ${path}`)
  return Object.freeze([...haw70DirtyExecutableSource(result.stdout.split('\n')), ...missing].sort())
}

/** The fixed child request. PURE: it builds, it does not launch. */
export function haw70ChildLaunchRequest(input: {
  readonly stage: Haw70Stage
  readonly stageRoot: string
  readonly candidateCommit: string
  readonly datasourceUrl: string
  readonly environment: Readonly<Record<string, string>>
  readonly paths: { readonly nodeExecutable: string; readonly prismaCliEntry: string
    readonly dedicatedConfig: string; readonly backend: string }
}): Readonly<{ executable: string; argv: readonly string[]; cwd: string
  env: Readonly<Record<string, string>> }> {
  const { stage, stageRoot, candidateCommit, datasourceUrl, environment, paths } = input
  // Fixed argv. No shell, no PATH lookup, no npx, no download, no caller
  // argument, and never generate, seed, dev or reset.
  const argv = Object.freeze([paths.prismaCliEntry, 'migrate', 'deploy',
    '--config', paths.dedicatedConfig])
  const projected: Record<string, string> = {
    CI: 'true', GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'dharmik0431/hawkview-app',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
    GITHUB_WORKFLOW: 'Required quality gates', GITHUB_JOB: 'backend-quality',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    HAWKVIEW_CI_MIGRATION_PROFILE: 'haw70-upgrade',
    HAWKVIEW_RUN_HAW70_UPGRADE: '1',
    HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1',
    HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
    HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
    JITI_FS_CACHE: 'false', TZ: 'UTC', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    GITHUB_SHA: candidateCommit, GITHUB_WORKFLOW_SHA: candidateCommit,
    HAWKVIEW_HAW70_STAGE_ROOT: stageRoot,
    HAWKVIEW_HAW70_STAGE_NAME: stage,
    HAWKVIEW_HAW70_STAGE_CANDIDATE: candidateCommit,
    DATABASE_URL: datasourceUrl,
  }
  for (const carried of ['GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    const value = environment[carried]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Haw70WitnessMismatch('carried context key')
    }
    projected[carried] = value
  }
  const keys = Object.keys(projected).sort()
  if (keys.length !== HAW70_LAUNCH_ENVIRONMENT_KEYS.length
    || keys.join(',') !== [...HAW70_LAUNCH_ENVIRONMENT_KEYS].join(',')) {
    throw new Haw70WitnessMismatch('child environment key inventory')
  }
  return Object.freeze({ executable: paths.nodeExecutable, argv, cwd: paths.backend,
    env: Object.freeze(projected) })
}

/** The explicit client options. PURE: it builds, it does not connect. */
export function haw70ClientOptions(url: URL): Readonly<Record<string, unknown>> {
  // Explicit connection fields from the already guarded URL, so no ambient
  // PG* default can choose the route. SSL is off for this loopback service.
  return Object.freeze({
    host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: false, application_name: 'haw70-staged-upgrade',
    connectionTimeoutMillis: 10_000, query_timeout: 60_000,
    statement_timeout: 60_000, lock_timeout: 15_000, options: '-c timezone=UTC',
  })
}

/**
 * THE PUBLIC PRODUCTION ENTRY. It accepts exactly one environment snapshot and
 * nothing else: no boundary, executable, argument, query, callback, receipt or
 * target override. It builds the fixed adapter itself.
 *
 * It validates the actual runtime, the tracked executable source and the
 * installed tooling BEFORE constructing a client or launching a migration
 * child, because a claim string is not a hosted runner and an unmodified
 * schema is not unmodified code.
 */
export async function runHaw70StagedUpgrade(
  input: { readonly environment: Readonly<Record<string, string | undefined>> },
): Promise<Haw70UpgradeOutcome> {
  const keys = Object.keys(input ?? {})
  if (keys.length !== 1 || keys[0] !== 'environment' || typeof input.environment !== 'object'
    || input.environment === null || Array.isArray(input.environment)) {
    return freezeOutcome({ completed: false, phase: 'validate-context',
      failure: 'public input shape', candidateCommit: null,
      counts: { baselineMigrations: 0, candidateMigrations: 0, additions: 0, fixtureTenants: 0,
        fixtureSnapshots: 0, authorityRows: 0, deployments: 0 }, retained: [] })
  }
  // One immutable snapshot of the primitive string values.
  const environment = Object.freeze(Object.fromEntries(Object.entries(input.environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')))

  const refusal = (failure: string): Haw70UpgradeOutcome => freezeOutcome({
    completed: false, phase: 'validate-context', failure, candidateCommit: null,
    counts: { baselineMigrations: 0, candidateMigrations: 0, additions: 0, fixtureTenants: 0,
      fixtureSnapshots: 0, authorityRows: 0, deployments: 0 }, retained: [] })

  // The profile this driver is built for, which is NOT registered today.
  if (environment.HAWKVIEW_CI_MIGRATION_PROFILE !== 'haw70-upgrade') return refusal('migration profile')
  if (environment.HAWKVIEW_RUN_HAW70_UPGRADE !== '1') return refusal('upgrade opt-in')
  if (environment.JITI_FS_CACHE !== 'false') return refusal('loader cache setting')
  if (environment.TZ !== 'UTC') return refusal('timezone setting')
  for (const forbidden of ['NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY',
    'http_proxy', 'https_proxy', 'ALL_PROXY', 'PGSERVICE', 'PGSERVICEFILE']) {
    if (environment[forbidden] !== undefined) return refusal('ambient control')
  }
  // `GIT_*` too. The status inspection below runs with a closed environment of
  // its own, so ambient routing cannot redirect it -- but a snapshot carrying
  // `GIT_DIR` or `GIT_WORK_TREE` is still a tainted context, and the rest of
  // the entry trusts this snapshot.
  for (const name of Object.keys(environment)) {
    if (/^(PG|DOTENV_CONFIG_|GIT_)/.test(name)) return refusal('ambient control')
  }
  // The driver owns its stage. An externally supplied handoff is the second
  // authority path this design refuses, so it is refused here as well as in
  // the core rather than quietly accepted by whichever runs first.
  for (const name of Object.keys(environment)) {
    if (name.startsWith('HAWKVIEW_HAW70_STAGE_')) return refusal('external stage handoff')
  }
  // ACTUAL runtime, not a claim. The registered profile is Linux on Node 22.
  if (process.platform !== 'linux') return refusal('runtime platform')
  if (!/^v22\./.test(process.version)) return refusal('runtime version')

  const backend = realpathSync(join(import.meta.dirname, '..'))
  if (!lstatSync(backend).isDirectory()) return refusal('backend root')

  // TRACKED EXECUTABLE SOURCE, before anything physical. Selected migration
  // provenance does not cover these files, so without this a modified runner
  // or witness would reach a real client and a real CLI.
  let repositoryRoot: string
  try { repositoryRoot = haw70ConfigRepositoryRoot() } catch { return refusal('repository root') }
  if (inspectHaw70ExecutableSource(repositoryRoot).length !== 0) {
    return refusal('executable source drift')
  }

  // The candidate the hosted claims name, and the validated target, both
  // BEFORE a stage exists -- the driver materializes its own.
  const claimedCandidate = environment.GITHUB_SHA
  if (typeof claimedCandidate !== 'string' || !/^[0-9a-f]{40}$/.test(claimedCandidate)) {
    return refusal('candidate claim shape')
  }
  let datasourceUrl: string
  try {
    const target = inspectHaw70UpgradeTarget({
      environment, expectedCandidateCommit: claimedCandidate,
    }) as { candidateCommit: string }
    if (target.candidateCommit !== claimedCandidate) return refusal('candidate identity agreement')
    const supplied = environment.DATABASE_URL
    if (typeof supplied !== 'string') return refusal('datasource shape')
    datasourceUrl = supplied
  } catch { return refusal('target qualification') }

  let url: URL
  try { url = new URL(datasourceUrl) } catch { return refusal('datasource shape') }

  const { Client } = await import('pg') as unknown as {
    Client: new (options: Record<string, unknown>) => {
      connect(): Promise<void>
      query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
      end(): Promise<void>
    }
  }

  /**
   * The validated launch plan for one stage. Shared by `qualify` and `deploy`
   * so the pre-connection check and the per-deployment check cannot disagree,
   * while each still performs the validation rather than trusting a cached
   * verdict.
   */
  const validatedPlan = (request: Haw70QualifyRequest): {
    paths: { nodeExecutable: string; prismaCliEntry: string; dedicatedConfig: string }
    installedTools: { prismaVersion: string; prismaConfigVersion: string
      prismaDeclaredBinary: string }
  } => {
    const derived = Object.freeze({
      ...environment,
      HAWKVIEW_HAW70_STAGE_ROOT: request.stageRoot,
      HAWKVIEW_HAW70_STAGE_NAME: request.stage,
      HAWKVIEW_HAW70_STAGE_CANDIDATE: request.candidateCommit,
    })
    return buildHaw70UpgradeLaunchPlan({ environment: derived }) as never
  }

  const boundary: Haw70UpgradeBoundary = Object.freeze({
    async qualify(request: Haw70QualifyRequest): Promise<void> {
      // Read-only. `buildHaw70UpgradeLaunchPlan` throws unless both `prisma`
      // and `@prisma/config` are the expected version and the package declares
      // the expected binary. Nothing is launched and nothing is connected.
      validatedPlan(request)
    },
    async deploy(request: Haw70DeployRequest): Promise<Haw70DeployOutcome> {
      // INSTALLED-TOOL QUALIFICATION, reused rather than re-implemented.
      // `buildHaw70UpgradeLaunchPlan` is the module that already checks both
      // `prisma` and `@prisma/config` are the expected version and that the
      // package declares `build/index.js` as the Prisma binary. File existence
      // alone, which is all this adapter used to require, lets a different
      // installed package or inconsistent bin metadata reach the CLI.
      //
      // It is called per request with the handoff DERIVED from the owned stage
      // root, so no runnable environment is added to that descriptive plan and
      // its `executionAllowed: false` contract is untouched.
      // REVALIDATED per deployment, not trusted from the pre-connection call.
      const plan = validatedPlan(request)
      const launch = haw70ChildLaunchRequest({
        stage: request.stage, stageRoot: request.stageRoot,
        candidateCommit: request.candidateCommit, datasourceUrl, environment,
        paths: { ...plan.paths, backend },
      })
      const result = spawnSync(launch.executable, [...launch.argv], {
        cwd: launch.cwd, env: { ...launch.env }, shell: false,
        timeout: DEPLOY_TIMEOUT_MS, maxBuffer: DEPLOY_OUTPUT_CAP + 1,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const outputBytes = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0)
      return Object.freeze({
        status: result.status, signal: result.signal, timedOut: result.error !== undefined,
        outputBytes, argv: launch.argv,
        environmentKeys: Object.freeze(Object.keys(launch.env).sort()),
      })
    },
    async connect(): Promise<Haw70Session> {
      const client = new Client({ ...haw70ClientOptions(url) })
      try {
        await client.connect()
      } catch (error) {
        // THE ADAPTER OWNS THIS CLIENT until a session exists. The caller's
        // `finally` has no reference to it on this path, so without closing it
        // here a rejected connection leaks the socket and its timers. The
        // original failure is rethrown, not masked by a close failure.
        try { await client.end() } catch { /* nothing to close */ }
        throw error
      }
      return Object.freeze({
        async query(_name: string, sql: string, parameters?: readonly unknown[]) {
          const result = await client.query(sql, parameters === undefined ? undefined : [...parameters])
          return Object.freeze(result.rows)
        },
        async close() { await client.end() },
      })
    },
  })

  return await executeHaw70UpgradeStages(environment, boundary)
}
