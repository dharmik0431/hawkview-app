import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  applyStatement,
  applyValidated,
  revertStatement,
  digestOf,
  explain,
  revertValidated,
  validateApply,
  validateRevert,
  watchedFieldsDisturbedBetween,
  type ApplyReceipt,
  type Excluded,
  type ExclusionReason,
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
  decision: 'WRITE',
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
  assert.deepEqual(decision.refused, [])
  const undone = revertValidated(after, receipt, decision, '2026-09-12T11:00:00.000Z')
  assert.deepEqual(watchedFieldsDisturbedBetween(after, undone.after), [])
  assert.deepEqual(undone.after, before, 'and it lands exactly back on the before-state')
})

test('REVERT IS NEVER A BLANKET UPDATE, and refuses to overwrite later work', () => {
  const before = [row({ id: 'n-1' }), row({ id: 'n-2' }), row({ id: 'n-other' })]
  const mapping = [entryFor(before[0]!), entryFor(before[1]!), entryFor(before[2]!)]
  const { after, receipt } = mustApply(before, mapping)

  // A row somebody re-keyed after this run is not this run's to undo.
  const meddled = after.map((r) => (r.id === 'n-2' ? { ...r, incidentKey: 'somebody-elses-later-key' } : r))
  const decision = validateRevert(meddled, receipt)
  assert.equal(decision.refused.length, 1)
  assert.equal(decision.refused[0]?.notificationId, 'n-2')

  // PER ROW, NOT WHOLESALE — the opposite of apply, and the asymmetry is the reason. A partial
  // apply is dangerous for being SILENT; a partial revert is described by the receipt and this
  // report. And a refused row is not half-done work: somebody else owns it now, so leaving it
  // is correct rather than incomplete. Refusing the rest would block a recovery action during
  // an incident, which is when reverts happen.
  const undone = revertValidated(meddled, receipt, decision, 't')
  assert.equal(undone.after.find((r) => r.id === 'n-1')?.incidentKey, null, 'the others go back')
  assert.equal(undone.after.find((r) => r.id === 'n-2')?.incidentKey, 'somebody-elses-later-key',
    'and the row somebody else changed is left exactly as they left it')

  // THE REPORT IS WHAT MAKES PER-ROW SAFE: reverted plus refused accounts for the whole
  // receipt, so the mixed state is described rather than inferred.
  assert.equal(undone.receipt.reverted.length + undone.receipt.refused.length, receipt.changed.length)
  assert.deepEqual(undone.receipt.refused, decision.refused)

  // A ROW OUTSIDE THE RECEIPT IS NEVER TOUCHED, which is what "never a blanket update" means.
  const other = { ...after.find((r) => r.id === 'n-other')!, incidentKey: 'set-by-another-run' }
  const partialReceipt: ApplyReceipt = { ...receipt, changed: receipt.changed.filter((c) => c.notificationId !== 'n-other') }
  const store = after.map((r) => (r.id === 'n-other' ? other : r))
  const otherDecision = validateRevert(store, partialReceipt)
  const reverted = revertValidated(store, partialReceipt, otherDecision, 't').after
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

  const onlyFirst = revertValidated(after, receipt, { rows: ['n-1'], refused: [] }, 't').after
  assert.equal(onlyFirst.find((r) => r.id === 'n-1')?.incidentKey, null, 'the named row is reverted')
  assert.equal(onlyFirst.find((r) => r.id === 'n-2')?.incidentKey, 'hawkview-alert-incident/v1|admin-1',
    'and the one not named keeps what the run wrote')

  // The empty list reverts nothing, rather than meaning "all".
  assert.deepEqual(revertValidated(after, receipt, { rows: [], refused: [] }, 't').after, after)
})

test('B8 — REVERT MUST NOT REUSE APPLY\'S CHECK, or it is un-runnable within five minutes', () => {
  // The trap, and I had fallen into it before this test existed: `validateRevert` called
  // `digestOf`, which is apply's check. Apply checks every mapping input; REVERT CHECKS
  // `incidentKey` AND `episode` ONLY.
  //
  // Occurrences arrive between apply and revert — that is the system working. A row reading
  // 301 at apply time reads 305 an hour later, and apply's digest covers `occurrenceCount`, so
  // reusing it refuses every row the moment any new event arrives. REUSING THE CHECK LOOKS
  // LIKE CONSISTENCY, which is why it is a trap rather than an oversight.
  const before = [row({ id: 'n-1', occurrenceCount: 301 })]
  const { after, receipt } = mustApply(before, [entryFor(before[0]!)])

  // Four real events arrive after the apply. Nothing about the incident key has changed.
  const busy = after.map((r) => ({ ...r, occurrenceCount: 305 }))
  const decision = validateRevert(busy, receipt)

  assert.deepEqual(decision.refused, [],
    'new occurrences are normal and must not make the revert refuse')
  assert.deepEqual(decision.rows, ['n-1'])

  // AND THE REVERT MUST NOT ROLL THE COUNT BACK. Restoring the row as the receipt found it
  // would write 301 over 305 — four real events gone — and `occurrenceCount` is a watched
  // field, so the same write can deliver. "Restore the prior state" is not "restore the prior
  // row", and the receipt makes that easier to get wrong because the old values sit in it
  // looking authoritative.
  const undone = revertValidated(busy, receipt, decision, 't')
  assert.equal(undone.after[0]?.occurrenceCount, 305, 'the four events survive the revert')
  assert.equal(undone.after[0]?.incidentKey, null, 'and the annotation is undone')
  assert.deepEqual(watchedFieldsDisturbedBetween(busy, undone.after), [])

  // THE CONTROL, or "never refuses" passes this too: a genuinely re-keyed row IS refused.
  const reKeyed = busy.map((r) => ({ ...r, incidentKey: 'somebody-elses-key' }))
  assert.equal(validateRevert(reKeyed, receipt).refused.length, 1)
})

test('THE APPLY IS ONE STATEMENT, whatever the row count', () => {
  // Measured at 364 rows: a per-row UPDATE is 395ms on loopback and 5,623ms with a 14.5ms round
  // trip; one statement is 12ms either way. THE DRIVER IS ROUND TRIPS x LATENCY, NOT ROWS — per
  // row, 364 to 5,000 rows is 395ms to 1,034ms, under 3x for 14x the rows.
  //
  // Production is Supabase in ca-central-1 with the backend on Render — a real network hop
  // nobody has measured. That is the argument for the shape that does not depend on the number.
  const statementsFor = (n: number) => {
    const store = Array.from({ length: n }, (_, i) => row({ id: `n-${i}`, occurrenceCount: i + 1 }))
    const decision = validateApply(store, store.map((r) => entryFor(r)))
    assert.ok(decision.proceed)
    return applyStatement(decision.run)
  }

  for (const n of [1, 10, 364, 5000]) {
    const statement = statementsFor(n)
    assert.equal(statement.sql.split(';').filter((part) => part.trim() !== '').length, 1,
      `${n} rows must still be ONE statement`)
    assert.equal(statement.expectedRowCount, n)
    // The parameters grow; the round trips do not. That is the whole property.
    assert.equal(statement.params.length, n * 5)
  }

  // A LOOP WOULD PASS "the SQL is one statement" TRIVIALLY, so the count that matters is what a
  // runner would execute: one, for any n.
  assert.equal(statementsFor(364).sql, statementsFor(364).sql, 'deterministic for a given input')
})

test('THE VERSION CHECK IS IN THE STATEMENT, not read in the application first', () => {
  // If the runner reads the version in TypeScript and then writes, it is not the conditional
  // write — it is the naive control, which let BOTH writers through in all 25 of QA's rounds.
  // Not "we checked", but "there was no gap in which to be wrong".
  const store = [row({ id: 'n-1', dedupeKey: 'k-1', occurrenceCount: 7 })]
  const decision = validateApply(store, [entryFor(store[0]!)])
  assert.ok(decision.proceed)
  const statement = applyStatement(decision.run)

  // Both halves of apply's scope are predicates in the statement itself.
  assert.match(statement.sql, /n\.dedupe_key = v\.expected_dedupe_key/)
  assert.match(statement.sql, /n\.occurrence_count = v\.expected_occurrence_count/)
  // And a row somebody else keyed is declined by the database, not by application logic.
  assert.match(statement.sql, /n\.incident_key IS NULL/)

  // The expected values travel as parameters, so nothing is interpolated into SQL text.
  assert.ok(statement.params.includes('k-1'))
  assert.ok(statement.params.includes(7))
  assert.doesNotMatch(statement.sql, /k-1/, 'values are parameters, never inlined')
})

test('B8 AT THE SQL LEVEL — the revert statement has no occurrence_count predicate', () => {
  // The two checks have different scopes, and here it is visible as the absence of a clause.
  // A revert predicate over occurrence_count would refuse every row within five minutes of any
  // new event, because occurrences arriving in between are the system working.
  const before = [row({ id: 'n-1', occurrenceCount: 301 })]
  const { after, receipt } = mustApply(before, [entryFor(before[0]!)])
  const busy = after.map((r) => ({ ...r, occurrenceCount: 305 }))
  const decision = validateRevert(busy, receipt)
  const statement = revertStatement(receipt, decision)

  assert.doesNotMatch(statement.sql, /occurrence_count/,
    'the revert must not predicate on a field that legitimately moves between apply and revert')
  assert.doesNotMatch(statement.sql, /dedupe_key/)
  // What it DOES check: the values this run wrote.
  assert.match(statement.sql, /n\.incident_key = v\.written_incident_key/)
  assert.match(statement.sql, /n\.episode IS NOT DISTINCT FROM v\.written_episode/,
    'null-safe, because episode is null for the 47 unrecoverable rows')

  // AND THE CONTRAST IS THE POINT: apply's statement does carry that predicate.
  const applyDecision = validateApply(before, [entryFor(before[0]!)])
  assert.ok(applyDecision.proceed)
  assert.match(applyStatement(applyDecision.run).sql, /occurrence_count/)

  assert.equal(statement.expectedRowCount, 1, 'the busy row is still revertable')
})

test('THE REVERT STATEMENT CARRIES ONLY THE APPROVED ROWS', () => {
  const before = [row({ id: 'n-1' }), row({ id: 'n-2' })]
  const { after, receipt } = mustApply(before, before.map((r) => entryFor(r)))
  const meddled = after.map((r) => (r.id === 'n-2' ? { ...r, incidentKey: 'somebody-else' } : r))
  const decision = validateRevert(meddled, receipt)

  assert.equal(decision.refused.length, 1)
  const statement = revertStatement(receipt, decision)
  assert.equal(statement.expectedRowCount, 1, 'only the row still ours to undo')
  assert.ok(statement.params.includes('n-1'))
  assert.ok(!statement.params.includes('n-2'), 'the refused row is not in the statement at all')
})

test('THE RUNNER CARRIES NO PRODUCTION FIGURE, and this is why that is checked here', () => {
  // PM's criterion, made checkable rather than advisory: "a runner that prints plausible
  // numbers is the failure this document exists to prevent, so the script should READ the
  // figures rather than carry them — if any of those five is a constant anywhere in it, that
  // is the defect."
  //
  // A grep run once is not a property. This is the same move as the one-statement assertion
  // above: the constraint is on a file nobody can execute here, so the only way to hold it is
  // to read the file.
  const source = readFileSync(new URL('../../scripts/alerting-apply.mts', import.meta.url), 'utf8')

  // COMMENTS ARE STRIPPED, DELIBERATELY. The figures belong in prose explaining what a number
  // means — "47 rows are entitled to null and 317 are not" is exactly the sentence a reader
  // needs. What must not exist is one in a position that can reach a comparison or an output.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

  for (const figure of ['364', '317', '71', '62', '47']) {
    assert.doesNotMatch(code, new RegExp(`\\b${figure}\\b`),
      `${figure} is a production figure and appears in executable position. The runner must `
      + 'read every number it prints.')
  }

  // AND THE POSITIVE CONTROL, or the test above is satisfied by an empty file. The figures
  // ARE present in the comments, so the stripping is doing something rather than the source
  // happening to contain no digits.
  assert.match(source, /\b364\b/)
  assert.match(source, /\b317\b/)

  // THE SHAPE THAT WOULD REINTRODUCE IT is a comparison against an expected count, so the
  // words are pinned too. `save-mapping` prints what it read and tells the operator to compare;
  // it must not do the comparing, because a runner that knows the answer can agree with itself.
  assert.doesNotMatch(code, /expected(Rows|Total|Mapping|Figures)/i)
})

/** RULING (b): key only the rows whose shape determines a type — 47 of 364 today, 317 when the
 * classifier reaches historical audit rows. These tests are about the consequence nobody had
 * looked at, which is that most rows in the table are now UNWRITABLE ON PURPOSE. */

const excludeFor = (r: StoredRow, because: ExclusionReason = 'TYPE_UNDETERMINED'): Excluded =>
  ({ decision: 'EXCLUDE', notificationId: r.id, because })

/** The production shape in miniature: one writable row among many that are not. */
const manyRows = (n: number): StoredRow[] =>
  Array.from({ length: n }, (_, i) => row({ id: `n-${i}`, dedupeKey: `security:directory-audit:Directory_${i}` }))

test('AN UNWRITABLE ROW IS A DECISION, NOT A REFUSAL - and without saying so the run is impossible', () => {
  // THE FAILURE THIS EXISTS FOR, exhibited first. With the mapping being only a list of writes,
  // the scope of the run was INFERRED as "everything in the table" — so every row left out on
  // purpose arrived at the final loop as ROW_UNEXPECTED.
  const store = manyRows(20)
  const onlyTheWrites = [entryFor(store[0]!)]

  const inferred = validateApply(store, onlyTheWrites)
  assert.equal(inferred.proceed, false)
  assert.equal(inferred.proceed === false ? inferred.differences.length : 0, 19,
    'nineteen deliberate exclusions read as nineteen surprises')
  assert.ok(inferred.proceed === false
    && inferred.differences.every((difference) => difference.kind === 'ROW_UNEXPECTED'))
  // AT PRODUCTION SCALE THAT IS 317 DIFFERENCES ON A CLEAN TABLE. The preflight would abort
  // every time, by construction, and the apply could never run. Not a reporting nicety.

  // WITH THE SCOPE STATED, the same data proceeds and the split is carried on the run.
  const stated = validateApply(store, [entryFor(store[0]!), ...store.slice(1).map((r) => excludeFor(r))])
  assert.ok(stated.proceed)
  assert.equal(stated.run.writes.length, 1)
  assert.equal(stated.run.excluded.length, 19)
  assert.deepEqual([...new Set(stated.run.excluded.map((entry) => entry.because))], ['TYPE_UNDETERMINED'])
})

test('A ROW THE MAPPING NEVER SAW STILL ABORTS - the original property, unchanged', () => {
  // The point of the change was to distinguish a decision from a surprise, NOT to stop caring
  // about surprises. An alert that arrived after the mapping was saved was never measured, so
  // no digest speaks for it, and applying around it leaves two keying schemes with nothing
  // saying so.
  const store = manyRows(3)
  const late = row({ id: 'n-late' })
  const mapping = [entryFor(store[0]!), excludeFor(store[1]!), excludeFor(store[2]!)]

  const clean = validateApply(store, mapping)
  assert.ok(clean.proceed, 'the control: this mapping is complete over this store')

  const withLate = validateApply([...store, late], mapping)
  assert.equal(withLate.proceed, false)
  assert.deepEqual(withLate.proceed === false ? withLate.differences : [],
    [{ kind: 'ROW_UNEXPECTED', notificationId: 'n-late' }])
})

test('A ROW WE SAID NOT TO TOUCH THAT IS KEYED ANYWAY IS AN ABORT', () => {
  // An exclusion is a decision about what WE write. It is never a promise about what the row
  // holds — and a row carrying somebody else's incident key is the two-keying-schemes state the
  // all-or-nothing rule exists to make unreachable, arriving through the rows we left alone.
  const mine = row({ id: 'n-1' })
  const theirs = row({ id: 'n-2', incidentKey: 'somebody-elses-key', episode: 3 })
  const decision = validateApply([mine, theirs], [entryFor(mine), excludeFor(theirs)])

  assert.equal(decision.proceed, false)
  const differences = decision.proceed === false ? decision.differences : []
  assert.equal(differences[0]?.kind, 'EXCLUDED_BUT_KEYED')
  assert.match(explain(differences), /n-2 {2}holds somebody-elses-key\/3 {2}mapping says leave it alone/)

  // AND IT IS NOT SATISFIED BY FLAGGING EVERY EXCLUSION: an excluded row with a null key is fine.
  assert.equal(validateApply([mine, row({ id: 'n-2' })], [entryFor(mine), excludeFor(row({ id: 'n-2' }))]).proceed, true)
})

test('A ROW DECIDED ABOUT TWICE IS AN ABORT, whichever two decisions they are', () => {
  // The one way left to get a mapping wrong now that a row has exactly one decision or none.
  const only = row({ id: 'n-1' })

  const twiceWritten = validateApply([only], [entryFor(only), entryFor(only)])
  assert.equal(twiceWritten.proceed, false)
  assert.deepEqual(twiceWritten.proceed === false ? twiceWritten.differences : [],
    [{ kind: 'MAPPED_TWICE', notificationId: 'n-1' }])

  // BOTH WAYS, because "write then exclude" is the contradiction that reads as harmless.
  const contradicted = validateApply([only], [entryFor(only), excludeFor(only)])
  assert.equal(contradicted.proceed, false)
  assert.deepEqual(contradicted.proceed === false ? contradicted.differences : [],
    [{ kind: 'MAPPED_TWICE', notificationId: 'n-1' }])
})

test('AN EXCLUDED ROW IS NEVER IN THE STATEMENT - not as a parameter, not as a row', () => {
  // The whole point, checked at the SQL rather than at the decision: the migration must not
  // touch a row it said it would leave alone, and the statement is where that becomes true.
  const store = manyRows(5)
  const decision = validateApply(store,
    [entryFor(store[0]!), ...store.slice(1).map((r) => excludeFor(r))])
  assert.ok(decision.proceed)
  const statement = applyStatement(decision.run)

  assert.equal(statement.expectedRowCount, 1)
  assert.ok(statement.params.includes('n-0'))
  for (const excludedRow of store.slice(1)) {
    assert.ok(!statement.params.includes(excludedRow.id), `${excludedRow.id} must not be a parameter`)
  }
})

test('THE TWO EXCLUSION REASONS ARE CARRIED SEPARATELY, because they clear at different times', () => {
  // TYPE_UNDETERMINED waits on the classifier reaching historical audit rows — a scoped piece of
  // work. SUBJECT_UNRESOLVED waits on the row's own subject becoming resolvable, which may never
  // happen. Collapsing them into one count would make the second look like it is coming soon.
  const store = manyRows(3)
  const decision = validateApply(store, [
    entryFor(store[0]!),
    excludeFor(store[1]!, 'TYPE_UNDETERMINED'),
    excludeFor(store[2]!, 'SUBJECT_UNRESOLVED'),
  ])
  assert.ok(decision.proceed)
  assert.deepEqual(decision.run.excluded.map((entry) => entry.because).sort(),
    ['SUBJECT_UNRESOLVED', 'TYPE_UNDETERMINED'])
})
