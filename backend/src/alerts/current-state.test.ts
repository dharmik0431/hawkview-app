import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { currentStateFrom } from './current-state.js'
import { type SqlRunner } from './pipeline-store.js'

/**
 * WHAT A FAKE RUNNER CAN AND CANNOT PROVE, stated up front so nothing here is mistaken for
 * more than it is.
 *
 * It CAN prove the mapping: that aggregates become numbers, that a missing row becomes null,
 * that an absent disposition is not read as RECORD_ONLY, and that this module never invents a
 * recipient. Those are decisions this file makes, so a double is the right instrument.
 *
 * It CANNOT prove the SQL is correct. A fake answers whatever shape it is handed, so a query
 * naming a column that does not exist passes every test below. I made exactly that mistake
 * while writing this — the disposition column is `disposition`, and I wrote `tier` from the
 * schema's prose comment. `tsc` cannot see inside a SQL string either.
 *
 * So the last test reads the MIGRATION DDL and checks the columns this module names against it,
 * with a negative control for the name I got wrong. The real proof is the drain-time grading
 * against a live cluster; this is what can be true before it.
 */

const runnerReturning = (rows: readonly unknown[]): SqlRunner => ({
  query: async <T,>() => rows as readonly T[],
  execute: async () => 0,
  transaction: async <T,>(run: (tx: SqlRunner) => Promise<T>) => run(runnerReturning(rows)),
})
const neverAsked: SqlRunner = {
  query: async () => { throw new Error('the database was consulted when it should not have been') },
  execute: async () => 0,
  transaction: async () => { throw new Error('unexpected transaction') },
}
const ref = { organizationId: '7f1d5a1e-0000-4000-8000-000000000001', incidentKey: 'k|tenant:x' }
const noRecipient = async () => null

test('an incident with occurrences maps its aggregates', async () => {
  const state = currentStateFrom(runnerReturning([{
    alert_type_id: 'security.suspected_credential_attack',
    condition: 'ACTIVE', investigation: 'OPEN', ownership: 'UNACKNOWLEDGED',
    first_seen: new Date('2026-09-13T08:00:00.000Z'),
    last_seen: new Date('2026-09-13T12:00:00.000Z'),
    // Postgres returns COUNT as a string through most drivers; reading it as a number
    // without conversion yields NaN, which renders as "NaN incidents" in a subject line.
    tenants_affected: '2', incidents_affected: '3',
  }]), noRecipient)

  const incident = await state.incident(ref)
  assert.ok(incident)
  assert.equal(incident.condition, 'ACTIVE')
  assert.equal(incident.investigation, 'OPEN')
  assert.equal(incident.tenantsAffected, 2)
  assert.equal(incident.incidentsAffected, 3)
  assert.equal(incident.firstSeenIso, '2026-09-13T08:00:00.000Z')
})

test('an incident with no occurrences reports none, and invents no window', async () => {
  // The LEFT JOIN case. Nulls here mean "no notification rows", not "unknown time", and a
  // fabricated window would put a date range in an email that nothing observed.
  const state = currentStateFrom(runnerReturning([{
    alert_type_id: 'security.suspected_credential_attack',
    condition: 'ACTIVE', investigation: 'OPEN', ownership: 'UNACKNOWLEDGED',
    // NOT ZERO. The peer join counts distinct incidents of the same type in the same
    // organisation, and this incident is one of them — it counts itself. A fabricated '0' here
    // agreed with nothing the SQL could return, which is what makes a mocked aggregate evidence
    // about the mock rather than about the query.
    first_seen: null, last_seen: null, tenants_affected: '0', incidents_affected: '1',
  }]), noRecipient)

  const incident = await state.incident(ref)
  assert.ok(incident, 'an incident with no occurrences vanished entirely')
  assert.equal(incident.firstSeenIso, null, 'an absent window became an empty string, which renders and sorts as a time')
  assert.equal(incident.incidentsAffected, 1,
    'the peer join counts this incident itself, so zero is a number the SQL cannot return')
})

test('a missing incident is null, not an empty incident', async () => {
  const state = currentStateFrom(runnerReturning([]), noRecipient)
  assert.equal(await state.incident(ref), null)
})

test('NO disposition row is not RECORD_ONLY', async () => {
  // An organisation that has never expressed a preference has not chosen to stop being told.
  // Returning a tier for a row that does not exist would invent their choice — and returning
  // RECORD_ONLY specifically would silence them on the strength of a missing row.
  const state = currentStateFrom(runnerReturning([]), noRecipient)
  assert.equal(await state.disposition(ref.organizationId, 'security.suspected_credential_attack'), null)
})

test('a disposition row is returned as stored', async () => {
  const state = currentStateFrom(runnerReturning([{ disposition: 'RECORD_ONLY' }]), noRecipient)
  assert.equal(await state.disposition(ref.organizationId, 'security.suspected_credential_attack'), 'RECORD_ONLY')
})

test('the recipient comes from the supplied source and the database is never asked', async () => {
  // The declared gap. This module must not reach for a recipient of its own, because there is
  // no verification in the schema to reach for — the runner throws if consulted.
  let askedFor: string | null = null
  const state = currentStateFrom(neverAsked, async (organizationId) => {
    askedFor = organizationId
    return null
  })
  assert.equal(await state.recipient(ref.organizationId), null)
  assert.equal(askedFor, ref.organizationId)
})

test('SQL GUARD: every column this module names exists in the migration DDL', () => {
  // The check a double cannot make. Derived from the other side of the boundary: the CREATE
  // TABLE statements, not a list restated here.
  const ddl = readFileSync(new URL(
    '../../prisma/migrations/20260912190000_alert_incidents_and_dispositions/migration.sql',
    import.meta.url), 'utf8')
  const source = readFileSync(new URL('./current-state.ts', import.meta.url), 'utf8')

  for (const column of ['alert_type_id', 'condition', 'investigation', 'disposition', 'incident_key']) {
    assert.ok(ddl.includes(`"${column}"`),
      `${column} is not declared in the migration, so the query naming it cannot work`)
    assert.ok(source.includes(column),
      `${column} is no longer used; this guard is checking something the module dropped`)
  }

  // NEGATIVE CONTROL, and it is the name I actually got wrong. `tier` appears in the schema's
  // prose about what the column MEANS; the column is `disposition`. If this guard cannot tell
  // the difference it is not checking anything.
  assert.ok(!ddl.includes('"tier"'), 'the DDL gained a tier column; this control is stale')
  assert.ok(!source.includes('SELECT tier'), 'the query is reading a column that does not exist')
})
