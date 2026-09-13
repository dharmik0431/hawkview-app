import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  NOTIFICATION_TIERS,
  readTier,
  showsSeverityInstead,
  shownDespiteMuting,
  type ReadTier,
} from './tier.ts'

test('every arm the API documents survives the read', () => {
  assert.deepEqual(readTier({ kind: 'TIER', tier: 'ACT_NOW' }), {
    kind: 'TIER',
    tier: 'ACT_NOW',
  })
  assert.deepEqual(readTier({ kind: 'NOT_AN_ALERT' }), { kind: 'NOT_AN_ALERT' })
  assert.deepEqual(
    readTier({ kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: 'security.typo' }),
    { kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: 'security.typo' }
  )

  // Swept over all three tiers rather than sampled. A mutation dropping one
  // from the accepted set would otherwise leave a legitimately recorded alert
  // rendering as "the API did not say".
  for (const tier of NOTIFICATION_TIERS) {
    assert.deepEqual(readTier({ kind: 'TIER', tier }), { kind: 'TIER', tier })
  }
})

test('"the API did not say" is not "this is not an alert"', () => {
  // THE ARM THE API DOES NOT HAVE, AND THE REASON THIS READER IS NOT A CAST.
  // All three of the API's arms are the API saying something. A response with
  // no tier field is the API saying nothing -- an older backend, a row this
  // build cannot read -- and collapsing it into NOT_AN_ALERT converts "we were
  // not told" into a claim about the row. That is the same merge the empty
  // inbox made.
  assert.deepEqual(readTier(undefined), { kind: 'NOT_STATED' })
  assert.deepEqual(readTier(null), { kind: 'NOT_STATED' })
  assert.notDeepEqual(readTier(undefined), readTier({ kind: 'NOT_AN_ALERT' }))

  // And the two must stay distinguishable as values, not merely as labels: a
  // later refactor that made both render the same thing would still fail here.
  const states: ReadTier[] = [
    readTier({ kind: 'TIER', tier: 'ACT_NOW' }),
    readTier({ kind: 'NOT_AN_ALERT' }),
    readTier({ kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: 'x' }),
    readTier(undefined),
  ]
  assert.equal(
    new Set(states.map((state) => state.kind)).size,
    4,
    'two tier states collapsed into one'
  )
})

test('a malformed tier is not coerced into the mildest one', () => {
  // A claimed TIER naming something this build does not have is plainly an
  // alert, so NOT_AN_ALERT would be false -- and RECORD_ONLY would be the
  // reassuring direction of the error, since it is the tier that means "do not
  // tell me". NOT_STATED is the only honest answer.
  const invented = readTier({ kind: 'TIER', tier: 'PAGE_THE_CEO' })
  assert.deepEqual(invented, { kind: 'NOT_STATED' })
  assert.notEqual(invented.kind, 'NOT_AN_ALERT')

  // UNKNOWN_ALERT_TYPE without the id it exists to carry says nothing useful.
  assert.deepEqual(readTier({ kind: 'UNKNOWN_ALERT_TYPE' }), {
    kind: 'NOT_STATED',
  })
  assert.deepEqual(readTier({ kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: '' }), {
    kind: 'NOT_STATED',
  })

  // Controls: the shapes that ARE well-formed must still be accepted, or the
  // rules above would be satisfied by a reader that refuses everything.
  assert.equal(readTier({ kind: 'TIER', tier: 'RECORD_ONLY' }).kind, 'TIER')
  assert.equal(
    readTier({ kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: 'a' }).kind,
    'UNKNOWN_ALERT_TYPE'
  )
})

test('exactly one vocabulary is shown per row', () => {
  // "Critical" and "Act now" on one row are the same fact under two names, and
  // a reader comparing the inbox with the settings page cannot tell whether
  // they are looking at one alert or two things. An alert row speaks the
  // catalogue's vocabulary; a collector row keeps its severity, which IS its
  // urgency because it has no tier.
  assert.equal(showsSeverityInstead({ kind: 'TIER', tier: 'ACT_NOW' }), false)
  assert.equal(showsSeverityInstead({ kind: 'NOT_AN_ALERT' }), true)
  assert.equal(showsSeverityInstead({ kind: 'NOT_STATED' }), true)
  assert.equal(
    showsSeverityInstead({ kind: 'UNKNOWN_ALERT_TYPE', alertTypeId: 'x' }),
    true
  )
})

test('the tier names are the catalogue\'s, checked against the catalogue', () => {
  // Derived from the other side of the boundary rather than from a list typed
  // here. A list written by hand would agree with the client by construction;
  // this fails if the catalogue's Severity union ever gains or loses a member.
  // CARRIAGE RETURNS STRIPPED FIRST. The working copy is CRLF, and the first
  // version of this searched for a bare two-newline terminator and found
  // nothing -- the POSITIVE CONTROL below is what caught it. Without that
  // control the test would have passed over an empty slice and reported the
  // two vocabularies as agreeing, which is the precise failure it exists to
  // rule out.
  const source = readFileSync(
    new URL('../../backend/src/alerts/alert-type.ts', import.meta.url),
    'utf8'
  ).split(String.fromCharCode(13)).join('')
  const OPEN = 'export type Severity ='
  const CLOSE = "\n\n"
  const from = source.indexOf(OPEN)
  const to = from === -1 ? -1 : source.indexOf(CLOSE, from)
  // POSITIVE CONTROL. If the declaration moved, the slice is empty and every
  // assertion below would pass over nothing.
  assert.ok(from !== -1 && to !== -1, 'could not find the Severity declaration')
  const declared = source.slice(from, to)

  for (const tier of NOTIFICATION_TIERS) {
    assert.ok(
      declared.includes("'" + tier + "'"),
      tier + ' is not a member of the backend Severity union'
    )
  }
  // And nothing the backend declares is missing here.
  const members = declared.match(/'[A-Z_]+'/g) ?? []
  assert.ok(members.length >= 2, 'parsed a suspiciously short union')
  assert.deepEqual(
    members.map((member) => member.replace(/'/g, '')).sort(),
    [...NOTIFICATION_TIERS].sort(),
    'the client tier list no longer matches the backend Severity union'
  )
})

test('the muting exemption follows severity, on every tier arm', () => {
  // THE DEFECT THIS LOCKS DOWN WAS INVISIBLE TO EVERY TEST THAT PASSED. The
  // note explaining why a row appears despite muted in-app notifications was
  // read off the severity copy table, and an alert row stopped consulting that
  // table the moment it started showing its tier -- so ACT_NOW rows silently
  // lost the explanation. They are exactly the rows somebody mutes and then
  // sees, and the note was still correct everywhere it did appear, so nothing
  // was wrong enough to fail. Only rendering the two beside each other showed
  // it.
  //
  // visibilityFilter matches on severity, so the rule is about severity alone.
  // THE TIER CANNOT ENTER INTO IT, and that is a type-level guarantee rather
  // than something to sweep: shownDespiteMuting does not take a tier. An
  // earlier version of this test looped over the four tier arms asserting the
  // same call four times, which proved nothing the signature had not already
  // settled.
  assert.equal(shownDespiteMuting('critical'), true)

  // The control. Every other severity, and absence, must NOT claim the
  // exemption -- otherwise the note would appear on rows a muted reader
  // genuinely will not see, which is the opposite lie.
  for (const severity of ['high', 'medium', 'low', 'info', undefined]) {
    assert.equal(
      shownDespiteMuting(severity),
      false,
      String(severity) + ' claimed the critical-only visibility exemption'
    )
  }
})
