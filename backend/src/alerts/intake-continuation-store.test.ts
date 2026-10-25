import assert from 'node:assert/strict'
import test from 'node:test'
import { readIntakeCandidatePages } from './intake-continuation-store.js'
import type { SqlRunner } from './pipeline-store.js'

const tickAt = '2026-10-25T12:00:00.000000Z'
const row = {
  id: '00000000-0000-0000-0000-000000000001',
  organization_id: '00000000-0000-0000-0000-000000000002',
  customer_tenant_id: '00000000-0000-0000-0000-000000000003',
  matched_result_id: '00000000-0000-0000-0000-000000000004',
  dedupe_key: 'dedupe', rule_id: 'HV-ID-AUTH-001.v1', rule_version: 'v1',
  subject_type: 'USER', subject_id: 'subject', state: 'UPDATED',
  severity: 'HIGH', confidence: 'MEDIUM', coverage: 'FULL',
  observed_at_exact: '2026-10-24T12:00:00.123456Z',
  expires_at_exact: '2026-10-25T11:00:00.123457Z',
  updated_at_exact: '2026-10-25T11:00:00.123458Z',
}

test('inactive selector applies durable eligibility before each capped lane limit', async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  const runner = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      calls.push({ sql, params })
      return [row] as T[]
    },
  } as SqlRunner
  const pages = await readIntakeCandidatePages(runner, tickAt, 'reviewed-map-a', { recent: 3000, old: 2000 })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(c => c.params), [
    [tickAt, 'reviewed-map-a', 3001], [tickAt, 'reviewed-map-a', 2001],
  ])
  for (const { sql } of calls) {
    assert.match(sql, /LEFT JOIN alert_finding_intake_status s ON s\.finding_id = f\.id/)
    assert.match(sql, /f\.state IN \('OPEN', 'UPDATED'\)/)
    assert.match(sql, /s\.finding_id IS NULL/)
    assert.match(sql, /s\.organization_id = f\.organization_id\s+AND s\.customer_tenant_id = f\.customer_tenant_id/)
    assert.doesNotMatch(sql, /s\.organization_id IS DISTINCT FROM f\.organization_id/)
    assert.doesNotMatch(sql, /s\.dedupe_key/)
    assert.match(sql, /s\.outcome = 'BLOCKED_UNMAPPED'/)
    assert.match(sql, /s\.source_rule_version IS DISTINCT FROM f\.rule_version/)
    assert.match(sql, /s\.mapping_revision IS DISTINCT FROM \$2::varchar/)
    assert.ok(sql.indexOf('LEFT JOIN alert_finding_intake_status') < sql.indexOf('ORDER BY'))
    assert.ok(sql.indexOf('s.finding_id IS NULL') < sql.indexOf('ORDER BY'))
    assert.ok(sql.indexOf('ORDER BY f.observed_at, f.id') < sql.indexOf('LIMIT $3::int'))
    assert.match(sql, /HH24:MI:SS\.US"Z"/)
    assert.doesNotMatch(sql, /f\.expires_at >/)
  }
  assert.match(calls[0].sql, /f\.observed_at >= \$1::timestamptz - INTERVAL '24 hours'/)
  assert.match(calls[1].sql, /f\.observed_at < \$1::timestamptz - INTERVAL '24 hours'/)
  assert.deepEqual(pages.recent.findings[0], {
    id: row.id, organizationId: row.organization_id, customerTenantId: row.customer_tenant_id,
    matchedResultId: row.matched_result_id, dedupeKey: row.dedupe_key, ruleId: row.rule_id,
    ruleVersion: row.rule_version, subjectType: row.subject_type, subjectId: row.subject_id,
    state: row.state, severity: row.severity, confidence: row.confidence, coverage: row.coverage,
    observedAt: row.observed_at_exact, expiresAt: row.expires_at_exact, updatedAt: row.updated_at_exact,
  })
  assert.deepEqual(pages.old.findings, pages.recent.findings)
})

test('a mismatched receipt is excluded in SQL so a valid tail can make progress', async () => {
  const runner = {
    async query<T>(_sql: string, _params: readonly unknown[]): Promise<readonly T[]> {
      // PostgreSQL applies the scope-qualified receipt predicate before the
      // limit. The returned row represents the valid tail past a corrupt head.
      return [row] as T[]
    },
  } as SqlRunner
  const pages = await readIntakeCandidatePages(runner, tickAt, 'reviewed-map-a',
    { recent: 200, old: 200 })
  assert.equal(pages.recent.findings[0]?.id, row.id)
})

test('a quiet recent lane lends its unused cap to old pending evidence', async () => {
  const limits: number[] = []
  const runner = {
    async query<T>(_sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      limits.push(Number(params[2]))
      return Array.from({ length: limits.length === 1 ? 1 : Number(params[2]) }, () => row) as T[]
    },
  } as SqlRunner
  const pages = await readIntakeCandidatePages(runner, tickAt, 'reviewed-map-a',
    { recent: 200, old: 200 })
  assert.deepEqual(limits, [201, 201, 400])
  assert.equal(pages.recent.findings.length, 1)
  assert.equal(pages.old.findings.length, 399)
  assert.equal(pages.old.truncated, true)
  assert.equal(pages.recent.findings.length + pages.old.findings.length, 400)
})

test('lane reader reports one-past-cap and refuses accidental unbounded budgets', async () => {
  let calls = 0
  const runner = {
    async query<T>(_sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      calls++
      return Array.from({ length: Number(params[2]) }, () => row) as T[]
    },
  } as SqlRunner
  const pages = await readIntakeCandidatePages(runner, tickAt, 'reviewed-map-a', { recent: 200, old: 200 })
  assert.equal(pages.recent.findings.length, 200)
  assert.equal(pages.old.findings.length, 200)
  assert.equal(pages.recent.truncated, true)
  assert.equal(pages.old.truncated, true)
  for (const budgets of [
    { recent: 199, old: 200 }, { recent: 200, old: 199 },
    { recent: 4801, old: 200 }, { recent: Number.POSITIVE_INFINITY, old: 200 },
  ]) {
    await assert.rejects(readIntakeCandidatePages(runner, tickAt, 'reviewed-map-a', budgets),
      /INVALID_INTAKE_LANE_BUDGETS/)
  }
  assert.equal(calls, 2)
})
