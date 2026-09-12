import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyMapping,
  digestOf,
  revert,
  watchedFieldsDisturbedBetween,
  type MappingEntry,
  type StoredRow,
  type StoredSnapshot,
} from './apply-mapping.js'

/** The apply, against QA's seam attack. Six of seven properties were unpinnable through
 * `apply(mapping)`; every one of them needed the STORE rather than the mapping. */

const row = (over: Partial<StoredRow> = {}): StoredRow => ({
  id: 'n-1',
  organizationId: 'org-1',
  dedupeKey: 'security:directory-audit:Directory_a',
  occurrenceCount: 1,
  resolvedAt: null,
  lastOccurredAt: '2026-07-01T09:00:00.000Z',
  incidentKey: null,
  episode: null,
  ...over,
})

const entryFor = (r: StoredRow, over: Partial<MappingEntry> = {}): MappingEntry => ({
  notificationId: r.id,
  incidentKey: 'hawkview-alert-incident/v1|admin-1',
  episode: 1,
  observed: digestOf(r),
  ...over,
})

test('A1 — the fields a notifier watches are byte-identical afterwards', () => {
  // "Nothing was delivered" is not an output, so a seam with no notifier parameter closes only
  // the door somebody would knock on. THE REALISTIC ROUTE IS INDIRECT: a notifier watching
  // occurrenceCount, resolvedAt or lastOccurredAt turns a migration that touches one of them
  // into 364 messages, without anything ever being called.
  const before: StoredSnapshot = [
    row({ id: 'n-1', occurrenceCount: 12, lastOccurredAt: '2026-07-02T00:00:00.000Z' }),
    row({ id: 'n-2', resolvedAt: '2026-07-03T00:00:00.000Z' }),
  ]
  const { after, watchedFieldsDisturbed } = applyMapping(before, before.map((r) => entryFor(r)))

  assert.deepEqual(watchedFieldsDisturbed, [])
  for (const [index, was] of before.entries()) {
    const now = after[index]
    assert.equal(now?.occurrenceCount, was.occurrenceCount)
    assert.equal(now?.resolvedAt, was.resolvedAt)
    assert.equal(now?.lastOccurredAt, was.lastOccurredAt)
  }

  // AND THE APPLY DID SOMETHING, or the assertion above holds for the migration that does
  // nothing at all — which is the control that makes A1 mean anything.
  assert.equal(after.filter((r) => r.incidentKey !== null).length, 2)
})

test('THE PHOTOGRAPH PROBLEM, first half — a row that moved is refused and named', () => {
  // Through apply(mapping) a row that changed since it was measured and one that did not are
  // the same input. Re-running the dry run immediately before narrows the window; it cannot
  // close it, because the write still happens after the read. A TIMESTAMP SAYS WHEN SOMEBODY
  // LOOKED; THE DIGEST SAYS WHAT THEY SAW.
  const measured = row({ id: 'n-1', occurrenceCount: 3 })
  const moved = { ...measured, occurrenceCount: 9 }
  const { after, outcomes } = applyMapping([moved], [entryFor(measured)])

  assert.equal(outcomes[0]?.kind, 'REFUSED_ROW_CHANGED')
  assert.equal(after[0]?.incidentKey, null, 'and nothing was written')
  // Named with both versions, so a reader knows what moved rather than that something did.
  const refusal = outcomes[0]
  assert.ok(refusal?.kind === 'REFUSED_ROW_CHANGED' && refusal.observed !== refusal.now)

  // A ROW THAT DID NOT MOVE IS STILL APPLIED. Without this the refusal is satisfied by
  // refusing everything, which is a migration that never runs.
  const still = row({ id: 'n-2', occurrenceCount: 3 })
  assert.equal(applyMapping([still], [entryFor(still)]).outcomes[0]?.kind, 'APPLIED')
})

test('A7 — the second half: a row that APPEARED was never measured, and is named', () => {
  // The half the version digest cannot reach. There is no version to compare for a row that
  // was never in the mapping, so nothing about the digest catches it: apply 364 entries while
  // three new alerts arrive and THE TABLE HOLDS TWO KEYING SCHEMES AT ONCE WITH NOTHING SAYING
  // SO — partly migrated, reading as finished.
  const measured = row({ id: 'n-1' })
  const arrivedSince = [row({ id: 'n-late-1' }), row({ id: 'n-late-2' })]
  const result = applyMapping([measured, ...arrivedSince], [entryFor(measured)])

  assert.deepEqual(result.unmapped, ['n-late-1', 'n-late-2'],
    'named, not counted — "2 unmapped" tells a reader nothing they can act on')
  assert.equal(result.outcomes.length, 1, 'and they are not silently applied')
  assert.equal(result.after.find((r) => r.id === 'n-late-1')?.incidentKey, null)

  // A COMPLETE APPLY NAMES NOTHING, or the field always has entries and says as little as one
  // that never does.
  assert.deepEqual(applyMapping([measured], [entryFor(measured)]).unmapped, [])
})

test('IDEMPOTENT, and the two kinds of no-op stay different facts', () => {
  const before = [row({ id: 'n-1' })]
  const mapping = [entryFor(before[0]!)]

  const once = applyMapping(before, mapping)
  assert.equal(once.outcomes[0]?.kind, 'APPLIED')

  const twice = applyMapping(once.after, mapping)
  assert.equal(twice.outcomes[0]?.kind, 'ALREADY_APPLIED')
  assert.deepEqual(twice.after, once.after, 'a second run changes nothing')

  // DIFFERS IS NOT ALREADY_APPLIED. Merging them lets a second migration silently overwrite a
  // first while the report says it was already done — and the report is the only thing anybody
  // will read afterwards.
  const rival = applyMapping(once.after, [entryFor(before[0]!, { incidentKey: 'other-key' })])
  assert.equal(rival.outcomes[0]?.kind, 'DIFFERS')
  assert.equal(rival.after[0]?.incidentKey, 'hawkview-alert-incident/v1|admin-1',
    'and the first migration wins, because being later is not being right')
})

test('A MAPPING ENTRY WHOSE ROW IS GONE is refused rather than ignored', () => {
  const gone = row({ id: 'n-deleted' })
  const result = applyMapping([], [entryFor(gone)])
  assert.equal(result.outcomes[0]?.kind, 'REFUSED_ROW_GONE')
  assert.deepEqual(result.after, [])
})

test('REVERT IS THE WHOLE PROCEDURE, and it is weaker than it reads', () => {
  const before = [row({ id: 'n-1' }), row({ id: 'n-2', occurrenceCount: 5 })]
  const mapping = before.map((r) => entryFor(r))
  const applied = applyMapping(before, mapping)
  assert.equal(applied.after.every((r) => r.incidentKey !== null), true)

  const reverted = revert(applied.after)
  assert.deepEqual(reverted, before, 'set both columns to null; nothing else changes')

  // Revert is idempotent too, and reverting an untouched store is a no-op rather than an error.
  assert.deepEqual(revert(reverted), before)

  // THE HONEST LIMIT, RECORDED RATHER THAN CONTRIVED AROUND. A keyed row is never applied, so
  // a previous non-null value cannot arise from this migration — which means a revert that
  // ALWAYS writes null is indistinguishable from a correct one. This proves the data needed
  // for a revert exists; it does not prove a revert restores something, and no fixture here
  // can make it do so.
  assert.equal(before.every((r) => r.incidentKey === null), true,
    'every row this migration can apply to starts null, which is why the above is weak')
})

test('THE DIGEST SAYS WHAT WAS SEEN, and excludes what the mapping does not depend on', () => {
  const measured = row({ occurrenceCount: 3, dedupeKey: 'k' })

  // Mapping inputs move the digest.
  assert.notEqual(digestOf(measured), digestOf({ ...measured, occurrenceCount: 4 }))
  assert.notEqual(digestOf(measured), digestOf({ ...measured, dedupeKey: 'k2' }))

  // A ROW RESOLVED SINCE THE DRY RUN STILL MAPS TO THE SAME INCIDENT, so `resolvedAt` is
  // deliberately outside the digest even though it is mutable and watched. Including it would
  // refuse a correct write on ordinary churn — the failure where the migration is re-run six
  // times and never completes. A DECISION, not an omission: it is in the doc for PM to
  // overrule, and the two concerns are separate. A1 is about what the migration WRITES; the
  // digest is about whether the mapping is still true.
  const resolvedSince = row({ occurrenceCount: 3, dedupeKey: 'k', resolvedAt: '2026-07-09T00:00:00.000Z' })
  assert.equal(digestOf(resolvedSince), digestOf(measured))
  assert.equal(applyMapping([resolvedSince], [entryFor(measured)]).outcomes[0]?.kind, 'APPLIED')

  // And the length-prefixed join means a separator inside a key cannot forge a digest.
  assert.notEqual(
    digestOf({ dedupeKey: 'a', occurrenceCount: 11 }),
    digestOf({ dedupeKey: 'a1', occurrenceCount: 1 }))
})

test('THE WATCHED-FIELD CHECK IS TESTED DIRECTLY, because no input can exercise it in place', () => {
  // The apply only ever writes two columns nothing watches, so in place this check is a
  // TRIPWIRE against a future change rather than an input-falsifiable one — a mutation
  // disabling it survived the whole suite until this test existed. The direct field
  // assertions catch a real disturbance; this covers the thing that would catch one added
  // later, and a tripwire whose own behaviour is untested is decoration.
  const before = [row({ id: 'n-1', occurrenceCount: 3 }), row({ id: 'n-2' })]

  assert.deepEqual(watchedFieldsDisturbedBetween(before, before), [], 'unchanged is healthy')
  assert.deepEqual(
    watchedFieldsDisturbedBetween(before, before.map((r) => ({ ...r, incidentKey: 'k', episode: 1 }))),
    [], 'writing the two columns this migration owns is not a disturbance')

  // Each watched field, one at a time, so the check is not satisfied by noticing only one.
  for (const disturb of [
    (r: StoredRow) => ({ ...r, occurrenceCount: r.occurrenceCount + 1 }),
    (r: StoredRow) => ({ ...r, resolvedAt: '2026-09-01T00:00:00.000Z' }),
    (r: StoredRow) => ({ ...r, lastOccurredAt: '2026-09-01T00:00:00.000Z' }),
  ]) {
    const after = [disturb(before[0]!), before[1]!]
    const found = watchedFieldsDisturbedBetween(before, after)
    assert.equal(found.length, 1)
    assert.match(found[0] ?? '', /^n-1: /, 'and it names which row')
  }
})
