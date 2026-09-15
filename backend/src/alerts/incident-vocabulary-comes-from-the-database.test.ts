import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { type CurrentState, type IncidentNow, messageSourceOf } from './message-source.js'
import type { SendJob } from './send-queue.js'

/**
 * THE LIFECYCLE VOCABULARY BELONGS TO THE DATABASE, AND ITS MEANING BELONGS TO alert-lifecycle.
 *
 * This module once kept its own set: `['CLOSED', 'RESOLVED', 'CLEARED']` matched against
 * `condition` alone. It was wrong three separate ways.
 *
 *   `CLOSED` is in no column's vocabulary at all.
 *   `RESOLVED` belongs to `investigation`, a different column.
 *   And once those were fixed, `NONE` was still treated as sendable and `CLEARED` as
 *   conclusive -- neither of which is what the product means.
 *
 * The first two are spelling and a CHECK constraint can arbitrate them. The third is MEANING,
 * and no constraint can: `alert-lifecycle.ts` says `NONE` "means this alert never opened an
 * investigation", `RECORDED` carries it, and `needsAttention` returns false for it. It also says
 * a `CLEARED` condition still wants attention while ownership is `UNACKNOWLEDGED` -- the
 * situation stopping is not the same as anybody having seen that it stopped.
 *
 * So the decision is delegated, and what remains here is the half a test can check: that the
 * vocabulary those rules are written in is the one the database enforces.
 */

const MIGRATION =
  'prisma/migrations/20260912190000_alert_incidents_and_dispositions/migration.sql'

/** Values the DATABASE permits, parsed from the constraint. Substring rather than regex: a regex
 *  that fails to match returns null, and the obvious version would read "constraint not found"
 *  as "no values" and pass vacuously. Every step asserts before it proceeds. */
function permitted(column: string): readonly string[] {
  const sql = readFileSync(new URL('../../' + MIGRATION, import.meta.url), 'utf8')
  const marker = '"' + column + '" IN ('
  const at = sql.indexOf(marker)
  assert.notEqual(at, -1, 'no CHECK constraint found for "' + column + '"')
  const close = sql.indexOf(')', at)
  assert.notEqual(close, -1, 'unterminated IN list for "' + column + '"')
  const values = sql.slice(at + marker.length, close).split(',')
    .map((raw) => raw.trim()).map((raw) => raw.slice(1, -1))
  assert.ok(values.length > 1, 'suspiciously short vocabulary for "' + column + '"')
  return values
}

/** Members of a TypeScript string union, read from the source that declares the meaning. */
function declared(alias: string): readonly string[] {
  const source = readFileSync(new URL('./alert-lifecycle.ts', import.meta.url), 'utf8')
  const marker = 'export type ' + alias + ' ='
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, alias + ' is no longer declared in alert-lifecycle.ts')
  const line = source.slice(at + marker.length, source.indexOf('\n', at))
  const members = line.split('|').map((raw) => raw.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.ok(members.length > 1, 'parsed a suspiciously short union for ' + alias)
  return members
}

test('the lifecycle vocabulary is exactly the vocabulary the database enforces', () => {
  // Both directions. A union member the CHECK refuses is a state that can never be written; a
  // CHECK value the union omits is a row the rules cannot describe. Either is a place where the
  // two sides have drifted, and the whole defect began as one of them.
  for (const [alias, column] of [
    ['Ownership', 'ownership'],
    ['ObservedCondition', 'condition'],
    ['Investigation', 'investigation'],
  ] as const) {
    assert.deepEqual(
      [...declared(alias)].sort(), [...permitted(column)].sort(),
      alias + ' and the ' + column + ' CHECK constraint disagree')
  }
})

const ORG = '7f1d5a1e-0000-4000-8000-000000000001'
const KEY = 'security.suspected_credential_attack|tenant:contoso'
const job = { messageId: 'incident/' + ORG + '|' + KEY } as SendJob
const incident = (over: Partial<IncidentNow> = {}): IncidentNow => ({
  alertTypeId: 'security.suspected_credential_attack',
  condition: 'ACTIVE', ownership: 'UNACKNOWLEDGED', investigation: 'OPEN',
  firstSeenIso: '2026-09-13T08:00:00.000Z', lastSeenIso: '2026-09-13T12:00:00.000Z',
  tenantsAffected: 1, incidentsAffected: 3, ...over,
})
const state = (over: Partial<IncidentNow>): CurrentState => ({
  incident: async () => incident(over),
  disposition: async () => 'ACT_TODAY',
  visibility: async () => 'SURFACED' as const,
  recipient: async () => ({
    kind: 'MSP_SECURITY_INBOX', address: 'ops@example.invalid', verifiedAt: new Date(),
  } as never),
})
const sends = async (over: Partial<IncidentNow>) =>
  (await messageSourceOf(state(over)).resolve(job)).send

test('a RECORD never becomes an email just because its type is enabled', async () => {
  // investigation NONE. needsAttention returns false for it, and it was the last of the three
  // errors to survive: matching the database's allowed spelling is not establishing the meaning.
  assert.equal(await sends({ investigation: 'NONE' }), false)
})

test('a RESOLVED investigation does not send', async () => {
  assert.equal(await sends({ investigation: 'RESOLVED' }), false)
})

test('a CLEARED condition NOBODY HAS ACKNOWLEDGED still sends', async () => {
  // The case my own set got wrong by withdrawing on CLEARED unconditionally. The situation
  // stopping is not the same as anybody having seen that it stopped, and needsAttention says so.
  assert.equal(await sends({ condition: 'CLEARED', ownership: 'UNACKNOWLEDGED' }), true)
})

test('a CLEARED condition somebody HAS acknowledged does not send', async () => {
  assert.equal(await sends({ condition: 'CLEARED', ownership: 'ACKNOWLEDGED' }), false)
})

test('CONTROL: an active, open, unacknowledged incident sends', async () => {
  assert.equal(await sends({}), true)
})

test('CONTROL: an UNKNOWN condition on an open investigation still sends', async () => {
  // Not being able to see the situation is itself something to act on, and alert-lifecycle says
  // so in as many words. This is the arm that must not be swept up by a broader suppression.
  assert.equal(await sends({ condition: 'UNKNOWN' }), true)
})
