import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyValidated,
  digestOf,
  explain,
  revertValidated,
  validateApply,
  validateRevert,
  watchedFieldsDisturbedBetween,
  type ApplyReceipt,
  type MappingEntry,
  type StoredRow,
  type StoredSnapshot,
} from './apply-mapping.js'

/** The apply and revert, to the operator's spec: all-or-nothing, receipted, never blanket. */

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

/** Validate, assert it may proceed, and run it. Fixtures go through the only door there is. */
const mustApply = (store: StoredSnapshot, mapping: readonly MappingEntry[]) => {
  const decision = validateApply(store, mapping)
  assert.ok(decision.proceed, 'fixture must validate')
  return applyValidated(store, decision.run, 'run-1', '2026-09-12T10:00:00.000Z')
}

test('ONE REFUSABLE ROW ABORTS THE WHOLE RUN, before a single write', () => {
  // Stricter than the pre-registered contract, deliberately. QA's design refuses a moved row,
  // names it, and continues; the operator asked for all-or-nothing, because a partial migration
  // IS the two-keying-schemes state, and he chose to make it unreachable rather than
  // detectable. A detectable bad state still has to be noticed by somebody.
  const good = row({ id: 'n-1' })
  const measured = row({ id: 'n-2', occurrenceCount: 3 })
  const moved = { ...measured, occurrenceCount: 9 }

  const decision = validateApply([good, moved], [entryFor(good), entryFor(measured)])
  assert.equal(decision.proceed, false)
  assert.equal(decision.proceed === false ? decision.differences.length : -1, 1)

  // AND THE GOOD ROW IS NOT WRITTEN EITHER. That is the whole difference from the contract.
  assert.equal(good.incidentKey, null)
  assert.equal(moved.incidentKey, null)
})

test('ALL FOUR ABORT CONDITIONS, and each on its own is enough', () => {
  const base = row({ id: 'n-1' })

  const cases: readonly (readonly [string, StoredSnapshot, readonly MappingEntry[]])[] = [
    ['a mapping input changed',
      [{ ...base, occurrenceCount: 99 }], [entryFor(base)]],
    ['a row is missing',
      [], [entryFor(base)]],
    ['an unexpected row is present',
      [base, row({ id: 'n-late' })], [entryFor(base)]],
    ['a row is already keyed differently',
      [{ ...base, incidentKey: 'someone-elses-key', episode: 2 }], [entryFor(base)]],
  ]

  for (const [name, store, mapping] of cases) {
    const decision = validateApply(store, mapping)
    assert.equal(decision.proceed, false, `${name} must abort`)
  }

  // AND A CLEAN RUN PROCEEDS, or "aborts on everything" satisfies all four above and the
  // migration can never run at all.
  const clean = validateApply([base], [entryFor(base)])
  assert.equal(clean.proceed, true)
})

test('THE RUN CANNOT BE APPLIED WITHOUT BEING VALIDATED', () => {
  // "Abort before writing anything" is a property of the shape rather than a rule about call
  // order, because nothing but `validateApply` produces a ValidatedRun.
  // @ts-expect-error a hand-written run is not a ValidatedRun
  const forged = applyValidated([row()], { writes: [], alreadyApplied: [] }, 'r', 't')
  assert.ok(forged)
})

test('THE RECEIPT RECONSTRUCTS THE CHANGE WITHOUT THE DATABASE', () => {
  const before = [row({ id: 'n-1' }), row({ id: 'n-2', occurrenceCount: 5 })]
  const { after, receipt } = mustApply(before, before.map((r) => entryFor(r)))

  assert.equal(receipt.changed.length, 2)
  assert.equal(receipt.runId, 'run-1')
  for (const entry of receipt.changed) {
    assert.deepEqual(entry.previous, { incidentKey: null, episode: null })
    assert.equal(entry.written.incidentKey, 'hawkview-alert-incident/v1|admin-1')
  }

  // THE TEST OF INDEPENDENCE: rebuild the after-state from the before-state and the receipt
  // alone, touching nothing else. A receipt that says "see the table" is no use when the table
  // is the thing in doubt.
  const rebuilt = before.map((r) => {
    const entry = receipt.changed.find((c) => c.notificationId === r.id)
    return entry === undefined ? r : { ...r, incidentKey: entry.written.incidentKey, episode: entry.written.episode }
  })
  assert.deepEqual(rebuilt, after)
})

test('NEITHER APPLY NOR REVERT TOUCHES A FIELD A NOTIFIER WATCHES', () => {
  // The delivery route is indirect: a notifier watching occurrenceCount, resolvedAt or
  // lastOccurredAt turns a migration that touches one into 364 messages with nothing called.
  const before = [
    row({ id: 'n-1', occurrenceCount: 12, lastOccurredAt: '2026-07-02T00:00:00.000Z' }),
    row({ id: 'n-2', resolvedAt: '2026-07-03T00:00:00.000Z' }),
  ]
  const { after, receipt } = mustApply(before, before.map((r) => entryFor(r)))
  assert.deepEqual(watchedFieldsDisturbedBetween(before, after), [])

  // AND THE APPLY DID SOMETHING, or this holds for the migration that does nothing.
  assert.equal(after.filter((r) => r.incidentKey !== null).length, 2)

  // REVERT TOO, and it is free rather than argued: a revert cannot restore occurrenceCount
  // because the apply never changed it.
  const decision = validateRevert(after, receipt)
  assert.ok(decision.proceed)
  const reverted = revertValidated(after, receipt, decision.rows)
  assert.deepEqual(watchedFieldsDisturbedBetween(after, reverted), [])
  assert.deepEqual(reverted, before, 'and it lands exactly back on the before-state')
})

test('REVERT IS NEVER A BLANKET UPDATE, and refuses to overwrite later work', () => {
  const before = [row({ id: 'n-1' }), row({ id: 'n-2' }), row({ id: 'n-other' })]
  const mapping = [entryFor(before[0]!), entryFor(before[1]!), entryFor(before[2]!)]
  const { after, receipt } = mustApply(before, mapping)

  // A row somebody re-keyed after this run is not this run's to undo.
  const meddled = after.map((r) => (r.id === 'n-2' ? { ...r, incidentKey: 'somebody-elses-later-key' } : r))
  const refused = validateRevert(meddled, receipt)
  assert.equal(refused.proceed, false)
  assert.equal(refused.proceed === false ? refused.differences[0]?.notificationId : '', 'n-2')

  // WHOLESALE, matching apply: the untouched rows are not reverted either. Recommended rather
  // than assumed — see the runbook for the counter-argument that revert is the emergency path.
  assert.equal(meddled.find((r) => r.id === 'n-1')?.incidentKey, 'hawkview-alert-incident/v1|admin-1')

  // A ROW OUTSIDE THE RECEIPT IS NEVER TOUCHED, which is what "never a blanket update" means.
  const other = { ...after.find((r) => r.id === 'n-other')!, incidentKey: 'set-by-another-run' }
  const partialReceipt: ApplyReceipt = { ...receipt, changed: receipt.changed.filter((c) => c.notificationId !== 'n-other') }
  const store = after.map((r) => (r.id === 'n-other' ? other : r))
  const decision = validateRevert(store, partialReceipt)
  assert.ok(decision.proceed)
  const reverted = revertValidated(store, partialReceipt, decision.rows)
  assert.equal(reverted.find((r) => r.id === 'n-other')?.incidentKey, 'set-by-another-run',
    'a row this run did not change keeps its value')
})

test('A RE-RUN IS NOT A FIRST RUN, and the receipt says which', () => {
  const before = [row({ id: 'n-1' })]
  const mapping = [entryFor(before[0]!)]
  const first = mustApply(before, mapping)
  assert.equal(first.receipt.changed.length, 1)
  assert.deepEqual(first.receipt.untouched, [])

  const second = validateApply(first.after, mapping)
  assert.ok(second.proceed, 'an already-applied row is not a difference — it is a no-op')
  const receipt = applyValidated(first.after, second.run, 'run-2', 't').receipt
  assert.deepEqual(receipt.changed, [], 'nothing written the second time')
  assert.deepEqual(receipt.untouched, ['n-1'], 'and the row is accounted for rather than absent')
})

test('THE ABORT REPORT NAMES EVERY ROW, grouped, because a count is not actionable', () => {
  const base = row({ id: 'n-1', occurrenceCount: 3 })
  const decision = validateApply(
    [{ ...base, occurrenceCount: 9 }, row({ id: 'n-late' })],
    [entryFor(base), entryFor(row({ id: 'n-gone' }))])
  assert.equal(decision.proceed, false)

  const report = decision.proceed === false ? explain(decision.differences) : ''
  assert.match(report, /^ABORTED - 3 difference/)
  assert.match(report, /Nothing was written/)
  for (const id of ['n-1', 'n-late', 'n-gone']) {
    assert.ok(report.includes(id), `${id} must be named in the report`)
  }
  // The changed row shows both versions, so the operator knows WHAT moved.
  assert.match(report, /saw .+ {2}now /)

  assert.equal(explain([]), 'No differences. The mapping still describes the data.')
})

test('THE WATCHED-FIELD CHECK IS TESTED DIRECTLY, because no input can exercise it in place', () => {
  const before = [row({ id: 'n-1', occurrenceCount: 3 }), row({ id: 'n-2' })]
  assert.deepEqual(watchedFieldsDisturbedBetween(before, before), [])
  assert.deepEqual(
    watchedFieldsDisturbedBetween(before, before.map((r) => ({ ...r, incidentKey: 'k', episode: 1 }))),
    [], 'writing the two columns this migration owns is not a disturbance')

  for (const disturb of [
    (r: StoredRow) => ({ ...r, occurrenceCount: r.occurrenceCount + 1 }),
    (r: StoredRow) => ({ ...r, resolvedAt: '2026-09-01T00:00:00.000Z' }),
    (r: StoredRow) => ({ ...r, lastOccurredAt: '2026-09-01T00:00:00.000Z' }),
  ]) {
    const found = watchedFieldsDisturbedBetween(before, [disturb(before[0]!), before[1]!])
    assert.equal(found.length, 1)
    assert.match(found[0] ?? '', /^n-1: /)
  }
})

test('THE DIGEST SAYS WHAT WAS SEEN, and excludes what the mapping does not depend on', () => {
  const measured = row({ occurrenceCount: 3, dedupeKey: 'k' })
  assert.notEqual(digestOf(measured), digestOf({ ...measured, occurrenceCount: 4 }))
  assert.notEqual(digestOf(measured), digestOf({ ...measured, dedupeKey: 'k2' }))

  // A ROW RESOLVED SINCE THE DRY RUN STILL MAPS TO THE SAME INCIDENT. Under all-or-nothing,
  // including `resolvedAt` would not refuse one row — it would abort the entire migration on
  // ordinary churn. A decision, flagged in the runbook to be overruled there.
  const resolvedSince = row({ occurrenceCount: 3, dedupeKey: 'k', resolvedAt: '2026-07-09T00:00:00.000Z' })
  assert.equal(digestOf(resolvedSince), digestOf(measured))
  assert.equal(validateApply([resolvedSince], [entryFor(measured)]).proceed, true)

  // The length-prefixed join means a separator inside a key cannot forge a digest.
  assert.notEqual(digestOf({ dedupeKey: 'a', occurrenceCount: 11 }), digestOf({ dedupeKey: 'a1', occurrenceCount: 1 }))
})

test('REVERT TOUCHES ONLY THE ROWS IT WAS TOLD TO, even within one receipt', () => {
  // `revertValidated` takes the row list explicitly, and a mutation removing the check that
  // honours it survived — because the restore lookup already returns undefined for a row
  // outside the receipt, so the two guards overlap. They stop overlapping the moment a caller
  // passes a SUBSET, which is the case this pins: partial revert is a decision somebody makes,
  // not something that happens because a guard was redundant.
  const before = [row({ id: 'n-1' }), row({ id: 'n-2' })]
  const { after, receipt } = mustApply(before, before.map((r) => entryFor(r)))
  assert.equal(receipt.changed.length, 2)

  const onlyFirst = revertValidated(after, receipt, ['n-1'])
  assert.equal(onlyFirst.find((r) => r.id === 'n-1')?.incidentKey, null, 'the named row is reverted')
  assert.equal(onlyFirst.find((r) => r.id === 'n-2')?.incidentKey, 'hawkview-alert-incident/v1|admin-1',
    'and the one not named keeps what the run wrote')

  // The empty list reverts nothing, rather than meaning "all".
  assert.deepEqual(revertValidated(after, receipt, []), after)
})
