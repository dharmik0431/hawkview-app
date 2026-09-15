import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

/**
 * A VOCABULARY MAY GROW. IT MAY NOT SHRINK.
 *
 * `20260914020000_identity_risk_not_assessed` adds `NOT_ASSESSED` to six CHECK constraints so a
 * detector that did not compute a severity, a confidence or a coverage can say so instead of
 * asserting one. `confidence` is the sharpest: it is confidence OF COMPROMISE, and the accepted
 * mapping says the native detector does not make that claim — writing `LOW` would make it in the
 * row while the document beside it says it is not made.
 *
 * These constraints are widened by DROP and RE-ADD, which is the only mechanism Postgres offers
 * and also the one that can silently NARROW: re-adding with a member missing would make every
 * row holding it unwritable, and nothing in a migration review reliably catches a value dropped
 * from the middle of a list.
 *
 * So this reads every definition of each constraint across the whole migration history and
 * asserts the newest is a superset of all of them. The same method the
 * `alert_send_jobs_state_check` widenings were verified by, applied here as a test rather than
 * as a reading.
 */

const DIR = new URL('../../prisma/migrations/', import.meta.url)

/** Every `CHECK ("col" IN (...))` for a named constraint, oldest first. */
function definitions(constraint: string): string[][] {
  const found: string[][] = []
  for (const entry of readdirSync(DIR).sort()) {
    let sql: string
    try {
      sql = readFileSync(new URL(entry + '/migration.sql', DIR), 'utf8')
    } catch {
      continue
    }
    let at = sql.indexOf('"' + constraint + '"')
    while (at !== -1) {
      const inAt = sql.indexOf(' IN (', at)
      const close = inAt === -1 ? -1 : sql.indexOf(')', inAt)
      // A DROP mentions the name with no IN list before the next statement; skip those.
      const nextStatement = sql.indexOf(';', at)
      if (inAt !== -1 && close !== -1 && (nextStatement === -1 || inAt < nextStatement)) {
        found.push(sql.slice(inAt + 5, close).split(',')
          .map((raw) => raw.trim()).map((raw) => raw.replace(/^'|'$/g, '')))
      }
      at = sql.indexOf('"' + constraint + '"', at + 1)
    }
  }
  return found
}

const CONSTRAINTS = [
  'identity_risk_finding_severity_check',
  'identity_risk_finding_confidence_check',
  'identity_risk_finding_coverage_check',
  'identity_risk_matched_severity_check',
  'identity_risk_matched_confidence_check',
  'identity_risk_matched_coverage_check',
]

test('POSITIVE CONTROL: the parser finds real definitions to compare', () => {
  // Without this every assertion below passes by parsing nothing, which is what this kind of
  // check does when its scan quietly stops matching.
  for (const constraint of CONSTRAINTS) {
    const history = definitions(constraint)
    assert.ok(history.length >= 2,
      constraint + ' has ' + history.length + ' parsed definition(s); the parser is not seeing ' +
      'the history it is meant to compare, so a narrowing could not be detected')
    assert.ok(history.every((members) => members.length >= 2),
      constraint + ' parsed a suspiciously short member list')
  }
})

test('no vocabulary has ever NARROWED across the migration history', () => {
  // The failure a DROP-and-RE-ADD invites: a member missing from the re-added list makes every
  // row holding it unwritable, and the migration reads as a normal widening.
  for (const constraint of CONSTRAINTS) {
    const history = definitions(constraint)
    const latest = new Set(history[history.length - 1])
    for (const [index, earlier] of history.entries()) {
      for (const member of earlier) {
        assert.ok(latest.has(member),
          constraint + ' dropped ' + member + ', which definition ' + (index + 1) +
          ' permitted. Re-adding a CHECK without a previously valid member makes every row ' +
          'holding it unwritable.')
      }
    }
  }
})

test('NOT_ASSESSED is permitted in all six, so a detector can decline to claim', () => {
  for (const constraint of CONSTRAINTS) {
    const history = definitions(constraint)
    assert.ok(history[history.length - 1].includes('NOT_ASSESSED'),
      constraint + ' does not permit NOT_ASSESSED, so a detector that did not compute this ' +
      'value has to assert one it did not determine')
  }
})

test('CONTROL: the additions did not swallow the real values', () => {
  // A vocabulary of nothing-but-NOT_ASSESSED would satisfy every assertion above while making
  // the column useless. The originals must still be there.
  const expected: Record<string, string[]> = {
    identity_risk_finding_severity_check: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    identity_risk_finding_confidence_check: ['LOW', 'MEDIUM', 'HIGH'],
    identity_risk_finding_coverage_check: ['FULL', 'PARTIAL'],
    identity_risk_matched_severity_check: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    identity_risk_matched_confidence_check: ['LOW', 'MEDIUM', 'HIGH'],
    identity_risk_matched_coverage_check: ['FULL', 'PARTIAL'],
  }
  for (const [constraint, members] of Object.entries(expected)) {
    const latest = definitions(constraint).at(-1) ?? []
    for (const member of members) {
      assert.ok(latest.includes(member), constraint + ' no longer permits ' + member)
    }
  }
})
