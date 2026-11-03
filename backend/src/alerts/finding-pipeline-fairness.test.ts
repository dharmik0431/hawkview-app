import assert from 'node:assert/strict'
import test from 'node:test'
import { dispositionKey, noticeKeyFor, runIntake, scopedNoticeKey, type ExistingIncident, type PipelineStore } from './finding-pipeline.js'
import { pipelineStore } from './pipeline-store.js'

const AT = '2026-10-04T06:00:00.000Z'
const SINCE = '2026-10-03T06:00:00.000Z'
const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const WATERMARK = { sendNothingObservedBeforeIso: SINCE, because: 'fixture activation' }
const row = (i: number) => ({
  id: String(i).padStart(6, '0'), organization_id: ORG, customer_tenant_id: OTHER,
  rule_id: 'HV-ID-AUTH-001.v1', dedupe_key: `evidence-${i}`,
  subject_type: 'USER', subject_id: `user-${i}`, state: 'OPEN',
  observed_at: new Date(AT), expires_at: new Date('2026-10-05T00:00:00.000Z'),
})
type History = { organizationId: string; dedupeKey: string; resolved?: boolean }

/** A deliberately narrow SQL-boundary model, NOT PostgreSQL execution. The shipping selector
 * supplies predicates/parameters/order/cap; writes below are atomic memory commits. SQL syntax,
 * isolation and query cost require the separately guarded database suite. */
function fixture(count = 5001) {
  const rows = Array.from({ length: count }, (_, i) => row(i))
  const notified: History[] = []
  const withheld: History[] = []
  const existing: ExistingIncident[] = []
  const state = { recipient: true, recordOnly: false, failCommit: false, queries: 0, commits: 0, clock: 0, yieldAfterCommit: false }
  const actual = pipelineStore({
    async query<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
      state.queries++
      assert.match(sql, /WHERE state = 'OPEN'/)
      assert.match(sql, /expires_at > \$2::timestamptz/)
      assert.match(sql, /ORDER BY observed_at, id/)
      assert.match(sql, /LIMIT 5001/)
      const excludes = (table: string, alias: string, history: History[], finding: ReturnType<typeof row>) => {
        const block = sql.match(new RegExp(`AND NOT EXISTS \\(\\s*SELECT 1 FROM ${table} AS ${alias}([\\s\\S]*?)\\)`))?.[1]
        if (!block) return false // Also runs on the old selector for the positive regression.
        const prefix = block.match(new RegExp(`${alias}\\.dedupe_key = '([^']*)' \\|\\| finding\\.dedupe_key`))?.[1]
        assert.notEqual(prefix, undefined, 'selector must compare the exact evidence identity')
        const scoped = block.includes(`${alias}.organization_id = finding.organization_id`)
        return history.some(h => (!scoped || h.organizationId === finding.organization_id)
          && h.dedupeKey === prefix + finding.dedupe_key
          && (!block.includes('resolved_at IS NULL') || !h.resolved))
      }
      return rows.filter(f => f.state === 'OPEN' && f.observed_at >= new Date(String(params[0]))
        && f.expires_at > new Date(String(params[1]))
        && !excludes('notifications', 'notice', notified, f)
        && !excludes('alert_withheld_notices', 'withheld', withheld, f))
        .sort((a, b) => +a.observed_at - +b.observed_at || a.id.localeCompare(b.id))
        .slice(0, 5001) as unknown as T[]
    },
    async execute() { throw new Error('Unexpected SQL write in offline fixture') },
    async transaction() { throw new Error('Unexpected SQL transaction in offline fixture') },
  })
  const store: PipelineStore = {
    ...actual,
    async findExistingIncidents() { return existing },
    async loadDispositions() { return { byOrganizationAndAlertType: new Map(state.recordOnly
      ? [[dispositionKey(ORG, 'security.suspected_credential_attack'), 'RECORD_ONLY' as const]] : []),
      unreadable: [], anyRecipientByOrganization: new Map([[ORG, state.recipient], [OTHER, state.recipient]]) } },
    async findDecidedNoticeKeys() { return new Set([...notified, ...withheld].map(h => scopedNoticeKey(h.organizationId, h.dedupeKey))) },
    async countUnknownAlertTypes() { return 0 },
    async commit(incidents, notices, jobs, suppressed) {
      if (state.failCommit) throw new Error('Injected rollback before durable commit')
      existing.push(...incidents.map(i => ({ organizationId: i.organizationId, incidentKey: i.incidentKey })))
      notified.push(...notices)
      withheld.push(...suppressed)
      state.commits++
      if (state.yieldAfterCommit) state.clock = 1000
      return { incidentsWritten: incidents.length, notificationsWritten: notices.length, jobsWritten: jobs.length, noticesWithheld: suppressed.length }
    },
  }
  const tick = () => runIntake(store, WATERMARK, AT, 1000, SINCE, () => state.clock)
  return { rows, notified, withheld, existing, state, store, actual, tick }
}
async function ran(f: ReturnType<typeof fixture>) {
  const outcome = await f.tick()
  assert.equal(outcome.kind, 'RAN')
  if (outcome.kind !== 'RAN') throw new Error('Unexpected failure')
  return outcome.report
}

for (const recipient of [true, false]) test(`eligible tail progresses after 5000 ${recipient ? 'notified' : 'withheld'} OPEN decisions`, async () => {
  const f = fixture()
  f.state.recordOnly = !recipient
  const first = await ran(f)
  assert.equal(first.findingsRead, 5000)
  assert.equal(first.truncated, true)
  assert.equal(first.chunksCommitted, 25)
  assert.equal(recipient ? first.notificationsWritten : first.noticesWithheld, 5000)
  const second = await ran(f)
  assert.equal(second.notificationsWritten + second.noticesWithheld, 1, 'the eligible tail must be processed on the next completed call')
  assert.equal(second.findingsRead, 1)
  assert.equal(second.truncated, false)
  assert.equal(f.rows.every(r => r.state === 'OPEN' && r.expires_at > new Date(AT)), true)
  assert.equal([...f.notified, ...f.withheld].some(h => h.dedupeKey === 'identity-risk:evidence-5000'), true)
  f.state.recordOnly = false
  assert.equal((await ran(f)).findingsRead, 0, 'a disposition change must not replay durable decisions')
})

test('resolved notifications remain decided before the cap', async () => {
  const f = fixture()
  f.notified.push(...f.rows.slice(0, 5000).map(r => ({ organizationId: ORG, dedupeKey: `identity-risk:${r.dedupe_key}`, resolved: true })))
  assert.equal((await ran(f)).notificationsWritten, 1, 'resolved prefix must release the eligible tail')
})

for (const history of ['notified', 'withheld'] as const) test(`${history} selection is scoped to organization`, async () => {
  const f = fixture(1)
  f[history].push({ organizationId: OTHER, dedupeKey: 'identity-risk:evidence-0' })
  assert.equal((await ran(f)).notificationsWritten, 1, 'foreign organization must not suppress this finding')
})

test('fresh evidence on an existing incident receives a notice without another job', async () => {
  const f = fixture(1)
  assert.equal((await ran(f)).jobsWritten, 1)
  f.rows.push({ ...row(1), subject_id: f.rows[0]!.subject_id })
  const fresh = await ran(f)
  assert.equal(fresh.notificationsWritten, 1)
  assert.equal(fresh.jobsWritten, 0)
  assert.equal(fresh.incidentsWritten, 0)
  assert.equal((await ran(f)).findingsRead, 0)
})

test('unknown rule prefix remains a documented fairness limit', async () => {
  const f = fixture()
  f.rows.slice(0, 5000).forEach(r => { r.rule_id = 'unknown-rule' })
  for (let i = 0; i < 2; i++) {
    const report = await ran(f)
    assert.equal(report.truncated, true)
    assert.equal(report.notificationsWritten, 0)
    assert.equal(report.noticesWithheld, 0)
  }
  assert.equal(f.notified.length, 0)
})

test('rollback leaves undecided work eligible for retry', async () => {
  const f = fixture(201)
  f.state.failCommit = true
  assert.equal((await f.tick()).kind, 'FAILED')
  assert.equal(f.notified.length, 0)
  assert.equal(f.existing.length, 0)
  f.state.failCommit = false
  assert.equal((await ran(f)).notificationsWritten, 201)
  assert.equal((await ran(f)).findingsRead, 0)
})

test('budget yield retains the uncommitted chunk and resumes it', async () => {
  const f = fixture(201)
  f.state.clock = 1000
  assert.equal((await ran(f)).yieldedOnBudget, true)
  assert.equal(f.state.queries, 0)
  f.state.clock = 0
  f.state.yieldAfterCommit = true
  const first = await ran(f)
  assert.equal(first.notificationsWritten, 200)
  assert.equal(first.findingsUnprocessed, 1)
  assert.equal(first.yieldedOnBudget, true)
  f.state.clock = 0
  f.state.yieldAfterCommit = false
  assert.equal((await ran(f)).notificationsWritten, 1)
})

test('expiry, state and read window exclusions survive selection', async () => {
  const f = fixture(4)
  f.rows[0]!.expires_at = new Date(AT)
  f.rows[1]!.state = 'RESOLVED'
  f.rows[2]!.observed_at = new Date('2026-10-01T00:00:00.000Z')
  assert.equal((await ran(f)).notificationsWritten, 1)
})

test('SQL lookup and write identity agree for arbitrary evidence keys', async () => {
  const f = fixture(1)
  for (const key of ['', 'identity-risk:already-prefixed', "quote'|%_", '雪']) {
    f.rows[0]!.dedupe_key = key
    const selected = await f.actual.findOpenFindings(SINCE, AT)
    assert.equal(selected.length, 1)
    f.notified.push({ organizationId: ORG, dedupeKey: noticeKeyFor(selected[0]!) })
    assert.equal((await f.actual.findOpenFindings(SINCE, AT)).length, 0)
  }
})
