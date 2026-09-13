import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alertTypeForRule, decide,
  type Dispositions, type ExistingIncident, type FindingRow, type Watermark,
} from './finding-pipeline.js'
import { ALERT_CATALOG } from './alert-catalog.js'
import { IDENTITY_RISK_RULE_CATALOG } from '../identity-risk/identity-risk.catalog.js'

/** The join. Everything before this was a library nobody called. */

const T0 = '2026-09-12T09:00:00.000Z'
const OLD = '2026-08-01T09:00:00.000Z'
const ORG = '11111111-1111-1111-1111-111111111111'
const TENANT = '22222222-2222-2222-2222-222222222222'

const WATERMARK: Watermark = {
  sendNothingObservedBeforeIso: '2026-09-12T00:00:00.000Z',
  because: 'the instant the pipeline was first switched on',
}

const finding = (over: Partial<FindingRow> = {}): FindingRow => ({
  id: 'f-1',
  organizationId: ORG,
  customerTenantId: TENANT,
  ruleId: 'HV-ID-AUTH-001.v1',
  dedupeKey: 'auth-001:user-1',
  subjectType: 'ACCOUNT',
  subjectId: 'user-1',
  severity: 'ACT_NOW',
  state: 'OPEN',
  observedAtIso: T0,
  ...over,
})

const canEmail: Dispositions = {
  byOrganizationAndRule: new Map(),
  anyRecipientByOrganization: new Map([[ORG, true]]),
}
const noRecipients: Dispositions = {
  byOrganizationAndRule: new Map(),
  anyRecipientByOrganization: new Map([[ORG, false]]),
}
const none: readonly ExistingIncident[] = []

test('A FINDING BECOMES AN INCIDENT AND A SEND JOB - the hop that did not exist', () => {
  const out = decide([finding()], none, canEmail, WATERMARK, T0)

  assert.equal(out.incidents.length, 1)
  assert.equal(out.incidents[0]?.alertTypeId, 'security.suspected_credential_attack')
  assert.equal(out.incidents[0]?.ownership, 'UNACKNOWLEDGED')
  assert.equal(out.incidents[0]?.condition, 'ACTIVE')
  assert.equal(out.incidents[0]?.investigation, 'OPEN')

  assert.equal(out.jobs.length, 1)
  assert.equal(out.jobs[0]?.incidentKey, out.incidents[0]?.incidentKey,
    'the job is for the incident, not for the finding')
  assert.deepEqual(out.accountingProblems, [])
})

test('NO HISTORICAL SENDS - the record is backfilled, the sending is not', () => {
  // THE SAME RULE THE MIGRATION FOLLOWS. Switching this on against a table with history in it
  // and no watermark sends the entire backlog at once, to a real MSP, about real incidents, all
  // of them stale — and there is no recalling an email.
  const out = decide([finding({ observedAtIso: OLD })], none, canEmail, WATERMARK, T0)

  assert.equal(out.jobs.length, 0, 'nothing is sent about last month')
  assert.equal(out.incidents.length, 1, 'but the incident is still recorded')
  assert.equal(out.skipped[0]?.because, 'BEFORE_WATERMARK')

  // THE DISTINCTION IS THE POINT: the same finding after the watermark does send.
  assert.equal(decide([finding()], none, canEmail, WATERMARK, T0).jobs.length, 1)
})

test('ONE MESSAGE PER INCIDENT, however many findings arrive on it', () => {
  // Two findings on the same subject are one incident and must be one email. The message id is
  // derived from the incident rather than the finding, so a second finding cannot produce a
  // second job even if the caller loops.
  const out = decide([finding({ id: 'f-1' }), finding({ id: 'f-2' })], none, canEmail, WATERMARK, T0)

  assert.equal(out.incidents.length, 1)
  assert.equal(out.jobs.length, 1)
  assert.equal(out.skipped.find((each) => each.findingId === 'f-2')?.because, 'INCIDENT_ALREADY_OPEN')
  assert.deepEqual(out.accountingProblems, [])
})

test('AN INCIDENT ALREADY OPEN DOES NOT RE-SEND on the next tick', () => {
  const first = decide([finding()], none, canEmail, WATERMARK, T0)
  const already: readonly ExistingIncident[] = [{
    organizationId: ORG,
    incidentKey: first.incidents[0]!.incidentKey,
  }]
  const second = decide([finding()], already, canEmail, WATERMARK, '2026-09-12T09:05:00.000Z')

  assert.equal(second.incidents.length, 0)
  assert.equal(second.jobs.length, 0, 'or every tick emails about the same incident')
  assert.equal(second.skipped[0]?.because, 'INCIDENT_ALREADY_OPEN')
})

test('AN ORGANISATION WITH NO ELIGIBLE RECIPIENT IS A REPORTED GAP, not a quiet nothing', () => {
  // Where the two grains meet. The organisation says this is urgent; nobody there can receive an
  // email. That is not "no email needed" — it is an incident nobody will be told about.
  const out = decide([finding()], none, noRecipients, WATERMARK, T0)

  assert.equal(out.jobs.length, 0)
  assert.equal(out.incidents.length, 1, 'the incident still exists to be seen in the product')
  assert.equal(out.skipped[0]?.because, 'NO_ELIGIBLE_RECIPIENT')
})

test('AN MSP PREFERENCE OVERRIDES THE CATALOGUE DEFAULT, and RECORD_ONLY sends nothing', () => {
  const recordOnly: Dispositions = {
    ...canEmail,
    byOrganizationAndRule: new Map([[`${ORG}|security.suspected_credential_attack`, 'RECORD_ONLY']]),
  }
  const out = decide([finding()], none, recordOnly, WATERMARK, T0)

  assert.equal(out.jobs.length, 0)
  assert.equal(out.skipped[0]?.because, 'RECORD_ONLY')
  assert.equal(out.incidents.length, 1, 'RECORD_ONLY is quiet, never absent — there is no OFF')

  // AND THE DEFAULT IS THE CATALOGUE'S, not this file's. An ACT_NOW type with no stored
  // preference still produces a job, so the override above is doing the work.
  assert.equal(decide([finding()], none, canEmail, WATERMARK, T0).jobs.length, 1)
})

test('A RULE NOTHING CAN TYPE PRODUCES NOTHING, AND IS NAMED', () => {
  // The third rule namespace. `IdentityRiskFinding.ruleId` maps to no alert type, and it was on
  // the backlog with the note that the failure would be silence the moment routing was driven by
  // findings. This is that moment, so the hole is a reported count.
  const out = decide([finding({ ruleId: 'HV-ID-MBX-001.v1' })], none, canEmail, WATERMARK, T0)

  assert.equal(out.incidents.length, 0, 'no incident, because it cannot be typed')
  assert.equal(out.jobs.length, 0)
  assert.equal(out.skipped[0]?.because, 'NO_ALERT_TYPE')
  assert.deepEqual(out.unmappedRules, ['HV-ID-MBX-001.v1'],
    'the rule id is what somebody has to go and add, so a count is not enough')

  // NOT A BLANKET REFUSAL: the mapped prefixes do work.
  assert.equal(alertTypeForRule('HV-ID-CHG-002.v1'), 'security.privileged_directory_change')
  assert.equal(alertTypeForRule('HV-ID-EXP-003.v1'), 'security.privileged_directory_change',
    'EXP is EXPOSURE, not expiring - an access rule, which the guidance code says and the letters do not')
  assert.equal(alertTypeForRule('HV-ID-APP-001.v1'), null, 'a declared rule whose kind has no type')
  assert.equal(alertTypeForRule('HV-ID-NOPE-999.v1'), null, 'and a rule the catalogue never declared')
})

test('A CLOSED FINDING IS NOT AN ALERT', () => {
  const out = decide([finding({ state: 'EXPIRED' })], none, canEmail, WATERMARK, T0)
  assert.equal(out.incidents.length, 0)
  assert.equal(out.jobs.length, 0)
  assert.equal(out.skipped[0]?.because, 'NOT_OPEN')
})

test('EVERY FINDING IS ACCOUNTED FOR EXACTLY ONCE', () => {
  // A finding that simply vanished is the silence this whole feature is about.
  const out = decide([
    finding({ id: 'a' }),
    finding({ id: 'b', subjectId: 'user-2' }),
    finding({ id: 'c', state: 'EXPIRED' }),
    finding({ id: 'd', ruleId: 'HV-ID-APP-001.v1' }),
    finding({ id: 'e', subjectId: 'user-3', observedAtIso: OLD }),
  ], none, canEmail, WATERMARK, T0)

  assert.deepEqual(out.accountingProblems, [])
  assert.equal(out.jobs.length + out.skipped.length, 5)
  assert.deepEqual(
    [...out.skipped.map((each) => each.findingId), ...out.jobs.map(() => 'a-or-b')].length, 5)
})

test('THE MAPPING IS DERIVED FROM THE CATALOGUE, so a new rule cannot fall through a gap', () => {
  // Two earlier versions matched on the rule id: the first on a namespace no row can have, the
  // second on three-letter families whose meaning it guessed. EXP is EXPOSURE, not expiring, and
  // that version was consistent, total over the real vocabulary, and wrong.
  //
  // This reads `investigationGuidanceCode`, which every rule declares exactly one of. The test
  // is that EVERY declared rule resolves through it — so adding a rule inherits its kind rather
  // than silently producing nothing.
  const declared = Object.keys(IDENTITY_RISK_RULE_CATALOG)
  assert.ok(declared.length >= 20, `expected the full catalogue, saw ${declared.length}`)

  const byKind = new Map<string, number>()
  for (const ruleId of declared) {
    const type = alertTypeForRule(ruleId)
    const kind = (IDENTITY_RISK_RULE_CATALOG as Record<string, { investigationGuidanceCode: string }>)
      [ruleId]!.investigationGuidanceCode
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    // Every rule gets an answer, and the answer is a catalogue id or an honest null. What must
    // not happen is a rule the function has no opinion about at all.
    assert.ok(type === null || ALERT_CATALOG.some((each) => each.id === type),
      `${ruleId} mapped to ${type}, which is not a catalogue type`)
  }

  // ALL FOUR KINDS ARE PRESENT IN THE DATA, so the two refusals are refusing something real
  // rather than describing an empty case.
  assert.deepEqual([...byKind.keys()].sort(),
    ['REVIEW_ACCESS', 'REVIEW_ACTIVITY', 'REVIEW_CONFIGURATION', 'REVIEW_MAILBOX_RULE'])

  // AND THE TWO REFUSALS ARE REFUSALS, not an empty map: some rules do get a type.
  const typed = declared.filter((ruleId) => alertTypeForRule(ruleId) !== null)
  assert.ok(typed.length > 0, 'nothing maps, so the mapping is not doing anything')
  assert.ok(typed.length < declared.length, 'everything maps, so the refusals are not refusing')
})
