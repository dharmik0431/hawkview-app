import assert from 'node:assert/strict'
import test from 'node:test'
import { ALERT_CATALOG } from './alert-catalog.js'
import { alertTypeForRule } from './finding-pipeline.js'
import {
  alertPolicyCapability, alertPreferenceCapabilities, hasProvenAlertProducer,
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

test('proof, legacy observed input and edit permission are separate', () => {
  const none = typesWithProducerInput([])
  assert.deepEqual(alertPolicyCapability('security.suspected_credential_attack', none, true), {
    intakeWiring: 'MAPPED', producerSupport: 'PROVEN', observedInput: 'NO_OPEN_FINDING', editable: true, reason: 'READY',
  })
  assert.equal(settingDoesSomething('security.suspected_credential_attack', none), false)
  assert.equal(alertPolicyCapability('security.suspected_credential_attack', none, false).reason, 'OWNER_REQUIRED')
  const access = alertPolicyCapability('security.privileged_directory_change', typesWithProducerInput([FEEDS_ACCESS]), true)
  assert.deepEqual(access, {
    intakeWiring: 'MAPPED', producerSupport: 'NOT_ESTABLISHED', observedInput: 'OPEN_FINDING_PRESENT',
    editable: false, reason: 'PRODUCER_NOT_ESTABLISHED',
  })
  assert.equal(ALERT_CATALOG.filter(type => hasProvenAlertProducer(type.id)).length, 1)
  for (const type of ALERT_CATALOG.filter(type => !dispositionIsConsulted(type.id))) {
    assert.equal(alertPolicyCapability(type.id, none, true).reason, 'INTAKE_UNMAPPED')
  }
})

test('channel capabilities expose safe configuration availability, not secrets or delivery claims', () => {
  const org = '00000000-0000-4000-8000-000000000051'
  const owner = '00000000-0000-4000-8000-000000000052'
  const now = Date.parse('2026-09-16T12:10:00.000Z')
  const env = {
    HAWKVIEW_ALERT_EMAIL_MODE: 'controlled', HAWKVIEW_ALERT_EMAIL_ACTIVATION_ID: org,
    HAWKVIEW_ALERT_EMAIL_ORGANIZATION_ID: org, HAWKVIEW_ALERT_EMAIL_OWNER_USER_ID: owner,
    HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256: 'a'.repeat(64),
    HAWKVIEW_ALERT_EMAIL_STARTS_AT: '2026-09-16T12:00:00.000Z',
    HAWKVIEW_ALERT_EMAIL_EXPIRES_AT: '2026-09-16T13:00:00.000Z',
    HAWKVIEW_ALERT_EMAIL_FROM: 'alerts@example.test', FRONTEND_APP_URL: 'https://console.hawkviewapp.com',
    SUPABASE_URL: 'https://auth.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-not-a-real-service-key',
    RESEND_API_KEY: 're_synthetic_not_a_real_key', RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_c3ludGhldGlj',
  }
  assert.deepEqual(alertPreferenceCapabilities(org, owner, {}, now).channels.email,
    { supported: true, availability: 'DISABLED', reason: 'SENDER_OFF' })
  assert.equal(alertPreferenceCapabilities(org, owner, { HAWKVIEW_ALERT_EMAIL_MODE: 'controlled' }, now).channels.email.reason, 'CONFIGURATION_UNAVAILABLE')
  const controlled = alertPreferenceCapabilities(org, owner, env, now)
  assert.deepEqual(controlled.channels.email, { supported: true, availability: 'CONTROLLED', reason: 'CONTROLLED_TRIAL_ONLY' })
  assert.equal(alertPreferenceCapabilities(org, org, env, now).channels.email.reason, 'NOT_DESIGNATED_RECIPIENT')
  assert.equal(alertPreferenceCapabilities(owner, owner, env, now).channels.email.reason, 'NOT_DESIGNATED_RECIPIENT')
  assert.equal(alertPreferenceCapabilities(org, owner, env, now + 3_600_000).channels.email.reason, 'OUTSIDE_ACTIVATION_WINDOW')
  for (const value of [org, owner, env.RESEND_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.HAWKVIEW_ALERT_EMAIL_RECIPIENT_SHA256]) {
    assert.equal(JSON.stringify(controlled).includes(value), false)
  }
})
