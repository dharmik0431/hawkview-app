import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { alertTypeForRule } from './finding-pipeline.js'
import {
  dispositionIsConsulted,
  reachOfAlertTypes,
  settingDoesSomething,
  typesWithProducerInput,
} from './alert-type-reach.js'

/** Whether a setting does anything, derived rather than counted. The count has been got wrong by
 * hand once already, in a message that then built a ruling on top of it. */

test('TWO OF THE SEVEN TYPES HAVE A SETTING THAT DOES ANYTHING', () => {
  const reach = reachOfAlertTypes()
  assert.equal(reach.length, ALERT_CATALOG.length, 'every declared type is accounted for')

  const consulted = reach.filter((each) => each.kind === 'CONSULTED').map((each) => each.alertTypeId)
  assert.deepEqual([...consulted].sort(),
    ['security.privileged_directory_change', 'security.suspected_credential_attack'])

  // THE OTHER FIVE HAVE NO PRODUCER — nothing writes a notification carrying them, so a setting
  // cannot bite either way. That is honest on a settings page; a switch that silently does
  // nothing is not.
  assert.equal(reach.filter((each) => each.kind === 'NO_PRODUCER').length, 5)
})

test('IT IS DERIVED FROM THE MAPPING, so adding a producer moves it without anybody remembering', () => {
  // NOT A HARD-CODED PAIR. Every consulted type is one the guidance mapping actually reaches, and
  // every catalogue type appears exactly once — so a new mapping shows up here on its own.
  const reach = reachOfAlertTypes()
  const ids = reach.map((each) => each.alertTypeId)
  assert.deepEqual([...ids].sort(), ALERT_CATALOG.map((type) => type.id).sort())
  assert.equal(new Set(ids).size, ids.length, 'each type appears once')

  for (const each of reach) {
    assert.equal(dispositionIsConsulted(each.alertTypeId), each.kind === 'CONSULTED')
  }
})

test('A TYPE THE CATALOGUE DOES NOT DECLARE IS NOT CONSULTED', () => {
  // The settings page is built from the catalogue, so this is the degenerate input rather than a
  // realistic one — but answering `true` for an unknown id would put a working-looking switch on
  // a row that cannot exist.
  assert.equal(dispositionIsConsulted('security.invented_by_a_typo'), false)
  assert.equal(dispositionIsConsulted(''), false)

  // NOT VACUOUS: a real one is true, so the check is not refusing everything.
  assert.equal(dispositionIsConsulted('security.suspected_credential_attack'), true)
})

// ---------------------------------------------------------------------------------------
// WIRED IS NOT FED
// ---------------------------------------------------------------------------------------

/** Real ids, because an invented one proves only that invented ids behave. */
const FEEDS_ACTIVITY = 'HV-ID-AUTH-010.v1'   // REVIEW_ACTIVITY  -> suspected_credential_attack
const FEEDS_ACCESS = 'HV-ID-CHG-001.v1'      // REVIEW_ACCESS    -> privileged_directory_change
const FEEDS_NOTHING = 'HV-ID-CHG-005.v1'     // REVIEW_CONFIGURATION -> no alert type at all

test('A WIRED TYPE WITH NOTHING TO CARRY DOES NOT CLAIM THE SETTING WORKS', () => {
  // The defect this pair exists for. Both types are wired -- the pipeline reads their
  // disposition before delivering -- and an organisation with no findings hands it nothing.
  const none = typesWithProducerInput([])
  assert.equal(dispositionIsConsulted('security.suspected_credential_attack'), true,
    'still wired: the two halves must be able to disagree, or this proves nothing')
  assert.equal(settingDoesSomething('security.suspected_credential_attack', none), false)
  assert.equal(settingDoesSomething('security.privileged_directory_change', none), false)

  // AND IT FLIPS WHEN THE DATA ARRIVES, which is the point of deriving it.
  const fed = typesWithProducerInput([FEEDS_ACTIVITY])
  assert.equal(settingDoesSomething('security.suspected_credential_attack', fed), true)
  // Only the type that rule maps to. A finding does not vouch for its neighbours.
  assert.equal(settingDoesSomething('security.privileged_directory_change', fed), false)
})

test('IT IS DERIVED THROUGH THE SAME MAPPING THE PIPELINE STAMPS WITH', () => {
  // Not a second list: whatever alertTypeForRule says for a rule is what appears here, so a new
  // rule or a changed guidance code moves this without an edit.
  for (const ruleId of [FEEDS_ACTIVITY, FEEDS_ACCESS, FEEDS_NOTHING, 'HV-ID-INVENTED-999.v1']) {
    const expected = alertTypeForRule(ruleId)
    const fed = typesWithProducerInput([ruleId])
    assert.deepEqual([...fed], expected === null ? [] : [expected], ruleId)
  }

  // A REAL RULE THAT MAPS TO NO TYPE FEEDS NOTHING -- the control that keeps the line above from
  // passing by mapping everything to something.
  assert.equal(alertTypeForRule(FEEDS_NOTHING), null)
  assert.equal(typesWithProducerInput([FEEDS_NOTHING]).size, 0)
})

test('BEING FED DOES NOT MAKE AN UNWIRED TYPE CLAIM A WORKING SETTING', () => {
  // The AND has to hold in both directions. Force every catalogue type to look fed, and the five
  // with no producer must still say so -- otherwise the input check would have quietly replaced
  // the wiring check rather than joined it.
  const everything = new Set(ALERT_CATALOG.map((type) => type.id))
  const unwired = reachOfAlertTypes().filter((each) => each.kind === 'NO_PRODUCER')
  assert.ok(unwired.length > 0, 'the fixture needs at least one unwired type to be worth running')
  for (const each of unwired) {
    assert.equal(settingDoesSomething(each.alertTypeId, everything), false, each.alertTypeId)
  }
})
