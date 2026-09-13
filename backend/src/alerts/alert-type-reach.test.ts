import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { dispositionIsConsulted, reachOfAlertTypes } from './alert-type-reach.js'

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
