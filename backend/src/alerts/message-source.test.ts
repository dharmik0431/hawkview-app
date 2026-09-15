import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { type ObservedCondition } from './alert-lifecycle.js'
import { needsAttention } from './alert-lifecycle.js'

/** (Derived from EVERY_CONDITION, which a test below holds equal to the CHECK constraint, so
 *  this is still anchored to the database rather than to a list kept here.)
 *
 * THE SET THIS FILE USED TO IMPORT NO LONGER EXISTS, and its absence is the point.
 *
 * `NO_LONGER_ACTIONABLE` lived in message-source.ts and decided, from the condition axis alone,
 * whether an incident still wanted an email. It has been replaced by delegation to
 * `needsAttention`, which reads all three axes -- because narrowing that set to `['CLEARED']`
 * killed the invented spellings and still left RESOLVED unhandled, RESOLVED being an
 * INVESTIGATION value that this module never read.
 *
 * The properties below are unchanged in intent and now asked of the rule rather than of a local
 * list: every withdrawing condition must be one the database can hold, and something must still
 * send. Derived here so the two cannot agree by construction. */

/**
 * **THE VOCABULARY THIS MODULE REASONS OVER, HELD AGAINST THE DATABASE THAT DEFINES IT.**
 *
 * `NO_LONGER_ACTIONABLE` said `['CLOSED', 'RESOLVED', 'CLEARED']` while
 * `alert_incidents_condition_check` permitted only `ACTIVE | CLEARED | UNKNOWN`. Two of the three
 * arms could never fire, so **resolving an incident did not stop its email** — and the integration
 * test asserted the behaviour with `condition: 'RESOLVED'`, a value the database would have
 * refused on insert. The test agreed with the code because one author wrote both, and neither
 * half ever met the constraint.
 *
 * The type is the primary repair: `IncidentNow.condition` is `ObservedCondition` now, so the
 * compiler refuses an invented value at every call site. This file is the second half — **the
 * type and the CHECK are still two copies of one decision**, and nothing but this holds them
 * together. A type is only as true as its agreement with the column it describes.
 */

const MIGRATIONS = new URL('../../prisma/migrations/', import.meta.url)

/** The condition vocabulary the running database will accept, read from the migration that
 * defines it rather than from anything in this codebase. **Derived from the other side of the
 * boundary on purpose**: a list built from `ObservedCondition` would agree with it by
 * construction and could not detect the disagreement this test exists for. */
function conditionsPermittedBySchema(): readonly string[] {
  const sql = readdirSync(MIGRATIONS)
    .sort()
    .filter(name => !name.endsWith('.toml'))
    .map(name => {
      try { return readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8') }
      catch { return '' }
    })
    .join('\n')

  // The LAST definition wins, as with every CHECK that gets widened.
  const all = [...sql.matchAll(/alert_incidents_condition_check"\s*\n?\s*CHECK \("condition" IN \(([^)]*)\)\)/g)]
  assert.ok(all.length >= 1, 'could not find alert_incidents_condition_check in any migration')
  const permitted = [...all[all.length - 1][1].matchAll(/'([A-Z_]+)'/g)].map(match => match[1])
  assert.ok(permitted.length >= 2, `parsed only ${permitted.length} conditions; the parser is wrong`)
  return permitted
}

/** Every member of the union, as values. Exhaustive by type: a fourth condition added to
 * `ObservedCondition` fails to compile here rather than silently escaping the checks below. */
const EVERY_CONDITION = Object.keys({
  ACTIVE: true, CLEARED: true, UNKNOWN: true,
} satisfies Record<ObservedCondition, true>) as readonly ObservedCondition[]

const withdrawingConditions = (): readonly ObservedCondition[] =>
  EVERY_CONDITION.filter(
    (condition) => !needsAttention({ condition, ownership: 'ACKNOWLEDGED', investigation: 'OPEN' }))
const NO_LONGER_ACTIONABLE = withdrawingConditions()

// ---------------------------------------------------------------------------------------

test('the condition type and the database CHECK describe the same set', () => {
  assert.deepEqual([...conditionsPermittedBySchema()].sort(), [...EVERY_CONDITION].sort())
})

test('EVERY WITHDRAWING CONDITION IS ONE THE DATABASE CAN ACTUALLY HOLD', () => {
  // THE ASSERTION THAT WOULD HAVE FAILED. `CLOSED` and `RESOLVED` are not in the CHECK, so a rule
  // written about them was unreachable in production while every unit test passed.
  const permitted = conditionsPermittedBySchema()
  for (const condition of NO_LONGER_ACTIONABLE) {
    assert.ok(permitted.includes(condition),
      `${condition} stops a send in code and cannot exist in the database`)
  }
})

test('the set is a strict subset, so something still sends', () => {
  // A degenerate guard that withdrew everything would satisfy the test above completely. This is
  // the non-firing half: at least one condition must leave the send alone, or the queue drains
  // itself and no MSP is ever told anything.
  const sending = EVERY_CONDITION.filter(condition => !NO_LONGER_ACTIONABLE.includes(condition))
  assert.ok(sending.length > 0, 'every condition withdraws; nothing could ever be sent')
  assert.ok(sending.includes('ACTIVE'), 'an active incident must still produce a send')
  // UNKNOWN means we cannot see whether the condition holds. Treating that as "nothing to say" is
  // the absence-reads-as-reassurance failure the product exists to prevent, so it must send.
  assert.ok(sending.includes('UNKNOWN'), 'an unreadable condition must not silently suppress')
})
