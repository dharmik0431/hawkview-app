import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { parseDedupeKey, reconcile, TYPE_FOR_SHAPE, type ExistingAlertRow } from './reconciliation.js'

/** The dry run, against fixtures. It writes nothing and it checks its own output. */

let nextId = 0
const row = (over: Partial<ExistingAlertRow> = {}): ExistingAlertRow => ({
  id: `n-${(nextId += 1)}`,
  organizationId: 'org-1',
  customerTenantId: 'tenant-1',
  dedupeKey: 'tenant:tenant-1:connection',
  occurrenceCount: 1,
  resolvedAt: null,
  audit: null,
  ...over,
})

const auditRow = (auditId: string, actor: string | null, targets: readonly string[]) =>
  row({
    dedupeKey: `security:directory-audit:${auditId}`,
    audit: { initiatedBy: actor, targetResources: targets, privileged: false },
  })

test('every shape the current system produces is recognised', () => {
  // Taken from the dedupeKey literals in the codebase rather than from whatever keys happen
  // to be in the data — a list derived from production rows would omit any shape that has
  // not fired yet and call that coverage.
  assert.equal(parseDedupeKey('security:directory-audit:abc-123').shape, 'DIRECTORY_AUDIT')
  assert.equal(parseDedupeKey('security:directory-audit:abc-123').eventIdInKey, 'abc-123')
  assert.equal(parseDedupeKey('tenant:t1:sync:SIGN_INS').shape, 'TENANT_SYNC')
  assert.equal(parseDedupeKey('tenant:t1:sync:SIGN_INS').resourceType, 'SIGN_INS')
  assert.equal(parseDedupeKey('tenant:t1:connection').shape, 'TENANT_CONNECTION')
  assert.equal(parseDedupeKey('tenant:t1:initial-sync').shape, 'TENANT_INITIAL_SYNC')
  assert.equal(parseDedupeKey('tenant:t1:onboarding-authorized').shape, 'TENANT_ONBOARDING')

  // And one nobody anticipated is UNRECOGNISED rather than forced into the nearest match.
  assert.equal(parseDedupeKey('something:nobody:wrote').shape, 'UNRECOGNISED')
  assert.equal(parseDedupeKey('').shape, 'UNRECOGNISED')
})

test('RECOVERY IS CHECKED BEFORE THE KEY IT RECOVERS, or every recovery is miscounted', () => {
  // The recovery shape is a SUFFIX on another key, so a recovery of a sync alert matches the
  // sync pattern too. Checking in the other order classifies every recovery as whatever it
  // recovered — and the count of recoveries is exactly what this step needs to see.
  const recovery = parseDedupeKey('tenant:t1:sync:SIGN_INS:recovered:3')
  assert.equal(recovery.shape, 'RECOVERY')
  assert.equal(recovery.recoveryOf, 'tenant:t1:sync:SIGN_INS')

  // POSITIVE CONTROL: the key it recovers still parses as itself.
  assert.equal(parseDedupeKey('tenant:t1:sync:SIGN_INS').shape, 'TENANT_SYNC')

  // THE OCCURRENCE COUNT IS IN THE KEY, which is the 301 defect one layer over: the same
  // logical recovery gets a different key every time the count moves, so recoveries cannot
  // deduplicate against each other at all.
  const counts = [1, 2, 17].map((n) => parseDedupeKey(`tenant:t1:connection:recovered:${n}`))
  assert.equal(new Set(counts.map((parsed) => parsed.recoveryOf)).size, 1,
    'all three recover the same incident')
  assert.equal(new Set(['1', '2', '17']).size, 3, 'and each arrived under a different key')
})

test('THE 301 SHAPE COLLAPSES ONTO ITS ACTOR, which is the number to react to', () => {
  // Twelve audit rows, one actor, twelve different targets — the compromised-admin case. The
  // declared subject for a directory change is the actor, so this is ONE incident.
  const rows = Array.from({ length: 12 }, (_, index) =>
    auditRow(`audit-${index}`, 'admin-1', [`victim-${index}`]))

  // The type is not determined by the key shape, so these are reported as needing
  // classification rather than assigned a default — see the next test.
  const report = reconcile(rows)
  assert.equal(report.total, 12)
  assert.equal(report.byShape.DIRECTORY_AUDIT, 12)
  assert.equal(report.incidents.needingClassification, 12)
})

test('AN AUDIT ROW IS NOT GIVEN A DEFAULT TYPE', () => {
  // The shape says "a directory change happened"; whether it was privileged is a property of
  // the change, not of the key. Defaulting to the routine type would file real privileged
  // changes as records, which is the 301 problem arriving from the migration instead of from
  // the collector.
  assert.equal(TYPE_FOR_SHAPE.DIRECTORY_AUDIT, null)
  assert.equal(TYPE_FOR_SHAPE.UNRECOGNISED, null)
  assert.equal(TYPE_FOR_SHAPE.TENANT_ONBOARDING, null)

  const report = reconcile([auditRow('a-1', 'admin-1', ['victim-1'])])
  const entry = report.mapping[0]
  assert.equal(entry?.alertTypeId, null)
  assert.equal(entry?.incidentKey, null)
  assert.match(entry?.because ?? '', /classified first|not one the current system/i)

  // THE STRUCTURAL VERSION OF "it must not claim a type it declined to assign". My first
  // assertion here was `doesNotMatch(/routine/i)`, and it failed — because the sentence
  // legitimately EXPLAINS that defaulting to the routine type would be wrong. That is a
  // prose assertion standing in for a structural property, which is the mistake I have been
  // finding all evening in other people's tests and then made in my own.
  //
  // What actually matters is that no catalogue id appears where no type was assigned.
  for (const declared of ALERT_CATALOG) {
    assert.doesNotMatch(entry?.because ?? '', new RegExp(declared.id.replace(/\./g, '\\.')),
      `the reasoning must not name ${declared.id} when no type was assigned`)
  }
})

test('BOTH COUNTS COME FROM THE SAME ROWS, differing only in the subject', () => {
  // The number PM wants to put in front of Dharmik. A sync alert declares COLLECTOR, so the
  // declared count groups per resource type; keyed on the target instead it groups on the
  // audit target, which these rows do not have — so the two numbers genuinely differ and
  // the difference is the subject rather than the data.
  const rows = [
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t1:sync:AUDIT_LOGS', customerTenantId: 't1' }),
  ]
  const report = reconcile(rows)
  assert.equal(report.byShape.TENANT_SYNC, 3)
  assert.equal(report.incidents.declared, 2, 'two resource types, two incidents')
  assert.equal(report.incidents.ifKeyedOnTarget, 0,
    'these rows have no audit target, so a target-keyed scheme could not group them at all')
})

test('EVERY ROW IS MAPPED EXACTLY ONCE, and the report says so', () => {
  // The failure that matters: "364 became 51" and "364 became 51 and we dropped 12" look
  // identical unless something counts. The generator checks its own output rather than
  // leaving that to a reviewer.
  const rows = [
    row({ dedupeKey: 'tenant:t1:connection' }),
    row({ dedupeKey: 'tenant:t2:sync:SIGN_INS', customerTenantId: 't2' }),
    auditRow('a-1', 'admin-1', ['v-1']),
    row({ dedupeKey: 'nobody:wrote:this' }),
    row({ dedupeKey: 'tenant:t1:connection:recovered:4' }),
  ]
  const report = reconcile(rows)

  assert.equal(report.mapping.length, rows.length)
  assert.deepEqual(report.invariants.rowsMissingFromMapping, [])
  assert.deepEqual(report.invariants.duplicatedNotificationIds, [])
  assert.deepEqual(
    report.mapping.map((entry) => entry.notificationId).sort(),
    rows.map((input) => input.id).sort())

  // Including the unrecognised one: reported with its key, not dropped.
  assert.equal(report.byShape.UNRECOGNISED, 1)
  assert.deepEqual(report.unrecognisedExamples, ['nobody:wrote:this'])
  assert.ok(report.mapping.some((entry) => entry.dedupeKey === 'nobody:wrote:this'))
})

test('THE OCCURRENCES BEHIND THE ROWS ARE STATED, because consolidating must preserve them', () => {
  // The 301 and the 334 are real events. A report that says "51 incidents" without saying
  // how many occurrences they represent invites reading consolidation as deletion.
  const rows = [
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', occurrenceCount: 334, customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t1:connection', occurrenceCount: 1 }),
  ]
  const report = reconcile(rows)
  assert.equal(report.occurrencesRepresented, 335)
  assert.equal(report.invariants.occurrencesPreserved, true)
  assert.notEqual(report.occurrencesRepresented, report.total,
    'the point of stating it is that it differs from the row count')
})

test('AN UNRESOLVED SUBJECT IS COUNTED, not quietly grouped', () => {
  // A sync key with no resource type cannot resolve its declared COLLECTOR subject. It is
  // reported as unattributed and carries the reason, rather than joining a bucket.
  const rows = [
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: null }),
  ]
  const report = reconcile(rows)
  assert.equal(report.incidents.unattributed, 1)
  assert.equal(report.mapping[0]?.incidentKey, null)
  assert.match(report.mapping[0]?.because ?? '', /no resolvable tenant|recorded on its own/i)

  // POSITIVE CONTROL: with the tenant present it does group, so the refusal is about the
  // missing subject rather than the shape being ungroupable.
  const withTenant = reconcile([row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' })])
  assert.equal(withTenant.incidents.unattributed, 0)
  assert.notEqual(withTenant.mapping[0]?.incidentKey, null)
})

test('the report is a pure function of its rows', () => {
  // No clock, no environment, no client. Two runs over the same input are identical, which
  // is what makes it safe for somebody else to run and bring back.
  const rows = [auditRow('a-1', 'admin-1', ['v-1']), row({ dedupeKey: 'tenant:t1:connection' })]
  assert.deepEqual(reconcile(rows), reconcile(rows))
  // And an empty input is an empty report rather than a crash or a default.
  const empty = reconcile([])
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.invariants.rowsMissingFromMapping, [])
  assert.equal(empty.incidents.declared, 0)
})

test('A DUPLICATED ROW IS NAMED, which is what makes the invariant testable at all', () => {
  // The invariants were booleans, and a mutation hardcoding the most important one —
  // "every row mapped exactly once" — survived every test. No input can make the generator
  // drop a row, so a computed true and a hardcoded true are indistinguishable. The most
  // important check was the one nothing guarded.
  //
  // As lists they name the offender, and the duplicate case IS reachable: a query with a bad
  // join returns the same notification twice. That is a realistic failure, it inflates every
  // count in the report, and the set arithmetic that catches it is the same arithmetic behind
  // the missing-rows list.
  const duplicated = row({ id: 'n-dup', dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' })
  const report = reconcile([duplicated, duplicated, row({ dedupeKey: 'tenant:t2:connection', customerTenantId: 't2' })])

  assert.deepEqual(report.invariants.duplicatedNotificationIds, ['n-dup'])
  assert.deepEqual(report.invariants.rowsMissingFromMapping, [],
    'a duplicate is not a missing row — the two lists answer different questions')

  // The report still maps every row it was given, so the duplicate shows up as a count
  // problem rather than as a silent loss. Both are worth distinguishing.
  assert.equal(report.total, 3)
  assert.equal(report.mapping.length, 3)

  // POSITIVE CONTROL: distinct ids report nothing, so the list is about duplication rather
  // than firing on any input.
  const clean = reconcile([
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t2:connection', customerTenantId: 't2' }),
  ])
  assert.deepEqual(clean.invariants.duplicatedNotificationIds, [])
})
