import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js'
import { assertE2DisposableUrl, disposableConnectionOptions, loadCommittedMigrationPlan } from './e2-migration-upgrade.js'

async function main(mode: string | undefined): Promise<void> {
  assert.ok(['seed-upgrade', 'verify-upgrade', 'verify-fresh'].includes(mode ?? ''), 'Verification mode required')
  const before = mode === 'seed-upgrade'
  const url = assertE2DisposableUrl(process.env, mode === 'verify-fresh' ? 'fresh' : 'upgrade')
  const plan = loadCommittedMigrationPlan(process.env)
  const stage = before ? 64 : 66
  assert.equal(process.env.HAWKVIEW_E2_MIGRATION_STAGE, String(stage))
  const connection = disposableConnectionOptions(url)
  const prisma = new PrismaClient({ adapter: new PrismaPg(connection) })
  const sql = new pg.Client(connection)
  const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
  const organizationId = id(6501)
  const tenantId = id(6502)
  const runId = id(6503)
  const at = new Date('2026-09-14T12:00:00.000Z')
  const expiry = new Date('2026-09-15T12:00:00.000Z')
  const legacy = [
    ['LOW', 'LOW', 'FULL'],
    ['MEDIUM', 'MEDIUM', 'PARTIAL'],
    ['HIGH', 'HIGH', 'FULL'],
    ['CRITICAL', 'LOW', 'PARTIAL'],
  ] as const

  async function seed() {
    assert.equal(await prisma.organization.findUnique({ where: { id: organizationId } }), null,
      'Preserve an existing fixture rather than overwriting it')
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.organization.create({ data: {
        id: organizationId, name: 'E2 synthetic migration fixture', slug: 'e2-m66-vocabulary-fixture',
      } })
      await tx.customerTenant.create({ data: {
        id: tenantId, organizationId, microsoftTenantId: id(6504),
        displayName: 'E2 synthetic migration tenant', status: 'ACTIVE',
      } })
      await tx.identityRiskEvaluationRun.create({ data: {
        id: runId, organizationId, customerTenantId: tenantId, runKey: 'e2-m66-fixture',
        engineVersion: 'migration-fixture', catalogVersion: 'migration-fixture', status: 'COMPLETED',
        windowStart: new Date(at.getTime() - 3_600_000), windowEnd: at,
        sourceWatermarkHash: 'synthetic', sourceContentHash: 'synthetic',
        completedAt: at, expiresAt: expiry,
      } })
      for (const [index, [severity, confidence, coverage]] of legacy.entries()) {
        await tx.identityRiskMatchedResult.create({ data: {
          id: id(6600 + index), organizationId, customerTenantId: tenantId,
          evaluationRunId: runId, resultKey: `e2-m66-result-${index}`,
          ruleId: 'HV-ID-AUTH-010.v1', subjectType: 'USER', subjectId: `e2-m66-subject-${index}`,
          severity, confidence, coverage, observedAt: at, expiresAt: expiry, evidence: [],
        } })
        await tx.identityRiskFinding.create({ data: {
          id: id(6700 + index), organizationId, customerTenantId: tenantId,
          matchedResultId: id(6600 + index), dedupeKey: `e2-m66-finding-${index}`,
          ruleId: 'HV-ID-AUTH-010.v1', ruleVersion: 'v1', subjectType: 'USER',
          subjectId: `e2-m66-subject-${index}`, state: 'RESOLVED',
          severity, confidence, coverage, observedAt: at, expiresAt: expiry,
        } })
      }
    })
  }

  async function assertLegacyRows() {
    const rows = await prisma.identityRiskFinding.findMany({
      where: { organizationId }, include: { matchedResult: true }, orderBy: { dedupeKey: 'asc' },
    })
    assert.equal(rows.length, legacy.length)
    for (const [index, row] of rows.entries()) {
      assert.equal(row.id, id(6700 + index))
      assert.equal(row.matchedResultId, id(6600 + index))
      assert.equal(row.matchedResult.evaluationRunId, runId)
      assert.equal(row.state, 'RESOLVED')
      assert.deepEqual([row.severity, row.confidence, row.coverage], legacy[index])
      assert.deepEqual([row.matchedResult.severity, row.matchedResult.confidence,
        row.matchedResult.coverage], legacy[index])
      for (const side of [row, row.matchedResult]) {
        assert.equal(side.observedAt.toISOString(), at.toISOString())
        assert.equal(side.expiresAt.toISOString(), expiry.toISOString())
        assert.equal(side.organizationId, organizationId)
        assert.equal(side.customerTenantId, tenantId)
        assert.equal(side.ruleId, 'HV-ID-AUTH-010.v1')
        assert.equal(side.subjectId, `e2-m66-subject-${index}`)
      }
      assert.deepEqual(row.matchedResult.evidence, [])
    }
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  }

  async function probe(table: string, column: string, rowId: string,
    value: string | null, expectedError?: string) {
    // Identifiers come only from the closed table/column list below; values are bound.
    await sql.query('BEGIN')
    try {
      let error: unknown
      let result: pg.QueryResult | undefined
      try {
        result = await sql.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2 RETURNING ${column}`,
          [value, rowId])
      } catch (cause) { error = cause }
      if (expectedError) {
        assert.equal((error as { code?: string } | undefined)?.code, expectedError,
          `${table}.${column} must reject the tested value for the expected constraint reason`)
      } else {
        if (error) throw error
        assert.equal(result?.rowCount, 1)
        assert.equal(result?.rows[0]?.[column], value)
      }
    } finally {
      await sql.query('ROLLBACK')
    }
  }


  try {
    await sql.connect()
    const { rows: [state] } = await sql.query(
      "SELECT current_database() AS database, current_user AS role, current_setting('TimeZone') AS timezone, inet_server_port() AS port, current_setting('server_version_num') AS version")
    assert.ok(state.database === url.pathname.slice(1) && state.role === 'postgres'
      && state.timezone === 'UTC' && state.port === 55432
      && Math.floor(Number(state.version) / 10000) === 15, 'Reserved PostgreSQL 15 UTC fixture required')
    const history = await sql.query<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name')
    assert.equal(history.rows.length, stage)
    assert.ok(history.rows.every(row => row.finished_at !== null && row.rolled_back_at === null))
    assert.deepEqual(history.rows.map(row => ({ name: row.migration_name, checksum: row.checksum })),
      plan.migrations.slice(0, stage).map(({ name, checksum }) => ({ name, checksum })))
    const session = await prisma.$queryRawUnsafe<Array<{ timezone: string }>>(
      "SELECT current_setting('TimeZone') AS timezone")
    assert.equal(session[0]?.timezone, 'UTC')
    if (before || mode === 'verify-fresh') await seed()
    const legacyDigest = await assertLegacyRows()
    if (mode === 'verify-upgrade') {
      assert.match(process.env.HAWKVIEW_E2_LEGACY_DIGEST ?? '', /^[a-f0-9]{64}$/)
      assert.equal(legacyDigest, process.env.HAWKVIEW_E2_LEGACY_DIGEST,
        'Every seeded row field, link, clock and evidence value must survive the upgrade')
    }
    let checks = 0
    for (const [table, rowId] of [
      ['identity_risk_findings', id(6700)],
      ['identity_risk_matched_results', id(6600)],
    ]) {
      for (const column of ['severity', 'confidence', 'coverage']) {
        await probe(table!, column, rowId!, 'NOT_ASSESSED', before ? '23514' : undefined)
        checks += 1
        if (!before) {
          await probe(table!, column, rowId!, null, '23502')
          await probe(table!, column, rowId!, 'INVALID', '23514')
          checks += 2
        }
      }
    }
    assert.equal(await assertLegacyRows(), legacyDigest, 'Constraint probes must leave all fixture rows unchanged')
    if (!before) await prisma.organization.delete({ where: { id: organizationId } })
    console.log(JSON.stringify({
      mode, status: 'PASS', candidateSha: plan.candidateSha, manifestDigest: plan.digest,
      migrations: stage, postgresMajor: 15, timezone: 'UTC',
      legacyRowsPerTable: 4, legacyTables: 2, legacyDigest,
      constraintChecksPassed: checks, failures: 0,
      rlsMigrationApplied: !before, syntheticFixtureCleaned: !before, databaseRetained: true,
    }))
  } finally {
    await sql.end()
    await prisma.$disconnect()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(() => {
    console.error(JSON.stringify({ status: 'FAILED', code: 'DISPOSABLE_VOCABULARY_VERIFICATION_FAILED' }))
    process.exitCode = 1
  })
}
