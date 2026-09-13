import assert from 'node:assert/strict'
import test from 'node:test'
import { emptinessCopy, type AlertDispositionRow } from './dispositions.ts'
import {
  emptinessOf,
  readDispositionRow,
  readDispositions,
} from './read-dispositions.ts'

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  alertTypeId: 'security.suspected_credential_attack',
  title: 'Suspected credential attack',
  category: 'Security',
  catalogueSeverity: 'ACT_NOW',
  disposition: 'ACT_NOW',
  mapped: true,
  ...over,
})

test('a read that succeeded and a read that failed are different empty states', () => {
  // The whole point of the module. Both produce zero rows to render, and only
  // one of them is a fact about the organisation.
  const empty = readDispositions({ items: [] })
  const broken = readDispositions({ unexpected: 'shape' })

  assert.deepEqual(emptinessOf(empty), { kind: 'NOTHING_MATCHED' })
  assert.deepEqual(emptinessOf(broken), { kind: 'NEVER_OBSERVED' })
  assert.notEqual(emptinessOf(empty).kind, emptinessOf(broken).kind)

  // And they reach the reader as different sentences, not just different tags.
  const matched = emptinessCopy(emptinessOf(empty))!
  const never = emptinessCopy(emptinessOf(broken))!
  assert.notEqual(matched.title, never.title)
  assert.ok(
    !/empty result/.test(never.detail),
    'a response this build could not read was described as an empty result'
  )
})

test('a response whose every row was discarded is NOT an empty organisation', () => {
  // The case that gets missed: 200, a body, a list -- and nothing in it
  // readable. Counting the survivors gives zero, which is the same number an
  // empty organisation gives, and the page would then say "HawkView asked and
  // the catalogue returned nothing" about a contract it could not parse.
  const unreadable = readDispositions({
    items: [
      { alertTypeId: 'a', title: 'A', category: 'Security' },
      { alertTypeId: 'b', title: 'B', category: 'Security' },
    ],
  })
  assert.equal(unreadable.outcome, 'UNREADABLE')
  assert.deepEqual(emptinessOf(unreadable), { kind: 'NEVER_OBSERVED' })

  // The control: a genuinely empty list is still allowed to say so. Without
  // this half, the rule above could be satisfied by never returning
  // NOTHING_MATCHED at all -- which would be a guard that fires always and
  // therefore discriminates nothing.
  const genuinely = readDispositions({ items: [] })
  assert.equal(genuinely.outcome, 'LOADED')
  assert.deepEqual(emptinessOf(genuinely), { kind: 'NOTHING_MATCHED' })
})

test('a partly readable response keeps its rows and reports the shortfall', () => {
  // Not UNREADABLE -- something survived, and hiding four good rows because a
  // fifth was malformed would be worse. But the count is carried out, because a
  // list quietly one row short is a list an MSP will trust completely and the
  // missing row is the alert type nobody has configured.
  const partial = readDispositions({
    items: [row(), row({ alertTypeId: 'b', disposition: 'PAGE_THE_CEO' })],
  })
  assert.equal(partial.outcome, 'LOADED')
  assert.equal(partial.outcome === 'LOADED' && partial.rows.length, 1)
  assert.equal(partial.outcome === 'LOADED' && partial.discarded, 1)
  assert.deepEqual(emptinessOf(partial), { kind: 'HAS_ITEMS' })
})

test('a row that cannot say what the setting is, is not rendered as a setting', () => {
  // Swept over every required field rather than sampled, so removing any one of
  // them from the guard fails here. An earlier guard in this codebase checked
  // one field of several and the others were free to go missing.
  const required = [
    'alertTypeId',
    'title',
    'category',
    'catalogueSeverity',
    'disposition',
    'mapped',
  ] as const
  for (const field of required) {
    const missing: Record<string, unknown> = row()
    delete missing[field]
    assert.equal(
      readDispositionRow(missing),
      null,
      'a row with no ' + field + ' was accepted as a setting'
    )
  }

  // The control. The same row with nothing removed must be accepted, or the
  // sweep above would pass for a reader that rejects everything.
  const whole = readDispositionRow(row())
  assert.ok(whole, 'the reader rejected a complete row')
  assert.equal(whole!.disposition, 'ACT_NOW')
  assert.equal(whole!.mapped, true)
})

test('mapped is read, not defaulted, and false survives', () => {
  // `false` is the load-bearing value and the one a default would erase.
  // Defaulting to true promises that something feeds this alert type, which is
  // exactly the assurance somebody relies on when they set it -- and only two
  // of the catalogue's seven types are reachable from a live detector today,
  // so false is the common case rather than the edge one.
  const unmapped = readDispositionRow(row({ mapped: false }))
  assert.equal(unmapped?.mapped, false)

  // Not merely falsy-tolerant: a non-boolean is refused rather than coerced.
  assert.equal(readDispositionRow(row({ mapped: 'false' })), null)
  assert.equal(readDispositionRow(row({ mapped: 0 })), null)
})

test('an override that departs from the catalogue is preserved as a departure', () => {
  // Both values are carried so the page can show one BESIDE the other. Reading
  // only `disposition` would make an organisation that has chosen ACT_TODAY for
  // an ACT_NOW type indistinguishable from one that has chosen nothing.
  const departed = readDispositionRow(
    row({ catalogueSeverity: 'ACT_NOW', disposition: 'RECORD_ONLY' })
  ) as AlertDispositionRow
  assert.equal(departed.catalogueSeverity, 'ACT_NOW')
  assert.equal(departed.disposition, 'RECORD_ONLY')
  assert.notEqual(departed.catalogueSeverity, departed.disposition)
})

test('a bare array is read, and a null body is not', () => {
  assert.equal(readDispositions([row()]).outcome, 'LOADED')
  assert.equal(readDispositions(null).outcome, 'UNREADABLE')
  assert.equal(readDispositions(undefined).outcome, 'UNREADABLE')
  assert.equal(readDispositions('[]').outcome, 'UNREADABLE')
  // An empty bare array is a real empty result, same as { items: [] }.
  assert.deepEqual(emptinessOf(readDispositions([])), { kind: 'NOTHING_MATCHED' })
})

test('the shape the real endpoint actually sends is read', () => {
  // THE GUESS THAT WAS WRONG. This reader accepted a bare array or `{ items }`,
  // both invented before the endpoint existed. AlertsController returns
  // `{ organizationId, dispositions }`, so every live response would have been
  // UNREADABLE and the page would have said "no request has succeeded" over a
  // perfectly good answer -- the failure mode this module exists to prevent,
  // arriving from the reader's own assumption about the envelope.
  const real = {
    organizationId: 'org-1',
    dispositions: [row(), row({ alertTypeId: 'monitoring.recovered', mapped: false })],
  }
  const read = readDispositions(real)
  assert.equal(read.outcome, 'LOADED')
  assert.equal(read.outcome === 'LOADED' && read.rows.length, 2)
  assert.deepEqual(emptinessOf(read), { kind: 'HAS_ITEMS' })

  // An organisation with no catalogue types is still an empty RESULT, not a
  // failed read -- the envelope arrived and it said nothing is configured.
  assert.deepEqual(
    emptinessOf(readDispositions({ organizationId: 'org-1', dispositions: [] })),
    { kind: 'NOTHING_MATCHED' }
  )

  // And the envelope without the array is still unreadable, or the fix above
  // would have been "accept anything with an organizationId".
  assert.equal(readDispositions({ organizationId: 'org-1' }).outcome, 'UNREADABLE')
})

test('a stored value the backend could not read reaches the row', () => {
  // The endpoint reports it deliberately: `disposition` says what will actually
  // happen and that is true, but on its own the row looks like nobody chose.
  // Somebody chose, and is being ignored. Dropping the field here would have
  // re-hidden exactly what the endpoint went out of its way to surface.
  const ignored = readDispositionRow(row({ storedValueIgnored: 'RING' }))
  assert.equal(ignored?.storedValueIgnored, 'RING')

  // Absent when there is none -- an absent key rather than a key holding
  // undefined, so a reader cannot mistake "no stored value" for "empty string".
  assert.equal('storedValueIgnored' in (readDispositionRow(row()) as object), false)

  // A non-string is not carried: the field exists to quote what was stored, and
  // quoting `[object Object]` at somebody is worse than saying nothing.
  assert.equal(
    'storedValueIgnored' in (readDispositionRow(row({ storedValueIgnored: 42 })) as object),
    false
  )
})

test('a saved setting with no row to appear on is carried, not dropped', () => {
  // THE SECOND FIELD OF THIS KIND I WOULD HAVE DISCARDED BY READING ONLY WHAT I
  // EXPECTED. `list()` walks the catalogue, so a stored row keyed to an id the
  // catalogue no longer declares is invisible in the rows -- seven come back and
  // none mentions it. The endpoint lists them at the envelope for that reason.
  // Dropping them here puts the page back where it was before
  // `storedValueIgnored`: a setting somebody made, doing nothing, with nothing
  // on screen saying so.
  const read = readDispositions({
    organizationId: 'org-1',
    dispositions: [row()],
    unrecognisedKeys: ['security.renamed_last_year', 'monitoring.typo'],
  })
  assert.equal(read.outcome, 'LOADED')
  assert.deepEqual(
    read.outcome === 'LOADED' ? read.unrecognisedKeys : null,
    ['security.renamed_last_year', 'monitoring.typo']
  )

  // Absent is an empty list, not undefined -- every caller renders a count.
  const without = readDispositions({ organizationId: 'org-1', dispositions: [row()] })
  assert.deepEqual(without.outcome === 'LOADED' ? without.unrecognisedKeys : null, [])

  // NOT FOLDED INTO `discarded`. A discarded row is one this build could not
  // parse; an unrecognised key is one the CATALOGUE does not have. Different
  // causes, different remedies, and a reader given one number cannot tell which.
  assert.equal(read.outcome === 'LOADED' && read.discarded, 0)

  // Junk in the list is dropped rather than rendered as an empty name.
  const messy = readDispositions({
    organizationId: 'org-1',
    dispositions: [row()],
    unrecognisedKeys: ['real.id', '', '   ', 42, null],
  })
  assert.deepEqual(
    messy.outcome === 'LOADED' ? messy.unrecognisedKeys : null,
    ['real.id']
  )
})
