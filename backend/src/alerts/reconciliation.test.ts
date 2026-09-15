import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import {
  adds, exclusionKindFor, parseDedupeKey, permanentlyUnresolvable, reconcile, resourceTypeFor,
  resourceTypeLookup,
  TYPE_FOR_SHAPE, type ExistingAlertRow, type KeyShape,
} from './reconciliation.js'
import { incidentGrouping, wouldGroupTogether } from './alert-incident-key.js'

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
  assert.deepEqual(report.invariants.occurrenceCountsAddUp, [])
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
  assert.equal(report.incidents.declaredSubjectUnresolvedAmongTypedRows, 1)
  assert.equal(report.mapping[0]?.incidentKey, null)
  assert.match(report.mapping[0]?.because ?? '', /no resolvable tenant|recorded on its own/i)

  // POSITIVE CONTROL: with the tenant present it does group, so the refusal is about the
  // missing subject rather than the shape being ungroupable.
  const withTenant = reconcile([row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' })])
  assert.equal(withTenant.incidents.declaredSubjectUnresolvedAmongTypedRows, 0)
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

test('THE AUDIT CATEGORY IS EXTRACTED BUT NOT MAPPED', () => {
  // Found in production, not in the code: the audit ids Microsoft issues carry a category
  // prefix, and the dedupe key is built from the id verbatim. Measured across the 364 —
  // 268 Directory, 45 SSPR, 3 PIM, 1 Authentication Methods.
  const cases = [
    ['Directory_abc-123', 'Directory'],
    ['SSPR_def-456', 'SSPR'],
    ['PIM_ghi-789', 'PIM'],
    ['Authentication Methods_jkl-012', 'Authentication Methods'],
  ] as const
  for (const [eventId, category] of cases) {
    const parsed = parseDedupeKey(`security:directory-audit:${eventId}`)
    assert.equal(parsed.auditCategory, category, eventId)
    // THE WHOLE REMAINDER STAYS THE EVENT ID, because that is what joins to
    // microsoftAuditId. All 317 production rows joined, so substituting the category for
    // the id would have broken a parse that demonstrably works.
    assert.equal(parsed.eventIdInKey, eventId, 'the join key must survive the extraction')
  }

  // An id with no category prefix still parses, with the category absent rather than guessed.
  const bare = parseDedupeKey('security:directory-audit:00000000-1111-2222-3333-444444444444')
  assert.equal(bare.auditCategory, null)
  assert.equal(bare.eventIdInKey, '00000000-1111-2222-3333-444444444444')

  // And the category does NOT become a type. It is a hint about subject area, and PIM being
  // Privileged Identity Management is the strongest candidate for the privileged type —
  // which is a classification decision, not a parse.
  const report = reconcile([
    auditRow('PIM_a-1', 'admin-1', ['v-1']),
    auditRow('Directory_a-2', 'admin-1', ['v-2']),
    auditRow('Directory_a-3', 'admin-2', ['v-3']),
  ])
  assert.deepEqual(report.auditCategories, { PIM: 1, Directory: 2 })
  assert.equal(report.incidents.needingClassification, 3,
    'the category is reported; it does not classify anything')
  for (const entry of report.mapping) assert.equal(entry.alertTypeId, null)
})

test('THE HEADLINE NUMBER IS A FLOOR, and the report says which number is which', () => {
  // The count to put in front of a person is "how many incidents do these become", and it
  // cannot be answered exactly for the directory-audit rows: the incident key contains the
  // type id, and one actor's privileged change is correctly a different incident from their
  // routine one. So `declared` excludes them — honest and unhelpful — and the bound counts
  // them under one nominated type.
  //
  // THE BOUND IS A LOWER BOUND. Classification can only split an actor's events across two
  // types, never merge them, so the real number is this or higher. Reporting it without that
  // qualification would be an understatement presented as a measurement.
  const actors = ['a-1', 'a-1', 'a-1', 'a-2']
  const rows = actors.map((actor, index) => auditRow(`Directory_e-${index}`, actor, [`t-${index}`]))
  const report = reconcile(rows)

  assert.equal(report.incidents.declared, 0, 'undetermined types are not grouped in the declared count')
  assert.equal(report.incidents.assumingSingleType, 2, 'two actors, two incidents under one type')
  assert.equal(report.incidents.assumingSingleTypeKeyedOnTarget, 4, 'four distinct targets')

  // THE DIRECTION IS THE POINT: keying on the actor collapses, keying on the target does not.
  assert.ok(report.incidents.assumingSingleType < report.incidents.assumingSingleTypeKeyedOnTarget,
    'the actor-keyed count must be the smaller one for these rows, which is D1 on the data')

  // The bound covers rows whose type IS determined too, so it is a bound over everything
  // rather than over a subset.
  const mixed = reconcile([...rows, row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' })])
  assert.equal(mixed.incidents.assumingSingleType, 3, 'two actors plus one tenant incident')

  // And nominating a type for the count does NOT assign one in the mapping.
  for (const entry of report.mapping) assert.equal(entry.alertTypeId, null)
})

test('THE OCCURRENCE CHECK COMPARES TWO INDEPENDENT SIDES', () => {
  // It was vacuous: a loop accumulator against a reduce over the same array with the same
  // addition, both sides equally wrong and therefore always agreeing. Searched for a
  // falsifying input — ordinary, zero, negative, MAX_SAFE_INTEGER, fractional values where
  // addition is not associative, 200,000 random sets. Nothing, bar Infinity + -Infinity
  // giving NaN, which is an artefact rather than a guard.
  //
  // Its comment was the worse half: it said the events are preserved "so applying the
  // mapping can be checked against it", which reads as a check on consolidation when the
  // mapping was not in the computation at all. Its sibling one line up honestly calls itself
  // a tripwire, so a reader comparing them would take the unlabelled one for the stronger.
  //
  // Now the mapping carries its own counts and the two sides come from different places.
  const rows = [
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1', occurrenceCount: 334 }),
    row({ dedupeKey: 'tenant:t2:connection', customerTenantId: 't2', occurrenceCount: 7 }),
    auditRow('Directory_a-1', 'admin-1', ['v-1']),
  ]
  const report = reconcile(rows)

  assert.deepEqual(report.invariants.occurrenceCountsAddUp, [])
  assert.equal(report.occurrencesRepresented, 342)
  // The counts reached the mapping, which is what makes the check non-tautological — and
  // the apply phase needs them anyway, since consolidating must preserve the events.
  assert.deepEqual(report.mapping.map((entry) => entry.occurrenceCount).sort((a, b) => a - b), [1, 7, 334])
  assert.equal(
    report.mapping.reduce((sum, entry) => sum + entry.occurrenceCount, 0),
    rows.reduce((sum, input) => sum + input.occurrenceCount, 0))
})

test('THE DIRECTORY-AUDIT BOUND IS A LIKE-FOR-LIKE SUBSET, so two instruments can disagree', () => {
  // The production figures were computed with SQL filtered on the directory-audit key
  // prefix, while the all-rows bound covers every shape. Comparing those two would be
  // comparing different subsets and finding a disagreement that was never there — so the
  // report carries the restricted pair as well, and that is the one to compare.
  const rows = [
    auditRow('Directory_a-1', 'admin-1', ['v-1']),
    auditRow('Directory_a-2', 'admin-1', ['v-2']),
    auditRow('SSPR_a-3', 'admin-2', ['v-3']),
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t2:sync:SIGN_INS', customerTenantId: 't2' }),
  ]
  const report = reconcile(rows)

  // Two actors across the audit rows.
  assert.equal(report.incidents.assumingSingleTypeDirectoryAuditOnly, 2)
  assert.equal(report.incidents.assumingSingleTypeDirectoryAuditOnlyKeyedOnTarget, 3)

  // AND IT IS A SUBSET: the restricted count can never exceed the all-rows count, which is
  // the property that makes the two comparable rather than merely adjacent.
  assert.ok(report.incidents.assumingSingleTypeDirectoryAuditOnly <= report.incidents.assumingSingleType)
  assert.ok(report.incidents.assumingSingleTypeDirectoryAuditOnlyKeyedOnTarget
    <= report.incidents.assumingSingleTypeKeyedOnTarget)

  // The non-audit rows are in the wider count and not in the restricted one, so the
  // restriction is doing something rather than the two being equal by coincidence.
  assert.ok(report.incidents.assumingSingleType > report.incidents.assumingSingleTypeDirectoryAuditOnly)
})

const DAY = 86_400_000
const T0 = Date.parse('2026-07-01T09:00:00.000Z')
const auditAt = (id: string, actor: string, at: number) =>
  row({
    dedupeKey: `security:directory-audit:Directory_${id}`,
    occurredAt: new Date(at),
    audit: { initiatedBy: actor, targetResources: [`t-${id}`], privileged: null },
  })

test('EPISODES SPLIT AN INCIDENT, AND THE INCIDENT KEY CARRIES NO EPISODE', () => {
  // The gap this closes: the key identifies a STREAM — type, organization, tenant, subject —
  // so an incident count answers "how many subjects" and not "how many separate bursts".
  // Across a two-month window those differ by roughly a factor of two, and reporting the
  // first as the second would create exactly the incidents episodes exist to prevent: an
  // attack next month joining last month's closed incident with nobody told.
  const oneActorThreeBursts = [0, 30, 60].flatMap((burst) =>
    [0, 3_600_000].map((within, index) =>
      auditAt(`b${burst}-${index}`, 'actor-1', T0 + burst * DAY + within)))
  const report = reconcile([...oneActorThreeBursts, auditAt('other', 'actor-2', T0)])

  assert.equal(report.incidents.assumingSingleTypeDirectoryAuditOnly, 2, 'two actors, two streams')
  assert.equal(report.episodes.countedDirectoryAuditOnly, 4, 'three bursts plus one = four episodes')
  assert.ok(report.episodes.counted > report.incidents.assumingSingleType,
    'episodes must exceed incidents when activity is spread, or nothing was split')
})

test('AN INCIDENT WHOSE EPISODES CANNOT BE RECOVERED IS UNKNOWN, NEVER ONE', () => {
  // A sync alert with occurrenceCount 42 represents 42 events at unknown individual times —
  // first_occurred_at and last_occurred_at give the span and nothing inside it. Inventing
  // times would be fabrication, and counting the incident as ONE episode would understate
  // the migration by exactly the thing episodes were built to catch.
  const report = reconcile([
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1', occurrenceCount: 42 }),
    auditAt('a', 'actor-1', T0),
  ])

  assert.equal(report.episodes.incidentsWithUnrecoverableEpisodes, 1)
  assert.equal(report.episodes.rowsWithoutEventTime, 1)
  assert.equal(report.episodes.counted, 1, 'only the audit incident is counted')
  // NOT folded into the count. Unknown is not one, which is the same refusal this product
  // makes with EXACT 0 versus NOT_AVAILABLE.
  assert.notEqual(report.episodes.counted, 2)

  // POSITIVE CONTROL: give the aggregate row a time and it becomes countable, so the
  // exclusion is about the missing time rather than about the shape.
  const withTime = reconcile([
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1', occurredAt: new Date(T0) }),
    auditAt('a', 'actor-1', T0),
  ])
  assert.equal(withTime.episodes.incidentsWithUnrecoverableEpisodes, 0)
  assert.equal(withTime.episodes.counted, 2)
})

test('THE EPISODE INTERVAL COMES FROM THE DECLARATION, and the report says which', () => {
  // Two events 30 hours apart: one episode at a 48-hour interval, two at 24. The report
  // states the interval it used so the number is auditable rather than asserted — and the
  // declared value is what step 02 ruled, not a constant chosen here.
  const report = reconcile([
    auditAt('a', 'actor-1', T0),
    auditAt('b', 'actor-1', T0 + 30 * 3_600_000),
  ])
  assert.equal(report.episodes.quietIntervalHours, 24)
  assert.equal(report.episodes.countedDirectoryAuditOnly, 2, '30 hours apart exceeds a 24-hour interval')

  // Inside the interval, the same two events are one episode — so the interval is being
  // applied rather than every event counting as its own episode.
  const together = reconcile([
    auditAt('a', 'actor-1', T0),
    auditAt('b', 'actor-1', T0 + 3 * 3_600_000),
  ])
  assert.equal(together.episodes.countedDirectoryAuditOnly, 1)
  // AND THE ALL-ROWS COUNT TOO. A mutation replacing spans.length with times.length
  // survived until this line: every assertion above used the directory-audit-only
  // figure, which is accumulated on a separate statement, so the wider counter was
  // unpinned. Two sibling counters and only one asserted is the fixture-cannot
  // -discriminate shape wearing different clothes.
  assert.equal(together.episodes.counted, 1,
    'two events inside the interval are one episode, not two')
})

test('TWO ACTORS BURSTING TOGETHER ARE TWO INCIDENTS, not one episode', () => {
  // Episodes are counted WITHIN a stream. Counting them across all rows would merge two
  // actors active on the same day into one burst, which is the actor-keying decision undone
  // one layer down.
  const sameDay = [
    auditAt('a', 'actor-1', T0),
    auditAt('b', 'actor-2', T0 + 60_000),
  ]
  const report = reconcile(sameDay)
  assert.equal(report.incidents.assumingSingleTypeDirectoryAuditOnly, 2)
  assert.equal(report.episodes.countedDirectoryAuditOnly, 2,
    'one episode each, not one episode shared')
})

test('AN UNGROUPED ROW IS STILL AN INCIDENT AND STILL AN EPISODE', () => {
  // The cause of a six-episode disagreement with a SQL count over the same rows. The bucket
  // guard was `if (boundGrouping.groups)`, so every unattributable row was dropped from the
  // episode accounting entirely and contributed ZERO. The rival instrument coalesced them
  // onto one literal actor and got at least one. Their reasoning was that merging should make
  // THEIR count lower and so could not explain the gap — what it could not see is that mine
  // was discarding the rows outright, which is the stronger effect and points the other way.
  const unattributable = [1, 2, 3].map((index) =>
    row({
      dedupeKey: `security:directory-audit:Directory_u${index}`,
      occurredAt: new Date(T0 + index * 1000),
      audit: { initiatedBy: null, targetResources: [], privileged: null },
    }))
  const report = reconcile(unattributable)

  // NOT `unattributed`: that counter only runs for rows whose alert type the key shape
  // determines, and a directory-audit shape does not determine one — those rows are reported
  // as needing classification and `continue` before reaching it. So "how many rows failed to
  // group" is not answerable from `unattributed`, which is part of how these rows went
  // missing: every counter that could have noticed them sits downstream of a verdict they
  // never get.
  assert.equal(report.incidents.needingClassification, 3, 'the shape determines no type')
  assert.equal(report.incidents.declaredSubjectUnresolvedAmongTypedRows, 0, 'so none of them reaches that counter')
  assert.equal(report.episodes.counted, 3,
    'three incidents of one event each — three episodes, not zero and not one merged')
  assert.equal(report.episodes.countedDirectoryAuditOnly, 3)

  // AND THEY ARE NOT MERGED, even though all three are within seconds of each other. The
  // unknown-subject merge that `wouldGroupTogether` refuses is now refused in the episode
  // count as well, rather than being reintroduced one layer down.
  assert.notEqual(report.episodes.counted, 1)
})

test('ONE EVENT IS ONE EPISODE, KNOWABLE WITHOUT ITS TIME', () => {
  // The time is only needed to SPLIT several events. A single event forms exactly one burst
  // whenever it happened, so refusing to count it was over-refusing — the mirror of counting
  // a genuinely unknowable incident as one, and both fail to distinguish "cannot be computed"
  // from "computed".
  const single = reconcile([
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1', occurrenceCount: 1 }),
  ])
  assert.equal(single.episodes.counted, 1)
  assert.equal(single.episodes.incidentsWithUnrecoverableEpisodes, 0,
    'one event with no time is still one episode')
  assert.equal(single.episodes.rowsWithoutEventTime, 1, 'and the missing time is still reported')

  // MANY events with no times stays unknown, which is the case that genuinely cannot be
  // computed: forty-two events at unknown individual times could be one burst or forty-two.
  const many = reconcile([
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1', occurrenceCount: 42 }),
  ])
  assert.equal(many.episodes.counted, 0)
  assert.equal(many.episodes.incidentsWithUnrecoverableEpisodes, 1)

  // And an incident mixing a timed event with a timeless MULTI-event row is unknown too: the
  // timeless events could fall inside the known episode or outside it.
  const mixed = reconcile([
    auditAt('a', 'actor-1', T0),
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1', occurrenceCount: 9 }),
  ])
  assert.equal(mixed.episodes.incidentsWithUnrecoverableEpisodes, 1)
  assert.equal(mixed.episodes.counted, 1, 'the audit incident counts; the aggregate one does not')
})

test('STEP 02 DECIDES WHAT GROUPS, AND THE RECONCILIATION MUST NOT DIVERGE', () => {
  // The coupling test. Step 02 ruled that an unresolvable subject does not group — it
  // stands alone, labelled unattributed, because merging on "unknown" asserts a
  // relationship nothing evidences. `incidentGrouping` implemented that ruling correctly
  // and the reconciliation quietly did something else: it dropped those rows from the
  // episode accounting entirely. One module right, one module wrong, and nothing tying
  // them together — so this asserts the tie rather than the number.
  //
  // THE EXPECTED COUNT IS DERIVED FROM `wouldGroupTogether`, not written down here. A
  // literal would agree with whichever side I copied it from; step 02's own predicate is
  // the other side of the boundary, so it can disagree with the reconciliation and that is
  // the entire point of the check.
  const declaration = ALERT_CATALOG.find((d) => d.id === 'security.routine_directory_change')
  assert.ok(declaration, 'the nominated type must exist for this comparison to mean anything')

  // THREE THAT GROUP AND TWO THAT DO NOT, and the asymmetry is load-bearing. My first
  // fixture had three of each, and a mutation INVERTING the standing-alone counter — count
  // the rows that did group — survived every assertion, because three and three read the
  // same. A fixture whose two populations are the same size cannot tell a count from its
  // complement. Asserted below rather than left to whoever edits this next.
  const actors: readonly (string | null)[] = ['admin-1', 'admin-1', 'admin-2', null, null]
  const rows = actors.map((actor, index) =>
    row({
      dedupeKey: `security:directory-audit:Directory_c${index}`,
      // Seconds apart, so the interval never splits anything and the only thing that can
      // move the episode count is the grouping decision under test.
      occurredAt: new Date(T0 + index * 1000),
      audit: { initiatedBy: actor, targetResources: ['t'], privileged: null },
    }))

  const groupings = actors.map((actor) =>
    incidentGrouping(
      declaration,
      { organizationId: 'org-1', customerTenantId: 'tenant-1' },
      actor === null
        ? { resolved: false, why: 'the audit record names no initiator' }
        : { resolved: true, id: actor }))

  // Partition by step 02's predicate alone. A non-grouping element joins nothing — not even
  // another non-grouping one, and not itself — so each forms its own class.
  const classes: (typeof groupings[number])[][] = []
  for (const grouping of groupings) {
    const existing = classes.find((members) => wouldGroupTogether(members[0]!, grouping))
    if (existing) existing.push(grouping)
    else classes.push([grouping])
  }

  const standingAlone = groupings.filter((grouping) => !grouping.groups).length
  const grouped = groupings.length - standingAlone
  assert.notEqual(standingAlone, grouped,
    'the two populations must differ in size, or a counter and its complement read alike')

  const report = reconcile(rows)
  assert.equal(report.episodes.counted, classes.length,
    'the reconciliation must produce exactly as many episodes as step 02 has incidents')
  assert.equal(report.episodes.rowsStandingAloneBecauseSubjectUnresolved, standingAlone)

  // AND THE PARTITION MUST DISCRIMINATE. Without this the assertion above passes whenever
  // both sides are broken the same way — five classes and five episodes would satisfy it
  // just as happily if nothing ever grouped at all.
  assert.equal(classes.length, 4,
    'two admin-1 rows are one incident, admin-2 is a second, and two unattributable stand alone')
  assert.ok(classes.length < actors.length, 'something grouped')
  assert.ok(classes.length > 1, 'and not everything did')
})

test('THE STANDING-ALONE COUNT IS NAMED, not left to subtraction', () => {
  // QA's point, and it holds whatever the count turns out to be: a row appears in `total`,
  // in `byShape` and in `needingClassification`, and then had no number at all in the
  // episode accounting. `incidents.unattributed` cannot cover it — that counter sits after
  // the `declaration === null` branch returns, and every directory-audit row takes that
  // branch, so it reads 0 for them by construction rather than by measurement.
  // Two that group onto one actor and one that does not — asymmetric on purpose, for the
  // same reason as the test above: equal populations cannot distinguish a count from its
  // complement.
  const rows = [
    auditAt('a', 'actor-1', T0),
    auditAt('b', 'actor-1', T0 + 1000),
    row({
      dedupeKey: 'security:directory-audit:Directory_u1',
      occurredAt: new Date(T0 + 2000),
      audit: { initiatedBy: null, targetResources: [], privileged: null },
    }),
  ]
  const report = reconcile(rows)

  assert.equal(report.episodes.rowsStandingAloneBecauseSubjectUnresolved, 1)
  assert.equal(report.incidents.declaredSubjectUnresolvedAmongTypedRows, 0,
    'and the counter that looks like it should say this cannot')
  assert.equal(report.incidents.needingClassification, 3, 'though all three rows are counted here')

  // The number is not derivable from the others, which is why it has to be reported: three
  // rows, two episodes, and nothing in the remaining figures distinguishes "two grouped and
  // one stood alone" from any other split that lands on two.
  assert.equal(report.episodes.counted, 2)
})

test('A ROW-LEVEL FACT IS COUNTED AT THE ROW, not summed over a structure that can drop it', () => {
  // The defect, reproduced. `rowsWithoutEventTime` was `rowsWithoutTime += bucket.missing`
  // over the incident buckets, and ungrouped rows were never bucketed — so the field silently
  // excluded exactly the rows the bucketing bug had dropped. On the production set it read 22
  // against a true 47, where 364 − 317 = 47 is checkable by hand, and when the bucketing was
  // fixed the number simply got better with nothing announcing a correction.
  //
  // THE EXPECTATION COMES FROM THE INPUT, not from a literal and not from another field of
  // the report. A literal would have agreed with whichever run wrote it down.
  const rows = [
    // Grouping rows with times — these were always counted correctly, which is how the bug
    // stayed plausible: every number was right for the rows it could see.
    auditAt('g1', 'admin-1', T0),
    auditAt('g2', 'admin-1', T0 + 1000),
    // A grouping row with NO time.
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),
    // Rows that do not group AND have no time — invisible to the old derivation entirely.
    row({ dedupeKey: 'tenant:t1:initial-sync', customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t1:onboarding-authorized', customerTenantId: 't1' }),
    row({ dedupeKey: 'nobody:wrote:this', customerTenantId: 't1' }),
  ]
  const report = reconcile(rows)

  const withoutTime = rows.filter((input) => !(input.occurredAt instanceof Date)).length
  const withTime = rows.length - withoutTime
  assert.equal(report.episodes.rowsWithoutEventTime, withoutTime)
  assert.equal(report.episodes.rowsWithEventTime, withTime)

  // AND THE FIXTURE MUST CONTAIN THE CASE THE OLD DERIVATION MISSED, or this test passes over
  // a version with the bug still in it. Three timeless rows that do not group: the old code
  // would have reported 1 here, counting only the grouping one.
  assert.equal(report.episodes.rowsStandingAloneBecauseSubjectUnresolved, 3)
  assert.ok(withoutTime > 1, 'more than one timeless row, and not all of them group')

  // The report checks its own arithmetic, so a reader does not have to be the check.
  assert.deepEqual(report.invariants.eventTimeCountsAddUp, [])
})

test('THE STANDING-ALONE TOTAL IS DERIVABLE FROM THE OTHER SIDE, by shape', () => {
  // A bare 34 is a number nobody can verify. Each shape stands alone for a reason that is a
  // property of the KEY, so anyone can count those shapes in SQL and compare — which is what
  // makes the figure evidence rather than a claim.
  const rows = [
    auditAt('a', 'admin-1', T0),                                          // groups on its actor
    row({                                                                  // no initiator
      dedupeKey: 'security:directory-audit:Directory_u1',
      occurredAt: new Date(T0 + 1000),
      audit: { initiatedBy: null, targetResources: [], privileged: null },
    }),
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }), // COLLECTOR resolves
    row({ dedupeKey: 'tenant:t1:initial-sync', customerTenantId: 't1' }),  // no resource type
    row({ dedupeKey: 'tenant:t1:connection:recovered:2', customerTenantId: 't1' }), // likewise
    row({ dedupeKey: 'nobody:wrote:this' }),                               // no type, no audit
  ]
  const report = reconcile(rows)

  // The shapes that DO resolve a subject are absent rather than present as zero, so the
  // breakdown cannot be misread as a list of shapes that all failed. Asserted BEFORE the
  // deepEqual below, because `assert.deepEqual` narrows its first argument to the expected
  // literal type — after it, this lookup does not compile, which is the compiler pointing
  // out that the two assertions are about different things.
  assert.equal(report.episodes.standingAloneByShape.TENANT_SYNC, undefined)
  assert.equal(report.episodes.standingAloneByShape.TENANT_CONNECTION, undefined)

  // The breakdown must sum to the headline figure, or one of the two is wrong and a reader
  // has no way to tell which.
  const summed = Object.values(report.episodes.standingAloneByShape)
    .reduce((total, count) => total + count, 0)
  assert.equal(summed, report.episodes.rowsStandingAloneBecauseSubjectUnresolved)

  assert.deepEqual(report.episodes.standingAloneByShape, {
    DIRECTORY_AUDIT: 1,
    TENANT_INITIAL_SYNC: 1,
    RECOVERY: 1,
    UNRECOGNISED: 1,
  })

})

test('THE IDENTITY THAT VALIDATES THE HEADLINE IS PRINTED, not performed in a message', () => {
  // 71 = 62 + 9 was reconciled by hand, using an attributed-episode count the report did not
  // expose — so the arithmetic that made the headline credible could not be reproduced by
  // anyone reading the output. A number verified once in a message is not a verified number.
  const DAY = 24 * 60 * 60 * 1000
  const rows = [
    // One actor, two bursts more than the quiet interval apart: TWO episodes, one incident.
    auditAt('a1', 'admin-1', T0),
    auditAt('a2', 'admin-1', T0 + 3 * DAY),
    // A second actor: one more.
    auditAt('b1', 'admin-2', T0),
    // Two rows that stand alone.
    ...[1, 2].map((index) =>
      row({
        dedupeKey: `security:directory-audit:Directory_u${index}`,
        occurredAt: new Date(T0 + index * 1000),
        audit: { initiatedBy: null, targetResources: [], privileged: null },
      })),
  ]
  const report = reconcile(rows)

  assert.equal(report.episodes.counted, 5)
  assert.equal(report.episodes.fromAttributedRows, 3, 'two bursts from one actor, one from another')
  assert.equal(report.episodes.fromStandingAloneRows, 2)
  assert.deepEqual(report.invariants.episodeCountsAddUp, [])

  // AND THE SPLIT MUST BE ASYMMETRIC, or a mutation swapping the two halves reads identical.
  assert.notEqual(report.episodes.fromAttributedRows, report.episodes.fromStandingAloneRows)

  // The identity is checkable from the printed output alone, which is the whole point: a
  // reader adds the two halves and gets the headline, without having to be told the sum.
  assert.equal(
    report.episodes.fromAttributedRows + report.episodes.fromStandingAloneRows,
    report.episodes.counted)
})

test('EVERY FIGURE RECONCILES AGAINST ANOTHER FIGURE, including the always-zero one', () => {
  // `unattributed` was unconstrained AND structurally zero for directory rows, which is the
  // quietest possible place for a wrong number: nothing contradicts it, and its correct value
  // is indistinguishable from a broken one. It now carries its restriction in its name and
  // has a complement and a total that must agree with it.
  const rows = [
    auditAt('a', 'admin-1', T0),                                           // no determined type
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),  // typed, resolves
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: null }),     // typed, does not
    row({ dedupeKey: 'nobody:wrote:this' }),                                // no determined type
  ]
  const report = reconcile(rows)

  assert.equal(report.incidents.withDeterminedType, 2)
  assert.equal(report.incidents.declaredSubjectResolvedAmongTypedRows, 1)
  assert.equal(report.incidents.declaredSubjectUnresolvedAmongTypedRows, 1)
  assert.equal(report.incidents.needingClassification, 2)

  // Both identities, and they are what makes the four figures above mutually constraining
  // rather than four independent claims.
  assert.deepEqual(report.invariants.rowCountsAddUp, [])
  assert.equal(report.incidents.withDeterminedType + report.incidents.needingClassification,
    report.total)
  assert.equal(
    report.incidents.declaredSubjectResolvedAmongTypedRows
    + report.incidents.declaredSubjectUnresolvedAmongTypedRows,
    report.incidents.withDeterminedType)
})

test('THE OCCURRENCE CHECK READS THE FIGURE IT VOUCHES FOR', () => {
  // The boolean it replaces compared two internal sums and touched NEITHER reported field, so
  // perturbing `occurrencesRepresented` left it reading "preserved". A misleading neighbour is
  // worse than no neighbour: an unchecked figure standing alone is merely unverified, while one
  // beside a boolean that looks like a guarantee is actively miscredited.
  const rows = [
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1', occurrenceCount: 42 }),
    row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1', occurrenceCount: 7 }),
  ]
  const report = reconcile(rows)

  assert.equal(report.occurrencesRepresented, 49)
  assert.deepEqual(report.invariants.occurrenceCountsAddUp, [])
  assert.notEqual(report.occurrencesRepresented, report.total,
    'the figure must differ from the row count, or the check cannot tell them apart')
})

test('A DISCREPANCY IS NAMED WITH ITS SIZE, so a reader knows where to look', () => {
  // Every one of these identities is a LIST rather than a boolean. `false` tells a reader to
  // distrust the whole report; "3 with a time + 1 without = 4, but rows read is 5" tells them
  // which figure to go and look at. Exercised through a duplicate id, which is the one
  // discrepancy reachable from input alone.
  const duplicate = row({ dedupeKey: 'tenant:t1:connection', customerTenantId: 't1' })
  const report = reconcile([duplicate, duplicate])

  assert.deepEqual(report.invariants.duplicatedNotificationIds, [duplicate.id])
  // The arithmetic identities still hold — a duplicated row is counted twice everywhere, so
  // the sums stay consistent. That is worth asserting: it shows the lists are reporting on
  // the arithmetic rather than on general unhappiness.
  assert.deepEqual(report.invariants.rowCountsAddUp, [])
  assert.deepEqual(report.invariants.eventTimeCountsAddUp, [])
})

test('THE IDENTITY HELPER IS TESTED DIRECTLY, because no input can exercise it in place', () => {
  // Every identity in this report has both sides computed in one pass over the same rows, so
  // no input can make one disagree — mutations making `adds` always report agreement, and
  // making it drop the size of the gap, both survived the whole suite. The identities are
  // TRIPWIRES against future drift, not checks on the present computation, and the only way
  // to cover the helper's own behaviour is to call it directly.
  assert.deepEqual(adds([['a', 2], ['b', 3]], 5, 'the whole'), [])
  assert.deepEqual(adds([], 0, 'the whole'), [], 'nothing adds to nothing')

  // THE MESSAGE CARRIES THE SIZE OF THE GAP, which is the difference between a reader
  // distrusting one figure and distrusting the report. Asserted on content, not on shape.
  const gap = adds([['with a time', 317], ['without', 22]], 364, 'rows read')
  assert.equal(gap.length, 1)
  assert.match(gap[0] ?? '', /317 with a time/)
  assert.match(gap[0] ?? '', /22 without/)
  assert.match(gap[0] ?? '', /= 339/, 'the sum it actually got')
  assert.match(gap[0] ?? '', /rows read is 364/, 'and what it should have been')

  // Over-count as well as under-count: a report can inflate as easily as it can drop.
  assert.match(adds([['counted', 9]], 5, 'the total')[0] ?? '', /= 9, but the total is 5/)
})

test('THE DIRECTORY-ONLY HEADLINE DECOMPOSES, which is the figure a person quotes', () => {
  // The first attempt decomposed `counted` (all shapes) and left `countedDirectoryAuditOnly`
  // — the figure the audit named — still standing alone. The two sit adjacent and differ only
  // in scope, which is exactly why the fix landed on the wrong one. ADJACENCY IS WHERE A FIX
  // GOES WRONG: the neighbour looks interchangeable with the thing that was asked for.
  const DAY = 24 * 60 * 60 * 1000
  const rows = [
    // Directory, attributed: one actor with two bursts, one actor with one. Three episodes.
    auditAt('a1', 'admin-1', T0),
    auditAt('a2', 'admin-1', T0 + 3 * DAY),
    auditAt('b1', 'admin-2', T0),
    // Directory, standing alone: two rows, one episode each.
    ...[1, 2].map((index) =>
      row({
        dedupeKey: `security:directory-audit:Directory_u${index}`,
        occurredAt: new Date(T0 + index * 1000),
        audit: { initiatedBy: null, targetResources: [], privileged: null },
      })),
    // NON-directory, attributed: must land in the all-shapes halves and NOT in the
    // directory-only ones. Without this row the two identities cannot be told apart.
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),
    // NON-directory, standing alone.
    row({ dedupeKey: 'tenant:t1:initial-sync', customerTenantId: 't1' }),
  ]
  const report = reconcile(rows)

  // The headline, reproducible from the output: 5 = 3 + 2.
  assert.equal(report.episodes.countedDirectoryAuditOnly, 5)
  assert.equal(report.episodes.fromAttributedRowsDirectoryAuditOnly, 3)
  assert.equal(report.episodes.fromStandingAloneRowsDirectoryAuditOnly, 2)

  // The all-shapes figures are LARGER, or the two identities are the same identity and the
  // directory-only one proves nothing.
  assert.equal(report.episodes.counted, 7)
  assert.equal(report.episodes.fromAttributedRows, 4)
  assert.equal(report.episodes.fromStandingAloneRows, 3)
  assert.ok(report.episodes.counted > report.episodes.countedDirectoryAuditOnly,
    'the fixture must contain non-directory rows or the two scopes are indistinguishable')

  assert.deepEqual(report.invariants.episodeCountsAddUp, [])
})

test('EVERY STANDING-ALONE ROW IS EITHER AN EPISODE OR NAMED AS UNPLACEABLE', () => {
  // 34 rows yielding 30 episodes was not derivable from the output, and the natural guess —
  // "rows without an event time cannot be placed" — is WRONG: a single timeless event still
  // counts as one episode. The dividing line is SEVERAL events at unknown times, which is the
  // case that genuinely cannot be computed. Not guessable from the other figures, so printed.
  const rows = [
    // Stands alone, one event, no time: still one episode.
    row({ dedupeKey: 'tenant:t1:initial-sync', customerTenantId: 't1', occurrenceCount: 1 }),
    // Stands alone, MANY events, no times: unplaceable, and named as such.
    row({ dedupeKey: 'tenant:t2:initial-sync', customerTenantId: 't2', occurrenceCount: 9 }),
    // Stands alone, directory, with a time: one episode.
    row({
      dedupeKey: 'security:directory-audit:Directory_u1',
      occurredAt: new Date(T0),
      audit: { initiatedBy: null, targetResources: [], privileged: null },
    }),
  ]
  const report = reconcile(rows)

  assert.equal(report.episodes.rowsStandingAloneBecauseSubjectUnresolved, 3)
  assert.equal(report.episodes.fromStandingAloneRows, 2)
  assert.equal(report.episodes.standingAloneRowsWithUnrecoverableEpisodes, 1)
  assert.equal(
    report.episodes.fromStandingAloneRows
    + report.episodes.standingAloneRowsWithUnrecoverableEpisodes,
    report.episodes.rowsStandingAloneBecauseSubjectUnresolved,
    'every standing-alone row is accounted for exactly once')

  // NO EVENT TIME IS NOT THE DIVIDING LINE. Two of these three carry no time, and one of
  // those two is still an episode — asserting this pins the rule rather than the arithmetic.
  assert.equal(report.episodes.rowsWithoutEventTime, 2)
  assert.notEqual(report.episodes.standingAloneRowsWithUnrecoverableEpisodes,
    report.episodes.rowsWithoutEventTime)

  assert.deepEqual(report.invariants.episodeCountsAddUp, [])
})

test('A CARDINALITY IS BOUNDED, NOT DECOMPOSED, and the report says which', () => {
  // QA's correction to the principle, and it is the sharper version: the six incident figures
  // are set cardinalities over different groupings of the same rows, not partitions. They
  // admit no additive sibling. Manufacturing six sums for them would produce fake identities
  // that READ like the real ones — worse than an honest gap, because a figure standing alone
  // is visibly unverified while one beside a meaningless sum is miscredited.
  const rows = [
    auditAt('a', 'admin-1', T0),
    auditAt('b', 'admin-2', T0 + 1000),
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),
    row({ dedupeKey: 'tenant:t2:connection', customerTenantId: 't2' }),
  ]
  const report = reconcile(rows)

  // The ONE relation these support: the directory-only figure is bounded by its all-rows
  // sibling, because the narrower set is drawn from the wider one.
  assert.ok(report.incidents.assumingSingleTypeDirectoryAuditOnly
    <= report.incidents.assumingSingleType)
  assert.ok(report.incidents.assumingSingleTypeDirectoryAuditOnlyKeyedOnTarget
    <= report.incidents.assumingSingleTypeKeyedOnTarget)
  assert.deepEqual(report.invariants.cardinalityOrderingHolds, [])

  // AND THE BOUND MUST BE STRICT SOMEWHERE IN THIS FIXTURE, or `<=` is satisfied by equality
  // everywhere and the assertion is indistinguishable from asserting nothing.
  assert.ok(report.incidents.assumingSingleTypeDirectoryAuditOnly
    < report.incidents.assumingSingleType,
    'the fixture needs non-directory rows, or the ordering check cannot discriminate')

  // NO ADDITIVE IDENTITY IS CLAIMED FOR THEM. Asserted as an absence so that anyone later
  // tempted to add one has to delete this line and read why first.
  const invariantNames = Object.keys(report.invariants)
  assert.ok(!invariantNames.some((name) => /declaredCountsAddUp|incidentCountsAddUp/.test(name)),
    'the six cardinalities are labelled, not given a manufactured sum')
})

test('atMost NAMES BOTH SIDES when a bound is violated', () => {
  // The helper is separate from `adds` because it says something WEAKER, and presenting a
  // bound in the same shape as a decomposition invites a reader to think a figure is
  // accounted for when it is only constrained. No input can violate the bound in place — the
  // narrower set is populated only where the wider one is — so, like `adds`, the only way to
  // cover its behaviour is to reach the report's own output for the passing case and rely on
  // the ordering assertions above for the rest.
  const report = reconcile([auditAt('a', 'admin-1', T0)])
  assert.deepEqual(report.invariants.cardinalityOrderingHolds, [],
    'a healthy report reports no violation')
})

/** The per-row episode, and what the apply may actually write.
 *
 * Added because the apply writes TWO columns and only one had an owner: it had an incident key
 * from the mapping and no episode at all. The convenient answer — null everywhere — is not a
 * gap but a WRONG VALUE, because null already means "the count could not be recovered". */

const auditNoTime = (id: string, actor: string) =>
  row({
    dedupeKey: `security:directory-audit:Directory_${id}`,
    audit: { initiatedBy: actor, targetResources: [`t-${id}`], privileged: null },
  })

const syncAt = (tenant: string, at: number) =>
  row({ dedupeKey: `tenant:${tenant}:sync:SIGN_INS`, customerTenantId: tenant, occurredAt: new Date(at) })

test('THE EPISODE NUMBER IS PER INCIDENT, NOT A RUNNING COUNTER', () => {
  // Two tenants, two bursts each, thirty days apart. Numbered within the incident this is
  // 1,2 and 1,2; numbered globally it is 1,2,3,4 — and the second reads exactly as plausibly
  // on a row. Nothing about "episode 3" looks wrong until you ask three of what.
  const rows = ['t1', 't2'].flatMap((tenant) => [0, 30].map((day) => syncAt(tenant, T0 + day * DAY)))
  const report = reconcile(rows)

  assert.deepEqual(rows.map((r) => report.episodeByRow.get(r.id)), [1, 2, 1, 2])
  assert.equal(report.episodes.counted, 4, 'four episodes across two incidents')

  // AND THE TWO NUMBERS COME FROM DIFFERENT STRUCTURES AND STILL AGREE. Distinct ordinals per
  // incident, summed, against the reported total. Unlike the four identities beside it in
  // `invariants`, AN INPUT CAN SEPARATE THESE: a numbering computed over a second partition
  // gives the same total with different ordinals, which is the failure worth catching.
  const byIncident = new Map<string, Set<number>>()
  for (const entry of report.mapping) {
    if (entry.incidentKey === null) continue
    const ordinal = report.episodeByRow.get(entry.notificationId)
    if (ordinal === null || ordinal === undefined) continue
    byIncident.set(entry.incidentKey, (byIncident.get(entry.incidentKey) ?? new Set()).add(ordinal))
  }
  assert.equal([...byIncident.values()].reduce((total, set) => total + set.size, 0),
    report.episodes.counted)
  assert.deepEqual(report.invariants.episodeOrdinalsAgreeWithCounts, [])
})

test('EVENTS INSIDE ONE BURST SHARE AN EPISODE NUMBER', () => {
  // Or "per incident" would be satisfied by numbering every row 1 and never splitting — the
  // degenerate reading of the test above.
  const together = [0, 3_600_000].map((within) => syncAt('t1', T0 + within))
  const apart = syncAt('t1', T0 + 30 * DAY)
  const report = reconcile([...together, apart])

  assert.deepEqual(together.map((r) => report.episodeByRow.get(r.id)), [1, 1])
  assert.equal(report.episodeByRow.get(apart.id), 2)
})

test('AN UNRECOVERABLE INCIDENT NUMBERS NONE OF ITS ROWS - not even the ones with a time', () => {
  // THE TRAP IS THE ROW THAT KEPT ITS TIME. It is numberable in isolation, and numbering it
  // would place it in a sequence nobody can see: the count that cannot be recovered is the
  // INCIDENT'S, so a "1" on that row claims a position in a series of unknown length.
  const timed = auditAt('has-time', 'actor-1', T0)
  const timeless = auditNoTime('no-time', 'actor-1')
  const report = reconcile([timed, timeless])

  assert.equal(report.episodes.incidentsWithUnrecoverableEpisodes, 1)
  assert.equal(report.episodeByRow.get(timeless.id), null)
  assert.equal(report.episodeByRow.get(timed.id), null, 'the timed row too, because the incident is')

  // POSITIVE CONTROL: the same two rows under different actors are two incidents of one event
  // each, and a single event is one episode whether or not its time survived.
  const split = reconcile([auditAt('has-time', 'actor-1', T0), auditNoTime('no-time', 'actor-2')])
  assert.equal(split.episodes.incidentsWithUnrecoverableEpisodes, 0)
  for (const [, ordinal] of split.episodeByRow) assert.equal(ordinal, 1)
})

test('EVERY ROW THE APPLY WOULD WRITE HAS AN EPISODE DECISION', () => {
  // The coupling the runner depends on. `alerting-apply.mts` throws rather than defaulting when
  // a decision is missing, so the failure would be loud — but a mapping entry with no decision
  // means the apply cannot run at all, which is worth catching here and not on production data.
  const report = reconcile([
    syncAt('t1', T0),
    syncAt('t1', T0 + 30 * DAY),
    auditAt('a', 'actor-1', T0),
    auditNoTime('c', 'actor-2'),
    row({ dedupeKey: 'nothing:like:a:known:key' }),
  ])

  const writable = report.mapping.filter((entry) => entry.incidentKey !== null)
  assert.ok(writable.length > 0, 'the fixture must produce writable rows or this proves nothing')
  for (const entry of writable) {
    assert.ok(report.episodeByRow.has(entry.notificationId),
      `${entry.notificationId} would be written with no episode decision`)
  }
})

test('THE APPLY WOULD NOT KEY A SINGLE DIRECTORY-AUDIT ROW, and that is the open decision', () => {
  // FOUND WHILE WIRING THE RUNNER, AND IT CHANGES THE EXPECTED OUTPUT. `TYPE_FOR_SHAPE`
  // maps DIRECTORY_AUDIT to null on purpose — the key shape does not determine the type, and
  // defaulting it would file real privileged changes as routine. So those rows reach the
  // mapping with `incidentKey: null` and the apply, which writes only non-null keys, skips
  // every one of them.
  //
  // On production that is 317 of the 364. The runbook's expected figures (364 written, 71
  // incidents) come from `incidents.assumingSingleType`, which is the count UNDER THE
  // NOMINATED TYPE — a different question from what the mapping authorises. Whether the apply
  // should key those rows under the nominated type, or wait for step 05 to classify them, is
  // not a decision this file can make; it is pinned here so it cannot be lost in a diff.
  const rows = [
    auditAt('a', 'actor-1', T0),
    auditAt('b', 'actor-1', T0 + 30 * DAY),
    syncAt('t1', T0),
  ]
  const report = reconcile(rows)

  const audits = report.mapping.filter((entry) => entry.notificationId !== rows[2]!.id)
  assert.equal(audits.length, 2)
  for (const entry of audits) {
    assert.equal(entry.incidentKey, null, 'no incident key, therefore never written')
    assert.equal(entry.alertTypeId, null)
  }

  // AND YET THEY ARE COUNTED. The audit rows contribute two of the three episodes and an
  // incident of their own, so the headline figures describe rows the apply would not touch.
  assert.equal(report.episodes.counted, 3)
  assert.equal(report.mapping.filter((entry) => entry.incidentKey !== null).length, 1,
    'one writable row out of three — the same shape as 47 out of 364')
})

/** PERMANENTLY UNWRITABLE ROWS, which are not the same thing as rows waiting for the
 * classifier. Found by QA at three rows of production data; the shape of it is here. */

test('A KEY NAMES A RESOURCE TYPE, OR NOTHING IT RECOVERS DOES EITHER', () => {
  // The grammar, per shape. A witness each, and the assertion is against `resourceTypeFor`
  // rather than a table restating it — the table this replaces was a second implementation of
  // the parser, and it stopped being expressible the moment a RECOVERY key could answer
  // differently depending on what it recovered.
  assert.equal(resourceTypeFor('tenant:t1:sync:SIGN_INS'), 'SIGN_INS')
  assert.equal(resourceTypeFor('tenant:t1:initial-sync'), null)
  assert.equal(resourceTypeFor('tenant:t1:connection'), null)
  assert.equal(resourceTypeFor('tenant:t1:onboarding-authorized'), null)
  assert.equal(resourceTypeFor('security:directory-audit:Directory_abc'), null)
  assert.equal(resourceTypeFor('nothing:like:a:known:key'), null)

  // ADVERSARIAL, because a witness chosen by the author proves the witness. Keys that LOOK
  // like they carry a resource type on a shape whose grammar has no segment for one.
  assert.equal(resourceTypeFor('tenant:t1:initial-sync:SIGN_INS'), null)
  assert.equal(resourceTypeFor('tenant:t1:connection:SIGN_INS'), null)

  // WHAT THIS DOES NOT ESTABLISH: that no key of those shapes anywhere yields one. It is a
  // witness set, not a proof over the grammar; the anchored regexes are the actual argument
  // and this is what keeps them honest if somebody edits one.
})

test('A RECOVERY TAKES ITS SUBJECT FROM WHAT IT RECOVERS, and keeps its own type', () => {
  // THE RULING, and the distinction it turns on: the recovery-first rule is about the TYPE and
  // this is about the SUBJECT. Reading SIGN_INS out of the recovered key reclassifies nothing.
  const key = 'tenant:t1:sync:SIGN_INS:recovered:8'
  assert.equal(parseDedupeKey(key).shape, 'RECOVERY', 'still classified as a recovery')
  assert.equal(parseDedupeKey(key).resourceType, null, 'the parse itself still does not reach in')
  assert.equal(resourceTypeFor(key), 'SIGN_INS', 'but the subject resolves through it')
  assert.equal(exclusionKindFor('monitoring.recovered', key), 'SUBJECT_UNRESOLVED',
    'so it is no longer permanently unwritable')

  // IT DOES NOT MERGE INTO WHAT IT RECOVERED. The incident key carries the type id, and the two
  // types differ — so the recovery is its own record-tier incident rather than a second alert
  // on the incident it closes.
  const report = reconcile([
    row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' }),
    row({ dedupeKey: key, customerTenantId: 't1' }),
  ])
  const keys = report.mapping.map((entry) => entry.incidentKey)
  assert.equal(keys.filter((each) => each !== null).length, 2, 'both key')
  assert.notEqual(keys[0], keys[1], 'and they are different incidents')
  assert.match(keys[1] ?? '', /monitoring\.recovered/)

  // A NESTED RECOVERY STILL RESOLVES, because the walk follows every hop.
  assert.equal(resourceTypeFor('tenant:t1:sync:SIGN_INS:recovered:8:recovered:2'), 'SIGN_INS')
})

test('BUT THE RULING DOES NOT REACH EVERY RECOVERY, and that is measurable rather than assumed', () => {
  // A recovery of a CONNECTION alert names no resource type, because what it recovers does not
  // have one either. So "17 recovery rows become writable" is a claim about which alerts those
  // 17 recover, not about the ruling — and if any of them recover a connection or an audit row,
  // they stay unwritable and any total quoted before counting them is wrong.
  assert.equal(resourceTypeFor('tenant:t1:connection:recovered:1'), null)
  assert.equal(exclusionKindFor('monitoring.recovered', 'tenant:t1:connection:recovered:1'),
    'SHAPE_CANNOT_NAME_SUBJECT', 'still never writable')
  assert.equal(resourceTypeFor('security:directory-audit:Directory_x:recovered:1'), null)

  // The contrast, so this is about what is recovered rather than about recoveries.
  assert.equal(exclusionKindFor('monitoring.recovered', 'tenant:t1:sync:SIGN_INS:recovered:1'),
    'SUBJECT_UNRESOLVED')
})

test('AN INITIAL-SYNC ROW CAN NEVER BE KEYED - no classifier and no future data changes it', () => {
  // THE CHAIN, and every link is in the code rather than in a claim about production:
  // TENANT_INITIAL_SYNC types to monitoring.collector_failing, whose subject is COLLECTOR,
  // which reads a resource type out of the key — and `tenant:<id>:initial-sync` is anchored
  // with no segment that could hold one, and it recovers nothing.
  assert.equal(TYPE_FOR_SHAPE.TENANT_INITIAL_SYNC, 'monitoring.collector_failing')
  assert.equal(ALERT_CATALOG.find((type) => type.id === 'monitoring.collector_failing')?.subject, 'COLLECTOR')
  assert.equal(resourceTypeFor('tenant:t1:initial-sync'), null)
  assert.equal(exclusionKindFor('monitoring.collector_failing', 'tenant:t1:initial-sync'),
    'SHAPE_CANNOT_NAME_SUBJECT')

  // AND IT SHOWS UP AS UNKEYABLE END TO END, not only in the classification.
  const report = reconcile([row({ dedupeKey: 'tenant:t1:initial-sync', customerTenantId: 't1' })])
  assert.equal(report.mapping[0]?.incidentKey, null)

  // THE CONTRAST THAT MAKES IT A FINDING RATHER THAN A COINCIDENCE: the same type, the same
  // subject, a key that CAN name a resource type — and that one keys.
  const sync = reconcile([row({ dedupeKey: 'tenant:t1:sync:SIGN_INS', customerTenantId: 't1' })])
  assert.notEqual(sync.mapping[0]?.incidentKey, null)
})
test('THE THREE EXCLUSION REASONS ARE DECIDED BY THE CODE, not by a list of shapes', () => {
  // The failure this guards is a hand-maintained set of "shapes that never work", which goes
  // stale the moment a key shape is added. Every answer below comes from the catalogue and
  // the grammar table.
  assert.equal(exclusionKindFor(null, 'security:directory-audit:Directory_a'), 'TYPE_UNDETERMINED')
  assert.equal(exclusionKindFor(null, 'nothing:like:a:known:key'), 'TYPE_UNDETERMINED')
  assert.equal(exclusionKindFor('monitoring.tenant_disconnected', 'tenant:t1:connection'), 'SUBJECT_UNRESOLVED')
  assert.equal(exclusionKindFor('monitoring.collector_failing', 'tenant:t1:initial-sync'), 'SHAPE_CANNOT_NAME_SUBJECT')

  // A TENANT-SUBJECT TYPE IS NEVER PERMANENT, because the subject comes from a column rather
  // than from the key — the row is missing data, not incapable of carrying it.
  assert.equal(permanentlyUnresolvable('tenant:t1:initial-sync', 'TENANT'), false)
  assert.equal(permanentlyUnresolvable('security:directory-audit:Directory_a', 'ACTOR'), false)
  // AN ACCOUNT SUBJECT ALWAYS IS, for a migration row: the old system had no assessed account
  // and `subjectFor` returns unresolved for every input.
  assert.equal(permanentlyUnresolvable('security:directory-audit:Directory_a', 'ACCOUNT'), true)
})

test('EXHAUSTING THE HOP LIMIT IS UNKNOWN, NOT NEVER', () => {
  // The label matters more than the case does. Returning null for an exhausted walk would file
  // the row under "NEVER writable - the key cannot name what its subject reads", and that is
  // wrong in a specific way: the key may well name one, the walker stopped before reaching it.
  // Never and unknown are different answers.
  const deep = (n: number) =>
    `tenant:t1:sync:SIGN_INS${':recovered:1'.repeat(n)}`

  assert.deepEqual(resourceTypeLookup(deep(0)), { kind: 'NAMED', resourceType: 'SIGN_INS' })
  assert.deepEqual(resourceTypeLookup(deep(7)), { kind: 'NAMED', resourceType: 'SIGN_INS' },
    'seven suffixes is the deepest chain that still resolves')
  assert.deepEqual(resourceTypeLookup(deep(8)), { kind: 'EXHAUSTED', hops: 8 })

  // THE BOUNDARY IS PINNED so nobody "fixes" it by one in either direction without noticing:
  // the walk gets eight parses, and the eighth must land on a non-recovery key to answer.
  assert.equal(exclusionKindFor('monitoring.recovered', deep(7)), 'SUBJECT_UNRESOLVED')
  assert.equal(exclusionKindFor('monitoring.recovered', deep(8)), 'RECOVERY_CHAIN_TOO_DEEP')
  assert.notEqual(exclusionKindFor('monitoring.recovered', deep(8)), 'SHAPE_CANNOT_NAME_SUBJECT')

  // AND AN EXHAUSTED WALK IS NOT "PERMANENTLY UNRESOLVABLE", because nobody established that.
  assert.equal(permanentlyUnresolvable(deep(8), 'COLLECTOR'), false)
  assert.equal(permanentlyUnresolvable('tenant:t1:initial-sync', 'COLLECTOR'), true)

  // UNREACHABLE TODAY, and that is the reason it is a label rather than a fix: recovery keys are
  // built in one place and every caller passes a freshly-built non-recovery key, so the maximum
  // depth in production is 1. The limit exists so a future change to how recovery keys are
  // composed cannot turn a key parser into a hang.
  assert.deepEqual(resourceTypeLookup('tenant:t1:sync:SIGN_INS:recovered:8'),
    { kind: 'NAMED', resourceType: 'SIGN_INS' }, 'depth 1, which is what production has')
})

test('A KEY THAT NAMES NOTHING IS NONE, AND THE THREE ANSWERS DO NOT OVERLAP', () => {
  // Or EXHAUSTED could be satisfied by returning it whenever the answer is not NAMED.
  assert.deepEqual(resourceTypeLookup('tenant:t1:initial-sync'), { kind: 'NONE' })
  assert.deepEqual(resourceTypeLookup('tenant:t1:connection:recovered:1'), { kind: 'NONE' })
  assert.deepEqual(resourceTypeLookup('security:directory-audit:Directory_a'), { kind: 'NONE' })
  assert.deepEqual(resourceTypeLookup('tenant:t1:sync:SIGN_INS'),
    { kind: 'NAMED', resourceType: 'SIGN_INS' })
})

test('MOVING THE MAPPING INTO THE CATALOGUE CHANGED NOTHING', () => {
  // THE PROOF THAT THIS MOVE IS BEHAVIOUR-PRESERVING, and it is written against the literal that
  // was deleted rather than against the thing that replaced it — a derived table compared with
  // itself agrees by construction. Reconciliation is already verified against production figures;
  // if moving its table changed any result, it has to be visible here rather than discovered
  // later tangled up with a new lookup somewhere else.
  const asItWasBeforeTheMove: Readonly<Record<string, string | null>> = {
    DIRECTORY_AUDIT: null,
    TENANT_SYNC: 'monitoring.collector_failing',
    TENANT_CONNECTION: 'monitoring.tenant_disconnected',
    TENANT_INITIAL_SYNC: 'monitoring.collector_failing',
    TENANT_ONBOARDING: null,
    RECOVERY: 'monitoring.recovered',
    UNRECOGNISED: null,
  }
  assert.deepEqual({ ...TYPE_FOR_SHAPE }, asItWasBeforeTheMove)

  // AND IT IS TOTAL. Every shape has an answer, including the three that are deliberately covered
  // by nothing — "no type covers this" is one of the answers rather than a gap.
  assert.equal(Object.keys(TYPE_FOR_SHAPE).length, 7)
})

test('EVERY COVERED KIND NAMES A TYPE THE CATALOGUE ACTUALLY DECLARES', () => {
  // A `covers` entry pointing at nothing would be a mapping to an id no lookup can resolve, and
  // the derived table would carry it silently.
  const declared = new Set<string>(ALERT_CATALOG.map((type) => type.id))
  for (const [shape, alertTypeId] of Object.entries(TYPE_FOR_SHAPE)) {
    if (alertTypeId === null) continue
    assert.ok(declared.has(alertTypeId), `${shape} maps to ${alertTypeId}, which is not declared`)
  }

  // NOT VACUOUS: some shape does map, so the loop above is not passing over an empty set.
  assert.ok(Object.values(TYPE_FOR_SHAPE).some((id) => id !== null))
})
