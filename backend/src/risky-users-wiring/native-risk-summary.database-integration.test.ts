import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { PrismaService } from '../prisma/prisma.service.js'
import { assertDisposableTestDatabase } from '../prisma/native-alert-test-database.js'
import { NATIVE_SUMMARY_SQL, readNativeRiskSummary } from './native-risk-summary.js'
import { RUN_ENGINE_VERSION, RUN_STATUS } from './persist-run.js'

const now = new Date('2026-09-15T12:00:00.456Z')
const organizationId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const scope = { totalTenants: 1, tenants: [{ id: tenantId, organizationId, gate: null }] }

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333', organization_id: organizationId, customer_tenant_id: tenantId,
    status: RUN_STATUS, engine_version: RUN_ENGINE_VERSION,
    completed_at: '2026-09-15T11:00:00.123Z', window_start: '2026-09-01T00:00:00.234Z',
    window_end: '2026-09-15T10:00:00.789Z', expires_at: '2026-09-16T00:00:00.321Z',
    evaluation_coverage: { version: 'hawkview-run-coverage/v1', streams: [{ stream: 'GRAPH_SIGN_INS', coverage: {
      version: 'hawkview-coverage/v1', collectionScope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' },
      applies: 10, doesNotApply: {}, notYetCited: {}, unknown: {}, unprocessable: {},
    } }] },
    evaluation_findings: {
      version: 'hawkview-run-findings/v1', complete: true, claim: { permitted: true },
      count: { accuracy: 'EXACT', value: 1, scope: { evidenceRequested: ['GRAPH_INTERACTIVE_ONLY'], setAside: [], covered: ['synthetic-detector'], notCovered: [] } },
      sources: [], items: [{ detectorId: 'synthetic-detector', subject: { kind: 'DIRECTORY_USER', userRef: 'synthetic-only' },
        signals: [{ signal: 'SYNTHETIC_SIGNAL', count: 1, capped: false, latest: null }] }],
    }, ...overrides,
  }
}

// Execute the ACTUAL production SELECT unchanged. A read-only CTE shadows its
// table with synthetic bound rows: no schema, table, user or fixture writes.
function fixtureQuery(sql: string) {
  assert.equal(sql, NATIVE_SUMMARY_SQL)
  assert.ok(sql.startsWith('WITH authorized AS'))
  return `WITH identity_risk_evaluation_runs AS (
    SELECT * FROM jsonb_to_recordset($6::jsonb) AS f(
      id uuid, organization_id uuid, customer_tenant_id uuid, status text, engine_version text,
      completed_at timestamptz, window_start timestamptz, window_end timestamptz, expires_at timestamptz,
      evaluation_coverage jsonb, evaluation_findings jsonb)
  ), ${sql.slice('WITH '.length)}`
}

type Query = <T>(sql: string, ...values: unknown[]) => Promise<T>
async function verifyClocks(query: Query) {
  const cases = [
    { rows: [fixture()], accuracy: 'EXACT', evaluatedAt: '2026-09-15T11:00:00.123Z', reason: null },
    { rows: [fixture({ completed_at: '2026-09-15T07:00:00.123-04:00' })], accuracy: 'EXACT', evaluatedAt: '2026-09-15T11:00:00.123Z', reason: null },
    { rows: [fixture({ completed_at: now.toISOString() })], accuracy: 'EXACT', evaluatedAt: now.toISOString(), reason: null },
    { rows: [fixture({ completed_at: new Date(now.getTime() + 1).toISOString() })], accuracy: 'NOT_AVAILABLE', evaluatedAt: null, reason: 'INVALID_RUN' },
    { rows: [fixture({ expires_at: now.toISOString() })], accuracy: 'NOT_AVAILABLE', evaluatedAt: null, reason: 'NO_CURRENT_RUN' },
    { rows: [fixture({ expires_at: new Date(now.getTime() - 1).toISOString() })], accuracy: 'NOT_AVAILABLE', evaluatedAt: null, reason: 'NO_CURRENT_RUN' },
    { rows: [fixture({ expires_at: new Date(now.getTime() + 1).toISOString() })], accuracy: 'EXACT', evaluatedAt: '2026-09-15T11:00:00.123Z', reason: null },
    { rows: [fixture({ completed_at: new Date(now.getTime() + 1).toISOString() }), fixture({ id: '44444444-4444-4444-8444-444444444444' })], accuracy: 'NOT_AVAILABLE', evaluatedAt: null, reason: 'INVALID_RUN' },
  ]
  const results = []
  for (const entry of cases) {
    const client = { $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => query<T>(fixtureQuery(sql), ...values, JSON.stringify(entry.rows)) }
    const result = await readNativeRiskSummary(client, scope, now)
    assert.equal(result.fleet.accuracy, entry.accuracy)
    assert.equal(result.fleet.distinctUserCount, entry.accuracy === 'EXACT' ? 1 : null)
    assert.equal(result.tenants[0].evaluatedAt, entry.evaluatedAt)
    assert.deepEqual(result.tenants[0].limitations, entry.reason ? [entry.reason] : [])
    if (entry.accuracy === 'EXACT') {
      assert.equal(result.tenants[0].windowStart, '2026-09-01T00:00:00.234Z')
      assert.equal(result.tenants[0].windowEnd, '2026-09-15T10:00:00.789Z')
    }
    results.push(result)
  }
  return results
}

test('real PostgreSQL summary clocks are identical across process/session UTC and Toronto, pg and Prisma',
  { skip: process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS !== '1', timeout: 30_000 }, async () => {
    const url = assertDisposableTestDatabase()
    const previousTZ = process.env.TZ
    let baseline: unknown
    try {
      for (const processZone of ['UTC', 'America/Toronto']) {
        process.env.TZ = processZone
        assert.equal(now.getTimezoneOffset(), processZone === 'UTC' ? 0 : 240)
        const raw = new pg.Client({ connectionString: url.toString() })
        const prisma = new PrismaService()
        try {
          await raw.connect()
          await raw.query('BEGIN READ ONLY')
          for (const sessionZone of ['UTC', 'America/Toronto']) {
            await raw.query("SELECT set_config('TimeZone', $1, true)", [sessionZone])
            assert.equal((await raw.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone, sessionZone)
            const pgResults = await verifyClocks(async <T>(sql: string, ...values: unknown[]) => {
              const result = await raw.query(sql, values)
              for (const name of ['completedAt', 'windowStart', 'windowEnd', 'expiresAt']) {
                assert.equal(result.fields.find((field) => field.name === name)?.dataTypeID, 25, 'canonical UTC text, not driver-local timestamp')
              }
              return result.rows as T
            })
            const prismaResults = await prisma.$transaction(async (transaction) => {
              await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY')
              await transaction.$queryRawUnsafe("SELECT set_config('TimeZone', $1, true)", sessionZone)
              const timezone = await transaction.$queryRawUnsafe<Array<{ zone: string }>>("SELECT current_setting('TimeZone') AS zone")
              assert.equal(timezone[0].zone, sessionZone)
              return verifyClocks((sql, ...values) => transaction.$queryRawUnsafe(sql, ...values))
            }, { isolationLevel: 'RepeatableRead', timeout: 10_000 })
            baseline ??= pgResults
            assert.deepEqual(pgResults, baseline)
            assert.deepEqual(prismaResults, baseline)
          }
        } finally {
          await raw.end()
          await prisma.$disconnect()
        }
      }
    } finally {
      if (previousTZ === undefined) delete process.env.TZ
      else process.env.TZ = previousTZ
    }
  })
