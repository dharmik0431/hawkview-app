import assert from 'node:assert/strict'
import test from 'node:test'
import { readLatestRun } from './read-run.js'
import { RUN_ENGINE_VERSION, RUN_STATUS, persistRun } from './persist-run.js'
import { assessTenant } from './assess-tenant.js'
import { normalizeSignInBatch } from '../risky-users-normalization/index.js'
import type { Finding } from '../evaluation-core/contract.js'

const now = new Date('2026-09-10T21:00:00.000Z')
const scope = { organizationId: 'org', customerTenantId: 'tenant' }

const raymonds: Finding = {
  detectorId: 'repeated-credential-failure',
  subject: { kind: 'DIRECTORY_USER', userRef: 'subject:c54eb6ce', correlation: { available: false, because: 'pseudonymous' } },
  signals: [
    { signal: 'LOCKED_OUT_AFTER_REPEATED_FAILURES', count: 462, latest: { at: '2026-09-03T10:40:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
    { signal: 'PASSWORD_REJECTED', count: 12, latest: { at: '2026-09-09T03:58:00.000Z', kind: 'EVENT_OCCURRED' }, capped: false },
  ],
}

/** A real written row, produced by the writer rather than hand-shaped, so the
 * two halves cannot drift into agreeing with each other's mistakes. */
async function writtenRow(findings: readonly Finding[] = [raymonds]) {
  const batch = await normalizeSignInBatch({
    scope: { organizationId: 'org', customerTenantId: 'tenant', microsoftTenantId: 'ms' },
    source: 'GRAPH_SIGN_INS', rows: [], directory: [],
    reference: async () => 'subject-ref', collectionScope: 'GRAPH_INTERACTIVE_ONLY',
  })
  const assessment = assessTenant({
    streams: [{
      stream: 'GRAPH_SIGN_INS', collection: 'READ' as const, batch,
      scope: { declared: true, asked: 'GRAPH_INTERACTIVE_ONLY' }, detectors: [], rowsFetched: 0,
    }],
    budget: { maxEvents: 5000 },
  })
  const withFindings = { ...assessment, findings: { items: findings, complete: true } }
  let captured: Record<string, unknown> = {}
  await persistRun(
    { identityRiskEvaluationRun: { create: async ({ data }) => { captured = data; return { id: 'run-1' } } } },
    withFindings as never,
    { ...scope, windowStart: new Date('2026-08-11T00:00:00.000Z'), windowEnd: new Date('2026-09-10T00:00:00.000Z'),
      rowsFetched: 2069, expiresAt: new Date('2026-12-10T00:00:00.000Z'), completedAt: new Date('2026-09-10T20:31:00.000Z'),
      sources: [{ source: 'GRAPH_SIGN_INS', status: 'SUCCESS', lastSuccessfulCollectionAt: '2026-09-10T20:55:00.000Z' }] })
  return captured
}

const reader = (row: Record<string, unknown> | null) => {
  const queries: Record<string, unknown>[] = []
  return {
    queries,
    client: {
      identityRiskEvaluationRun: {
        findFirst: async (args: Record<string, unknown>) => {
          queries.push(args)
          return row === null ? null : {
            evaluationCoverage: row.evaluationCoverage,
            evaluationFindings: row.evaluationFindings,
            completedAt: row.completedAt as Date,
            windowStart: row.windowStart as Date,
            windowEnd: row.windowEnd as Date,
          }
        },
      },
    },
  }
}

test('a complete run comes back with its findings attached to its coverage', async () => {
  const { client } = reader(await writtenRow())
  const result = await readLatestRun(client as never, scope, now)

  assert.equal(result.present, true)
  assert.ok(result.present)
  assert.equal(result.findings.length, 1)
  // Each signal still carrying its own date after a full write/read round trip.
  assert.equal(result.findings[0]?.signals[0]?.count, 462)
  assert.equal(result.findings[0]?.signals[0]?.latest?.at, '2026-09-03T10:40:00.000Z')
  assert.equal(result.findings[0]?.signals[1]?.latest?.at, '2026-09-09T03:58:00.000Z')
  assert.equal(result.streams.length, 1)
})

test('a count whose findings did not come back is REFUSED, not served as an empty list', async () => {
  // THE POINT OF THE FILE. Engineer 2 rendered this shape before it could reach
  // anyone: a tile reading "4 distinct users with a current finding" above a
  // list reading "no user is listed as needing attention right now". Both true
  // alone; the pair is an all-clear over four real findings.
  //
  // Neither component can catch it — the tile sees a number, the list sees an
  // emptiness, each coherent on its own. So it is refused here, by the one
  // layer that can see both.
  //
  // Reachable, not theoretical: evaluation_findings is nullable, so every run
  // written before the column existed decodes as absent.
  const row = await writtenRow()

  const notRecorded = reader({ ...row, evaluationFindings: null })
  assert.deepEqual(
    await readLatestRun(notRecorded.client as never, scope, now),
    { present: false, because: 'FINDINGS_NOT_RECORDED' })

  const unreadable = reader({ ...row, evaluationFindings: { version: 'hawkview-run-findings/v9', items: [] } })
  assert.deepEqual(
    await readLatestRun(unreadable.client as never, scope, now),
    { present: false, because: 'FINDINGS_UNREADABLE' })

  // POSITIVE CONTROL: the same row with its findings intact does come back, so
  // the refusals above are about the missing findings rather than a reader that
  // refuses everything.
  const intact = reader(row)
  assert.equal((await readLatestRun(intact.client as never, scope, now)).present, true)
})

test('a run that genuinely found nothing is served — absence is not emptiness', async () => {
  // The distinction the refusal above depends on. A recorded empty list is an
  // answer; an unrecorded list is not. Collapsing them would either withhold
  // every clean tenant or serve every unreadable one.
  const { client } = reader(await writtenRow([]))
  const result = await readLatestRun(client as never, scope, now)
  assert.equal(result.present, true)
  assert.deepEqual(result.present && result.findings, [])
})

test('this reader cannot see the old engine\'s rows — the direction nobody tests', async () => {
  // The mirror of the property asserted on the write side. Its reader cannot
  // see mine; mine must not see its 1,838 rows, which carry an aggregate this
  // decoder would reject and a status this filter must exclude.
  const { client, queries } = reader(await writtenRow())
  await readLatestRun(client as never, scope, now)

  const where = queries[0]?.where as Record<string, unknown>
  assert.equal(where.status, RUN_STATUS)
  assert.notEqual(where.status, 'COMPLETED')
  assert.equal(where.engineVersion, RUN_ENGINE_VERSION)
  assert.notEqual(where.engineVersion, 'hawkview-identity-engine/1')
  // Both terms, because either alone would let a future engine's rows through:
  // the status is shared by anything derived from this writer, the version by
  // anything that reuses the status.
  assert.deepEqual(Object.keys(where).sort(), ['customerTenantId', 'engineVersion', 'expiresAt', 'organizationId', 'status'])
})

test('no run at all is its own answer, not an empty assessment', async () => {
  const { client } = reader(null)
  assert.deepEqual(await readLatestRun(client as never, scope, now), { present: false, because: 'NO_RUN' })
})

test('a run that has not recorded completion is unreachable, not merely unlikely', async () => {
  // A row whose `completedAt` is null describes an evaluation that did not
  // finish. Serving it would present a partial assessment as a finished one —
  // and the status value that keeps these rows away from the LIVE reader does
  // nothing to keep a half-written one away from THIS reader.
  //
  // Not reachable by the current writer: `persistRun` is the last operation in
  // `evaluateAndPersistTenant` and a single insert, so a row exists only once
  // the assessment is complete. This asserts the guard anyway, because the
  // property depends on the write staying last and the guard was previously
  // enforced by code that nothing tested.
  const row = await writtenRow()

  const incomplete = reader({ ...row, completedAt: null })
  assert.deepEqual(
    await readLatestRun(incomplete.client as never, scope, now),
    { present: false, because: 'NO_RUN' })

  // POSITIVE CONTROL: the same row with a completion stamp is served, so the
  // refusal is about the missing stamp rather than the fixture.
  const complete = reader(row)
  assert.equal((await readLatestRun(complete.client as never, scope, now)).present, true)
})
