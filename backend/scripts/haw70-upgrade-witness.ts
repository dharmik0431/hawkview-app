/**
 * HAW-70 staged-upgrade witness: the fixed legacy fixture and the verification
 * expectations the driver checks against a real database.
 *
 * UNUSED BY DESIGN so far. No application module, workflow or package command
 * imports this, and importing it performs no work: every export is either a
 * pure function or a frozen constant. It opens no connection, spawns nothing
 * and reads no environment.
 *
 * Everything here is DESCRIPTIVE DATA AND PURE ASSERTION. The SQL strings are
 * derived from the committed baseline DDL and the fourteen pending migrations;
 * they are executed only by the driver's fixed adapter against the registered
 * disposable service, never by this module.
 */

/* ============================== fixture shape ============================== */

/**
 * Two organizations, three tenants. The first organization holds TWO SIBLING
 * tenants so that one can be mutated-checked against the other; the second
 * holds an independent tenant so cross-organization scope is exercised.
 *
 * `withSnapshots` has three legacy health snapshots at distinct timestamps,
 * model versions, statuses and payloads. `withoutSnapshots` has NONE: the
 * backfill must still produce an authority row for it, which an
 * empty-database upgrade could never demonstrate. `otherOrganization` proves
 * the backfill is not scoped to a single organization.
 */
export interface Haw70FixtureIdentifiers {
  readonly organizations: { readonly primary: string; readonly secondary: string }
  readonly tenants: {
    readonly withSnapshots: string
    readonly sibling: string
    readonly otherOrganization: string
  }
  readonly microsoftTenants: {
    readonly withSnapshots: string
    readonly sibling: string
    readonly otherOrganization: string
  }
  readonly snapshots: readonly [string, string, string]
  readonly syncState: string
}

export interface Haw70FixtureStatement {
  readonly name: string
  readonly sql: string
  readonly parameters: readonly unknown[]
}

/** Deterministic, so the saved before-state is comparable byte for byte. */
const SNAPSHOT_ROWS = Object.freeze([
  Object.freeze({ at: '2026-10-01T00:00:00.000Z', model: 3, status: 'HEALTHY',
    payload: '{"haw70Fixture":true,"ordinal":1,"detail":{"collectors":["USERS"],"nested":[1,2,3]}}' }),
  Object.freeze({ at: '2026-10-02T12:30:00.000Z', model: 3, status: 'DEGRADED',
    payload: '{"haw70Fixture":true,"ordinal":2,"detail":{"collectors":["USERS"],"nested":[]}}' }),
  Object.freeze({ at: '2026-10-03T23:59:59.000Z', model: 4, status: 'UNKNOWN',
    payload: '{"haw70Fixture":true,"ordinal":3,"detail":null}' }),
])

/**
 * BASELINE-COMPATIBLE SQL ONLY. At baseline the snapshot table has no
 * `source_incarnation`, `source_revision` or `observation_sequence` columns and
 * there is no authority table, so none is referenced. Columns are named
 * explicitly rather than relying on positional defaults.
 */
export function buildHaw70LegacyFixture(
  identifiers: Haw70FixtureIdentifiers): readonly Haw70FixtureStatement[] {
  const { organizations, tenants, microsoftTenants, snapshots, syncState } = identifiers
  const statements: Haw70FixtureStatement[] = [
    { name: 'organizations',
      sql: `INSERT INTO "organizations" ("id", "name", "slug", "status", "updated_at")
            VALUES ($1, $2, $3, 'ACTIVE', now()), ($4, $5, $6, 'ACTIVE', now())`,
      parameters: [organizations.primary, 'HAW-70 fixture primary', `haw70-fixture-primary-${organizations.primary.slice(0, 8)}`,
        organizations.secondary, 'HAW-70 fixture secondary', `haw70-fixture-secondary-${organizations.secondary.slice(0, 8)}`] },
    { name: 'customer_tenants',
      sql: `INSERT INTO "customer_tenants"
              ("id", "organization_id", "microsoft_tenant_id", "display_name", "status", "updated_at")
            VALUES ($1, $2, $3, $4, 'ACTIVE', now()),
                   ($5, $6, $7, $8, 'ACTIVE', now()),
                   ($9, $10, $11, $12, 'ACTIVE', now())`,
      parameters: [
        tenants.withSnapshots, organizations.primary, microsoftTenants.withSnapshots, 'HAW-70 fixture with snapshots',
        tenants.sibling, organizations.primary, microsoftTenants.sibling, 'HAW-70 fixture sibling',
        tenants.otherOrganization, organizations.secondary, microsoftTenants.otherOrganization, 'HAW-70 fixture other organization'] },
    { name: 'tenant_health_snapshots',
      sql: `INSERT INTO "tenant_health_snapshots"
              ("id", "organization_id", "customer_tenant_id", "health_model_version",
               "overall_status", "payload", "evaluated_at")
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz),
                   ($8, $9, $10, $11, $12, $13::jsonb, $14::timestamptz),
                   ($15, $16, $17, $18, $19, $20::jsonb, $21::timestamptz)`,
      parameters: SNAPSHOT_ROWS.flatMap((row, index) => [
        snapshots[index], organizations.primary, tenants.withSnapshots,
        row.model, row.status, row.payload, row.at]) },
    // An unchanged SOURCE row in a different table, scoped to the sibling
    // tenant. The upgrade must leave it untouched; a later pending migration
    // adds a trigger that reacts to changes here, which is why cleanup
    // ordering is inventoried rather than assumed.
    { name: 'sync_states',
      sql: `INSERT INTO "sync_states"
              ("id", "organization_id", "customer_tenant_id", "resource_type",
               "status", "consecutive_failures", "updated_at")
            VALUES ($1, $2, $3, 'USERS', 'IDLE', 0, now())`,
      parameters: [syncState, organizations.primary, tenants.sibling] },
  ]
  return Object.freeze(statements.map(statement => Object.freeze(statement)))
}

/* ============================ verification queries ============================ */

/** Fixed, parameterized read-only SQL. No interpolation of caller values. */
export const HAW70_WITNESS_QUERIES = Object.freeze({
  /** Refuse a target that already holds application state. */
  targetEmptiness: `SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S')) AS public_objects,
      to_regclass('_prisma_migrations') IS NOT NULL AS history_present`,
  serverIdentity: `SELECT current_database() AS database, current_user AS "user",
      inet_server_port() AS port, current_setting('server_version_num') AS version_num,
      current_setting('TimeZone') AS time_zone`,
  /**
   * THE COMPLETE CANONICAL ROW. The earlier projection selected only name,
   * checksum, two derived booleans and the step count, so changing a baseline
   * row's `id`, `started_at`, `finished_at` or `logs` while preserving those
   * five passed both the retention and the no-op comparison. Retention cannot
   * be observed in fields that were never selected.
   *
   * Timestamps are rendered as text at full precision, because a client-side
   * Date would silently truncate `timestamptz(3)`/`(6)` microseconds and make
   * a changed timestamp indistinguishable from an unchanged one.
   */
  history: `SELECT "id", "migration_name", "checksum",
      "started_at"::text AS started_at,
      "finished_at"::text AS finished_at,
      "rolled_back_at"::text AS rolled_back_at,
      "applied_steps_count" AS steps,
      "logs",
      "finished_at" IS NOT NULL AS finished, "rolled_back_at" IS NOT NULL AS rolled_back
    FROM "_prisma_migrations" ORDER BY "migration_name"`,
  fixtureSnapshots: `SELECT "id", "organization_id", "customer_tenant_id", "health_model_version",
      "overall_status", "payload"::text AS payload, "evaluated_at"::text AS evaluated_at
    FROM "tenant_health_snapshots" WHERE "customer_tenant_id" = ANY($1::uuid[])
    ORDER BY "evaluated_at"`,
  /** Only valid after the candidate set: the tag columns do not exist at baseline. */
  snapshotTags: `SELECT "id", "source_incarnation", "source_revision", "observation_sequence"
    FROM "tenant_health_snapshots" WHERE "customer_tenant_id" = ANY($1::uuid[]) ORDER BY "id"`,
  fixtureTenants: `SELECT "id", "organization_id", "microsoft_tenant_id", "display_name",
      "status"::text AS status FROM "customer_tenants" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
  fixtureSyncStates: `SELECT "id", "organization_id", "customer_tenant_id", "resource_type"::text AS resource_type,
      "status"::text AS status, "consecutive_failures", "delta_link"
    FROM "sync_states" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
  authorities: `SELECT "organization_id", "customer_tenant_id", "incarnation", "source_revision"::text AS source_revision,
      "live", "current_snapshot_id", "current_observation_sequence"::text AS current_observation_sequence
    FROM "tenant_health_source_authorities" WHERE "customer_tenant_id" = ANY($1::uuid[])
    ORDER BY "customer_tenant_id"`,
  /** Key COLUMNS bound, not merely the flags: a unique index over the wrong
   * columns is still unique, valid and ready. */
  exactIndex: `SELECT i."indisunique", i."indisvalid", i."indisready",
      pg_get_indexdef(i.indexrelid) AS definition,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
         FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      ) AS key_columns
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.oid = 'tenant_health_snapshots_exact_source_key'::regclass`,
  /**
   * ORDERED KEY COLUMNS FROM THE CATALOG, not parsed out of a definition
   * string. `conkey`/`confkey` are the authoritative column order, so a
   * foreign key over the right columns in the wrong ORDER, or pointing at the
   * wrong referenced relation, is detectable. `definition` is kept as well,
   * because a validated CHECK with the right name can still check something
   * else entirely -- a positivity constraint rewritten as `< 0` contains the
   * same column name.
   */
  constraints: `SELECT c."conname", c."contype"::text AS contype, c."convalidated",
      c."condeferrable", c."condeferred",
      c."confupdtype"::text AS confupdtype, c."confdeltype"::text AS confdeltype,
      pg_get_constraintdef(c.oid) AS definition,
      cr."relname" AS relation,
      fr."relname" AS referenced_relation,
      (SELECT string_agg(a."attname", ',' ORDER BY k.ord)
         FROM unnest(c."conkey") WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c."conrelid" AND a."attnum" = k.attnum
      ) AS local_columns,
      (SELECT string_agg(a."attname", ',' ORDER BY k.ord)
         FROM unnest(c."confkey") WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c."confrelid" AND a."attnum" = k.attnum
      ) AS referenced_columns
    FROM pg_constraint c
    JOIN pg_class cr ON cr.oid = c."conrelid"
    LEFT JOIN pg_class fr ON fr.oid = c."confrelid"
    WHERE c."conrelid" IN ('tenant_health_snapshots'::regclass,
                           'tenant_health_source_authorities'::regclass)
    ORDER BY cr."relname", c."conname"`,
  /**
   * EFFECTIVE privileges, not the ACL's nullity.
   *
   * A null `relacl` does NOT mean "no privileges": it means no explicit grants
   * were ever recorded, and PostgreSQL then applies the owner's built-in
   * defaults. Reading `relacl IS NULL` as "PUBLIC holds nothing" is the
   * mistaken rule this query replaces. `has_table_privilege('public', ...)`
   * answers the question actually being asked.
   */
  authorityRelation: `SELECT c."relrowsecurity", c."relforcerowsecurity",
      coalesce(array_length(c."relacl", 1), 0) AS acl_entries
    FROM pg_class c WHERE c.oid = 'tenant_health_source_authorities'::regclass`,
  /**
   * EVERY privilege the committed REVOKE clauses name, for the table AND the
   * sequence, and for the conditional roles as well as PUBLIC.
   *
   * `20261109150300` revokes ALL on both objects from PUBLIC, and from `anon`
   * and `authenticated` when those roles exist. Checking four table
   * privileges for PUBLIC alone left TRUNCATE/REFERENCES/TRIGGER, the whole
   * sequence, and both conditional roles unobserved.
   *
   * A role that does not exist is REPORTED AS ABSENT, not created: the
   * `pg_roles` lookup decides, and `has_*_privilege` is only evaluated for a
   * role that is present. This query is read-only.
   */
  privileges: `WITH roles AS (
      SELECT 'public'::text AS role_name, true AS present
      UNION ALL SELECT 'anon', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
      UNION ALL SELECT 'authenticated', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
    ), table_privileges AS (
      SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
        AS privilege
    ), sequence_privileges AS (
      SELECT unnest(ARRAY['USAGE','SELECT','UPDATE']) AS privilege
    )
    SELECT r.role_name, r.present, 'table'::text AS object_kind, p.privilege,
      CASE WHEN r.present
        THEN has_table_privilege(r.role_name, 'tenant_health_source_authorities'::regclass, p.privilege)
        ELSE NULL END AS granted
      FROM roles r CROSS JOIN table_privileges p
    UNION ALL
    SELECT r.role_name, r.present, 'sequence'::text AS object_kind, p.privilege,
      CASE WHEN r.present
        THEN has_sequence_privilege(r.role_name, 'tenant_health_observation_sequence'::regclass, p.privilege)
        ELSE NULL END AS granted
      FROM roles r CROSS JOIN sequence_privileges p
    ORDER BY object_kind, role_name, privilege`,
  /**
   * The WRITER / IMMUTABILITY trigger inventory, which the catalog check
   * previously omitted entirely: only TRUNCATE guards were inspected.
   * Row-level triggers on the participating relations, with the function each
   * executes and whether it is enabled ALWAYS.
   */
  /**
   * THE SOURCE-WRITER INVENTORY, over every relation the candidate installs a
   * HAW-70 invalidator on -- not three of them.
   *
   * The earlier scope omitted `sync_states`, `directory_audit_logs` and
   * `tenant_entra_snapshots`, which is where the invalidators live. The
   * sync-state one is the trigger that DETERMINES the cleanup outcome, so
   * omitting it meant the inventory could not observe the mechanism the
   * cleanup assertion depends on.
   *
   * Timing and mode are preserved rather than reduced to a boolean: `tgtype`
   * bit 1 is ROW (otherwise STATEMENT) and bit 2 is BEFORE (otherwise AFTER).
   */
  writerTriggers: `SELECT c."relname", t."tgname", t."tgenabled"::text AS tgenabled,
      p."proname" AS function_name,
      CASE WHEN (t."tgtype" & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS mode,
      CASE WHEN (t."tgtype" & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
      (t."tgtype" & 4) <> 0 AS on_insert,
      (t."tgtype" & 8) <> 0 AS on_delete,
      (t."tgtype" & 16) <> 0 AS on_update
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t."tgrelid"
    JOIN pg_proc p ON p.oid = t."tgfoid"
    WHERE NOT t."tgisinternal" AND (t."tgtype" & 32) = 0
      AND c.oid IN ('customer_tenants'::regclass,
                    'directory_audit_logs'::regclass,
                    'sync_states'::regclass,
                    'tenant_entra_snapshots'::regclass,
                    'tenant_health_snapshots'::regclass,
                    'tenant_health_source_authorities'::regclass)
    ORDER BY c."relname", t."tgname"`,
  observationSequence: `SELECT last_value, is_called FROM "tenant_health_observation_sequence"`,
  fixtureOrganizations: `SELECT "id", "name", "slug", "status"::text AS status
    FROM "organizations" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
  // TRUNCATE triggers ONLY, each with the relation it guards. The previous
  // form selected every non-internal trigger in the database with no relation
  // and no event predicate, so any trigger anywhere whose NAME merely contained
  // "truncate" satisfied the check -- including one on an unrelated table that
  // does not fire on TRUNCATE at all. `tgtype & 32` is TRIGGER_TYPE_TRUNCATE.
  triggers: `SELECT c."relname", t."tgname", t."tgenabled"::text AS tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t."tgrelid"
    WHERE NOT t."tgisinternal" AND (t."tgtype" & 32) <> 0
    ORDER BY c."relname", t."tgname"`,
})

/* ============================= pure assertions ============================= */

export class Haw70WitnessMismatch extends Error {
  readonly check: string
  constructor(check: string) {
    // The message carries the CHECK NAME only. No row value, credential,
    // environment value or raw database error reaches a caller or a log.
    super(`HAW-70 staged upgrade failed its ${check} check`)
    this.name = 'Haw70WitnessMismatch'
    this.check = check
  }
}

/** A function DECLARATION, so TypeScript narrows after each call site. */
function fail(check: string): never { throw new Haw70WitnessMismatch(check) }
const canonical = (value: unknown): string => JSON.stringify(value, (_, inner) =>
  typeof inner === 'bigint' ? inner.toString() : inner)

export interface Haw70HistoryRow {
  readonly id: string
  readonly migration_name: string
  readonly checksum: string
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly rolled_back_at: string | null
  readonly steps: number
  readonly logs: string | null
  readonly finished: boolean
  readonly rolled_back: boolean
}

/**
 * Exact NAMES and CHECKSUMS, not a count and not a prefix. Every record must be
 * finished exactly once and never rolled back, with no extra, duplicate or
 * unfinished row.
 */
export function assertExactHistory(
  rows: readonly Haw70HistoryRow[], expected: readonly { name: string; checksum: string }[],
  check: string): void {
  if (rows.length !== expected.length) fail(`${check} row count`)
  const names = rows.map(row => row.migration_name)
  if (new Set(names).size !== names.length) fail(`${check} duplicate migration`)
  const byName = new Map(rows.map(row => [row.migration_name, row]))
  for (const entry of expected) {
    const row = byName.get(entry.name)
    if (row === undefined) fail(`${check} missing migration`)
    if (row.checksum !== entry.checksum) fail(`${check} checksum`)
    if (!row.finished) fail(`${check} unfinished migration`)
    if (row.rolled_back) fail(`${check} rolled-back migration`)
    if (!(row.steps >= 1)) fail(`${check} applied step count`)
  }
  for (const name of names) {
    if (!expected.some(entry => entry.name === name)) fail(`${check} unexpected migration`)
  }
}

/**
 * Every saved baseline row must survive the upgrade FIELD FOR FIELD, over the
 * complete canonical record -- id, name, checksum, all three timestamps at
 * full precision, applied step count and logs -- not over a reduced
 * projection. History is compared, never repaired.
 */
export function assertBaselineHistoryRetained(
  saved: readonly Haw70HistoryRow[], now: readonly Haw70HistoryRow[]): void {
  const after = new Map(now.map(row => [row.migration_name, row]))
  for (const row of saved) {
    const current = after.get(row.migration_name)
    if (current === undefined) fail('retained baseline history presence')
    if (canonical(current) !== canonical(row)) fail('retained baseline history row')
  }
}

/** The additions must be exactly the expected names, interleaved or not. */
/**
 * REDUNDANT FOR ITS CURRENT CALLER, and kept deliberately as a defensive
 * invariant rather than presented as load-bearing. The two
 * `assertExactHistory` calls around it already pin both name multisets to the
 * same filesystem-derived arrays that `expectedAdditions` was computed from,
 * so with those callers in place this comparison cannot fail. It would start
 * failing usefully if either exact-history call were ever relaxed.
 */
export function assertHistoryAdditions(
  saved: readonly Haw70HistoryRow[], now: readonly Haw70HistoryRow[],
  expectedAdditions: readonly string[]): void {
  const before = new Set(saved.map(row => row.migration_name))
  const added = now.map(row => row.migration_name).filter(name => !before.has(name)).sort()
  if (canonical(added) !== canonical([...expectedAdditions].sort())) fail('history additions')
}

/** Structural and textual equality of every saved fixture row. */
export function assertRowsUnchanged(
  saved: readonly Record<string, unknown>[], now: readonly Record<string, unknown>[],
  check: string): void {
  if (canonical(saved) !== canonical(now)) fail(check)
}

export interface Haw70SnapshotTagRow {
  readonly id: string
  readonly source_incarnation: string | null
  readonly source_revision: string | null
  readonly observation_sequence: string | null
}

/** Legacy snapshots must NOT be promoted into current observations. */
export function assertLegacyTagsNull(rows: readonly Haw70SnapshotTagRow[], expectedCount: number): void {
  if (rows.length !== expectedCount) fail('legacy snapshot inventory')
  for (const row of rows) {
    if (row.source_incarnation !== null || row.source_revision !== null
      || row.observation_sequence !== null) fail('legacy snapshot tag nullity')
  }
}

export interface Haw70AuthorityRow {
  readonly organization_id: string
  readonly customer_tenant_id: string
  readonly incarnation: string
  readonly source_revision: string
  readonly live: boolean
  readonly current_snapshot_id: string | null
  readonly current_observation_sequence: string
}

/**
 * The one-time backfill inserts exactly one row per pre-existing tenant with
 * revision 1, live, a null pointer and sequence 0, and a DISTINCT non-null
 * incarnation. The tenant with no snapshot must be present too.
 */
export function assertAuthorityBackfill(
  rows: readonly Haw70AuthorityRow[],
  expected: readonly { tenant: string; organization: string }[]): void {
  if (rows.length !== expected.length) fail('authority backfill inventory')
  const byTenant = new Map(rows.map(row => [row.customer_tenant_id, row]))
  const incarnations = new Set<string>()
  for (const entry of expected) {
    const row = byTenant.get(entry.tenant)
    if (row === undefined) fail('authority backfill missing tenant')
    if (row.organization_id !== entry.organization) fail('authority backfill scope')
    if (!/^[0-9a-f-]{36}$/.test(row.incarnation)) fail('authority incarnation shape')
    if (row.source_revision !== '1') fail('authority revision')
    if (row.live !== true) fail('authority liveness')
    if (row.current_snapshot_id !== null) fail('authority pointer nullity')
    if (row.current_observation_sequence !== '0') fail('authority observation sequence')
    incarnations.add(row.incarnation)
  }
  if (incarnations.size !== expected.length) fail('authority incarnation distinctness')
}

/** Catalog objects the fourteen pending migrations are contracted to install. */
/**
 * THE EXPECTED KEY COLUMNS of the exact-source unique index, transcribed from
 * `20261109150100_tenant_health_exact_source_index`. A unique, valid, ready
 * index over the WRONG columns satisfies every flag, so the columns are bound.
 */
const EXACT_INDEX_KEY_COLUMNS =
  'id,organization_id,customer_tenant_id,source_incarnation,source_revision,observation_sequence'

/**
 * THE COMMITTED CONSTRAINT CONTRACT, transcribed from the migrations.
 *
 * Key columns are bound in ORDER, from `conkey`/`confkey`, because a foreign
 * key over the right columns in the wrong order is a different constraint.
 * CHECK semantics are bound by required patterns rather than by token
 * inclusion: `source_revision < 0` contains `source_revision`, and
 * `IN (0, 1, 3)` contains `num_nonnulls`, so both passed the earlier form.
 *
 * `confupdtype`/`confdeltype`: 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE,
 * ' ' = not a foreign key.
 */
interface Haw70ConstraintExpectation {
  readonly name: string
  readonly relation: string
  readonly contype: string
  readonly localColumns: string
  readonly referencedRelation: string | null
  readonly referencedColumns: string | null
  readonly confupdtype: string
  readonly confdeltype: string
  readonly deferrable: boolean
  readonly deferred: boolean
  /** For foreign keys: fragments, since structure is bound from the catalog. */
  readonly definitionMustMatch: readonly RegExp[]
  /**
   * For CHECKs: the COMPLETE accepted expressions, normalized. Fragments are
   * not enough -- `(a IS NULL) AND (a > 0)` contains both fragments of the
   * committed `(a IS NULL) OR (a > 0)` while rejecting every positive value,
   * and adding `OR (a = 0)` keeps the fragments while admitting zero.
   */
  readonly definitionForms?: readonly string[]
}

/**
 * Normalizes a CHECK definition for COMPLETE comparison: whitespace and
 * parentheses are removed, which are exactly the renderings PostgreSQL varies.
 *
 * NOT A SQL PARSER, and the limit is worth stating: because parentheses are
 * dropped, this cannot distinguish a regrouping such as `(a OR b) AND c` from
 * `a OR (b AND c)`. The three expressions it is applied to have two or three
 * operands and no mixed-operator form, so no such regrouping exists for them;
 * and the columns, referential actions, validation and deferral are bound
 * separately from catalog fields rather than from this string.
 */
function normalizeCheckExpression(definition: string): string {
  return definition.replace(/[()\s]/g, '')
}

const CONSTRAINT_EXPECTATIONS: readonly Haw70ConstraintExpectation[] = Object.freeze([
  // 20261109150000: the three snapshot tag CHECKs.
  { name: 'tenant_health_snapshots_source_tag_complete',
    relation: 'tenant_health_snapshots', contype: 'c',
    localColumns: 'source_incarnation,source_revision,observation_sequence',
    referencedRelation: null, referencedColumns: null,
    confupdtype: ' ', confdeltype: ' ', deferrable: false, deferred: false,
    // THE COMPLETE EXPRESSION. PostgreSQL may render `IN (0, 3)` as
    // `= ANY (ARRAY[0, 3])`, so both complete renderings are accepted; a
    // different allowed set, or an extra disjunct, is not.
    definitionMustMatch: [],
    definitionForms: [
      'CHECKnum_nonnullssource_incarnation,source_revision,observation_sequence=ANYARRAY[0,3]',
      'CHECKnum_nonnullssource_incarnation,source_revision,observation_sequenceIN0,3',
    ] },
  { name: 'tenant_health_snapshots_source_revision_positive',
    relation: 'tenant_health_snapshots', contype: 'c',
    localColumns: 'source_revision',
    referencedRelation: null, referencedColumns: null,
    confupdtype: ' ', confdeltype: ' ', deferrable: false, deferred: false,
    // POSITIVITY, bound as a COMPLETE expression. `IS NULL AND > 0` and an
    // extra `OR = 0` both contain the old fragments and both fail here.
    definitionMustMatch: [],
    definitionForms: ['CHECKsource_revisionISNULLORsource_revision>0'] },
  { name: 'tenant_health_snapshots_observation_sequence_positive',
    relation: 'tenant_health_snapshots', contype: 'c',
    localColumns: 'observation_sequence',
    referencedRelation: null, referencedColumns: null,
    confupdtype: ' ', confdeltype: ' ', deferrable: false, deferred: false,
    definitionMustMatch: [],
    definitionForms: ['CHECKobservation_sequenceISNULLORobservation_sequence>0'] },
  // 20261109150000: THE TWO SNAPSHOT SCOPE FENCES, previously absent from
  // this list although the existing database suite covers them.
  { name: 'tenant_health_snapshots_organization_id_fkey',
    relation: 'tenant_health_snapshots', contype: 'f',
    localColumns: 'organization_id',
    referencedRelation: 'organizations', referencedColumns: 'id',
    confupdtype: 'r', confdeltype: 'c', deferrable: false, deferred: false,
    definitionMustMatch: [/ON UPDATE RESTRICT/, /ON DELETE CASCADE/] },
  { name: 'tenant_health_snapshots_customer_tenant_id_organization_id_fkey',
    relation: 'tenant_health_snapshots', contype: 'f',
    localColumns: 'customer_tenant_id,organization_id',
    referencedRelation: 'customer_tenants', referencedColumns: 'id,organization_id',
    confupdtype: 'r', confdeltype: 'c', deferrable: false, deferred: false,
    definitionMustMatch: [/ON UPDATE RESTRICT/, /ON DELETE CASCADE/] },
  // 20261109150300: the exact pointer, with its six ordered columns on each
  // side and NO ACTION on both, deferred.
  { name: 'tenant_health_source_authorities_exact_pointer_fkey',
    relation: 'tenant_health_source_authorities', contype: 'f',
    localColumns: 'current_snapshot_id,organization_id,customer_tenant_id,'
      + 'incarnation,source_revision,current_observation_sequence',
    referencedRelation: 'tenant_health_snapshots',
    referencedColumns: 'id,organization_id,customer_tenant_id,'
      + 'source_incarnation,source_revision,observation_sequence',
    confupdtype: 'a', confdeltype: 'a', deferrable: true, deferred: true,
    definitionMustMatch: [/DEFERRABLE INITIALLY DEFERRED/] },
  { name: 'tenant_health_source_authorities_organization_id_fkey',
    relation: 'tenant_health_source_authorities', contype: 'f',
    localColumns: 'organization_id',
    referencedRelation: 'organizations', referencedColumns: 'id',
    confupdtype: 'r', confdeltype: 'c', deferrable: false, deferred: false,
    definitionMustMatch: [/ON UPDATE RESTRICT/, /ON DELETE CASCADE/] },
])

/**
 * Every privilege the committed REVOKE clauses name must be ABSENT. The
 * conditional roles are recorded as absent when they do not exist, rather
 * than being created or silently skipped.
 */
const REVOKED_ROLES = Object.freeze(['public', 'anon', 'authenticated'])

export function assertUpgradedCatalog(observed: {
  readonly exactIndex: readonly { indisunique: boolean; indisvalid: boolean; indisready: boolean
    definition: string; key_columns: string | null }[]
  readonly constraints: readonly { conname: string; contype: string; convalidated: boolean
    condeferrable: boolean; condeferred: boolean; confupdtype: string; confdeltype: string
    definition: string; relation: string; referenced_relation: string | null
    local_columns: string | null; referenced_columns: string | null }[]
  readonly authorityRelation: readonly { relrowsecurity: boolean; relforcerowsecurity: boolean
    acl_entries: number }[]
  readonly privileges: readonly { role_name: string; present: boolean; object_kind: string
    privilege: string; granted: boolean | null }[]
  readonly triggers: readonly { relname: string; tgname: string; tgenabled: string }[]
  readonly writerTriggers: readonly { relname: string; tgname: string; tgenabled: string
    function_name: string; mode: string; timing: string; on_insert: boolean
    on_delete: boolean; on_update: boolean }[]
  readonly observationSequence: readonly { last_value: string; is_called: boolean }[]
}, expected: {
  readonly truncateGuards: readonly {
    readonly relation: string; readonly trigger: string; readonly always: boolean }[]
  readonly writerTriggers: readonly {
    readonly relation: string; readonly trigger: string; readonly fn: string
    readonly timing: string; readonly mode: string; readonly events: string }[]
}): void {
  // ---- the exact-source unique index, including its KEY COLUMNS -----------
  if (observed.exactIndex.length !== 1) fail('exact source index')
  const index = observed.exactIndex[0]
  if (index.indisunique !== true || index.indisvalid !== true || index.indisready !== true) {
    fail('exact source index')
  }
  if (index.key_columns !== EXACT_INDEX_KEY_COLUMNS) fail('exact source index key columns')
  if (!/CREATE UNIQUE INDEX/i.test(index.definition)) fail('exact source index definition')

  // ---- the named constraints, with TYPES, ORDERED KEYS and SEMANTICS -----
  const byName = new Map(observed.constraints.map(row => [row.conname, row]))
  for (const expectation of CONSTRAINT_EXPECTATIONS) {
    const row = byName.get(expectation.name)
    if (row === undefined) fail('snapshot constraint presence')
    if (row.relation !== expectation.relation) fail('snapshot constraint relation')
    if (row.contype !== expectation.contype) fail('snapshot constraint type')
    if (row.convalidated !== true) fail('snapshot constraint validation')
    if (row.local_columns !== expectation.localColumns) fail('snapshot constraint key columns')
    if (row.referenced_relation !== expectation.referencedRelation) {
      fail('snapshot constraint referenced relation')
    }
    if (row.referenced_columns !== expectation.referencedColumns) {
      fail('snapshot constraint referenced columns')
    }
    if (row.confupdtype !== expectation.confupdtype
      || row.confdeltype !== expectation.confdeltype) {
      fail('snapshot constraint actions')
    }
    if (row.condeferrable !== expectation.deferrable
      || row.condeferred !== expectation.deferred) {
      fail('snapshot constraint deferral')
    }
    if (typeof row.definition !== 'string' || row.definition.length === 0) {
      fail('snapshot constraint definition')
    }
    for (const pattern of expectation.definitionMustMatch) {
      if (!pattern.test(row.definition)) fail('snapshot constraint definition')
    }
    if (expectation.definitionForms !== undefined) {
      const normalized = normalizeCheckExpression(row.definition)
      if (!expectation.definitionForms.includes(normalized)) {
        fail('snapshot constraint expression')
      }
    }
  }
  // The loop above now covers presence, deferral and both referential actions
  // for EVERY expectation, including the exact pointer and the authority scope
  // fence. The separate named checks that used to follow were unreachable
  // duplicates -- the loop always fired first -- so they are gone rather than
  // left as dead code implying coverage they no longer provide. The specific
  // fences remain bound by their entries in CONSTRAINT_EXPECTATIONS.

  // ---- row level security and the FULL revoked-privilege contract --------
  if (observed.authorityRelation.length !== 1) fail('authority relation presence')
  if (observed.authorityRelation[0].relrowsecurity !== true) fail('authority row level security')
  // `relacl IS NULL` was the old check and it does NOT mean PUBLIC holds
  // nothing: a null ACL means no explicit grant was recorded and the owner
  // defaults apply. These are the effective answers, for every privilege the
  // committed REVOKE clauses name, on the table AND the sequence.
  for (const role of REVOKED_ROLES) {
    const rows = observed.privileges.filter(row => row.role_name === role)
    if (rows.length === 0) fail('authority privilege observation')
    // An absent conditional role is recorded, not created, and nothing is
    // asserted about privileges it cannot hold.
    if (rows.every(row => row.present === false)) continue
    for (const row of rows) {
      if (row.granted === true) fail('authority public privileges')
    }
  }
  for (const kind of ['table', 'sequence']) {
    if (!observed.privileges.some(row => row.object_kind === kind)) {
      fail('authority privilege observation')
    }
  }

  // ---- the observation sequence, which was selected but never read -------
  if (observed.observationSequence.length !== 1) fail('observation sequence presence')
  const sequence = observed.observationSequence[0]
  // The backfill writes the literal 0, so nothing should have consumed the
  // sequence. `is_called` true would mean something called nextval during the
  // upgrade, which this protocol does not do.
  if (sequence.is_called !== false) fail('observation sequence consumed')
  if (sequence.last_value !== '1') fail('observation sequence start')

  // ---- the TRUNCATE guards the staged candidate SQL declares -------------
  const observedGuards = observed.triggers.map(row => `${row.relname}:${row.tgname}`).sort()
  const expectedGuards = expected.truncateGuards
    .map(guard => `${guard.relation}:${guard.trigger}`).sort()
  if (canonical(observedGuards) !== canonical(expectedGuards)) {
    fail('truncate refusal trigger presence')
  }
  const guardByKey = new Map(observed.triggers.map(row => [`${row.relname}:${row.tgname}`, row]))
  for (const guard of expected.truncateGuards) {
    const row = guardByKey.get(`${guard.relation}:${guard.trigger}`)
    if (row === undefined) fail('truncate refusal trigger presence')
    if (row.tgenabled === 'D') fail('truncate refusal trigger enabled')
    // The EXACT expected state, since the derivation already knows it. Only
    // excluding 'D' left 'R' (replica-only) passing: enabled, not disabled,
    // and firing only on a replica.
    if (guard.always) {
      if (row.tgenabled !== 'A') fail('truncate refusal trigger always')
    } else if (row.tgenabled !== 'O') {
      fail('truncate refusal trigger origin')
    }
  }

  // ---- the SOURCE-WRITER inventory, with timing, events and mode ---------
  const writerKey = (relation: string, trigger: string, fn: string, timing: string,
    mode: string, events: string): string => `${relation}:${trigger}:${fn}:${timing}:${mode}:${events}`
  const observedWriters = observed.writerTriggers.map(row => writerKey(
    row.relname, row.tgname, row.function_name, row.timing, row.mode,
    [row.on_insert ? 'INSERT' : '', row.on_update ? 'UPDATE' : '', row.on_delete ? 'DELETE' : '']
      .filter(event => event !== '').join('+'))).sort()
  const expectedWriters = expected.writerTriggers.map(row => writerKey(
    row.relation, row.trigger, row.fn, row.timing, row.mode, row.events)).sort()
  if (canonical(observedWriters) !== canonical(expectedWriters)) {
    fail('writer trigger inventory')
  }
  for (const row of observed.writerTriggers) {
    if (row.tgenabled === 'D') fail('writer trigger enabled')
    // A replica-only writer guard fires only on a replica. None of these is
    // declared ENABLE ALWAYS, so the expected state is origin.
    if (row.tgenabled !== 'O') fail('writer trigger origin')
    if (!(row.on_insert || row.on_update || row.on_delete)) fail('writer trigger events')
  }
}

/** The second deployment must change nothing that was verified. */
/**
 * WHAT CLEANUP ACTUALLY LEFT BEHIND, observed rather than declared, and bound
 * to the OWNED IDENTITIES with their own expected revision.
 *
 * The previous form required revision 2 for every retained authority. That is
 * wrong, and it would have failed a CORRECT physical upgrade, because two
 * committed triggers fire during cleanup and one of them touches only the
 * sibling:
 *
 *  - `20261114191500_tenant_health_sync_state_source_revision` installs
 *    `tenant_health_sync_state_delete_invalidate`, which on a sync-state
 *    DELETE advances `source_revision + 1` for the matching authority WHERE
 *    `authority.live`, clearing the pointer and zeroing the sequence. Cleanup
 *    deletes the sibling's sync-state row, so the sibling's authority goes
 *    1 -> 2 while it is still live.
 *  - `20261113021500_tenant_health_tenant_deletion_tombstone` then advances
 *    every deleted tenant's authority again and marks it dead, so the sibling
 *    reaches 3 and the other two reach 2.
 *
 * `tenant_health_snapshots` carries no non-TRUNCATE trigger, so deleting the
 * snapshots first advances nothing.
 *
 * The expectation is therefore PER IDENTITY, and the incarnation must be the
 * one the backfill minted: a tombstone for a different incarnation is a
 * different authority, not a preserved one.
 */
export interface Haw70ExpectedTombstone {
  readonly organization: string
  readonly tenant: string
  readonly incarnation: string
  readonly revision: string
}

export function assertCleanupPostconditions(observed: {
  readonly deletedSnapshots: number
  readonly deletedSyncStates: number
  readonly deletedTenants: number
  readonly remainingSnapshots: number
  readonly remainingSyncStates: number
  readonly remainingTenants: number
  readonly authorities: readonly Haw70AuthorityRow[]
  readonly organizations: readonly Record<string, unknown>[]
}, expected: {
  readonly snapshots: number; readonly syncStates: number; readonly tenants: number
  readonly organizations: number
  readonly tombstones: readonly Haw70ExpectedTombstone[]
}): void {
  if (observed.deletedSnapshots !== expected.snapshots) fail('cleanup deleted snapshot count')
  if (observed.deletedSyncStates !== expected.syncStates) fail('cleanup deleted sync state count')
  if (observed.deletedTenants !== expected.tenants) fail('cleanup deleted tenant count')
  if (observed.remainingSnapshots !== 0) fail('cleanup residual snapshots')
  if (observed.remainingSyncStates !== 0) fail('cleanup residual sync states')
  if (observed.remainingTenants !== 0) fail('cleanup residual tenants')

  // The retained rows, verified to BE the intended tombstones -- scoped by
  // organization AND tenant, since the authority key is that pair.
  if (observed.authorities.length !== expected.tombstones.length) {
    fail('retained tombstone inventory')
  }
  const byScope = new Map(observed.authorities
    .map(row => [`${row.organization_id}:${row.customer_tenant_id}`, row]))
  if (byScope.size !== observed.authorities.length) fail('retained tombstone duplication')
  for (const tombstone of expected.tombstones) {
    const row = byScope.get(`${tombstone.organization}:${tombstone.tenant}`)
    if (row === undefined) fail('retained tombstone scope')
    if (row.incarnation !== tombstone.incarnation) fail('retained tombstone incarnation')
    // EXACT, per identity. A lower bound such as `>= 2` would accept a
    // sibling that never invalidated, which is the whole point of the check.
    if (row.source_revision !== tombstone.revision) fail('retained tombstone revision')
    if (row.live !== false) fail('retained tombstone liveness')
    if (row.current_snapshot_id !== null) fail('retained tombstone pointer')
    if (row.current_observation_sequence !== '0') fail('retained tombstone sequence')
  }
  if (observed.organizations.length !== expected.organizations) fail('retained organization inventory')
}

export function assertNoOp(before: Record<string, unknown>, after: Record<string, unknown>): void {
  if (canonical(before) !== canonical(after)) fail('second deployment no-op')
}
