import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptMicrosoftRiskyUsersResponse,
  adaptRiskAssessmentResponse,
  unavailableMicrosoftEntraRiskyUsers,
} from './adapter.ts'
import {
  detectedByLabel,
  microsoftChannel,
  riskyUserCount,
  riskyUserList,
} from './risky-users-view.ts'
import type { MicrosoftEntraRiskyUser } from './types.ts'
import {
  assessmentFixture,
  assessmentNow,
  assessmentUser,
  at,
} from './assessment-test-fixtures.ts'
import { syntheticRiskResponses } from './test-fixtures.ts'

const licenceBlocked = microsoftChannel(
  unavailableMicrosoftEntraRiskyUsers(
    'UNAVAILABLE',
    'Microsoft Entra risky-user evidence is not available on this tenant.',
    'LICENSE_REQUIRED'
  )
)

function reportingMicrosoft() {
  const responses = syntheticRiskResponses()
  return microsoftChannel(
    adaptMicrosoftRiskyUsersResponse(responses.microsoftRiskyUsers)
  )
}

function adapt(value: Record<string, any>) {
  const assessment = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(assessment, 'fixture should adapt')
  return assessment!
}

/* -------------------------------------------------------------------------- */
/* Count                                                                      */
/* -------------------------------------------------------------------------- */

test('an exact count is printed plainly and says what it counts', () => {
  const assessment = adapt(assessmentFixture(true))
  const count = riskyUserCount({ assessment, channel: licenceBlocked })
  assert.equal(count.accuracy, 'EXACT')
  assert.equal(count.value, 1)
  assert.equal(count.display, '1')
  assert.equal(count.headline, 'Risky user')
  assert.match(count.caption, /counted once/)
  // Never a compromise verdict.
  assert.match(count.caption, /investigation leads/)
})

test('a lower bound is marked as one and can never be zero', () => {
  const value = assessmentFixture(true)
  value.meta.capability = 'PARTIAL'
  value.meta.freshness = 'UNKNOWN'
  value.meta.limitation = 'One evidence source is incomplete.'
  value.sources[1].status = 'PARTIAL'
  value.sources[1].reasonCode = 'INCOMPLETE_WINDOW'
  value.sources[1].freshness = 'UNKNOWN'
  value.rules[1].status = 'PARTIAL'
  value.rules[1].reasonCode = 'INCOMPLETE_WINDOW'
  value.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }
  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.equal(count.accuracy, 'AT_LEAST')
  assert.equal(count.display, '≥1')
  assert.equal(count.accessibleValue, 'At least 1')
  assert.match(count.caption, /may be higher/)

  // The adapter refuses a zero lower bound outright, so the view can never be
  // handed one. A lower bound of zero would claim nothing was found while
  // simultaneously admitting the search was incomplete.
  const zeroBound = assessmentFixture(false)
  zeroBound.summary.currentUsers = { value: 0, accuracy: 'AT_LEAST' }
  assert.equal(adaptRiskAssessmentResponse(zeroBound, assessmentNow), null)
})

test('a withheld count is a coverage statement, not an error', () => {
  const unknown = assessmentFixture(false)
  unknown.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  const withoutSummary = assessmentFixture(false)
  delete withoutSummary.summary

  for (const [label, input] of [
    ['unknown accuracy', { assessment: adapt(unknown) }],
    ['no summary reported', { assessment: adapt(withoutSummary) }],
  ] as const) {
    const count = riskyUserCount({ ...input, channel: licenceBlocked })
    assert.equal(count.accuracy, 'WITHHELD', label)
    assert.equal(count.value, null, label)
    assert.equal(count.accessibleValue, 'Not counted', label)
    assert.match(count.caption, /not zero/i, label)
    // A technician who reads this as breakage opens a support ticket, so
    // nothing in it may sound like a fault or invite a retry.
    assert.doesNotMatch(
      count.headline,
      /error|failed|could not be loaded/i,
      label
    )
    assert.doesNotMatch(count.caption, /try again|retry|error/i, label)
  }
})

test('a failed read is a failure and says so, unlike a withheld count', () => {
  for (const [label, input] of [
    ['no assessment at all', { assessment: null }],
    [
      'request failed',
      { assessment: adapt(assessmentFixture(true)), requestFailed: true },
    ],
    [
      'unreadable response',
      { assessment: adapt(assessmentFixture(true)), contractFailed: true },
    ],
  ] as const) {
    const count = riskyUserCount({ ...input, channel: licenceBlocked })
    assert.equal(count.accuracy, 'UNAVAILABLE', label)
    assert.equal(count.value, null, label)
    assert.equal(count.display, '—', label)
    assert.match(count.caption, /not zero|has not resolved/i, label)
  }
})

test('each withholding reason gets its own words', () => {
  const reasons = [
    'UNRESOLVED_SUBJECT_IDENTITY',
    'UNINTERPRETABLE_EVIDENCE',
    'CAPACITY_LIMIT',
    'INCOMPLETE_WINDOW',
    'COLLECTION_STALE',
    'SOURCE_UNAVAILABLE',
  ] as const
  const headlines = new Set<string>()
  const captions = new Set<string>()
  for (const reason of reasons) {
    const value = assessmentFixture(false)
    value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN', reason }
    const count = riskyUserCount({
      assessment: adapt(value),
      channel: licenceBlocked,
    })
    assert.equal(count.accuracy, 'WITHHELD', reason)
    headlines.add(count.headline)
    captions.add(count.caption)
  }
  // Collapsing these into one generic "unavailable" string is the defect this
  // rebuild exists to remove, so no two may share wording.
  assert.equal(headlines.size, reasons.length)
  assert.equal(captions.size, reasons.length)
})

test('the two reasons that send a technician to different places read differently', () => {
  const forReason = (reason: string) => {
    const value = assessmentFixture(false)
    value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN', reason }
    return riskyUserCount({
      assessment: adapt(value),
      channel: licenceBlocked,
    })
  }
  const identity = forReason('UNRESOLVED_SUBJECT_IDENTITY')
  const events = forReason('UNINTERPRETABLE_EVIDENCE')
  assert.match(identity.caption, /belongs to a person/)
  assert.match(events.caption, /does not recognise/)
  assert.notEqual(identity.caption, events.caption)
  assert.notEqual(identity.headline, events.headline)
})

test('an unreported withholding reason is admitted, never guessed at', () => {
  const value = assessmentFixture(false)
  value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.match(count.caption, /did not report why/)
})

test('what HawkView does know is carried beside a withheld count', () => {
  // Three mailboxes forwarding externally, none of which can be tied to a
  // person. The count is withheld; the findings are not.
  const value = assessmentFixture(true)
  value.users = ['a', 'b', 'c'].map((character) =>
    assessmentUser('HV-ID-MBX-001.v1', character)
  )
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 3
  value.rules[2].matchedIdentities = 3
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'UNRESOLVED_SUBJECT_IDENTITY',
  }
  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.equal(count.accuracy, 'WITHHELD')
  // "3 mailboxes forwarding externally" is true and useful even though the
  // number of people behind them is not knowable.
  assert.deepEqual(count.known, ['External mailbox forwarding: 3 mailboxes'])
})

test('a failed read never resolves findings that were already reported', () => {
  const assessment = adapt(assessmentFixture(true))
  const count = riskyUserCount({
    assessment,
    channel: licenceBlocked,
    requestFailed: true,
  })
  assert.equal(count.accuracy, 'UNAVAILABLE')
  assert.match(count.caption, /has not resolved them/)
  // The users themselves stay on screen; only the total is withdrawn.
  assert.equal(riskyUserList(assessment, licenceBlocked).rows.length, 1)
})

test('a zero is never rendered without the scope of the claim and its gaps', () => {
  const clean = adapt(assessmentFixture(false))
  const count = riskyUserCount({ assessment: clean, channel: licenceBlocked })

  assert.equal(count.accuracy, 'EXACT')
  assert.equal(count.value, 0)
  assert.equal(count.display, '0')
  // The headline states what was evaluated rather than asserting safety.
  assert.equal(count.headline, 'No findings in evaluated evidence')
  assert.match(count.caption, /does not establish that an identity is safe/)
  // And the unavailable Microsoft channel is disclosed beside the zero, so it
  // cannot be read as "nothing is wrong with this tenant".
  assert.ok(count.gaps.length > 0)
  assert.ok(count.gaps.some((gap) => /Entra ID P2/.test(gap)))
})

test('an incomplete evaluation is disclosed beside whatever number is shown', () => {
  const value = assessmentFixture(true)
  delete value.summary
  value.meta.capability = 'PARTIAL'
  value.meta.freshness = 'UNKNOWN'
  value.meta.limitation = 'One check did not complete.'
  value.rules[1].status = 'PARTIAL'
  value.rules[1].reasonCode = 'INCOMPLETE_WINDOW'
  value.sources[2].status = 'STALE'
  value.sources[2].reasonCode = 'COLLECTION_STALE'
  value.sources[2].freshness = 'STALE'

  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.ok(
    count.gaps.some((gap) =>
      /1 of 3 HawkView checks did not complete/.test(gap)
    )
  )
  assert.ok(
    count.gaps.some((gap) =>
      /1 of 3 evidence sources are incomplete or out of date/.test(gap)
    )
  )
})

test('a partial page is disclosed rather than counted as the whole tenant', () => {
  const value = assessmentFixture(true)
  delete value.summary
  value.page = { hasMore: true, nextCursor: 'cursor.abc' }
  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.equal(count.accuracy, 'WITHHELD')
  assert.ok(
    count.gaps.some((gap) =>
      /More users are available than the page that was read/.test(gap)
    )
  )
})

test('a check that cannot run bounds the claim and travels with the count', () => {
  // Three of five tenants are on the audit-log fallback, which carries no
  // conditional-access status, device detail or risk fields, so some checks
  // have nothing to execute against.
  const value = assessmentFixture(false)
  value.rules[2].status = 'INAPPLICABLE'
  value.rules[2].reasonCode = 'CHECK_NOT_APPLICABLE'
  value.rules[2].assessedIdentities = null
  value.rules[2].matchedIdentities = null
  value.rules[2].evaluatedAt = null
  value.rules[2].window = { start: null, end: null }
  const assessment = adapt(value)

  // A check that cannot run is not incomplete collection, so an exact zero is
  // still reachable — otherwise those three tenants could never show a number.
  const count = riskyUserCount({ assessment, channel: licenceBlocked })
  assert.equal(count.accuracy, 'EXACT')
  assert.equal(count.value, 0)

  // But the zero states its own scope, in the claim itself...
  assert.match(count.caption, /2 checks this tenant/)
  assert.match(count.caption, /1 further check cannot run/)
  // ...and in the disclosure carried alongside the number, so the scope is
  // never a footnote one component away.
  assert.ok(
    count.gaps.some((gap) =>
      /1 of 3 HawkView checks? cannot run on this tenant/.test(gap)
    )
  )
  // Naming which check it was is what makes the scope actionable.
  assert.ok(count.gaps.some((gap) => /External mailbox forwarding/.test(gap)))
})

/* -------------------------------------------------------------------------- */
/* Microsoft channel                                                          */
/* -------------------------------------------------------------------------- */

test('the P2 gap is stated as a fact with the licence named', () => {
  assert.equal(licenceBlocked.state, 'UNAVAILABLE')
  assert.match(licenceBlocked.headline, /requires Entra ID P2/)
  // Worth surfacing to an MSP as something they can act on.
  assert.equal(licenceBlocked.addressable, true)
  // And it says what the absence does not mean.
  assert.match(
    licenceBlocked.detail,
    /does not mean Microsoft would also report zero/
  )
})

test('each unavailable cause gets its own explanation, never a generic one', () => {
  const seen = new Set<string>()
  for (const reason of [
    'LICENSE_REQUIRED',
    'MISSING_PERMISSION',
    'WAITING_FOR_COLLECTION',
    'COLLECTION_FAILED',
    'SOURCE_UNAVAILABLE',
    'EVALUATION_DISABLED',
  ] as const) {
    const channel = microsoftChannel(
      unavailableMicrosoftEntraRiskyUsers(
        'UNAVAILABLE',
        'Not available.',
        reason
      )
    )
    assert.ok(channel.headline.length > 0, reason)
    assert.equal(seen.has(channel.headline), false, reason)
    seen.add(channel.headline)
  }

  // A cause the server did not report is admitted as unknown, not guessed at.
  const unreported = microsoftChannel(
    unavailableMicrosoftEntraRiskyUsers('UNAVAILABLE', 'Not available.')
  )
  assert.match(unreported.detail, /cause was not reported/)
  assert.equal(unreported.addressable, false)
})

test('never collected, unreadable and unavailable stay three separate states', () => {
  const states = [
    microsoftChannel(
      unavailableMicrosoftEntraRiskyUsers('NOT_EVALUATED', 'Not evaluated.')
    ),
    microsoftChannel(
      unavailableMicrosoftEntraRiskyUsers('ERROR', 'Could not be read.')
    ),
    licenceBlocked,
    reportingMicrosoft(),
  ]
  assert.deepEqual(
    states.map((channel) => channel.state),
    ['NOT_EVALUATED', 'INTERRUPTED', 'UNAVAILABLE', 'REPORTING']
  )
  assert.equal(new Set(states.map((channel) => channel.headline)).size, 4)
})

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

test('a row never implies Microsoft cleared a user it could not be asked about', () => {
  const assessment = adapt(assessmentFixture(true))

  const blocked = riskyUserList(assessment, licenceBlocked).rows[0]
  assert.equal(blocked.detection.microsoft, 'UNAVAILABLE')
  assert.equal(
    detectedByLabel(blocked.detection),
    'HawkView — Microsoft unavailable'
  )

  // Microsoft is reporting, but nothing correlates its records to a HawkView
  // pseudonym. "Not reported" would be a claim about Microsoft that no evidence
  // supports, so the row says the two cannot be compared.
  const reporting = reportingMicrosoft()
  const uncorrelated = riskyUserList(assessment, reporting).rows[0]
  assert.equal(uncorrelated.detection.microsoft, 'NOT_COMPARABLE')
  assert.equal(
    detectedByLabel(uncorrelated.detection),
    'HawkView — Microsoft not comparable'
  )
})

test('with a correlation, each channel keeps its own attribution', () => {
  const assessment = adapt(assessmentFixture(true))
  const subjectId = assessment.users[0].id
  const record: MicrosoftEntraRiskyUser = {
    id: 'microsoft-record-1',
    identityLabel: 'Reported by Microsoft',
    riskLevel: 'high',
    riskState: 'atRisk',
    riskDetail: null,
    observedAt: at(-5),
  }
  const reporting = reportingMicrosoft()

  const matched = riskyUserList(
    assessment,
    reporting,
    new Map([[subjectId, record]])
  ).rows[0]
  assert.equal(matched.detection.microsoft, 'REPORTED')
  assert.equal(matched.detection.microsoftRecord, record)
  assert.equal(detectedByLabel(matched.detection), 'HawkView and Microsoft')
  // Both systems are named. Neither is folded into the other or into a score.
  assert.equal(matched.detection.hawkView, true)

  const unmatched = riskyUserList(assessment, reporting, new Map()).rows[0]
  assert.equal(unmatched.detection.microsoft, 'NOT_REPORTED')
  assert.equal(unmatched.detection.microsoftRecord, null)
  assert.equal(detectedByLabel(unmatched.detection), 'HawkView only')
})

test('a Microsoft record never changes the HawkView count', () => {
  const assessment = adapt(assessmentFixture(true))
  const record: MicrosoftEntraRiskyUser = {
    id: 'microsoft-record-1',
    identityLabel: 'Reported by Microsoft',
    riskLevel: 'high',
    riskState: 'atRisk',
    riskDetail: null,
    observedAt: at(-5),
  }
  const withMicrosoft = riskyUserCount({
    assessment,
    channel: reportingMicrosoft(),
  })
  const withoutMicrosoft = riskyUserCount({
    assessment,
    channel: licenceBlocked,
  })
  assert.equal(withMicrosoft.value, withoutMicrosoft.value)
  assert.equal(
    riskyUserList(
      assessment,
      reportingMicrosoft(),
      new Map([[assessment.users[0].id, record]])
    ).rows.length,
    1
  )
})

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

test('the list carries what a technician triages on', () => {
  const assessment = adapt(assessmentFixture(true))
  const [row] = riskyUserList(assessment, licenceBlocked).rows
  assert.equal(row.name, 'Synthetic identity')
  assert.equal(row.subjectType, 'USER')
  assert.equal(row.priority, 'LOW')
  assert.equal(row.priorityLabel, 'Low')
  assert.equal(row.lastSeen, at(-1))
  assert.deepEqual(row.reasons, ['Repeated invalid credentials'])
  assert.equal(row.protection.label, 'Protection not verified')
  // The contract carries no address, so none is invented.
  assert.equal(row.email, null)
  assert.match(row.reference, /^hvr1_subject_/)
})

test('mailbox and historical evidence is kept out of the counted list', () => {
  const value = assessmentFixture(true)
  value.users.push(assessmentUser('HV-ID-MBX-001.v1', 'b'))
  value.rules[2].matchedIdentities = 1
  const assessment = adapt(value)

  const { rows, context } = riskyUserList(assessment, licenceBlocked)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].subjectType, 'USER')
  assert.equal(context.length, 1)
  assert.equal(context[0].subjectType, 'MAILBOX')

  // The headline counts people needing attention, not every piece of evidence.
  assert.equal(riskyUserCount({ assessment, channel: licenceBlocked }).value, 1)
})

test('the highest priority and most recent evidence sorts first', () => {
  const value = assessmentFixture(false)
  const low = assessmentUser('HV-ID-AUTH-010.v1', 'a')
  const medium = assessmentUser('HV-ID-AUTH-005.v2', 'b')
  const older = assessmentUser('HV-ID-AUTH-010.v1', 'c')
  older.findings[0].lastSeen = at(-9)
  value.users = [low, medium, older]
  value.rules[0].matchedIdentities = 2
  value.rules[1].matchedIdentities = 1
  value.summary.currentUsers = { value: 3, accuracy: 'EXACT' }

  const rows = riskyUserList(adapt(value), licenceBlocked).rows
  assert.deepEqual(
    rows.map((row) => row.priority),
    ['MEDIUM', 'LOW', 'LOW']
  )
  assert.equal(rows[1].lastSeen, at(-1))
  assert.equal(rows[2].lastSeen, at(-9))
})
