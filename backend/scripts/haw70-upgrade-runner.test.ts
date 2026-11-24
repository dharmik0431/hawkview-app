import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { after } from 'node:test'
import {
  HAW70_EXECUTABLE_SOURCE, HAW70_UPGRADE_PHASES, HAW70_WRITER_TRIGGER_RELATIONS,
  executeHaw70UpgradeStages, haw70ApplyTriggerDeclarations, haw70ChildLaunchRequest,
  haw70ClientOptions, haw70DirtyExecutableSource, haw70StatusCommand, runHaw70StagedUpgrade,
} from './haw70-upgrade-runner.js'
import type {
  Haw70DeployOutcome, Haw70DeployRequest, Haw70QualifyRequest, Haw70Session,
  Haw70TriggerDeclaration, Haw70UpgradeBoundary,
} from './haw70-upgrade-runner.js'

/**
 * Focused NONCONNECTING tests for the staged upgrade driver.
 *
 * NOTHING here opens a database, starts PostgreSQL, launches the Prisma CLI,
 * runs a migration, generates a client or starts the application -- not even
 * in a mutation control.
 *
 * That property is STRUCTURAL. Every database and migration-child effect in
 * `executeHaw70UpgradeStages` goes through the injected boundary, and this
 * suite only ever injects a fake. The production entry builds the real adapter
 * itself and is invoked here ONLY with environments that refuse before it
 * reaches the adapter -- never with a clean one. It is also checked at
 * RUNTIME, not by assertion over constants: the final test runs a cold import
 * of the driver in a fresh process under an inert observer that patches
 * `child_process`, `net` and `dns`, and a positive control in that same
 * process proves the observer records a deliberate launch.
 *
 * THE ORACLE SEPARATION. The driver mints its fixture identifiers with
 * randomUUID(), so the fake learns WHICH ids exist the only way a database
 * could: from the INSERT statements it is asked to execute. It does NOT learn
 * row CONTENT that way. The pinned snapshot rows, the TRUNCATE guard set, the
 * writer-trigger inventory and the index key columns are transcribed below
 * from the committed migrations, independently of the driver's own parser.
 *
 * WHAT THESE RESULTS DO NOT QUALIFY: SQL validity, catalog semantics, real
 * migration behaviour, actual fixture preservation and actual cleanup. A mock
 * cannot manufacture physical proof.
 */

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'haw70-runner-test-')))
after(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * EVERY staged root this run causes lands under `scratch`, so the `after`
 * hook removes them all.
 *
 * The driver owns a fresh `mkdtemp` root per invocation and never deletes it,
 * by design -- the materializer documents those trees as never reused or
 * deleted. Each one is roughly 100 MB, and the defect table drives the core
 * ~90 times, so a single run otherwise churns several gigabytes through the
 * system temp directory. That measurably degrades the run: per-case time rose
 * from ~9s to ~37s over one suite, and a case that passes in isolation failed
 * with a generic error late in the table.
 *
 * `os.tmpdir()` reads `TMPDIR` on POSIX, so redirecting it here keeps the
 * driver's own behaviour untouched while giving this suite a disposable root.
 * `scratch` itself was created under the real temp directory first.
 */
process.env.TMPDIR = scratch
const backend = realpathSync(join(import.meta.dirname, '..'))
const repositoryRoot = realpathSync(join(backend, '..'))
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const git = (...args: string[]) => {
  const result = spawnSync('/usr/bin/git', ['-C', repositoryRoot, ...args],
    { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
const head = git('rev-parse', 'HEAD').trim()

/** Comments removed, so a source assertion cannot be satisfied by prose. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(line => line.replace(/(^|[^:"'\\])\/\/.*$/, '$1')).join('\n')

/* ================== independent transcriptions (the oracles) ================== */

/** Transcribed from the reviewed design, NOT imported from the witness. */
const PINNED_SNAPSHOTS = [
  { at: '2026-10-01T00:00:00.000Z', model: 3, status: 'HEALTHY',
    payload: '{"haw70Fixture":true,"ordinal":1,"detail":{"collectors":["USERS"],"nested":[1,2,3]}}' },
  { at: '2026-10-02T12:30:00.000Z', model: 3, status: 'DEGRADED',
    payload: '{"haw70Fixture":true,"ordinal":2,"detail":{"collectors":["USERS"],"nested":[]}}' },
  { at: '2026-10-03T23:59:59.000Z', model: 4, status: 'UNKNOWN',
    payload: '{"haw70Fixture":true,"ordinal":3,"detail":null}' },
] as const

/**
 * The eight TRUNCATE-firing triggers, transcribed from the migration SQL
 * rather than produced by the driver's parser, which is the other side of this
 * comparison. Seven are ENABLE ALWAYS ('A'); the reconciliation guard is the
 * one legitimate origin-only ('O') row, and it is also the multi-event
 * `BEFORE UPDATE OR DELETE OR TRUNCATE` form a TRUNCATE-only pattern misses.
 */
const TRUNCATE_GUARDS = [
  { relname: 'customer_tenants', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
  { relname: 'directory_audit_logs', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
  { relname: 'organizations', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
  { relname: 'sync_states', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
  { relname: 'tenant_entra_snapshots', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
  { relname: 'tenant_health_reconciliation_generations',
    tgname: 'tenant_health_preserve_reconciliation_generation', tgenabled: 'O' },
  { relname: 'tenant_health_snapshots', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
  { relname: 'tenant_health_source_authorities', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' },
]

/**
 * ALL ELEVEN source-writer triggers on the six scoped relations, transcribed
 * from the migration SQL. The earlier list held two, because the scope held
 * three relations and omitted exactly the ones the HAW-70 invalidators live
 * on -- `sync_states` above all, whose delete invalidator is what advances the
 * sibling authority during cleanup.
 */
const writer = (relname: string, tgname: string, function_name: string, timing: string,
  mode: string, events: { on_insert?: boolean; on_update?: boolean; on_delete?: boolean }) =>
  ({ relname, tgname, function_name, timing, mode, tgenabled: 'O',
    on_insert: events.on_insert === true, on_update: events.on_update === true,
    on_delete: events.on_delete === true })

const WRITER_TRIGGERS = [
  writer('customer_tenants', 'tenant_health_authorize_on_tenant_insert',
    'tenant_health_authorize_on_tenant_insert', 'AFTER', 'ROW', { on_insert: true }),
  writer('customer_tenants', 'tenant_health_tombstone_on_tenant_delete',
    'tenant_health_tombstone_on_tenant_delete', 'AFTER', 'STATEMENT', { on_delete: true }),
  writer('directory_audit_logs', 'tenant_health_audit_delete_invalidate',
    'tenant_health_invalidate_on_audit_change', 'AFTER', 'STATEMENT', { on_delete: true }),
  writer('directory_audit_logs', 'tenant_health_audit_insert_invalidate',
    'tenant_health_invalidate_on_audit_change', 'AFTER', 'STATEMENT', { on_insert: true }),
  writer('directory_audit_logs', 'tenant_health_audit_update_invalidate',
    'tenant_health_invalidate_on_audit_change', 'AFTER', 'STATEMENT', { on_update: true }),
  // THE TRIGGER THAT DETERMINES CLEANUP: deleting the sibling's sync-state
  // row advances that live authority 1 -> 2 before the tenant delete.
  writer('sync_states', 'tenant_health_sync_state_delete_invalidate',
    'tenant_health_invalidate_on_sync_state_change', 'AFTER', 'STATEMENT', { on_delete: true }),
  writer('sync_states', 'tenant_health_sync_state_insert_invalidate',
    'tenant_health_invalidate_on_sync_state_change', 'AFTER', 'STATEMENT', { on_insert: true }),
  writer('sync_states', 'tenant_health_sync_state_update_invalidate',
    'tenant_health_invalidate_on_sync_state_change', 'AFTER', 'STATEMENT', { on_update: true }),
  writer('tenant_entra_snapshots', 'tenant_health_input_snapshot_delete_invalidate',
    'tenant_health_invalidate_on_input_snapshot_change', 'AFTER', 'STATEMENT', { on_delete: true }),
  writer('tenant_entra_snapshots', 'tenant_health_input_snapshot_insert_invalidate',
    'tenant_health_invalidate_on_input_snapshot_change', 'AFTER', 'STATEMENT', { on_insert: true }),
  writer('tenant_entra_snapshots', 'tenant_health_input_snapshot_update_invalidate',
    'tenant_health_invalidate_on_input_snapshot_change', 'AFTER', 'STATEMENT', { on_update: true }),
]

/**
 * The revoked-privilege contract: every privilege the committed REVOKE clauses
 * name, for the table and the sequence, for PUBLIC and the two conditional
 * roles. `anon` and `authenticated` are modelled as ABSENT, which is what a
 * disposable CI database has, so the assertion records absence rather than
 * asserting about privileges a nonexistent role cannot hold.
 */
const PRIVILEGE_ROWS = [
  ...['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    .map(privilege => ({ role_name: 'public', present: true, object_kind: 'table',
      privilege, granted: false })),
  ...['USAGE', 'SELECT', 'UPDATE']
    .map(privilege => ({ role_name: 'public', present: true, object_kind: 'sequence',
      privilege, granted: false })),
  ...['anon', 'authenticated'].flatMap(role => [
    ...['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
      .map(privilege => ({ role_name: role, present: false, object_kind: 'table',
        privilege, granted: null as boolean | null })),
    ...['USAGE', 'SELECT', 'UPDATE']
      .map(privilege => ({ role_name: role, present: false, object_kind: 'sequence',
        privilege, granted: null as boolean | null })),
  ]),
]

/** From 20261109150100_tenant_health_exact_source_index, in index order. */
/** The files this slice changes, copied into an observation clone. */
const SCOPED_SOURCE = [
  'backend/scripts/haw70-upgrade-runner.ts',
  'backend/scripts/haw70-upgrade-witness.ts',
  'backend/scripts/haw70-upgrade-runner.test.ts',
  'backend/scripts/haw70-upgrade-import-observer.mjs',
  'backend/scripts/haw70-upgrade-pg-stub.mjs',
  'backend/docs/haw70-upgrade-runner.md',
  'backend/tsconfig.haw70-scripts.json',
]

const EXACT_INDEX_KEY_COLUMNS =
  'id,organization_id,customer_tenant_id,source_incarnation,source_revision,observation_sequence'

/** Read from the staged tree, so the history oracle is not the driver's own. */
const stageParent = realpathSync(mkdtempSync(join(scratch, 'stage-')))
const stagedRoot = (() => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { materializeHaw70UpgradeSource } from ${JSON.stringify(join(backend, 'scripts/haw70-upgrade-materializer.mjs'))}
    const staged = materializeHaw70UpgradeSource({
      repositoryRoot: ${JSON.stringify(repositoryRoot)},
      expectedCandidateCommit: ${JSON.stringify(head)},
      scratchParent: ${JSON.stringify(stageParent)} })
    process.stdout.write(staged.outputRoot)
  `], { encoding: 'utf8', timeout: 180_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
})()

interface HistoryRow {
  id: string; migration_name: string; checksum: string
  started_at: string | null; finished_at: string | null; rolled_back_at: string | null
  steps: number; logs: string | null; finished: boolean; rolled_back: boolean
}
/**
 * Every field is derived from the migration NAME, never from its position.
 *
 * This models what actually happens: the baseline deployment writes those
 * rows, and the candidate deployment only APPENDS, so a migration present in
 * both sets must carry the identical complete row in both. Deriving `id` and
 * the timestamps from the row's index instead made the two lists disagree
 * about every shared migration whose position shifted, and the new
 * field-for-field retention check caught that immediately -- correctly, since
 * a baseline row whose id changed during the upgrade is exactly what it exists
 * to detect.
 */
function stageMigrations(stage: 'baseline' | 'candidate'): HistoryRow[] {
  const root = join(stagedRoot, stage, 'migrations')
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9]{14}_/.test(entry.name))
    .map(entry => entry.name).sort()
    .map(name => {
      const digest = sha256(name)
      const stamp = /^([0-9]{4})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{2})_/.exec(name)
      assert.ok(stamp !== null, name)
      const [, year, month, day, hour, minute, second] = stamp
      return {
        id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}`
          + `-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
        migration_name: name,
        checksum: sha256(readFileSync(join(root, name, 'migration.sql'))),
        // Microsecond precision, deliberately: a client-side Date would
        // truncate it and make a changed timestamp look unchanged.
        started_at: `${year}-${month}-${day} ${hour}:${minute}:${second}.123456+00`,
        finished_at: `${year}-${month}-${day} ${hour}:${minute}:${second}.654321+00`,
        rolled_back_at: null, steps: 1, logs: null, finished: true, rolled_back: false,
      }
    })
}
const BASELINE_ROWS = stageMigrations('baseline')
const CANDIDATE_ROWS = stageMigrations('candidate')

const constraint = (conname: string, relation: string, contype: string,
  local_columns: string, referenced_relation: string | null, referenced_columns: string | null,
  confupdtype: string, confdeltype: string, condeferrable: boolean, condeferred: boolean,
  definition: string) => ({ conname, relation, contype, convalidated: true,
  condeferrable, condeferred, confupdtype, confdeltype, definition,
  referenced_relation, local_columns, referenced_columns })

const CATALOG = {
  exactIndex: [{ indisunique: true, indisvalid: true, indisready: true,
    definition: 'CREATE UNIQUE INDEX tenant_health_snapshots_exact_source_key ON public.tenant_health_snapshots USING btree (id, organization_id, customer_tenant_id, source_incarnation, source_revision, observation_sequence)',
    key_columns: EXACT_INDEX_KEY_COLUMNS }],
  // Ordered key columns and actions transcribed from the migrations, with the
  // definition rendered as PostgreSQL would render it.
  constraints: [
    constraint('tenant_health_snapshots_source_tag_complete', 'tenant_health_snapshots', 'c',
      'source_incarnation,source_revision,observation_sequence', null, null, ' ', ' ', false, false,
      'CHECK ((num_nonnulls(source_incarnation, source_revision, observation_sequence) = ANY (ARRAY[0, 3])))'),
    constraint('tenant_health_snapshots_source_revision_positive', 'tenant_health_snapshots', 'c',
      'source_revision', null, null, ' ', ' ', false, false,
      'CHECK (((source_revision IS NULL) OR (source_revision > 0)))'),
    constraint('tenant_health_snapshots_observation_sequence_positive', 'tenant_health_snapshots', 'c',
      'observation_sequence', null, null, ' ', ' ', false, false,
      'CHECK (((observation_sequence IS NULL) OR (observation_sequence > 0)))'),
    constraint('tenant_health_snapshots_organization_id_fkey', 'tenant_health_snapshots', 'f',
      'organization_id', 'organizations', 'id', 'r', 'c', false, false,
      'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE CASCADE'),
    constraint('tenant_health_snapshots_customer_tenant_id_organization_id_fkey',
      'tenant_health_snapshots', 'f', 'customer_tenant_id,organization_id',
      'customer_tenants', 'id,organization_id', 'r', 'c', false, false,
      'FOREIGN KEY (customer_tenant_id, organization_id) REFERENCES customer_tenants(id, organization_id) ON UPDATE RESTRICT ON DELETE CASCADE'),
    constraint('tenant_health_source_authorities_exact_pointer_fkey',
      'tenant_health_source_authorities', 'f',
      'current_snapshot_id,organization_id,customer_tenant_id,incarnation,source_revision,current_observation_sequence',
      'tenant_health_snapshots',
      'id,organization_id,customer_tenant_id,source_incarnation,source_revision,observation_sequence',
      'a', 'a', true, true,
      'FOREIGN KEY (current_snapshot_id, organization_id, customer_tenant_id, incarnation, source_revision, current_observation_sequence) REFERENCES tenant_health_snapshots(id, organization_id, customer_tenant_id, source_incarnation, source_revision, observation_sequence) DEFERRABLE INITIALLY DEFERRED'),
    constraint('tenant_health_source_authorities_organization_id_fkey',
      'tenant_health_source_authorities', 'f', 'organization_id', 'organizations', 'id',
      'r', 'c', false, false,
      'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE CASCADE'),
  ],
  authorityRelation: [{ relrowsecurity: true, relforcerowsecurity: false, acl_entries: 1 }],
  observationSequence: [{ last_value: '1', is_called: false }],
}

/* ================================ the environment ================================ */

const REF = 'refs/heads/codex/haw70-staged-upgrade-runner-20261123'
const environmentFor = (overrides: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'dharmik0431/hawkview-app', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com', GITHUB_WORKFLOW: 'Required quality gates',
    GITHUB_JOB: 'backend-quality', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    GITHUB_REF: REF,
    GITHUB_WORKFLOW_REF: `dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@${REF}`,
    GITHUB_RUN_ID: '45250533221', GITHUB_RUN_ATTEMPT: '1',
    // The candidate is a CLAIM the target guard validates, and it is the only
    // source of the commit now: NO HAWKVIEW_HAW70_STAGE_* key is supplied,
    // because the driver materializes and derives its own stage.
    GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head,
    HAWKVIEW_CI_MIGRATION_PROFILE: 'haw70-upgrade', HAWKVIEW_RUN_HAW70_UPGRADE: '1',
    HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS: '1', HAWKVIEW_CI_DISPOSABLE_POSTGRES: '1',
    HAWKVIEW_HAW70_TENANT_DELETE_WITNESS: '1', HAWKVIEW_HAW70_AUDIT_WRITER_WITNESS: '1',
    HAWKVIEW_HAW70_DELETE_LOCK_ORDER_WITNESS: '1',
    DATABASE_URL: 'postgresql://hawkview_ci:hawkview_ci@127.0.0.1:5432/hawkview_ci',
    JITI_FS_CACHE: 'false', TZ: 'UTC',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key]
    else base[key] = value
  }
  return base
}

/* ============================== the fake transport ============================== */

type Rows = Record<string, unknown>[]
interface Store {
  orgs: { primary: string; secondary: string }
  tenants: string[]
  snapshotIds: string[]
  syncState: string
  contentMatchedTranscription: boolean
  cleaned: boolean
}
interface Ctx { call: number; parameters: readonly unknown[]; store: Store; base: Rows }
type Override = (ctx: Ctx) => Rows
const copy = (rows: Rows): Rows => rows.map(row => ({ ...row }))

function fakeBoundary(overrides: Record<string, Override> = {}, options: {
  deploy?: (request: Haw70DeployRequest, call: number) => Partial<Haw70DeployOutcome>
  rejectQuery?: string
  rejectClose?: boolean
  rejectConnect?: boolean
  rejectQualify?: boolean
} = {}) {
  const queries: { name: string; sql: string; parameters?: readonly unknown[] }[] = []
  const deploys: Haw70DeployRequest[] = []
  const counts = new Map<string, number>()
  const store: Store = { orgs: { primary: '', secondary: '' }, tenants: [], snapshotIds: [],
    syncState: '', contentMatchedTranscription: false, cleaned: false }
  const qualified: Haw70QualifyRequest[] = []
  let closed = 0
  let connected = 0

  function observeInsert(name: string, parameters: readonly unknown[] = []): void {
    const p = parameters as string[]
    if (name === 'fixture:organizations') { store.orgs = { primary: p[0], secondary: p[3] } }
    if (name === 'fixture:customer_tenants') { store.tenants = [p[0], p[4], p[8]] }
    if (name === 'fixture:sync_states') { store.syncState = p[0] }
    if (name === 'fixture:tenant_health_snapshots') {
      store.snapshotIds = [p[0], p[7], p[14]]
      store.contentMatchedTranscription = PINNED_SNAPSHOTS.every((row, index) => {
        const o = index * 7
        return p[o + 1] === store.orgs.primary && p[o + 2] === store.tenants[0]
          && (p[o + 3] as unknown) === row.model && p[o + 4] === row.status
          && p[o + 5] === row.payload && p[o + 6] === row.at
      })
    }
  }

  // Answers by query NAME. The driver's parameter scoping is asserted in the
  // success test from the recorded query log, not here, so this deliberately
  // takes no parameters rather than accepting one it would not read.
  function baseRows(name: string, call: number): Rows {
    switch (name) {
      case 'serverIdentity': return [{ database: 'hawkview_ci', user: 'hawkview_ci', port: 5432,
        version_num: '160004', time_zone: 'UTC' }]
      case 'targetEmptiness': return [{ public_objects: '0', history_present: false }]
      case 'history': return copy((call === 1 ? BASELINE_ROWS : CANDIDATE_ROWS) as unknown as Rows)
      case 'fixtureSnapshots': return store.cleaned ? [] : PINNED_SNAPSHOTS.map((row, index) => ({
        id: store.snapshotIds[index], organization_id: store.orgs.primary,
        customer_tenant_id: store.tenants[0], health_model_version: row.model,
        overall_status: row.status, payload: row.payload, evaluated_at: row.at }))
      case 'fixtureTenants': return store.cleaned ? [] : store.tenants.map((id, index) => ({ id,
        organization_id: index === 2 ? store.orgs.secondary : store.orgs.primary,
        microsoft_tenant_id: `ms-${index}`, display_name: 'HAW-70 fixture', status: 'ACTIVE' }))
      case 'fixtureSyncStates': return store.cleaned ? [] : [{ id: store.syncState,
        organization_id: store.orgs.primary, customer_tenant_id: store.tenants[1],
        resource_type: 'USERS', status: 'IDLE', consecutive_failures: 0, delta_link: null }]
      case 'fixtureOrganizations': return [store.orgs.primary, store.orgs.secondary]
        .map((id, index) => ({ id, name: `HAW-70 fixture ${index}`, slug: `haw70-${index}`,
          status: 'ACTIVE' }))
      case 'snapshotTags': return store.snapshotIds.map(id => ({ id,
        source_incarnation: null, source_revision: null, observation_sequence: null }))
      // After cleanup these are the TOMBSTONES the committed delete trigger
      // writes: live false, pointer cleared, sequence zero, revision 1 -> 2.
      // After cleanup these are the TOMBSTONES the committed triggers write.
      // The revisions are NOT uniform: cleanup deletes the sibling's
      // sync-state row first, and
      // `tenant_health_sync_state_delete_invalidate` advances that live
      // authority 1 -> 2; the tenant delete then advances all three and marks
      // them dead, so the sibling (index 1) reaches 3 and the others reach 2.
      case 'authorities': return store.tenants.map((tenant, index) => ({
        organization_id: index === 2 ? store.orgs.secondary : store.orgs.primary,
        customer_tenant_id: tenant,
        incarnation: `0000000${index}-0000-4000-8000-00000000000${index}`,
        source_revision: store.cleaned ? (index === 1 ? '3' : '2') : '1',
        live: !store.cleaned,
        current_snapshot_id: null, current_observation_sequence: '0' }))
      case 'exactIndex': return copy(CATALOG.exactIndex)
      case 'constraints': return copy(CATALOG.constraints)
      case 'authorityRelation': return copy(CATALOG.authorityRelation)
      case 'privileges': return copy(PRIVILEGE_ROWS as unknown as Rows)
      case 'observationSequence': return copy(CATALOG.observationSequence)
      case 'triggers': return copy(TRUNCATE_GUARDS)
      case 'writerTriggers': return copy(WRITER_TRIGGERS)
      // DELETE ... RETURNING "id": the rows the driver now counts.
      case 'cleanup:snapshots': return store.snapshotIds.map(id => ({ id }))
      case 'cleanup:syncStates': return [{ id: store.syncState }]
      case 'cleanup:tenants': {
        const deleted = store.tenants.map(id => ({ id }))
        store.cleaned = true
        return deleted
      }
      default: return []
    }
  }

  const session: Haw70Session = {
    async query(name, sql, parameters) {
      queries.push({ name, sql, parameters })
      if (options.rejectQuery !== undefined && name === options.rejectQuery) {
        throw new Error('fake transport rejection carrying postgresql://secret@host/db')
      }
      const call = (counts.get(name) ?? 0) + 1
      counts.set(name, call)
      if (name.startsWith('fixture:')) { observeInsert(name, parameters); return Object.freeze([]) as never[] }
      const base = baseRows(name, call)
      const override = overrides[name]
      return Object.freeze((override === undefined
        ? base : override({ call, parameters: parameters ?? [], store, base })) as never[])
    },
    async close() {
      closed += 1
      if (options.rejectClose === true) throw new Error('fake close rejection')
    },
  }
  const boundary: Haw70UpgradeBoundary = Object.freeze({
    async qualify(request: Haw70QualifyRequest) {
      qualified.push(request)
      if (options.rejectQualify === true) throw new Error('fake tool qualification rejection')
    },
    async connect() {
      connected += 1
      if (options.rejectConnect === true) throw new Error('fake connect rejection')
      return session
    },
    async deploy(request: Haw70DeployRequest) {
      deploys.push(request)
      const override = options.deploy?.(request, deploys.length) ?? {}
      return Object.freeze({ status: 0, signal: null, timedOut: false, outputBytes: 1024,
        argv: Object.freeze([]), environmentKeys: Object.freeze([]), ...override }) as Haw70DeployOutcome
    },
  })
  return { boundary, queries, deploys, store, qualified,
    state: () => ({ closed, connected }) }
}

const run = (overrides: Record<string, Override> = {},
  options?: Parameters<typeof fakeBoundary>[1], environment = environmentFor()) => {
  const harness = fakeBoundary(overrides, options)
  return executeHaw70UpgradeStages(environment, harness.boundary)
    .then(outcome => ({ outcome, harness }))
}

/* ================================== the tests ================================== */

test('the exported phase order is the order the body runs', () => {
  // materialize BEFORE connect and target-empty, which is what the body does.
  // Pinning the constant's own earlier (wrong) order made a returned
  // `phase: 'materialize'` read as "connected, target proved empty".
  // ALL SEVENTEEN, in order. Pinning only the first six left positions 7-16
  // free to be permuted exactly as 3-5 had been.
  assert.deepEqual([...HAW70_UPGRADE_PHASES], [
    'validate-context', 'validate-source', 'materialize', 'qualify-tools', 'connect',
    'target-empty', 'baseline-deploy', 'baseline-history', 'legacy-fixture', 'candidate-deploy',
    'candidate-history', 'preservation', 'backfill', 'catalog', 'no-op-deploy',
    'no-op-verify', 'cleanup', 'completed',
  ])
  assert.equal(new Set(HAW70_UPGRADE_PHASES).size, HAW70_UPGRADE_PHASES.length)
  // And the body assigns them in exactly that order, read from the source
  // rather than assumed: the constant agreeing with itself proves nothing.
  const assigned = [...stripComments(
    readFileSync(join(import.meta.dirname, 'haw70-upgrade-runner.ts'), 'utf8'))
    .matchAll(/phase = '([a-z-]+)'/g)].map(match => match[1])
  assert.deepEqual(assigned, [...HAW70_UPGRADE_PHASES].slice(1))
})

test('the public entry refuses a wrong context before any connection or launch', async () => {
  for (const [label, overrides, expected] of [
    ['absent profile', { HAWKVIEW_CI_MIGRATION_PROFILE: undefined }, 'migration profile'],
    ['wrong profile', { HAWKVIEW_CI_MIGRATION_PROFILE: 'e2-migration' }, 'migration profile'],
    ['absent opt-in', { HAWKVIEW_RUN_HAW70_UPGRADE: undefined }, 'upgrade opt-in'],
    ['loader cache on', { JITI_FS_CACHE: 'true' }, 'loader cache setting'],
    ['absent loader setting', { JITI_FS_CACHE: undefined }, 'loader cache setting'],
    ['wrong timezone', { TZ: 'America/New_York' }, 'timezone setting'],
    ['ambient preload', { NODE_OPTIONS: '--require /tmp/evil.js' }, 'ambient control'],
    ['ambient module path', { NODE_PATH: '/tmp/evil' }, 'ambient control'],
    ['ambient routing', { PGHOST: '127.0.0.1' }, 'ambient control'],
    ['ambient service file', { PGSERVICEFILE: '/tmp/pg.conf' }, 'ambient control'],
    ['ambient dotenv', { DOTENV_CONFIG_PATH: '/tmp/.env' }, 'ambient control'],
    ['ambient proxy', { HTTPS_PROXY: 'http://proxy.invalid:8080' }, 'ambient control'],
    ['ambient lowercase proxy', { https_proxy: 'http://proxy.invalid:8080' }, 'ambient control'],
    // The driver owns its stage. An externally supplied handoff is the second
    // authority path the design refuses, and the entry refuses it too rather
    // than leaving it to whichever check runs first.
    ['external stage root', { HAWKVIEW_HAW70_STAGE_ROOT: stagedRoot }, 'external stage handoff'],
    ['external stage name', { HAWKVIEW_HAW70_STAGE_NAME: 'candidate' }, 'external stage handoff'],
    ['external stage candidate', { HAWKVIEW_HAW70_STAGE_CANDIDATE: head }, 'external stage handoff'],
  ] as [string, Record<string, string | undefined>, string][]) {
    const outcome = await runHaw70StagedUpgrade({ environment: environmentFor(overrides) })
    assert.equal(outcome.completed, false, label)
    assert.equal(outcome.phase, 'validate-context', label)
    assert.equal(outcome.failure, expected, label)
    assert.equal(outcome.counts.deployments, 0, label)
  }
  for (const extra of [{ boundary: {} }, { deploy: () => undefined }, { executable: '/bin/sh' },
    { receipt: { kind: 'forged' } }, { session: {} }, { skipValidation: true }]) {
    const outcome = await runHaw70StagedUpgrade({ environment: environmentFor(), ...extra } as never)
    assert.equal(outcome.failure, 'public input shape', JSON.stringify(Object.keys(extra)))
    assert.equal(outcome.counts.deployments, 0)
  }
})

test('the platform and runtime gates read actual facts, not the claim strings', () => {
  // DELIBERATELY A SOURCE ASSERTION, AND NOT A CALL. Invoking the real entry
  // with a clean environment is UNSAFE: the gate order is profile, opt-in,
  // loader cache, timezone, ambient, stage, and only THEN process.platform,
  // so on the Linux runner this suite is meant to be registered on a clean
  // snapshot would pass every gate and go on to a real client and a real CLI.
  const raw = readFileSync(join(import.meta.dirname, 'haw70-upgrade-runner.ts'), 'utf8')
  // STRIPPED of comments before matching. Against the raw file, commenting the
  // two gates out would still satisfy these patterns -- the same prose-matches-
  // its-own-denial mistake this suite already had to fix once.
  const code = stripComments(raw)
  assert.match(code, /if \(process\.platform !== 'linux'\) return refusal\('runtime platform'\)/)
  assert.match(code, /if \(!\/\^v22\\\.\/\.test\(process\.version\)\) return refusal\('runtime version'\)/)
  assert.doesNotMatch(code, /environment\.RUNNER_OS/)
  // CONTROL ON THE STRIPPER, in both directions.
  assert.ok(/ACTUAL runtime, not a claim/.test(raw))
  assert.equal(/ACTUAL runtime, not a claim/.test(code), false)
  assert.ok(code.includes("refusal('runtime platform')"))
})

test('the trigger parser handles the forms the catalog can actually report', () => {
  // THE PURE PARSER, with authored SQL. Nothing in the committed candidate set
  // drops a trigger, so the DROP arm would otherwise have no coverage at all,
  // and the ONLY / quoted-identifier forms none either.
  const parse = (sql: string) => {
    const into = new Map<string, Haw70TriggerDeclaration>()
    haw70ApplyTriggerDeclarations(into, sql)
    return [...into.values()].map(row =>
      `${row.relation}:${row.trigger}:${row.fn}:truncate=${row.truncate}:always=${row.always}:row=${row.forEachRow}`)
      .sort()
  }
  // A multi-event list containing TRUNCATE is a TRUNCATE trigger.
  assert.deepEqual(parse(`CREATE TRIGGER g BEFORE UPDATE OR DELETE OR TRUNCATE
    ON public.t FOR EACH STATEMENT EXECUTE FUNCTION public.f();`),
  ['t:g:f:truncate=true:always=false:row=false'])
  // An event list without TRUNCATE is not.
  assert.deepEqual(parse('CREATE TRIGGER g BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();'),
    ['t:g:f:truncate=false:always=false:row=true'])
  // ENABLE ALWAYS is recognized bare, qualified, with ONLY, and quoted.
  for (const alter of ['ALTER TABLE t ENABLE ALWAYS TRIGGER g;',
    'ALTER TABLE public.t ENABLE ALWAYS TRIGGER g;',
    'ALTER TABLE ONLY public.t ENABLE ALWAYS TRIGGER g;',
    'ALTER TABLE ONLY public."t" ENABLE ALWAYS TRIGGER "g";']) {
    assert.deepEqual(parse(`CREATE TRIGGER g BEFORE TRUNCATE ON public.t
      FOR EACH STATEMENT EXECUTE FUNCTION f();\n${alter}`),
    ['t:g:f:truncate=true:always=true:row=false'], alter)
  }
  // ENABLE ALWAYS naming a DIFFERENT trigger or relation must not apply.
  assert.deepEqual(parse(`CREATE TRIGGER g BEFORE TRUNCATE ON public.t
    FOR EACH STATEMENT EXECUTE FUNCTION f();
    ALTER TABLE other ENABLE ALWAYS TRIGGER g;
    ALTER TABLE t ENABLE ALWAYS TRIGGER elsewhere;`),
  ['t:g:f:truncate=true:always=false:row=false'])
  // DROP removes it, with and without IF EXISTS, and only the named one.
  assert.deepEqual(parse(`CREATE TRIGGER g BEFORE TRUNCATE ON public.t
    FOR EACH STATEMENT EXECUTE FUNCTION f();
    DROP TRIGGER g ON public.t;`), [])
  assert.deepEqual(parse(`CREATE TRIGGER g BEFORE TRUNCATE ON public.t
    FOR EACH STATEMENT EXECUTE FUNCTION f();
    DROP TRIGGER IF EXISTS g ON t;`), [])
  assert.deepEqual(parse(`CREATE TRIGGER g BEFORE TRUNCATE ON public.t
    FOR EACH STATEMENT EXECUTE FUNCTION f();
    DROP TRIGGER g ON public.other;`),
  ['t:g:f:truncate=true:always=false:row=false'])
  // A later migration's DROP wins over an earlier CREATE, which is why the
  // real derivation walks the migration directories in sorted order.
  const across = new Map<string, Haw70TriggerDeclaration>()
  haw70ApplyTriggerDeclarations(across,
    'CREATE TRIGGER g BEFORE TRUNCATE ON public.t FOR EACH STATEMENT EXECUTE FUNCTION f();')
  haw70ApplyTriggerDeclarations(across, 'DROP TRIGGER g ON public.t;')
  assert.equal(across.size, 0)
})

test('the executable-source guard refuses modified or absent tracked source', () => {
  // The PURE parser, exercised with authored status records. No repository
  // state is needed, so the refusal logic is tested rather than inferred.
  assert.ok(HAW70_EXECUTABLE_SOURCE.includes('backend/scripts/haw70-upgrade-runner.ts'))
  assert.ok(HAW70_EXECUTABLE_SOURCE.includes('backend/scripts/haw70-upgrade-witness.ts'))
  assert.ok(HAW70_EXECUTABLE_SOURCE.includes('backend/prisma/haw70-upgrade.config.ts'))
  assert.deepEqual(haw70DirtyExecutableSource([]), [])
  assert.deepEqual(haw70DirtyExecutableSource([' M backend/scripts/haw70-upgrade-runner.ts']),
    ['M backend/scripts/haw70-upgrade-runner.ts'])
  assert.deepEqual(haw70DirtyExecutableSource(['?? backend/scripts/haw70-upgrade-witness.ts']),
    ['?? backend/scripts/haw70-upgrade-witness.ts'])
  assert.deepEqual(haw70DirtyExecutableSource([' D backend/prisma/haw70-upgrade.config.ts']),
    ['D backend/prisma/haw70-upgrade.config.ts'])
  // A rename record names both sides; the declared side is reported.
  assert.deepEqual(haw70DirtyExecutableSource(
    ['R  backend/scripts/old.ts -> backend/scripts/haw70-upgrade-runner.ts']),
  ['R backend/scripts/haw70-upgrade-runner.ts'])
  // NEGATIVE CONTROL: an unrelated dirty file is not reported, so the guard is
  // scoped to the declared executable source rather than to the whole tree.
  assert.deepEqual(haw70DirtyExecutableSource([' M README.md',
    ' M backend/src/auth/auth.service.ts', '?? notes.txt']), [])
  // And the selected migration manifest is NOT what covers these files.
  assert.ok(!HAW70_EXECUTABLE_SOURCE.some(path => path.includes('prisma/migrations/')))
})

test('the fixed child request carries the actual argv, cwd and full key values', () => {
  // THE REAL BUILDER the adapter calls, observed directly. Searching the
  // source for an expected token would still accept a wrong value assigned to
  // a projected key or a wrong cwd.
  const environment = environmentFor() as Record<string, string>
  const paths = {
    nodeExecutable: '/usr/local/bin/node',
    prismaCliEntry: join(backend, 'node_modules/prisma/build/index.js'),
    dedicatedConfig: join(backend, 'prisma/haw70-upgrade.config.ts'),
    backend,
  }
  const launch = haw70ChildLaunchRequest({ stage: 'baseline', stageRoot: stagedRoot,
    candidateCommit: head, datasourceUrl: String(environment.DATABASE_URL), environment, paths })

  assert.equal(launch.executable, '/usr/local/bin/node')
  assert.deepEqual([...launch.argv],
    [paths.prismaCliEntry, 'migrate', 'deploy', '--config', paths.dedicatedConfig])
  assert.equal(launch.cwd, backend)
  // THE VALUES, not just the key inventory.
  assert.equal(Object.keys(launch.env).length, 33)
  assert.equal(launch.env.HAWKVIEW_HAW70_STAGE_ROOT, stagedRoot)
  assert.equal(launch.env.HAWKVIEW_HAW70_STAGE_NAME, 'baseline')
  assert.equal(launch.env.HAWKVIEW_HAW70_STAGE_CANDIDATE, head)
  assert.equal(launch.env.GITHUB_SHA, head)
  assert.equal(launch.env.GITHUB_WORKFLOW_SHA, head)
  assert.equal(launch.env.DATABASE_URL, environment.DATABASE_URL)
  assert.equal(launch.env.PATH, '/usr/bin:/bin')
  assert.equal(launch.env.TZ, 'UTC')
  assert.equal(launch.env.JITI_FS_CACHE, 'false')
  assert.equal(launch.env.RUNNER_OS, 'Linux')
  // The four carried keys come from the snapshot, not from a fixed literal.
  assert.equal(launch.env.GITHUB_REF, environment.GITHUB_REF)
  assert.equal(launch.env.GITHUB_WORKFLOW_REF, environment.GITHUB_WORKFLOW_REF)
  assert.equal(launch.env.GITHUB_RUN_ID, environment.GITHUB_RUN_ID)
  assert.equal(launch.env.GITHUB_RUN_ATTEMPT, environment.GITHUB_RUN_ATTEMPT)
  // NOTHING ambient leaks in, including a variable present in this process.
  for (const key of ['HOME', 'USER', 'SHELL', 'NODE_OPTIONS', 'PGHOST', 'npm_config_registry']) {
    assert.equal(Object.hasOwn(launch.env, key), false, key)
  }
  // A missing carried key refuses rather than projecting an empty string.
  for (const carried of ['GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    assert.throws(() => haw70ChildLaunchRequest({ stage: 'candidate', stageRoot: stagedRoot,
      candidateCommit: head, datasourceUrl: 'postgresql://u:p@127.0.0.1:5432/d',
      environment: environmentFor({ [carried]: undefined }) as Record<string, string>, paths }),
    /carried context key/, carried)
  }
  // The stage name is projected per deployment, which is why the child's
  // dedicated config resolves a different migrations directory each time.
  const candidate = haw70ChildLaunchRequest({ stage: 'candidate', stageRoot: stagedRoot,
    candidateCommit: head, datasourceUrl: String(environment.DATABASE_URL), environment, paths })
  assert.equal(candidate.env.HAWKVIEW_HAW70_STAGE_NAME, 'candidate')
  assert.notEqual(candidate.env.HAWKVIEW_HAW70_STAGE_NAME, launch.env.HAWKVIEW_HAW70_STAGE_NAME)
})

test('the connection options are explicit, with no ambient route or TLS guess', () => {
  const options = haw70ClientOptions(
    new URL('postgresql://hawkview_ci:s3cret@127.0.0.1:5432/hawkview_ci'))
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, 5432)
  assert.equal(options.database, 'hawkview_ci')
  assert.equal(options.user, 'hawkview_ci')
  assert.equal(options.password, 's3cret')
  assert.equal(options.ssl, false)
  assert.equal(options.application_name, 'haw70-staged-upgrade')
  assert.equal(options.options, '-c timezone=UTC')
  for (const key of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout', 'lock_timeout']) {
    assert.equal(typeof options[key], 'number', key)
    assert.ok(Number(options[key]) > 0, key)
  }
  // Percent-encoded credentials are decoded, so a password with reserved
  // characters is not silently sent in its encoded form.
  const encoded = haw70ClientOptions(new URL('postgresql://u%40ser:p%3Ass@127.0.0.1:5432/d'))
  assert.equal(encoded.user, 'u@ser')
  assert.equal(encoded.password, 'p:ss')
})

test('a correct fake progression crosses every stage in order with three deployments', async () => {
  const { outcome, harness } = await run()
  assert.equal(outcome.failure, null, String(outcome.failure))
  assert.equal(outcome.completed, true)
  assert.equal(outcome.phase, 'completed')
  assert.equal(outcome.counts.baselineMigrations, 80)
  assert.equal(outcome.counts.candidateMigrations, 94)
  assert.equal(outcome.counts.additions, 14)
  assert.equal(outcome.counts.fixtureTenants, 3)
  assert.equal(outcome.counts.fixtureSnapshots, 3)
  assert.equal(outcome.counts.authorityRows, 3)
  assert.equal(outcome.counts.deployments, 3)

  // The driver's own INSERT parameters carry the pinned content, checked
  // against the transcription rather than against anything it returned.
  assert.equal(harness.store.contentMatchedTranscription, true)
  assert.equal(new Set(harness.store.tenants).size, 3)
  assert.notEqual(harness.store.orgs.primary, harness.store.orgs.secondary)

  assert.deepEqual(harness.deploys.map(d => `${d.stage}:${d.attempt}`),
    ['baseline:1', 'candidate:1', 'candidate:2'])
  assert.ok(harness.deploys.every(d => d.stageRoot.startsWith('/') && d.candidateCommit === head))
  // The stage root the driver deployed is one IT created, not the one this
  // test materialized: no external stage reached it.
  assert.ok(harness.deploys.every(d => d.stageRoot !== stagedRoot))

  const names = harness.queries.map(q => q.name)
  const order = (name: string) => names.indexOf(name)
  const last = (name: string) => names.lastIndexOf(name)
  assert.ok(order('targetEmptiness') < order('begin'))
  assert.ok(order('begin') < order('commit'))
  assert.ok(order('commit') < order('snapshotTags'))
  assert.ok(order('authorities') < order('cleanup:snapshots'))
  // The no-op receipt re-reads the legacy state, so those queries appear
  // again after the catalog and before cleanup.
  assert.ok(last('fixtureSnapshots') > order('writerTriggers'))
  assert.ok(last('fixtureSyncStates') > order('writerTriggers'))
  assert.ok(names.includes('observationSequence'))
  assert.ok(names.includes('writerTriggers'))
  assert.ok(names.includes('fixtureOrganizations'))
  // Cleanup is child-first and every DELETE reports its rows.
  assert.deepEqual(names.filter(name => name.startsWith('cleanup:')),
    ['cleanup:snapshots', 'cleanup:syncStates', 'cleanup:tenants'])
  for (const query of harness.queries.filter(q => q.name.startsWith('cleanup:'))) {
    assert.match(query.sql, /RETURNING "id"/)
    assert.doesNotMatch(query.sql, /_prisma_migrations/)
  }
  // NO DESTRUCTIVE STATEMENT, scanned with STRING LITERALS REMOVED.
  //
  // The privilege query legitimately contains the word TRUNCATE -- as a
  // quoted privilege NAME inside `ARRAY['SELECT',...,'TRUNCATE',...]` -- so a
  // bare word scan flags a read-only query. That is the same mistake as a
  // forbidden-token search matching its own denial, and it is fixed the same
  // way: strip what cannot be a statement before scanning.
  const withoutLiterals = (sql: string): string => sql.replace(/'[^']*'/g, "''")
  const destructive = /\bTRUNCATE\b|\bDROP\s+(TABLE|SCHEMA)\b|\bDISABLE\s+TRIGGER\b|\bALTER\s+TABLE\b|\bCREATE\s+(TABLE|INDEX|TRIGGER|FUNCTION|SEQUENCE)\b/i
  for (const query of harness.queries) {
    assert.doesNotMatch(withoutLiterals(query.sql), destructive, query.name)
  }
  // CONTROLS ON THE STRIPPER, in both directions. The privilege query really
  // does contain the word before stripping and really does not after; and a
  // genuine destructive statement is still caught.
  const privilegeSql = harness.queries.find(query => query.name === 'privileges')
  assert.ok(privilegeSql !== undefined)
  assert.match(privilegeSql.sql, /TRUNCATE/)
  assert.doesNotMatch(withoutLiterals(privilegeSql.sql), destructive)
  assert.match(withoutLiterals('TRUNCATE TABLE "tenant_health_snapshots"'), destructive)
  assert.match(withoutLiterals('ALTER TABLE x DISABLE TRIGGER y'), destructive)
  assert.match(withoutLiterals('DROP TABLE x'), destructive)
  // Every parameterized read is scoped to an identifier the driver created.
  const ownedIds = new Set([...harness.store.tenants, ...harness.store.snapshotIds,
    harness.store.syncState, harness.store.orgs.primary, harness.store.orgs.secondary])
  for (const name of ['fixtureSnapshots', 'fixtureTenants', 'fixtureSyncStates',
    'snapshotTags', 'authorities', 'fixtureOrganizations']) {
    const calls = harness.queries.filter(query => query.name === name)
    assert.ok(calls.length >= 1, name)
    for (const call of calls) {
      const supplied = ((call.parameters ?? []) as unknown[]).flat() as string[]
      assert.ok(supplied.length >= 1, `${name} carried no scope`)
      for (const value of supplied) assert.ok(ownedIds.has(value), `${name} -> ${value}`)
    }
  }
  assert.equal(outcome.retained.length, 3)
  assert.ok(outcome.retained.some(line => /tombstone/i.test(line)))
  assert.deepEqual(harness.state(), { closed: 1, connected: 1 })
})

test('each independently authored defect fails at its own check and stops the run', async () => {
  const drop = (n: number): Override => ({ base }) => base.slice(n)
  // A `null` expectation means the row set is a LEGITIMATE alternative that
  // must still complete: a positive control inside the defect table.
  const cases: [string, Record<string, Override>, string | null][] = [
    ['pre-existing history', { targetEmptiness: () => [{ public_objects: '0', history_present: true }] },
      'pre-existing migration history'],
    ['pre-existing objects', { targetEmptiness: () => [{ public_objects: '3', history_present: false }] },
      'pre-existing application objects'],
    ['wrong server major', { serverIdentity: () => [{ database: 'hawkview_ci', user: 'hawkview_ci',
      port: 5432, version_num: '150008', time_zone: 'UTC' }] }, 'server major version'],
    ['missing baseline row', { history: ctx => ctx.call === 1 ? drop(1)(ctx) : ctx.base },
      'baseline history row count'],
    ['duplicate baseline migration', { history: ctx => ctx.call === 1
      ? [...ctx.base.slice(1), { ...ctx.base[1] }] : ctx.base },
    'baseline history duplicate migration'],
    ['wrong baseline checksum', { history: ctx => ctx.call === 1
      ? ctx.base.map((row, i) => i === 0 ? { ...row, checksum: 'f'.repeat(64) } : row) : ctx.base },
    'baseline history checksum'],
    ['unfinished baseline migration', { history: ctx => ctx.call === 1
      ? ctx.base.map((row, i) => i === 0 ? { ...row, finished: false } : row) : ctx.base },
    'baseline history unfinished migration'],
    ['rolled-back baseline migration', { history: ctx => ctx.call === 1
      ? ctx.base.map((row, i) => i === 0 ? { ...row, rolled_back: true } : row) : ctx.base },
    'baseline history rolled-back migration'],
    ['zero applied steps', { history: ctx => ctx.call === 1
      ? ctx.base.map((row, i) => i === 0 ? { ...row, steps: 0 } : row) : ctx.base },
    'baseline history applied step count'],
    ['candidate history short by one row', { history: ctx => ctx.call === 1
      ? ctx.base : ctx.base.slice(1) }, 'candidate history row count'],
    // THE PREVIOUSLY UNOBSERVABLE FIELDS. Each of these changes a baseline row
    // in a column the old reduced projection never selected, so each would
    // have passed both retention and the no-op comparison.
    ['changed baseline row id', { history: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => row.migration_name === BASELINE_ROWS[0].migration_name
        ? { ...row, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } : row) },
    'retained baseline history row'],
    ['changed baseline started_at', { history: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => row.migration_name === BASELINE_ROWS[0].migration_name
        ? { ...row, started_at: '2020-01-01 00:00:00.000000+00' } : row) },
    'retained baseline history row'],
    // A microsecond-level change, which a client-side Date would truncate away.
    ['changed baseline finished_at microseconds', { history: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => row.migration_name === BASELINE_ROWS[0].migration_name
        ? { ...row, finished_at: String(row.finished_at).replace('.654321', '.654322') } : row) },
    'retained baseline history row'],
    ['changed baseline logs', { history: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => row.migration_name === BASELINE_ROWS[0].migration_name
        ? { ...row, logs: 'rewritten' } : row) },
    'retained baseline history row'],
    ['changed baseline step count', { history: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => row.migration_name === BASELINE_ROWS[0].migration_name
        ? { ...row, steps: 2 } : row) },
    'retained baseline history row'],
    ['absent fixture after commit', { fixtureSnapshots: ctx => ctx.call === 1 ? [] : ctx.base },
      'fixture snapshot visibility'],
    ['missing fixture tenant', { fixtureTenants: ctx => ctx.call === 1 ? drop(1)(ctx) : ctx.base },
      'fixture tenant visibility'],
    ['absent sibling sync state', { fixtureSyncStates: ctx => ctx.call === 1 ? [] : ctx.base },
      'fixture sibling visibility'],
    ['mutated snapshot payload after upgrade', { fixtureSnapshots: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map((row, i) => i === 0 ? { ...row, payload: '{"tampered":true}' } : row) },
    'fixture snapshot preservation'],
    ['mutated sibling after upgrade', { fixtureSyncStates: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => ({ ...row, consecutive_failures: 7 })) },
    'fixture sibling preservation'],
    ['wrongly promoted legacy snapshot', { snapshotTags: ctx => ctx.base.map((row, i) => i === 0
      ? { ...row, source_incarnation: 'x', source_revision: '1', observation_sequence: '1' } : row) },
    'legacy snapshot tag nullity'],
    ['authority row count short', { authorities: drop(1) }, 'authority backfill inventory'],
    ['authority for an unrelated tenant', { authorities: ctx => ctx.base.map((row, i) => i === 0
      ? { ...row, customer_tenant_id: '99999999-9999-4999-8999-999999999999' } : row) },
    'authority backfill missing tenant'],
    ['authority in the wrong organization', { authorities: ctx => ctx.base.map((row, i) => i === 0
      ? { ...row, organization_id: '88888888-8888-4888-8888-888888888888' } : row) },
    'authority backfill scope'],
    ['authority revision not one', { authorities: ctx => ctx.base.map((row, i) => i === 0
      ? { ...row, source_revision: '3' } : row) }, 'authority revision'],
    ['authority already pointing at a snapshot', { authorities: ctx => ctx.base.map((row, i) => i === 0
      ? { ...row, current_snapshot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : row) },
    'authority pointer nullity'],
    ['duplicated incarnation', { authorities: ctx => ctx.base.map(row => ({ ...row,
      incarnation: '00000000-0000-4000-8000-000000000000' })) },
    'authority incarnation distinctness'],
    // ---- catalog ---------------------------------------------------------
    ['invalid exact index', { exactIndex: ctx => ctx.base.map(row => ({ ...row, indisvalid: false })) },
      'exact source index'],
    ['exact index over the wrong columns', { exactIndex: ctx => ctx.base.map(row => ({ ...row,
      key_columns: 'id,organization_id,customer_tenant_id' })) },
    'exact source index key columns'],
    ['unvalidated snapshot constraint', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_tag_complete'
        ? { ...row, convalidated: false } : row) }, 'snapshot constraint validation'],
    ['snapshot constraint of the wrong type', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_tag_complete'
        ? { ...row, contype: 'f' } : row) }, 'snapshot constraint type'],
    ['snapshot constraint checking something else', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_tag_complete'
        ? { ...row, definition: 'CHECK ((payload IS NOT NULL))' } : row) },
    'snapshot constraint expression'],
    // ---- semantics the earlier token test accepted -----------------------
    // A positivity constraint rewritten as `< 0` still contains the column
    // name, so the earliest `definition.includes(column)` test passed it.
    ['positivity inverted to negative-only', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_revision_positive'
        ? { ...row, definition: 'CHECK (((source_revision IS NULL) OR (source_revision < 0)))' }
        : row) }, 'snapshot constraint expression'],
    // THE TWO FORMS A FRAGMENT SET CANNOT REJECT. Both contain `IS NULL` and
    // `> 0`, so the previous per-fragment check accepted them.
    //
    // `AND` instead of `OR` rejects every positive value outright. It is
    // especially easy to miss here: the driver's legacy snapshots carry null
    // tags, for which the wrong expression evaluates to NULL and a CHECK
    // admits the row, so the fixture would not necessarily expose it.
    ['positivity joined with AND instead of OR', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_revision_positive'
        ? { ...row, definition: 'CHECK (((source_revision IS NULL) AND (source_revision > 0)))' }
        : row) }, 'snapshot constraint expression'],
    // An extra disjunct keeps both fragments and admits zero.
    ['positivity with an extra zero disjunct', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_revision_positive'
        ? { ...row, definition: 'CHECK (((source_revision IS NULL) OR (source_revision > 0) '
          + 'OR (source_revision = 0)))' } : row) }, 'snapshot constraint expression'],
    ['observation sequence joined with AND', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_observation_sequence_positive'
        ? { ...row, definition: 'CHECK (((observation_sequence IS NULL) '
          + 'AND (observation_sequence > 0)))' } : row) }, 'snapshot constraint expression'],
    ['observation sequence admitting zero', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_observation_sequence_positive'
        ? { ...row, definition: 'CHECK (((observation_sequence IS NULL) '
          + 'OR (observation_sequence >= 0)))' } : row) }, 'snapshot constraint expression'],
    ['tag completeness allowing a partial tag', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_tag_complete'
        ? { ...row, definition: 'CHECK ((num_nonnulls(source_incarnation, source_revision, observation_sequence) = ANY (ARRAY[0, 1, 3])))' }
        : row) }, 'snapshot constraint expression'],
    ['tag completeness over the wrong columns', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_tag_complete'
        ? { ...row, definition: 'CHECK ((num_nonnulls(source_incarnation, source_revision) '
          + '= ANY (ARRAY[0, 3])))' } : row) }, 'snapshot constraint expression'],
    // AND THE POSITIVE CONTROL: the alternative rendering PostgreSQL may emit
    // for the same committed constraint is ACCEPTED, so the complete-form
    // check is not merely pinning one literal string.
    ['tag completeness in the IN rendering is accepted', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_source_tag_complete'
        ? { ...row, definition: 'CHECK ((num_nonnulls(source_incarnation, source_revision, '
          + 'observation_sequence) IN (0, 3)))' } : row) }, null],
    ['exact pointer over the wrong local columns', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_exact_pointer_fkey'
        ? { ...row, local_columns: 'current_snapshot_id,organization_id' } : row) },
    'snapshot constraint key columns'],
    // Right columns, WRONG ORDER. The ordered `conkey` read is what makes
    // this detectable at all.
    ['exact pointer columns in the wrong order', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_exact_pointer_fkey'
        ? { ...row, referenced_columns: 'organization_id,id,customer_tenant_id,'
          + 'source_incarnation,source_revision,observation_sequence' } : row) },
    'snapshot constraint referenced columns'],
    ['exact pointer referencing the wrong relation', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_exact_pointer_fkey'
        ? { ...row, referenced_relation: 'tenant_entra_snapshots' } : row) },
    'snapshot constraint referenced relation'],
    ['exact pointer cascading on delete', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_exact_pointer_fkey'
        ? { ...row, confdeltype: 'c' } : row) }, 'snapshot constraint actions'],
    // THE TWO SNAPSHOT SCOPE FENCES, previously absent from the expectation.
    ['snapshot organization fence missing', { constraints: ctx => ctx.base
      .filter(row => row.conname !== 'tenant_health_snapshots_organization_id_fkey') },
    'snapshot constraint presence'],
    ['snapshot tenant fence missing', { constraints: ctx => ctx.base.filter(row =>
      row.conname !== 'tenant_health_snapshots_customer_tenant_id_organization_id_fkey') },
    'snapshot constraint presence'],
    ['snapshot tenant fence not cascading', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_customer_tenant_id_organization_id_fkey'
        ? { ...row, confdeltype: 'a' } : row) }, 'snapshot constraint actions'],
    ['snapshot tenant fence over one column', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_snapshots_customer_tenant_id_organization_id_fkey'
        ? { ...row, local_columns: 'customer_tenant_id' } : row) },
    'snapshot constraint key columns'],
    // ---- the full privilege contract ------------------------------------
    ['public holds table select', { privileges: ctx => ctx.base.map(row =>
      row.role_name === 'public' && row.object_kind === 'table' && row.privilege === 'SELECT'
        ? { ...row, granted: true } : row) }, 'authority public privileges'],
    // TRUNCATE, REFERENCES and TRIGGER were unobserved before.
    ['public holds table truncate', { privileges: ctx => ctx.base.map(row =>
      row.role_name === 'public' && row.privilege === 'TRUNCATE'
        ? { ...row, granted: true } : row) }, 'authority public privileges'],
    ['public holds table trigger', { privileges: ctx => ctx.base.map(row =>
      row.role_name === 'public' && row.privilege === 'TRIGGER'
        ? { ...row, granted: true } : row) }, 'authority public privileges'],
    // The SEQUENCE was entirely unobserved before.
    ['public holds sequence usage', { privileges: ctx => ctx.base.map(row =>
      row.role_name === 'public' && row.object_kind === 'sequence' && row.privilege === 'USAGE'
        ? { ...row, granted: true } : row) }, 'authority public privileges'],
    // A conditional role that EXISTS and holds a privilege must fail; one
    // that is absent is recorded, not asserted about.
    ['existing anon role holds a privilege', { privileges: ctx => ctx.base.map(row =>
      row.role_name === 'anon' && row.object_kind === 'table' && row.privilege === 'SELECT'
        ? { ...row, present: true, granted: true } : row) }, 'authority public privileges'],
    ['sequence privileges not observed at all', { privileges: ctx => ctx.base
      .filter(row => row.object_kind !== 'sequence') }, 'authority privilege observation'],
    ['no privilege rows for a required role', { privileges: ctx => ctx.base
      .filter(row => row.role_name !== 'authenticated') }, 'authority privilege observation'],
    // ---- writer timing, mode and events ---------------------------------
    ['writer trigger timing changed to BEFORE', { writerTriggers: ctx => ctx.base.map(row =>
      row.tgname === 'tenant_health_sync_state_delete_invalidate'
        ? { ...row, timing: 'BEFORE' } : row) }, 'writer trigger inventory'],
    ['writer trigger mode changed to ROW', { writerTriggers: ctx => ctx.base.map(row =>
      row.tgname === 'tenant_health_sync_state_delete_invalidate'
        ? { ...row, mode: 'ROW' } : row) }, 'writer trigger inventory'],
    ['writer trigger firing on the wrong event', { writerTriggers: ctx => ctx.base.map(row =>
      row.tgname === 'tenant_health_sync_state_delete_invalidate'
        ? { ...row, on_delete: false, on_insert: true } : row) }, 'writer trigger inventory'],
    // THE OMISSION THAT MATTERED: without the sync-state invalidator the
    // cleanup lifecycle this suite asserts cannot happen at all.
    ['sync-state delete invalidator absent', { writerTriggers: ctx => ctx.base
      .filter(row => row.tgname !== 'tenant_health_sync_state_delete_invalidate') },
    'writer trigger inventory'],
    ['audit invalidators absent', { writerTriggers: ctx => ctx.base
      .filter(row => row.relname !== 'directory_audit_logs') }, 'writer trigger inventory'],
    ['input-snapshot invalidators absent', { writerTriggers: ctx => ctx.base
      .filter(row => row.relname !== 'tenant_entra_snapshots') }, 'writer trigger inventory'],
    ['writer trigger set to replica-only', { writerTriggers: ctx => ctx.base.map(row =>
      row.tgname === 'tenant_health_sync_state_delete_invalidate'
        ? { ...row, tgenabled: 'R' } : row) }, 'writer trigger origin'],
    // The per-expectation loop checks deferral for every entry, so this trips
    // the general name rather than a separate pointer-specific one.
    ['non-deferred exact pointer', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_exact_pointer_fkey'
        ? { ...row, condeferred: false } : row) }, 'snapshot constraint deferral'],
    ['non-deferrable exact pointer', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_exact_pointer_fkey'
        ? { ...row, condeferrable: false } : row) }, 'snapshot constraint deferral'],
    ['authority scope fence not cascading', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_organization_id_fkey'
        ? { ...row, confdeltype: 'a' } : row) }, 'snapshot constraint actions'],
    ['authority scope fence not restricting updates', { constraints: ctx => ctx.base.map(row =>
      row.conname === 'tenant_health_source_authorities_organization_id_fkey'
        ? { ...row, confupdtype: 'c' } : row) }, 'snapshot constraint actions'],
    ['row level security off', { authorityRelation: ctx => ctx.base.map(row =>
      ({ ...row, relrowsecurity: false })) }, 'authority row level security'],
    ['observation sequence consumed', { observationSequence: () => [{ last_value: '7', is_called: true }] },
      'observation sequence consumed'],
    ['observation sequence restarted', { observationSequence: () => [{ last_value: '9', is_called: false }] },
      'observation sequence start'],
    ['truncate guard disabled', { triggers: ctx => ctx.base.map(row =>
      row.relname === 'tenant_health_snapshots' ? { ...row, tgenabled: 'D' } : row) },
    'truncate refusal trigger enabled'],
    ['truncate guard origin-only', { triggers: ctx => ctx.base.map(row =>
      row.relname === 'tenant_health_snapshots' ? { ...row, tgenabled: 'O' } : row) },
    'truncate refusal trigger always'],
    // 'R' is enabled and not disabled, and fires only on a replica. For the
    // one guard the SQL does NOT mark ALWAYS, the expected state is exactly
    // 'O', so a replica-only enablement is a change of where it applies.
    ['non-always guard set to replica-only', { triggers: ctx => ctx.base.map(row =>
      row.relname === 'tenant_health_reconciliation_generations'
        ? { ...row, tgenabled: 'R' } : row) },
    'truncate refusal trigger origin'],
    ['truncate guard missing on a relation', { triggers: ctx => ctx.base
      .filter(row => row.relname !== 'tenant_health_source_authorities') },
    'truncate refusal trigger presence'],
    ['truncate guard on an unexpected relation', { triggers: ctx => [...ctx.base,
      { relname: 'unrelated_table', tgname: 'tenant_health_refuse_truncate', tgenabled: 'A' }] },
    'truncate refusal trigger presence'],
    ['truncate guard renamed', { triggers: ctx => ctx.base.map(row =>
      row.relname === 'tenant_health_snapshots'
        ? { ...row, tgname: 'something_else_truncate_ish' } : row) },
    'truncate refusal trigger presence'],
    // ---- the writer inventory, previously not inspected at all -----------
    ['writer trigger missing', { writerTriggers: drop(1) }, 'writer trigger inventory'],
    ['writer trigger re-pointed at another function', { writerTriggers: ctx => ctx.base.map((row, i) =>
      i === 0 ? { ...row, function_name: 'some_other_function' } : row) },
    'writer trigger inventory'],
    ['writer trigger fires on nothing at all', { writerTriggers: ctx => ctx.base.map((row, i) =>
      i === 0 ? { ...row, on_insert: false, on_update: false, on_delete: false } : row) },
    'writer trigger inventory'],
    ['writer trigger disabled', { writerTriggers: ctx => ctx.base.map((row, i) =>
      i === 0 ? { ...row, tgenabled: 'D' } : row) }, 'writer trigger enabled'],
    // ---- the second deployment, now compared over ALL observed state -----
    ['authority drift on the second read', { authorities: ctx => ctx.call === 1 ? ctx.base
      : ctx.base.map(row => ({ ...row, source_revision: '2' })) }, 'second deployment no-op'],
    ['legacy payload changed by the second deployment', { fixtureSnapshots: ctx =>
      ctx.call <= 3 ? ctx.base
        : ctx.base.map((row, i) => i === 0 ? { ...row, payload: '{"second":true}' } : row) },
    'second deployment no-op'],
    ['sibling deleted by the second deployment', { fixtureSyncStates: ctx =>
      ctx.call <= 3 ? ctx.base : [] }, 'second deployment no-op'],
    // snapshotTags is read THREE times: preservation (1), the no-op "before"
    // capture (2) and the no-op "after" read (3). Gating on `call === 1`
    // mutated reads 2 and 3 identically, so the two sides of the comparison
    // agreed and the no-op passed -- the mutation has to land on read 3 alone.
    ['legacy tag promoted by the second deployment', { snapshotTags: ctx =>
      ctx.call <= 2 ? ctx.base
        : ctx.base.map((row, i) => i === 0 ? { ...row, source_revision: '1' } : row) },
    'second deployment no-op'],
    // ---- cleanup postconditions, previously unobserved -------------------
    ['cleanup deleted no snapshots', { 'cleanup:snapshots': () => [] },
      'cleanup deleted snapshot count'],
    ['cleanup deleted no sibling', { 'cleanup:syncStates': () => [] },
      'cleanup deleted sync state count'],
    ['cleanup deleted no tenants', { 'cleanup:tenants': ctx => { ctx.store.cleaned = true; return [] } },
      'cleanup deleted tenant count'],
    ['residual snapshots after cleanup', { fixtureSnapshots: ctx => ctx.call <= 4 ? ctx.base
      : [{ id: 'left-behind' }] }, 'cleanup residual snapshots'],
    ['tombstone still live', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map(row => ({ ...row, live: true })) : ctx.base }, 'retained tombstone liveness'],
    ['tombstone revision not incremented', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map(row => ({ ...row, source_revision: '1' })) : ctx.base },
    'retained tombstone revision'],
    // THE NEGATIVE CASE FOR THE SIBLING INVALIDATION. If the sync-state
    // delete had not advanced the sibling, every tombstone would sit at 2 --
    // which is exactly what the previous uniform expectation required, so
    // this case would have PASSED under it while the correct state failed.
    ['sibling never invalidated', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map(row => ({ ...row, source_revision: '2' })) : ctx.base },
    'retained tombstone revision'],
    ['sibling invalidated twice', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map((row, i) => i === 1 ? { ...row, source_revision: '4' } : row) : ctx.base },
    'retained tombstone revision'],
    ['a non-sibling also invalidated', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map((row, i) => i === 0 ? { ...row, source_revision: '3' } : row) : ctx.base },
    'retained tombstone revision'],
    ['tombstone incarnation replaced', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map((row, i) => i === 1
        ? { ...row, incarnation: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } : row) : ctx.base },
    'retained tombstone incarnation'],
    ['tombstone for an unrelated scope', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map((row, i) => i === 1
        ? { ...row, organization_id: '77777777-7777-4777-8777-777777777777' } : row) : ctx.base },
    'retained tombstone scope'],
    ['tombstone pointer still set', { authorities: ctx => ctx.store.cleaned
      ? ctx.base.map(row => ({ ...row, current_snapshot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
      : ctx.base }, 'retained tombstone pointer'],
    ['organizations cascaded away', { fixtureOrganizations: () => [] },
      'retained organization inventory'],
  ]
  for (const [label, overrides, expected] of cases) {
    const { outcome, harness } = await run(overrides)
    if (expected === null) {
      assert.equal(outcome.failure, null, label)
      assert.equal(outcome.completed, true, label)
      assert.equal(harness.state().closed, 1, label)
      continue
    }
    assert.equal(outcome.completed, false, label)
    assert.equal(outcome.failure, expected, label)
    assert.equal(harness.state().closed, 1, label)
    assert.notEqual(outcome.phase, 'completed', label)
  }
})

test('a bad context or candidate claim stops the core before it stages anything', async () => {
  for (const [label, overrides, expected] of [
    ['external stage root', { HAWKVIEW_HAW70_STAGE_ROOT: stagedRoot }, 'external stage handoff'],
    ['absent candidate claim', { GITHUB_SHA: undefined }, 'candidate claim shape'],
    ['short candidate claim', { GITHUB_SHA: 'abc123' }, 'candidate claim shape'],
    ['disagreeing workflow sha', { GITHUB_WORKFLOW_SHA: 'a'.repeat(40) }, 'candidate claim agreement'],
  ] as [string, Record<string, string | undefined>, string][]) {
    const { outcome, harness } = await run({}, {}, environmentFor(overrides))
    assert.equal(outcome.failure, expected, label)
    assert.equal(outcome.phase, 'validate-context', label)
    assert.equal(harness.deploys.length, 0, label)
    assert.equal(harness.state().connected, 0, label)
  }
})

test('a failed, signalled, timed-out or oversized deployment stops at that stage', async () => {
  for (const [label, override, failure] of [
    ['nonzero exit', { status: 1 }, 'baseline deployment exit status'],
    ['signal', { status: null, signal: 'SIGKILL' }, 'baseline deployment signal'],
    ['timeout', { timedOut: true }, 'baseline deployment timeout'],
    ['output bound', { outputBytes: (1 << 20) + 1 }, 'baseline deployment output bound'],
  ] as [string, Partial<Haw70DeployOutcome>, string][]) {
    const { outcome, harness } = await run({}, { deploy: () => override })
    assert.equal(outcome.failure, failure, label)
    assert.equal(outcome.phase, 'baseline-deploy', label)
    assert.equal(harness.deploys.length, 1, label)
    assert.equal(harness.queries.filter(q => q.name === 'history').length, 0, label)
    assert.equal(harness.state().closed, 1, label)
  }
  const candidate = await run({}, { deploy: (_r, call) => (call === 2 ? { status: 2 } : {}) })
  assert.equal(candidate.outcome.failure, 'candidate deployment exit status')
  assert.equal(candidate.outcome.phase, 'candidate-deploy')
  assert.equal(candidate.harness.queries
    .filter(q => /snapshotTags|authorities|cleanup:/.test(q.name)).length, 0)
  const repeat = await run({}, { deploy: (_r, call) => (call === 3 ? { status: 3 } : {}) })
  assert.equal(repeat.outcome.failure, 'repeat deployment exit status')
  assert.equal(repeat.harness.deploys.length, 3)
  assert.equal(repeat.harness.queries.filter(q => q.name.startsWith('cleanup:')).length, 0)
})

test('owned resources close, and a close failure cannot hide under a success', async () => {
  // A CLOSE FAILURE ON THE OTHERWISE SUCCESSFUL PATH IS A FAILURE. The earlier
  // form built the completed result first and then discarded every close
  // rejection in `finally`, so a caller could be told `completed: true` while
  // the owned session had not been released.
  const closeFails = await run({}, { rejectClose: true })
  assert.equal(closeFails.outcome.completed, false)
  assert.equal(closeFails.outcome.failure, 'owned session close')
  assert.equal(closeFails.outcome.phase, 'cleanup')
  assert.equal(closeFails.harness.state().closed, 1)

  // On an ALREADY FAILING path the first failure is preserved, not replaced.
  const bothFail = await run({ targetEmptiness: () => [{ public_objects: '0', history_present: true }] },
    { rejectClose: true })
  assert.equal(bothFail.outcome.failure, 'pre-existing migration history')
  assert.equal(bothFail.harness.state().closed, 1)

  // A rejected connect never yields a session, and nothing is deployed.
  const connectFails = await run({}, { rejectConnect: true })
  assert.equal(connectFails.outcome.completed, false)
  assert.equal(connectFails.outcome.phase, 'connect')
  assert.equal(connectFails.outcome.failure, 'refused before completion')
  assert.equal(connectFails.harness.deploys.length, 0)
  assert.equal(connectFails.harness.state().closed, 0)
})

test('a transport rejection and a cleanup failure both preserve the first failure', async () => {
  const rejected = await run({}, { rejectQuery: 'authorities' })
  assert.equal(rejected.outcome.failure, 'refused before completion')
  assert.equal(rejected.outcome.phase, 'backfill')
  assert.equal(rejected.harness.state().closed, 1)

  const cleanupFailure = await run({}, { rejectQuery: 'cleanup:tenants' })
  assert.equal(cleanupFailure.outcome.completed, false)
  assert.equal(cleanupFailure.outcome.phase, 'cleanup')
  assert.equal(cleanupFailure.harness.deploys.length, 3)
  assert.equal(cleanupFailure.harness.state().closed, 1)
})

test('no outcome ever carries a credential, URL, row value or raw error', async () => {
  const { outcome } = await run()
  const serialized = JSON.stringify(outcome)
  assert.equal(serialized.includes('://'), false)
  assert.equal(serialized.includes('hawkview_ci'), false)
  // POSITIVE CONTROL: the rejection the fake throws DOES carry a URL and a
  // credential, so an empty search above is a real absence.
  const probe = fakeBoundary({}, { rejectQuery: 'history' })
  await assert.rejects(
    probe.boundary.connect().then(s => s.query('history', 'SELECT 1')),
    /postgresql:\/\/secret@host\/db/)
  const rejected = await run({}, { rejectQuery: 'history' })
  assert.equal(JSON.stringify(rejected.outcome).includes('secret'), false)
  assert.equal(JSON.stringify(rejected.outcome).includes('://'), false)
  assert.equal(rejected.outcome.failure, 'refused before completion')
})

test('installed tools are qualified before the first connection', async () => {
  const { outcome, harness } = await run()
  assert.equal(outcome.completed, true, String(outcome.failure))
  // Qualified ONCE, with the driver's own stage root, before connect.
  assert.equal(harness.qualified.length, 1)
  assert.equal(harness.qualified[0].stage, 'baseline')
  assert.equal(harness.qualified[0].candidateCommit, head)
  assert.ok(harness.qualified[0].stageRoot.startsWith('/'))
  assert.notEqual(harness.qualified[0].stageRoot, stagedRoot)

  // A FAILING qualification must prevent the connection AND the launch. It
  // used to run only inside `deploy`, which blocked the CLI but only after
  // the adapter had already connected and queried the target.
  const refused = await run({}, { rejectQualify: true })
  assert.equal(refused.outcome.completed, false)
  assert.equal(refused.outcome.phase, 'qualify-tools')
  assert.equal(refused.outcome.failure, 'refused before completion')
  assert.equal(refused.harness.state().connected, 0)
  assert.equal(refused.harness.queries.length, 0)
  assert.equal(refused.harness.deploys.length, 0)
})

test('the executable-source status runs on the sanitized Git boundary', () => {
  // The command is built by an exported pure function, so the closed
  // environment and fixed overrides are observable without running git.
  const command = haw70StatusCommand('/some/repository')
  assert.equal(command.executable, '/usr/bin/git')
  // NOTHING ambient: the environment is a closed literal, not process.env.
  assert.deepEqual(Object.keys(command.env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
    'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT',
    'LANG', 'LC_ALL', 'PATH'])
  assert.equal(command.env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(command.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(command.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(command.env.PATH, '/usr/bin:/bin')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'HOME']) {
    assert.equal(Object.hasOwn(command.env, key), false, key)
  }
  // The configuration-sensitive behaviour the established adapter suppresses.
  const argv = [...command.argv].join(' ')
  assert.match(argv, /core\.fsmonitor=false/)
  assert.match(argv, /core\.hooksPath=\/dev\/null/)
  assert.match(argv, /core\.untrackedCache=false/)
  assert.match(argv, /--no-pager/)
  assert.match(argv, /--no-replace-objects/)
  // Scoped to the repository it was given and to the declared paths only.
  assert.ok([...command.argv].includes('/some/repository'))
  assert.ok([...command.argv].includes('--porcelain=v1'))
  for (const declared of HAW70_EXECUTABLE_SOURCE) {
    assert.ok([...command.argv].includes(declared), declared)
  }

  // A FIXTURE WITNESS that supplied routing cannot redirect the inspection.
  // Two throwaway repositories are prepared: one clean, one with a declared
  // file modified. Running the clean repository's command with GIT_DIR and
  // GIT_WORK_TREE pointing at the DIRTY one must still report the clean
  // repository, because the closed environment replaces them rather than
  // inheriting them. No hook is installed and nothing is executed from
  // either tree.
  const make = (name: string, dirty: boolean): string => {
    const root = realpathSync(mkdtempSync(join(scratch, `${name}-`)))
    const run2 = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-C', root, ...args],
        { encoding: 'utf8', timeout: 60_000,
          env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
      assert.equal(result.status, 0, result.stderr)
    }
    run2('init', '--quiet')
    for (const declared of HAW70_EXECUTABLE_SOURCE) {
      const target = join(root, declared)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, 'committed\n')
    }
    run2('add', '-A')
    run2('-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'fixture')
    if (dirty) writeFileSync(join(root, HAW70_EXECUTABLE_SOURCE[0]), 'modified\n')
    return root
  }
  const cleanRepository = make('clean', false)
  const dirtyRepository = make('dirty', true)
  const status = (root: string, extra: Record<string, string>) => {
    const command2 = haw70StatusCommand(root)
    const result = spawnSync(command2.executable, [...command2.argv],
      { encoding: 'utf8', env: { ...command2.env, ...extra }, shell: false, timeout: 60_000 })
    assert.equal(result.status, 0, result.stderr)
    return haw70DirtyExecutableSource(String(result.stdout).split('\n'))
  }
  // CONTROLS: the fixtures really are clean and really are dirty.
  assert.deepEqual(status(cleanRepository, {}), [])
  assert.deepEqual(status(dirtyRepository, {}),
    [`M ${HAW70_EXECUTABLE_SOURCE[0]}`])
  // And the redirect does not take effect, because the command carries its
  // own closed environment.
  assert.deepEqual(status(cleanRepository, {}), [])
  const redirected = spawnSync(haw70StatusCommand(cleanRepository).executable,
    [...haw70StatusCommand(cleanRepository).argv],
    { encoding: 'utf8', shell: false, timeout: 60_000,
      env: { ...haw70StatusCommand(cleanRepository).env } })
  assert.equal(redirected.status, 0, redirected.stderr)
  assert.deepEqual(haw70DirtyExecutableSource(String(redirected.stdout).split('\n')), [])
})

test('the observer delegates only enforced read-only Git, and refuses the rest', () => {
  // THE DELEGATION EXCEPTION, exercised. It used to accept anything whose
  // argv[0] was `/usr/bin/git`, through any of seven process APIs, forwarding
  // every argument and option to the real implementation -- so it would have
  // delegated `git push`, `git clean -fdx`, or a `-c core.hooksPath=...`
  // invocation that runs an external helper.
  //
  // Every prohibited shape below is refused BEFORE delegation, so nothing
  // destructive or networked runs as a control. The one permitted request is
  // a read-only `status` inside the owned repository.
  const owned = realpathSync(mkdtempSync(join(scratch, 'git-exception-')))
  const seed = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', ['-C', owned, ...args],
      { encoding: 'utf8', timeout: 60_000,
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    assert.equal(result.status, 0, result.stderr)
  }
  seed('init', '--quiet')
  writeFileSync(join(owned, 'tracked.txt'), 'content\n')
  seed('add', '-A')
  seed('-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'seed')
  const outside = realpathSync(mkdtempSync(join(scratch, 'git-outside-')))
  seed('init', '--quiet')
  // A symlink POINTING AT the owned root: absolute and self-resolving as a
  // string, but not canonical, so the target check must refuse it.
  const linkedOwned = join(scratch, 'git-linked-owned')
  symlinkSync(owned, linkedOwned)

  const probe = join(scratch, 'git-exception-probe.mjs')
  writeFileSync(probe, `
    import { spawnSync, exec } from 'node:child_process'
    const owned = ${JSON.stringify(owned)}
    const outside = ${JSON.stringify(outside)}
    const attempt = (label, fn) => { try { fn() } catch { /* refused, as recorded */ } }
    // The closed environment and process options the driver's own adapter
    // supplies. A request WITHOUT these is refused, which is asserted below.
    const safeEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' }
    const safeOptions = { env: safeEnv, shell: false, timeout: 15000, encoding: 'utf8' }
    const prefix = ['--no-pager', '--no-replace-objects', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-C', owned]
    // PERMITTED: the exact read-only status form the driver issues.
    attempt('allowed-status', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      safeOptions))
    // PERMITTED: the read-only config probe the source adapter issues.
    attempt('allowed-config', () => spawnSync('/usr/bin/git',
      [...prefix, 'config', '--local', '--name-only', '--get-regexp', '^extensions\\.'],
      safeOptions))
    // REFUSED, each for its own reason. None of these runs.
    //
    // THE TWO WRITE FORMS a verb allowlist admitted: both have the allowed
    // verb and otherwise acceptable options.
    attempt('config-write', () => spawnSync('/usr/bin/git',
      [...prefix, 'config', 'core.hooksPath', '/tmp/x'], safeOptions))
    attempt('config-switch', () => spawnSync('/usr/bin/git',
      [...prefix, 'config', '--local', '--unset', 'core.hooksPath'], safeOptions))
    attempt('symbolic-ref-write', () => spawnSync('/usr/bin/git',
      [...prefix, 'symbolic-ref', 'HEAD', 'refs/heads/other'], safeOptions))
    attempt('push', () => spawnSync('/usr/bin/git', [...prefix, 'push', 'origin', 'main'], safeOptions))
    attempt('clean', () => spawnSync('/usr/bin/git', [...prefix, 'clean', '-fdx'], safeOptions))
    attempt('fetch', () => spawnSync('/usr/bin/git', [...prefix, 'fetch', '--all'], safeOptions))
    // MISSING OR UNSAFE REQUEST FIELDS.
    attempt('hookspath', () => spawnSync('/usr/bin/git',
      ['-c', 'core.hooksPath=/tmp/evil', '-C', owned, 'status', '--porcelain=v1',
       '--untracked-files=all', '--', 'tracked.txt'], safeOptions))
    attempt('no-containment', () => spawnSync('/usr/bin/git',
      ['--no-pager', 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      safeOptions))
    attempt('outside', () => spawnSync('/usr/bin/git',
      ['--no-pager', '--no-replace-objects', '-c', 'core.fsmonitor=false',
       '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-C', outside,
       'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'], safeOptions))
    attempt('cwd-outside', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { ...safeOptions, cwd: outside }))
    attempt('routing', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { ...safeOptions, env: { ...safeEnv, GIT_DIR: outside } }))
    attempt('env-tampered', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { ...safeOptions, env: { ...safeEnv, GIT_CONFIG_GLOBAL: '/tmp/theirs' } }))
    attempt('env-absent', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { shell: false, timeout: 15000 }))
    // A STRING-VALUED shell, which shell === true alone did not catch.
    attempt('shell-string', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { ...safeOptions, shell: '/bin/sh' }))
    attempt('shell-true', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { ...safeOptions, shell: true }))
    attempt('no-timeout', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt'],
      { env: safeEnv, shell: false }))
    // TRAILING-ARGUMENT forms that the verb check alone accepted.
    attempt('status-absolute-path', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', '/etc/passwd'],
      safeOptions))
    attempt('status-traversal', () => spawnSync('/usr/bin/git',
      [...prefix, 'status', '--porcelain=v1', '--untracked-files=all', '--', '../elsewhere'],
      safeOptions))
    attempt('cat-file-non-oid', () => spawnSync('/usr/bin/git',
      [...prefix, 'cat-file', 'blob', 'HEAD:tracked.txt'], safeOptions))
    attempt('rev-parse-other-ref', () => spawnSync('/usr/bin/git',
      [...prefix, 'rev-parse', '--verify', 'refs/heads/other'], safeOptions))
    attempt('extra-trailing-token', () => spawnSync('/usr/bin/git',
      [...prefix, 'rev-parse', '--show-toplevel', 'extra'], safeOptions))
    // EACH REQUIRED BARRIER DELETED IN TURN. The safe environment suppresses
    // system and global configuration but NOT the owned repository's local
    // .git/config, so these -c overrides are the actual barrier and a request
    // without them must be refused rather than merely tolerated.
    const noPager = prefix.slice(1)
    const noReplace = [prefix[0], ...prefix.slice(2)]
    const noFsmonitor = [prefix[0], prefix[1], ...prefix.slice(4)]
    const noHooksPath = [...prefix.slice(0, 4), ...prefix.slice(6)]
    const noUntracked = [...prefix.slice(0, 6), ...prefix.slice(8)]
    const noSettings = [prefix[0], prefix[1], '-C', owned]
    const reordered = [prefix[0], prefix[1], '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', owned]
    const statusTail = ['status', '--porcelain=v1', '--untracked-files=all', '--', 'tracked.txt']
    for (const [label, head] of [['omit-no-pager', noPager], ['omit-no-replace', noReplace],
      ['omit-fsmonitor', noFsmonitor], ['omit-hookspath', noHooksPath],
      ['omit-untracked', noUntracked], ['omit-all-settings', noSettings],
      ['reordered-settings', reordered]]) {
      attempt(label, () => spawnSync('/usr/bin/git', [...head, ...statusTail], safeOptions))
    }
    // A RELATIVE TARGET whose meaning changes under options.cwd. Validation in
    // the observer would resolve it against the observer's own working
    // directory; Git applies -C after chdir to cwd. The cwd here is INSIDE the
    // owned repository, so only the target check can catch this.
    attempt('relative-target', () => spawnSync('/usr/bin/git',
      [...prefix.slice(0, 9), '..', ...statusTail], { ...safeOptions, cwd: owned }))
    // An absolute but NON-CANONICAL target, and a symlink to the owned root.
    attempt('noncanonical-target', () => spawnSync('/usr/bin/git',
      [...prefix.slice(0, 9), owned + '/backend/..', ...statusTail], safeOptions))
    attempt('symlinked-target', () => spawnSync('/usr/bin/git',
      [...prefix.slice(0, 9), ${JSON.stringify(linkedOwned)}, ...statusTail], safeOptions))
    attempt('api', () => exec('/usr/bin/git status'))
    attempt('noverb', () => spawnSync('/usr/bin/git', [...prefix], safeOptions))
  `)
  // GUARD: a backtick inside this file's probe template would terminate the
  // template literal and produce a syntax error that reads as an unrelated
  // test failure. It has happened three times in this work, so it is checked
  // rather than remembered.
  const probeSource = readFileSync(probe, 'utf8')
  assert.equal(probeSource.includes('`'), false, 'probe source must contain no backtick')
  const output = join(scratch, 'git-exception.json')
  const result = spawnSync(process.execPath,
    ['--import', join(import.meta.dirname, 'haw70-upgrade-import-observer.mjs'), probe],
    { encoding: 'utf8', timeout: 180_000, env: {
      PATH: String(process.env.PATH), HOME: String(process.env.HOME),
      HAW70_OBSERVER_OUTPUT: output, HAW70_OBSERVER_ALLOW_GIT: '1',
      HAW70_OBSERVER_GIT_ROOT: owned,
    } })
  assert.equal(result.status, 0, result.stderr)
  const recorded = JSON.parse(readFileSync(output, 'utf8')) as
    { attempts: { kind: string; detail: string }[] }

  const delegated = recorded.attempts.filter(a => a.detail.startsWith('delegated-git'))
  const refused = recorded.attempts
    .filter(a => a.kind.startsWith('child_process.') && !a.detail.startsWith('delegated-git'))
    .map(a => (JSON.parse(a.detail) as { refused: string }).refused)

  // EXACTLY TWO delegations: the permitted read-only status and config probe.
  assert.equal(delegated.length, 2, JSON.stringify(delegated))
  // And every prohibited shape refused, each for its own stated reason.
  // Each reason was derived from the predicate before the run, so this list
  // checks that reasoning rather than recording whatever came out. The two
  // `prefix` duplicates are real: the hooksPath-redirect control also starts
  // with `-c`, and the missing-`-C` control also drops `--no-replace-objects`.
  assert.deepEqual(refused.sort(), [
    'api exec',
    'cwd outside repository',
    'environment GIT_CONFIG_GLOBAL',
    'environment keys',
    'environment missing',
    'form cat-file',
    'form config',
    'form config',
    'form rev-parse',
    'form rev-parse',
    'form status',
    'form status',
    'no verb',
    'prefix 0 --no-pager',
    'prefix 0 --no-pager',
    'prefix 1 --no-replace-objects',
    'prefix 1 --no-replace-objects',
    'prefix 2 -c',
    'prefix 3 core.fsmonitor=false',
    'prefix 3 core.fsmonitor=false',
    'prefix 5 core.hooksPath=/dev/null',
    'prefix 6 -c',
    'shell',
    'shell',
    'target not absolute',
    'target not canonical',
    'target not canonical',
    'target outside repository',
    'timeout',
    'verb clean',
    'verb fetch',
    'verb push',
    'verb symbolic-ref',
  ])
  // CONTROL: the refusals are not vacuous -- the permitted requests really
  // were delegated and really did run, so the boundary distinguishes rather
  // than refusing everything.
  assert.ok(delegated.every(entry => entry.detail.startsWith('delegated-git')))
  // And the delegated receipt is now a COMPLETE request, not one argument.
  const summary = (JSON.parse(readFileSync(output, 'utf8')) as {
    delegatedGit: { signature: string; count: number
      request: { argv: string[]; environment: Record<string, string>
        shell: boolean | null; timeout: number | null; cwd: string | null } }[] }).delegatedGit
  assert.equal(summary.length, 2, JSON.stringify(summary.map(entry => entry.signature)))
  for (const entry of summary) {
    assert.ok(entry.request.argv.includes('-C'))
    assert.equal(entry.request.shell, false)
    assert.equal(entry.request.timeout, 15000)
    assert.deepEqual(Object.keys(entry.request.environment).sort(),
      ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS',
        'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'LANG', 'LC_ALL', 'PATH'])
  }
})

test('a cold import of the driver attempts no child, socket or name resolution', () => {
  // RUNTIME OBSERVATION, in a fresh process where the import has not yet
  // happened. Asserting on exported constants from this file cannot establish
  // it, because this file already imported the module at load time.
  const observer = join(import.meta.dirname, 'haw70-upgrade-import-observer.mjs')
  const target = join(import.meta.dirname, 'haw70-upgrade-runner.ts')
  const readAttempts = (positiveControl: boolean): string[] => {
    const output = join(scratch, `observer-${positiveControl ? 'control' : 'clean'}.json`)
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', '--import', observer, '-e', 'process.exitCode = 0'],
      { encoding: 'utf8', timeout: 180_000, env: {
        PATH: String(process.env.PATH), HOME: String(process.env.HOME),
        HAW70_OBSERVER_OUTPUT: output, HAW70_OBSERVER_TARGET: target,
        ...(positiveControl ? { HAW70_OBSERVER_POSITIVE_CONTROL: '1' } : {}),
      } })
    assert.equal(result.status, 0, result.stderr)
    const recorded = JSON.parse(readFileSync(output, 'utf8')) as { attempts: { kind: string }[] }
    return recorded.attempts.map(attempt => attempt.kind)
  }

  // The import itself: begins, ends, and attempts nothing in between.
  const clean = readAttempts(false)
  assert.deepEqual(clean, ['import:begin', 'import:end'])

  // POSITIVE CONTROL in the same observer: a deliberate launch IS recorded.
  // Without this, "nothing recorded" could mean the observer is blind.
  const controlled = readAttempts(true)
  assert.deepEqual(controlled, ['import:begin', 'import:end', 'child_process.spawnSync'])

  // And the observer's patch reaches an ESM NAMED import, which is how the
  // driver imports spawnSync. Without `syncBuiltinESMExports` the driver would
  // keep the original function and a real launch would go unobserved.
  const esm = spawnSync(process.execPath,
    ['--import', observer, '--input-type=module', '-e',
      "import { spawnSync } from 'node:child_process'\ntry { spawnSync('/usr/bin/true', []) }"
      + " catch (error) { process.stdout.write(error.message) }"],
    { encoding: 'utf8', timeout: 60_000, env: { PATH: String(process.env.PATH) } })
  assert.match(String(esm.stdout), /INERT OBSERVER: child launch refused/)
})

test('the ACTUAL fixed adapter is observed, inertly, on both connect paths', () => {
  // THE REAL PUBLIC ENTRY, THE REAL ADAPTER. The pure-builder tests above
  // show what the adapter WOULD construct; they cannot show that it forwards
  // that request unchanged, nor that it wires and closes a real client. This
  // does, without a production hook: the entry still accepts only its
  // environment snapshot and imports `pg` by name. The module graph and the
  // process facts are redirected from OUTSIDE, in a child process.
  //
  // Inertness, stated precisely: `pg` resolves to an inert stub, so no socket
  // opens and no name resolves; the migration CLI is recorded and REFUSED, so
  // no migration executable runs. Read-only `/usr/bin/git` IS delegated,
  // because the driver materializes its own stage from the repository and
  // refusing git would stop the run long before the adapter exists. Every git
  // invocation appears in the recorded log.
  //
  // The entry refuses unless the declared executable source is tracked and
  // clean, so the run happens in a DISPOSABLE CLONE where those files are
  // committed. The working checkout is untouched.
  const clone = realpathSync(mkdtempSync(join(scratch, 'adapter-clone-')))
  rmSync(clone, { recursive: true, force: true })
  const gitIn = (root: string, ...args: string[]) => {
    const result = spawnSync('/usr/bin/git', ['-C', root, ...args],
      { encoding: 'utf8', timeout: 180_000,
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const cloned = spawnSync('/usr/bin/git',
    ['clone', '--quiet', '--local', '--no-hardlinks', repositoryRoot, clone],
    { encoding: 'utf8', timeout: 300_000,
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  assert.equal(cloned.status, 0, cloned.stderr)
  // The scoped files, so the declared source is tracked and clean.
  for (const relative of SCOPED_SOURCE) {
    const target = join(clone, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(repositoryRoot, relative)))
  }
  // COMMIT ONLY IF THE SCOPED BYTES DIFFER.
  //
  // An unconditional commit works today, while those files are uncommitted in
  // the base, but it BREAKS exactly when this has to run from sealed or
  // restored source: the clone then already contains identical bytes, `add`
  // stages nothing, and an ordinary `git commit` exits 1 for "nothing to
  // commit" -- failing before any adapter observation, in the one validation
  // that matters most. Both paths are exercised and the clean one keeps the
  // clone's own HEAD identity rather than gaining a meaningless commit.
  gitIn(clone, 'add', '-A')
  const staged = gitIn(clone, 'status', '--porcelain=v1', '--untracked-files=all')
    .split('\n').filter(line => line.trim() !== '')
  const draftCommitNeeded = staged.length > 0
  if (draftCommitNeeded) {
    gitIn(clone, '-c', 'user.email=observer@local', '-c', 'user.name=observer',
      'commit', '--quiet', '-m', 'haw70 adapter observation draft')
  }
  // Either way the declared source is now tracked and clean, which is what
  // the entry requires. Recorded so the report says which path ran.
  assert.deepEqual(gitIn(clone, 'status', '--porcelain=v1', '--untracked-files=all')
    .split('\n').filter(line => line.trim() !== '' && !line.includes('node_modules')), [])
  // BOTH PATHS, PROVEN HERE rather than discovered at seal time -- and
  // WITHOUT assuming which one the base takes.
  //
  // Before sealing, the scoped files are uncommitted in the base and a draft
  // commit is required. After sealing they are committed, nothing stages, and
  // the clone's own identity must be kept. An earlier version of this test
  // asserted the draft path unconditionally, which is the same mistake as the
  // unconditional commit it replaced: correct today, broken in the sealed
  // validation. So the path taken is checked against what the base ACTUALLY
  // is, and both branches are then exercised explicitly below.
  const baseScopedStatus = gitIn(repositoryRoot, 'status', '--porcelain=v1',
    '--untracked-files=all', '--', ...SCOPED_SOURCE)
    .split('\n').filter(line => line.trim() !== '')
  assert.equal(draftCommitNeeded, baseScopedStatus.length > 0,
    `base scoped status: ${JSON.stringify(baseScopedStatus)}`)

  const second = realpathSync(mkdtempSync(join(scratch, 'adapter-clone-clean-')))
  rmSync(second, { recursive: true, force: true })
  const secondClone = spawnSync('/usr/bin/git',
    ['clone', '--quiet', '--local', '--no-hardlinks', clone, second],
    { encoding: 'utf8', timeout: 300_000,
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  assert.equal(secondClone.status, 0, secondClone.stderr)
  const secondHeadBefore = gitIn(second, 'rev-parse', 'HEAD').trim()
  for (const relative of SCOPED_SOURCE) {
    const target = join(second, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(repositoryRoot, relative)))
  }
  gitIn(second, 'add', '-A')
  const secondStaged = gitIn(second, 'status', '--porcelain=v1', '--untracked-files=all')
    .split('\n').filter(line => line.trim() !== '')
  // PATH A, the sealed/restored case: identical bytes stage no delta, so no
  // commit is attempted and the clone keeps its own identity.
  assert.deepEqual(secondStaged, [], 'identical bytes must stage no delta')
  assert.equal(gitIn(second, 'rev-parse', 'HEAD').trim(), secondHeadBefore)

  // PATH B, the draft case: a changed scoped byte does stage a delta, a
  // commit is then required, and the tree is clean afterwards. Exercising
  // both here makes this test independent of whether the base happens to be
  // sealed, which is the property the earlier version lacked.
  writeFileSync(join(second, SCOPED_SOURCE[0]),
    `${readFileSync(join(second, SCOPED_SOURCE[0]), 'utf8')}\n// draft-path witness\n`)
  gitIn(second, 'add', '-A')
  const draftStaged = gitIn(second, 'status', '--porcelain=v1', '--untracked-files=all')
    .split('\n').filter(line => line.trim() !== '')
  assert.equal(draftStaged.length, 1, JSON.stringify(draftStaged))
  gitIn(second, '-c', 'user.email=observer@local', '-c', 'user.name=observer',
    'commit', '--quiet', '-m', 'haw70 draft-path witness')
  assert.notEqual(gitIn(second, 'rev-parse', 'HEAD').trim(), secondHeadBefore)
  assert.deepEqual(gitIn(second, 'status', '--porcelain=v1', '--untracked-files=all')
    .split('\n').filter(line => line.trim() !== ''), [])

  symlinkSync(join(backend, 'node_modules'), join(clone, 'backend', 'node_modules'))
  const cloneHead = gitIn(clone, 'rev-parse', 'HEAD').trim()
  const cloneRef = `refs/heads/${gitIn(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()}`

  const observe = (connectRejects: boolean): {
    kinds: string[]; detail: (kind: string) => string; gitDelegations: number
    delegatedVerbs: string[]
    delegatedSummary: { signature: string; count: number
      request: { argv: string[]; environment: Record<string, string>
        shell: boolean | null; timeout: number | null; cwd: string | null } }[] } => {
    const output = join(scratch, `adapter-${connectRejects ? 'reject' : 'accept'}.json`)
    const environment = {
      ...environmentFor(), GITHUB_SHA: cloneHead, GITHUB_WORKFLOW_SHA: cloneHead,
      GITHUB_REF: cloneRef,
      GITHUB_WORKFLOW_REF: `dharmik0431/hawkview-app/.github/workflows/quality-gates.yml@${cloneRef}`,
    }
    const result = spawnSync(process.execPath,
      ['--import', 'tsx',
        '--import', join(clone, 'backend/scripts/haw70-upgrade-import-observer.mjs'),
        '-e', 'process.exitCode = 0'],
      { encoding: 'utf8', timeout: 540_000, cwd: join(clone, 'backend'),
        env: {
          PATH: String(process.env.PATH), HOME: String(process.env.HOME),
          HAW70_OBSERVER_OUTPUT: output,
          HAW70_OBSERVER_TARGET: join(clone, 'backend/scripts/haw70-upgrade-runner.ts'),
          HAW70_OBSERVER_PG_STUB: join(clone, 'backend/scripts/haw70-upgrade-pg-stub.mjs'),
          HAW70_OBSERVER_ALLOW_GIT: '1',
          HAW70_OBSERVER_GIT_ROOT: clone,
          HAW70_OBSERVER_FORCE_PLATFORM: 'linux',
          HAW70_OBSERVER_FORCE_VERSION: 'v22.23.2',
          HAW70_OBSERVER_ENTRY_ENVIRONMENT: JSON.stringify(environment),
          ...(connectRejects ? { HAW70_OBSERVER_PG_CONNECT_REJECTS: '1' } : {}),
        } })
    assert.equal(result.status, 0, result.stderr)
    const recorded = JSON.parse(readFileSync(output, 'utf8')) as {
      attempts: { kind: string; detail: string }[]
      delegatedGit: { signature: string; count: number
        request: { argv: string[]; environment: Record<string, string>
          shell: boolean | null; timeout: number | null; cwd: string | null } }[]
    }
    // The delegated read-only git calls are excluded from BOTH views, so a
    // lookup for the migration child cannot match a git invocation instead.
    const observed = recorded.attempts
      .filter(attempt => !attempt.detail.startsWith('delegated-git'))
    return {
      kinds: observed.map(attempt => attempt.kind),
      detail: (kind: string) => {
        const found = observed.find(attempt => attempt.kind === kind)
        assert.ok(found !== undefined, kind)
        return found.detail
      },
      gitDelegations: recorded.attempts.length - observed.length,
      delegatedVerbs: recorded.attempts
        .filter(attempt => attempt.detail.startsWith('delegated-git'))
        .map(attempt => attempt.detail.replace('delegated-git ', '')),
      delegatedSummary: recorded.delegatedGit,
    }
  }

  // ---- the accepted-connection path ------------------------------------
  const accepted = observe(false)
  // `pg` really was replaced, so nothing could have reached a database.
  assert.ok(accepted.kinds.includes('resolve:pg'))
  // The delegated git work is counted, not hidden: the driver materializes
  // its own stage, so this is expected to be substantial.
  assert.ok(accepted.gitDelegations > 100, String(accepted.gitDelegations))
  // AND THE ALLOWLIST MATCHES THE REAL DRIVER. Every one of those delegated
  // calls passed the exact-form validator, so the permitted set is neither
  // too narrow (the run reached the adapter) nor a verb-level approximation.
  // The verbs seen are asserted to be a subset of the declared safe set, and
  // each receipt carries the closed environment and safe options.
  assert.deepEqual([...new Set(accepted.delegatedVerbs)].sort()
    .filter(verb => !['cat-file', 'config', 'for-each-ref', 'ls-tree', 'rev-parse', 'status']
      .includes(verb)), [], JSON.stringify([...new Set(accepted.delegatedVerbs)].sort()))
  assert.ok(accepted.delegatedSummary.length >= 3,
    JSON.stringify(accepted.delegatedSummary.map(entry => entry.signature)))
  for (const entry of accepted.delegatedSummary) {
    assert.equal(entry.request.shell, false, entry.signature)
    assert.ok(entry.request.argv.includes('-C'), entry.signature)
    assert.deepEqual(Object.keys(entry.request.environment).sort(),
      ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS',
        'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'LANG', 'LC_ALL', 'PATH'], entry.signature)
  }
  // THE ACTUAL CONSTRUCTED OPTIONS, from the real adapter.
  const options = JSON.parse(accepted.detail('pg:construct')) as Record<string, unknown>
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, 5432)
  assert.equal(options.database, 'hawkview_ci')
  assert.equal(options.user, 'hawkview_ci')
  assert.equal(options.ssl, false)
  assert.equal(options.application_name, 'haw70-staged-upgrade')
  assert.equal(options.options, '-c timezone=UTC')
  assert.equal(options.connectionTimeoutMillis, 10_000)
  assert.equal(options.statement_timeout, 60_000)
  assert.equal(options.lock_timeout, 15_000)
  // The password reached the client but is never recorded as a value.
  assert.equal(options.passwordLength, 'hawkview_ci'.length)
  assert.equal(Object.hasOwn(options, 'password'), false)
  // Qualification precedes the connection: the plan validated, then connect.
  assert.ok(accepted.kinds.indexOf('pg:construct') < accepted.kinds.indexOf('pg:connect'))
  // The adapter forwarded the driver's real SQL.
  const queries = JSON.parse(accepted.detail('pg:query')) as { sql: string }
  assert.match(queries.sql, /current_database\(\)/)
  // THE ACTUAL CHILD REQUEST, recorded IN FULL and refused. Matching only
  // the executable name proved a launch and nothing about what it would run.
  assert.ok(accepted.kinds.includes('child_process.spawnSync'))
  const recorded = JSON.parse(accepted.detail('child_process.spawnSync')) as {
    refused: string
    request: {
      api: string; executable: string; argv: string[]; cwd: string | null
      shell: boolean | null; timeout: number | null; maxBuffer: number | null
      stdio: string[] | null; environmentKeys: string[]
      environment: Record<string, string>
    }
  }
  const request = recorded.request
  // Refused at the EXECUTABLE check: the migration child is a node binary,
  // not git, so it never reaches the read-only git allowlist at all.
  assert.equal(recorded.refused, 'executable')
  assert.equal(request.api, 'spawnSync')
  assert.match(request.executable, /\/node$/)
  // The fixed migration argv, with the dedicated config, and nothing else.
  assert.equal(request.argv.length, 5)
  assert.match(request.argv[0], /node_modules\/prisma\/build\/index\.js$/)
  assert.equal(request.argv[1], 'migrate')
  assert.equal(request.argv[2], 'deploy')
  assert.equal(request.argv[3], '--config')
  assert.match(request.argv[4], /prisma\/haw70-upgrade\.config\.ts$/)
  // The process options, fixed.
  assert.equal(request.cwd, join(clone, 'backend'))
  assert.equal(request.shell, false)
  assert.equal(request.timeout, 300_000)
  assert.equal(request.maxBuffer, (1 << 20) + 1)
  assert.deepEqual(request.stdio, ['ignore', 'pipe', 'pipe'])
  // THE CLOSED CHILD ENVIRONMENT: exactly 33 keys, and the values the driver
  // actually projected -- including the stage context for this deployment.
  assert.equal(request.environmentKeys.length, 33)
  assert.equal(request.environment.HAWKVIEW_HAW70_STAGE_NAME, 'baseline')
  assert.equal(request.environment.HAWKVIEW_HAW70_STAGE_CANDIDATE, cloneHead)
  assert.equal(request.environment.GITHUB_SHA, cloneHead)
  assert.equal(request.environment.GITHUB_WORKFLOW_SHA, cloneHead)
  assert.ok(request.environment.HAWKVIEW_HAW70_STAGE_ROOT.startsWith('/'))
  assert.equal(request.environment.HAWKVIEW_CI_MIGRATION_PROFILE, 'haw70-upgrade')
  assert.equal(request.environment.PATH, '/usr/bin:/bin')
  assert.equal(request.environment.TZ, 'UTC')
  assert.equal(request.environment.JITI_FS_CACHE, 'false')
  assert.equal(request.environment.LANG, 'C')
  assert.equal(request.environment.LC_ALL, 'C')
  // The datasource is present but never recorded as a value. The digest is
  // compared against the one this test supplied, so the assertion is about
  // the actual forwarded string rather than about its shape.
  const expectedDatasource = String(environmentFor().DATABASE_URL)
  assert.equal(request.environment.DATABASE_URL,
    `sha256:${createHash('sha256').update(expectedDatasource).digest('hex')}`
    + `:len=${expectedDatasource.length}`)
  // Nothing ambient from this process reached the child.
  for (const key of ['HOME', 'USER', 'SHELL', 'TMPDIR', 'NODE_OPTIONS', 'PGHOST']) {
    assert.equal(Object.hasOwn(request.environment, key), false, key)
  }
  // The owned client was closed.
  assert.ok(accepted.kinds.includes('pg:end'))
  // And the entry returned an outcome rather than rejecting.
  const outcome = JSON.parse(accepted.detail('entry:outcome')) as Record<string, unknown>
  assert.equal(outcome.completed, false)
  assert.equal(outcome.phase, 'baseline-deploy')
  assert.equal(outcome.deployments, 0)

  // ---- the FAILED-connection path --------------------------------------
  // This is the case the fake-core test cannot cover: that fake never creates
  // the adapter-owned client, so deleting the adapter's `end()` on a rejected
  // connection would go unobserved there. Here the `pg:end` below is that
  // observation.
  const rejected = observe(true)
  assert.equal(rejected.detail('pg:connect'), 'rejecting')
  assert.ok(rejected.kinds.includes('pg:end'))
  assert.ok(rejected.kinds.indexOf('pg:connect') < rejected.kinds.indexOf('pg:end'))
  // Nothing was launched, because the connection never succeeded.
  assert.equal(rejected.kinds.includes('child_process.spawnSync'), false)
  const rejectedOutcome = JSON.parse(rejected.detail('entry:outcome')) as Record<string, unknown>
  assert.equal(rejectedOutcome.phase, 'connect')
  assert.equal(rejectedOutcome.completed, false)
  // The original connect failure is what surfaced, sanitized.
  assert.equal(rejectedOutcome.failure, 'refused before completion')
})

test('nothing in this suite started a database, a CLI or a migration', () => {
  assert.ok(stagedRoot.startsWith(scratch))
  assert.ok(existsSync(join(stagedRoot, 'baseline', 'schema.prisma')))
  assert.ok(existsSync(join(stagedRoot, 'candidate', 'schema.prisma')))
  // The SIX relations the HAW-70 invalidators are installed on. The earlier
  // three-relation list omitted sync_states, whose delete invalidator is what
  // advances the sibling authority during cleanup.
  assert.deepEqual([...HAW70_WRITER_TRIGGER_RELATIONS].sort(),
    ['customer_tenants', 'directory_audit_logs', 'sync_states', 'tenant_entra_snapshots',
      'tenant_health_snapshots', 'tenant_health_source_authorities'])
})
