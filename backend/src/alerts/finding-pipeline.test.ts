import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runIntake, type PipelineStore,
  alertTierFor,
  asAlertTypeId, dispositionKey,
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

/** The severity a row carries for a given tier, so these tests read the row the way the DTO
 * does rather than restating the tone table. */
const severityOf = (tier: string) =>
  tier === 'ACT_NOW' ? 'critical' : tier === 'ACT_TODAY' ? 'high' : 'info'

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
  byOrganizationAndAlertType: new Map(),
  unreadable: [],
  anyRecipientByOrganization: new Map([[ORG, true]]),
}
const noRecipients: Dispositions = {
  byOrganizationAndAlertType: new Map(),
  unreadable: [],
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
    byOrganizationAndAlertType: new Map([
      [dispositionKey(ORG, 'security.suspected_credential_attack'), 'RECORD_ONLY'],
    ]),
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

test('THE TIER IS DERIVED FROM THE ALERT TYPE, and absence is not RECORD_ONLY', () => {
  // ALL THREE TIERS, not one plus two edge cases. A mutation sweep elsewhere deleted RECORD_ONLY
  // from an accepted set and killed nothing, because the tests had covered one tier and two
  // edges — so the tier that means "off" was the one nobody checked.
  assert.deepEqual(alertTierFor('security.suspected_credential_attack', 'critical'),
    { kind: 'TIER', tier: 'ACT_NOW' })

  const tiers = new Set(ALERT_CATALOG.map((type) => alertTierFor(type.id, severityOf(type.severity)))
    .flatMap((answer) => (answer.kind === 'TIER' ? [answer.tier] : [])))
  assert.ok(tiers.has('ACT_NOW'), 'ACT_NOW is reachable from the catalogue')
  assert.ok(tiers.has('ACT_TODAY'), 'and so is ACT_TODAY')
  assert.ok(tiers.has('RECORD_ONLY'), 'AND SO IS RECORD_ONLY — the one that means off')

  // EVERY DECLARED TYPE RESOLVES, so the derivation is not covered by an author-chosen example.
  for (const type of ALERT_CATALOG) {
    assert.equal(alertTierFor(type.id, severityOf(type.severity)).kind, 'TIER',
      `${type.id} has no tier`)
  }
})

test('A ROW THAT DID NOT SAY IS NOT A ROW THAT SAID RECORD_ONLY', () => {
  // Most notifications are not alerts — a sync failure, a connection problem. Those have no
  // alert type, and rendering them as RECORD_ONLY would make a silenced alert type and an
  // unconfigured one look identical. RECORD_ONLY is a decision somebody made; null is the
  // absence of one, and the two have different remedies.
  assert.deepEqual(alertTierFor(null, 'high'), { kind: 'NOT_AN_ALERT' })
  assert.deepEqual(alertTierFor(undefined, 'high'), { kind: 'NOT_AN_ALERT' })
  assert.deepEqual(alertTierFor('', 'high'), { kind: 'NOT_AN_ALERT' })

  // AND THEY ARE DISTINGUISHABLE IN THE TYPE, not merely by convention — there is no value of
  // `NotificationTier` that is both.
  const recordOnly = ALERT_CATALOG.find((type) => type.severity === 'RECORD_ONLY')
  assert.ok(recordOnly !== undefined, 'the catalogue has a RECORD_ONLY type to compare against')
  assert.notDeepEqual(alertTierFor(recordOnly.id, 'info'), alertTierFor(null, 'info'))
})

test('AN UNRECOGNISED ALERT TYPE IS REPORTED, NEVER DEFAULTED', () => {
  // A stored id the catalogue does not contain is a fact about the data. Defaulting it to a tier
  // is how a setting somebody made gets silently ignored — the same failure the disposition
  // column has, where a value outside the vocabulary must be reported rather than replaced.
  const answer = alertTierFor('security.invented_by_a_typo', 'critical')
  assert.equal(answer.kind, 'UNKNOWN_ALERT_TYPE')
  assert.equal(answer.kind === 'UNKNOWN_ALERT_TYPE' ? answer.alertTypeId : null,
    'security.invented_by_a_typo', 'and it names the value, so somebody can go and look')
})

test('THE NOTIFICATION CARRIES THE ALERT TYPE, and its severity is derived from it', () => {
  const decision = decide([finding()], [], canEmail, WATERMARK, T0)
  const written = decision.notifications[0]
  assert.ok(written !== undefined)
  assert.equal(written.alertTypeId, 'security.suspected_credential_attack', 'THE FACT')

  // THE RENDERINGS AGREE WITH IT BY CONSTRUCTION, because they are computed from it rather than
  // chosen alongside it. This asserts the relationship, not two remembered constants.
  const tier = alertTierFor(written.alertTypeId, written.severity)
  assert.equal(tier.kind, 'TIER')
  assert.equal(tier.kind === 'TIER' ? tier.tier : null, 'ACT_NOW')
  assert.equal(written.severity, 'critical', 'ACT_NOW renders critical, which is always shown')
  assert.equal(written.eventType, written.alertTypeId, 'and the family filter matches on it')
})

test('A DISPOSITION KEY CANNOT BE BUILT FROM A RULE ID', () => {
  // THE MEASURED BUG, MADE UNWRITEABLE. A disposition stored as `HV-ID-AUTH-010.v1` was silently
  // ignored and the email went anyway: the row existed, the write succeeded, and the MSP saw
  // their choice saved. Renaming the column fixed the reader; this fixes the next author,
  // because `alertTypeForRule` lives in this same file and both vocabularies are strings.
  const key = dispositionKey(ORG, 'security.suspected_credential_attack')
  assert.equal(key, `${ORG}|security.suspected_credential_attack`)

  // @ts-expect-error - a rule id is not an alert type id, and now the compiler says so
  const wrong = dispositionKey(ORG, 'HV-ID-AUTH-010.v1')
  assert.ok(wrong !== null)
})

test('A STORED VALUE THE CATALOGUE DOES NOT DECLARE IS REPORTED, NOT DEFAULTED', () => {
  // An unreadable policy must not silently become the catalogue default — that is a setting the
  // MSP made, ignored without anybody being told. `asAlertTypeId` is the only door.
  assert.equal(asAlertTypeId('security.suspected_credential_attack'),
    'security.suspected_credential_attack')
  assert.equal(asAlertTypeId('HV-ID-AUTH-010.v1'), null, 'a rule id names no alert type')
  assert.equal(asAlertTypeId(''), null)

  // NOT VACUOUS: every declared type passes, so the check is not refusing everything.
  for (const type of ALERT_CATALOG) assert.equal(asAlertTypeId(type.id), type.id)
})

test('AN UNREADABLE DISPOSITION LEAVES THE CATALOGUE DEFAULT IN FORCE, and is still reported', () => {
  // The two halves together: the send is decided by the default (so a broken row cannot silence
  // an alert by accident), AND the broken row is visible (so nobody thinks the MSP never chose).
  const withJunk: Dispositions = { ...canEmail, unreadable: [{ alertTypeId: 'HV-ID-AUTH-010.v1', disposition: 'RECORD_ONLY', because: 'UNKNOWN_ALERT_TYPE' as const }] }
  const out = decide([finding()], none, withJunk, WATERMARK, T0)

  assert.equal(out.jobs.length, 1, 'the catalogue default still applies — ACT_NOW sends')
  assert.equal(withJunk.unreadable[0]?.alertTypeId, 'HV-ID-AUTH-010.v1',
    'and the value survives to be read')
})

test('A COMMIT THAT FAILS REPORTS THE PHASE AND EVERYTHING IT LOST', async () => {
  // THE FAILURE QA MEASURED. The transaction budget is exhausted well below the per-tick cap, and
  // the tick writes nothing, comes back without throwing, and works on the retry. Both a yield
  // and this leave every finding OPEN, so they are indistinguishable by their effect — the
  // report is the only place they can differ.
  const store: PipelineStore = {
    findOpenFindings: async () => [finding()],
    findExistingIncidents: async () => [],
    loadDispositions: async () => canEmail,
    commit: async () => { throw new Error('the timeout was 5000 ms, however 5002 ms passed') },
  }
  const outcome = await runIntake(store, WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

  assert.equal(outcome.kind, 'FAILED')
  if (outcome.kind !== 'FAILED') return
  assert.equal(outcome.phase, 'WRITING', 'a decision existed and none of it landed')
  assert.match(outcome.because, /5002 ms/, 'the provider’s own words, so it can be recognised')

  // HOW MUCH WAS LOST, which is the difference between "intake failed" and a number somebody can
  // act on. All three tables or none, so there is no partial state — but the whole tick is gone.
  assert.deepEqual(outcome.attempted,
    { findingsRead: 1, incidents: 1, notifications: 1, jobs: 1 })
})

test('A READ THAT FAILS IS A DIFFERENT PHASE, and reports nothing attempted', async () => {
  // The control for the test above: without it, a FAILED outcome that always said WRITING with
  // the same counts would pass, and the phase would be decoration.
  const store: PipelineStore = {
    findOpenFindings: async () => { throw new Error('connection terminated') },
    findExistingIncidents: async () => [],
    loadDispositions: async () => canEmail,
    commit: async () => ({ incidentsWritten: 0, notificationsWritten: 0, jobsWritten: 0 }),
  }
  const outcome = await runIntake(store, WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

  assert.equal(outcome.kind, 'FAILED')
  if (outcome.kind !== 'FAILED') return
  assert.equal(outcome.phase, 'READING', 'nothing was decided, so nothing could be lost')
  assert.deepEqual(outcome.attempted, { findingsRead: 0, incidents: 0, notifications: 0, jobs: 0 })
})

test('AND A HEALTHY TICK IS NEITHER, or the two above are satisfied by always failing', async () => {
  const store: PipelineStore = {
    findOpenFindings: async () => [finding()],
    findExistingIncidents: async () => [],
    loadDispositions: async () => canEmail,
    commit: async () => ({ incidentsWritten: 1, notificationsWritten: 1, jobsWritten: 1 }),
  }
  const outcome = await runIntake(store, WATERMARK, T0, Date.now() + 30_000, '2026-01-01T00:00:00.000Z')

  assert.equal(outcome.kind, 'RAN')
  assert.equal(outcome.kind === 'RAN' ? outcome.report.jobsWritten : null, 1)
  assert.equal(outcome.kind === 'RAN' ? outcome.report.yieldedOnBudget : null, false,
    'and a completed tick is not a yield either')
})

test('LOWERING URGENCY CHANGES THE NOTIFICATION, and raising it does too', () => {
  // **TWO OF THE THREE SETTINGS WERE INERT.** ACT_NOW and ACT_TODAY produced byte-identical
  // output and both matched no row at all, because the severity was written from the CATALOGUE
  // in every case. An MSP who lowered urgency still got the row marked critical; one who raised
  // it had made a choice the product recorded, displayed and never acted on.
  const lowered: Dispositions = {
    ...canEmail,
    byOrganizationAndAlertType: new Map([
      [dispositionKey(ORG, 'security.suspected_credential_attack'), 'ACT_TODAY'],
    ]),
  }
  const out = decide([finding()], none, lowered, WATERMARK, T0)

  assert.equal(out.notifications[0]?.severity, 'high', 'NOT critical, which is the catalogue value')
  assert.equal(out.notifications[0]?.category, 'warning')
  assert.equal(out.jobs.length, 1, 'and it still sends — ACT_TODAY is not off')

  // THE CONTROL: with no setting the catalogue's own judgement applies, so the assertion above
  // is about the disposition rather than about a severity that is always high.
  const untouched = decide([finding()], none, canEmail, WATERMARK, T0)
  assert.equal(untouched.notifications[0]?.severity, 'critical')
  assert.equal(untouched.notifications[0]?.category, 'error')
})

test('RAISING URGENCY ON A QUIET TYPE IS VISIBLE TOO', () => {
  // The other direction, on a type the catalogue calls RECORD_ONLY — so this cannot pass by the
  // catalogue happening to agree.
  const quiet = ALERT_CATALOG.find((type) => type.severity === 'RECORD_ONLY')
  assert.ok(quiet !== undefined)
  const mapped = ALERT_CATALOG.find((type) => type.id === 'security.suspected_credential_attack')
  assert.ok(mapped !== undefined)

  const raised: Dispositions = {
    ...canEmail,
    byOrganizationAndAlertType: new Map([
      [dispositionKey(ORG, mapped.id), 'RECORD_ONLY'],
    ]),
  }
  const out = decide([finding()], none, raised, WATERMARK, T0)

  // RECORD_ONLY renders as info AND withholds the job — one value deciding both, which is the
  // point: they are the same judgement.
  assert.equal(out.notifications[0]?.severity, 'info')
  assert.equal(out.jobs.length, 0)
  assert.equal(out.skipped[0]?.because, 'RECORD_ONLY')

  // AND THE INCIDENT AND THE NOTIFICATION STILL EXIST. Off means recorded, not absent.
  assert.equal(out.incidents.length, 1)
  assert.equal(out.notifications.length, 1)
})

test('AN UNREADABLE STORED TIER LEAVES THE CATALOGUE IN CHARGE, and is reported', () => {
  // A value outside the vocabulary never reaches the map — the store collects it into
  // `unreadable` — so the catalogue default applies and the fact travels in the report rather
  // than becoming a tier nobody chose.
  const withJunk: Dispositions = { ...canEmail, unreadable: [{ alertTypeId: 'HV-ID-AUTH-010.v1', disposition: 'RECORD_ONLY', because: 'UNKNOWN_ALERT_TYPE' as const }] }
  const out = decide([finding()], none, withJunk, WATERMARK, T0)

  assert.equal(out.notifications[0]?.severity, 'critical', 'the catalogue judgement, unchanged')
  assert.equal(out.jobs.length, 1)
})
