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
  microsoftLevelsHidden,
  microsoftRecordsByPolarity,
  microsoftRiskLevelLabel,
  microsoftVerdictDetail,
  microsoftVerdictPolarity,
  riskyUserCount,
  riskyUserList,
} from './risky-users-view.ts'
import { findingEvidenceSummary, ruleScopeSummary } from './presentation.ts'
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
    // Never a dash and never a blank: both read as zero on a dashboard.
    assert.equal(count.display, 'Not available', label)
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
    'HawkView — Microsoft unavailable on this tenant'
  )
  // The row carries the reason, so a technician learns what would change it.
  assert.match(blocked.detection.because ?? '', /requires Entra ID P2/)

  // Microsoft is reporting, but nothing correlates its records to a HawkView
  // identity. "Not reported" would be a claim about Microsoft that no evidence
  // supports, so the row says the two cannot be compared. These two states are
  // deliberately not one sentence: one is a capability, the other is a gap.
  const reporting = reportingMicrosoft()
  const uncorrelated = riskyUserList(assessment, reporting).rows[0]
  assert.equal(uncorrelated.detection.microsoft, 'NOT_COMPARABLE')
  assert.equal(
    detectedByLabel(uncorrelated.detection),
    'HawkView — Microsoft cannot be compared for this user'
  )
})

function microsoftRecord(
  correlation: MicrosoftEntraRiskyUser['correlation'],
  id = 'microsoft-record-1'
): MicrosoftEntraRiskyUser {
  return {
    id,
    identityLabel: 'Reported by Microsoft',
    correlation,
    riskLevel: 'high',
    riskState: 'atRisk',
    riskDetail: null,
    observedAt: at(-5),
  }
}

function assessmentWithCorrelation(
  correlation: unknown,
  overrides: Record<string, unknown> = {}
) {
  const value = assessmentFixture(true)
  Object.assign(value.users[0], { correlation, ...overrides })
  return adapt(value)
}

const guid = {
  available: true as const,
  shape: 'DIRECTORY_OBJECT_ID' as const,
  ref: '11111111-2222-3333-4444-555555555555',
}
const upn = {
  available: true as const,
  shape: 'USER_PRINCIPAL_NAME' as const,
  ref: 'wrapped:alice',
}

test('a matched key is the strongest thing this product can say', () => {
  const assessment = assessmentWithCorrelation(guid)
  const record = microsoftRecord(guid)
  const row = riskyUserList(assessment, reportingMicrosoft(), [record]).rows[0]
  assert.equal(row.detection.microsoft, 'REPORTED')
  assert.equal(row.detection.microsoftRecord, record)
  assert.equal(detectedByLabel(row.detection), 'HawkView and Microsoft')
  // Both systems are named. Neither is folded into the other or into a score.
  assert.equal(row.detection.hawkView, true)
})

test('Microsoft did not report this user is only sayable once the join worked', () => {
  const assessment = assessmentWithCorrelation(guid)
  const other = microsoftRecord({ ...guid, ref: 'a-different-guid' })
  const row = riskyUserList(assessment, reportingMicrosoft(), [other]).rows[0]
  assert.equal(row.detection.microsoft, 'NOT_REPORTED')
  assert.equal(row.detection.microsoftRecord, null)
  assert.match(
    detectedByLabel(row.detection),
    /Microsoft did not report this user/
  )
})

test('refs are never compared across shapes', () => {
  // A directory object GUID and a user principal name are different
  // namespaces. Comparing them would match nothing, or match by coincidence.
  const assessment = assessmentWithCorrelation(guid)
  const crossShape = microsoftRecord({ ...upn, ref: guid.ref })
  const row = riskyUserList(assessment, reportingMicrosoft(), [crossShape])
    .rows[0]
  assert.equal(row.detection.microsoft, 'NOT_REPORTED')
  assert.equal(row.detection.microsoftRecord, null)
})

test('an audit-fallback tenant joins by user principal name, not by GUID', () => {
  // Three of five tenants have no GUID at all. A GUID-only join would silently
  // return nothing for them.
  const assessment = assessmentWithCorrelation(upn)
  const record = microsoftRecord(upn)
  const row = riskyUserList(assessment, reportingMicrosoft(), [record]).rows[0]
  assert.equal(row.detection.microsoft, 'REPORTED')
})

test('a mismatched wrapping fails closed rather than matching by accident', () => {
  const assessment = assessmentWithCorrelation(upn)
  const unwrapped = microsoftRecord({ ...upn, ref: 'alice' })
  const row = riskyUserList(assessment, reportingMicrosoft(), [unwrapped])
    .rows[0]
  assert.equal(row.detection.microsoft, 'NOT_REPORTED')
})

test('an unavailable key states the capability instead of shrugging', () => {
  const assessment = assessmentWithCorrelation({
    available: false,
    because: "Microsoft's channel requires Entra ID P2 on this tenant.",
  })
  const row = riskyUserList(assessment, reportingMicrosoft(), [
    microsoftRecord(guid),
  ]).rows[0]
  assert.equal(row.detection.microsoft, 'NOT_COMPARABLE')
  assert.equal(
    row.detection.because,
    "Microsoft's channel requires Entra ID P2 on this tenant."
  )
})

test('an unmatchable Microsoft record makes a miss unproven, not negative', () => {
  // If some of Microsoft's records carry no usable key, the absence of a match
  // is not evidence that Microsoft cleared anyone.
  const assessment = assessmentWithCorrelation(guid)
  const row = riskyUserList(assessment, reportingMicrosoft(), [
    microsoftRecord(null, 'unkeyed'),
  ]).rows[0]
  assert.equal(row.detection.microsoft, 'NOT_COMPARABLE')
  assert.match(row.detection.because ?? '', /not evidence that Microsoft/)
})

test('a server that sends no key at all still cannot imply a clearance', () => {
  const assessment = adapt(assessmentFixture(true))
  assert.equal(assessment.users[0].correlation, null)
  const row = riskyUserList(assessment, reportingMicrosoft(), [
    microsoftRecord(guid),
  ]).rows[0]
  assert.equal(row.detection.microsoft, 'NOT_COMPARABLE')
})

test('a Microsoft record never changes the HawkView count', () => {
  const assessment = assessmentWithCorrelation(guid)
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
    riskyUserList(assessment, reportingMicrosoft(), [microsoftRecord(guid)])
      .rows.length,
    1
  )
})

test('a resolved identity is shown, and an unresolved one is not invented', () => {
  const resolved = assessmentWithCorrelation(guid, {
    displayName: 'Alice Chen',
    userPrincipalName: 'alice.chen@synthetic.invalid',
  })
  const [row] = riskyUserList(resolved, licenceBlocked).rows
  assert.equal(row.name, 'Alice Chen')
  assert.equal(row.email, 'alice.chen@synthetic.invalid')

  // A server that does not resolve identity yields the opaque reference, not a
  // blank and not a fabricated address.
  const [plain] = riskyUserList(
    adapt(assessmentFixture(true)),
    licenceBlocked
  ).rows
  assert.equal(plain.email, null)
  assert.match(plain.reference, /^hvr1_subject_/)
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
  assert.deepEqual(
    row.reasons.map((reason) => reason.title),
    ['Repeated invalid credentials']
  )
  // Each reason carries its own count and its own recency, so a surface
  // cannot pair one reason's number with another reason's date.
  assert.equal(row.reasons[0].evidenceCount, 10)
  assert.equal(row.reasons[0].evidenceCountCapped, false)
  assert.equal(row.reasons[0].lastSeen, at(-1))
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

/* -------------------------------------------------------------------------- */
/* Microsoft verdict polarity                                                 */
/* -------------------------------------------------------------------------- */

function verdict(
  overrides: Partial<MicrosoftEntraRiskyUser> = {}
): MicrosoftEntraRiskyUser {
  return {
    id: 'microsoft-record-1',
    identityLabel: 'Synthetic user',
    correlation: null,
    riskLevel: 'high',
    riskState: 'atRisk',
    riskDetail: null,
    observedAt: at(-5),
    ...overrides,
  }
}

test('a verdict that clears a sign-in is never treated as a detection', () => {
  // Microsoft's channel carries conclusions, and some of them are "this was
  // safe". Rendering one of those as a risk gets an account disabled over a
  // sign-in Microsoft cleared.
  for (const riskDetail of [
    'aiConfirmedSigninSafe',
    'adminConfirmedSigninSafe',
    'adminConfirmedAccountSafe',
  ]) {
    // Even when the state still reads atRisk, the explicit safe conclusion wins.
    assert.equal(
      microsoftVerdictPolarity(verdict({ riskDetail, riskState: 'atRisk' })),
      'CLEARED',
      riskDetail
    )
  }
  assert.equal(
    microsoftVerdictPolarity(verdict({ riskState: 'confirmedSafe' })),
    'CLEARED'
  )
})

test('an unrecognised verdict never defaults to the risk side', () => {
  assert.equal(
    microsoftVerdictPolarity(verdict({ riskState: 'unknownFutureValue' })),
    'UNRECOGNISED'
  )
  assert.equal(
    microsoftVerdictDetail(verdict({ riskDetail: 'unknownFutureValue' })),
    'Microsoft reported a detail this client does not recognise'
  )
})

test('active risk, closed and cleared stay three separate groups', () => {
  assert.equal(
    microsoftVerdictPolarity(verdict({ riskState: 'atRisk' })),
    'ACTIVE_RISK'
  )
  assert.equal(
    microsoftVerdictPolarity(verdict({ riskState: 'confirmedCompromised' })),
    'ACTIVE_RISK'
  )
  assert.equal(
    microsoftVerdictPolarity(verdict({ riskState: 'remediated' })),
    'CLOSED'
  )
  assert.equal(
    microsoftVerdictPolarity(verdict({ riskState: 'dismissed' })),
    'CLOSED'
  )

  const view = {
    channel: 'MICROSOFT_ENTRA_RISKY_USERS' as const,
    meta: unavailableMicrosoftEntraRiskyUsers('AVAILABLE', 'x').meta,
    users: [
      verdict({ id: 'a', riskState: 'atRisk' }),
      verdict({ id: 'b', riskState: 'dismissed' }),
      verdict({ id: 'c', riskDetail: 'aiConfirmedSigninSafe' }),
      verdict({ id: 'd', riskState: 'unknownFutureValue' }),
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }
  const groups = microsoftRecordsByPolarity(view)
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(groups).map(([key, users]) => [key, users.length])
    ),
    { ACTIVE_RISK: 1, CLOSED: 1, CLEARED: 1, UNRECOGNISED: 1 }
  )
})

test('Microsoft automatic remediation is not rendered as human negligence', () => {
  // Microsoft's automatic remediation lands in the dismissed state, not the remediated one.
  const automatic = microsoftVerdictDetail(
    verdict({ riskState: 'dismissed', riskDetail: 'aiConfirmedSigninSafe' })
  )
  const person = microsoftVerdictDetail(
    verdict({
      riskState: 'dismissed',
      riskDetail: 'adminDismissedAllRiskForUser',
    })
  )
  assert.match(automatic, /automated assessment/)
  assert.match(person, /An administrator/)
  assert.notEqual(automatic, person)
})

test('a hidden risk level reads as withheld, never as no risk', () => {
  const label = microsoftRiskLevelLabel('hidden')
  assert.match(label, /requires Entra ID P2/)
  // The two readings that would tell an MSP their customer is clean.
  assert.doesNotMatch(label, /^none$/i)
  assert.notEqual(label.trim(), '')

  assert.equal(
    microsoftLevelsHidden({
      channel: 'MICROSOFT_ENTRA_RISKY_USERS',
      meta: unavailableMicrosoftEntraRiskyUsers('AVAILABLE', 'x').meta,
      users: [verdict({ riskLevel: 'hidden' })],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    true
  )
})

test('the risk level is labelled as confidence, not as severity', () => {
  assert.equal(microsoftRiskLevelLabel('high'), 'High confidence')
  assert.equal(microsoftRiskLevelLabel('low'), 'Low confidence')
})

test('the misleading password-reset identifier is never rendered as a reset', () => {
  // Microsoft's own documentation notes this means a secure password change,
  // not a self-service reset flow.
  for (const riskDetail of [
    'userPerformedSecuredPasswordReset',
    'userPerformedSecuredPasswordChange',
  ]) {
    const detail = microsoftVerdictDetail(verdict({ riskDetail }))
    assert.match(detail, /secure password change/)
    assert.doesNotMatch(detail, /reset/i, riskDetail)
  }
})

test('no raw Microsoft identifier reaches the rendered detail', () => {
  for (const riskDetail of [
    'none',
    'adminGeneratedTemporaryPassword',
    'userPerformedSecuredPasswordChange',
    'userPerformedSecuredPasswordReset',
    'adminConfirmedSigninSafe',
    'aiConfirmedSigninSafe',
    'userPassedMFADrivenByRiskBasedPolicy',
    'adminDismissedAllRiskForUser',
    'adminConfirmedSigninCompromised',
    'hidden',
    'adminConfirmedUserCompromised',
    'm365DAdminDismissedDetection',
    'userChangedPasswordOnPremises',
    'adminDismissedRiskForSignIn',
    'adminConfirmedAccountSafe',
    'unknownFutureValue',
  ]) {
    const detail = microsoftVerdictDetail(verdict({ riskDetail }))
    assert.doesNotMatch(detail, /[a-z][A-Z]/, riskDetail)
  }
})

test('a zero counts people and never speaks for the findings beneath it', () => {
  // The count is distinct directory users. Evidence that cannot be tied to a
  // person is deliberately excluded from it, so EXACT 0 beside a non-empty
  // findings list is a legitimate state: zero people identified, three
  // mailboxes still forwarding externally. Reading the zero as "nothing to
  // show" would render an exfiltrating tenant as a clean one.
  const value = assessmentFixture(true)
  value.users = ['a', 'b', 'c'].map((character) =>
    assessmentUser('HV-ID-MBX-001.v1', character)
  )
  value.rules[0].matchedIdentities = 0
  value.rules[2].assessedIdentities = 3
  value.rules[2].matchedIdentities = 3
  value.summary.currentUsers = { value: 0, accuracy: 'EXACT' }
  const assessment = adapt(value)

  const count = riskyUserCount({ assessment, channel: licenceBlocked })
  assert.equal(count.accuracy, 'EXACT')
  assert.equal(count.value, 0)
  // The headline itself refuses to read as an all-clear.
  assert.match(count.headline, /but there are findings/)
  assert.match(count.caption, /counts people/)
  assert.match(count.caption, /not an all-clear/)
  // And what was found travels with the number.
  assert.deepEqual(count.known, ['External mailbox forwarding: 3 mailboxes'])

  // A genuinely clean tenant keeps the plain wording; this is not a blanket
  // hedge applied to every zero.
  const clean = riskyUserCount({
    assessment: adapt(assessmentFixture(false)),
    channel: licenceBlocked,
  })
  assert.equal(clean.value, 0)
  assert.doesNotMatch(clean.headline, /but there are findings/)
  assert.deepEqual(clean.known, [])
})

test('a zero says what it is a proportion of, and admits it is not people', () => {
  // A zero invites one question: out of how many? The contract carries no
  // identity population, so the honest answer is that the number qualifies the
  // checks that ran. Leaving it unsaid lets a technician supply "out of
  // everyone" themselves, which is the reading that makes a zero dangerous.
  const zero = riskyUserCount({
    assessment: adapt(assessmentFixture(false)),
    channel: licenceBlocked,
  })
  assert.equal(zero.value, 0)
  assert.ok(
    zero.gaps.some((gap) =>
      /not reported how many identities in this tenant were in scope/.test(gap)
    )
  )
  assert.ok(
    zero.gaps.some((gap) => /not a proportion of your people/.test(gap))
  )

  // A positive count is a report of what was found rather than a claim about
  // what was not, so it does not carry the same qualification.
  const positive = riskyUserCount({
    assessment: adapt(assessmentFixture(true)),
    channel: licenceBlocked,
  })
  assert.equal(positive.value, 1)
  assert.ok(!positive.gaps.some((gap) => /proportion of your people/.test(gap)))
})

test('every reason a count was withheld is carried, not the first one', () => {
  // Unresolved mailbox bindings and uninterpretable sign-in codes are
  // independent problems and a tenant can have both. Showing one of them reads
  // as "this is the reason", which sends a technician to fix half of it.
  const value = assessmentFixture(false)
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reasons: ['UNRESOLVED_SUBJECT_IDENTITY', 'UNINTERPRETABLE_EVIDENCE'],
  }
  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.equal(count.accuracy, 'WITHHELD')
  assert.equal(count.reasons.length, 2)
  assert.ok(count.reasons.some((reason) => /belongs to a person/.test(reason)))
  assert.ok(count.reasons.some((reason) => /does not recognise/.test(reason)))
  // The headline does not privilege either one.
  assert.match(count.headline, /2 reasons/)
  assert.doesNotMatch(count.headline, /tied to people|interpreted/)

  // A single reason keeps its own specific headline, which is more useful.
  const one = assessmentFixture(false)
  one.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reasons: ['UNRESOLVED_SUBJECT_IDENTITY'],
  }
  const single = riskyUserCount({
    assessment: adapt(one),
    channel: licenceBlocked,
  })
  assert.match(single.headline, /could not be tied to people/)
  assert.equal(single.reasons.length, 1)
})

test('the older single-reason shape is still accepted', () => {
  // Both forms normalise to a list, so the client does not need the server to
  // migrate first.
  const value = assessmentFixture(false)
  value.summary.currentUsers = {
    value: null,
    accuracy: 'UNKNOWN',
    reason: 'CAPACITY_LIMIT',
  }
  const count = riskyUserCount({
    assessment: adapt(value),
    channel: licenceBlocked,
  })
  assert.equal(count.accuracy, 'WITHHELD')
  assert.match(count.headline, /more evidence than a single assessment covers/)
})

test('a repeated or unknown reason is refused rather than shown twice', () => {
  for (const reasons of [
    ['CAPACITY_LIMIT', 'CAPACITY_LIMIT'],
    ['NOT_A_REAL_REASON'],
  ]) {
    const value = assessmentFixture(false)
    value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN', reasons }
    assert.equal(
      adaptRiskAssessmentResponse(value, assessmentNow),
      null,
      JSON.stringify(reasons)
    )
  }
})

test('ordering does not depend on what the customer pays Microsoft', () => {
  // Microsoft's channel is populated on Entra ID P2 tenants and empty
  // everywhere else. If corroboration ordered the list, the same two HawkView
  // findings would sort one way on a P2 tenant and the other way on an
  // identical tenant without it — a rule that changes per tenant without
  // saying so, invisible from any single screen.
  const build = () => {
    const value = assessmentFixture(true)
    Object.assign(value.users[0], {
      correlation: guid,
      displayName: 'Low, corroborated',
    })
    const louder = assessmentUser('HV-ID-AUTH-005.v2', 'b')
    louder.label = 'Medium, single source'
    value.users.push(louder)
    value.rules[1].matchedIdentities = 1
    value.summary.currentUsers = { value: 2, accuracy: 'EXACT' }
    return adapt(value)
  }

  const onP2 = riskyUserList(build(), reportingMicrosoft(), [
    microsoftRecord(guid),
  ]).rows.map((row) => row.name)
  const withoutP2 = riskyUserList(build(), licenceBlocked).rows.map(
    (row) => row.name
  )
  assert.deepEqual(onP2, withoutP2)
  assert.deepEqual(onP2, ['Medium, single source', 'Low, corroborated'])
})

test('corroboration breaks ties inside a priority band', () => {
  // It cannot flip a High below a Low, but it does put the row two systems
  // agree on at the top of its own band.
  const value = assessmentFixture(true)
  Object.assign(value.users[0], {
    correlation: guid,
    displayName: 'Low, corroborated',
  })
  const other = assessmentUser('HV-ID-AUTH-010.v1', 'b')
  other.label = 'Low, single source'
  value.users.push(other)
  value.rules[0].assessedIdentities = 2
  value.rules[0].matchedIdentities = 2
  value.summary.currentUsers = { value: 2, accuracy: 'EXACT' }

  const rows = riskyUserList(adapt(value), reportingMicrosoft(), [
    microsoftRecord(guid),
  ]).rows
  assert.deepEqual(
    rows.map((row) => row.priority),
    ['LOW', 'LOW']
  )
  assert.equal(rows[0].name, 'Low, corroborated')
})

test('the panel never claims unavailability while showing Microsoft records', () => {
  // Microsoft verdicts reach HawkView through sign-in evidence too, which
  // needs no Entra ID P2 licence, so records and an unlicensed channel are
  // independent facts and both can hold at once. "Requires Entra ID P2"
  // printed above those records is a flat contradiction on one screen.
  const unlicensed = unavailableMicrosoftEntraRiskyUsers(
    'UNAVAILABLE',
    'Microsoft Entra risky-user evidence is not available on this tenant.',
    'LICENSE_REQUIRED'
  )
  const withRecords = {
    ...unlicensed,
    users: [microsoftRecord(null, 'a'), microsoftRecord(null, 'b')],
  }
  const channel = microsoftChannel(withRecords)
  assert.equal(channel.state, 'CONTRADICTORY')
  assert.match(channel.headline, /2 records/)
  assert.match(channel.headline, /reports itself unavailable/)
  // Neither half is suppressed: the records stand, and the status is marked
  // as not to be relied on rather than quietly dropped.
  assert.match(channel.detail, /cannot both be right/)
  assert.match(channel.detail, /should not be relied on/)
  // And it does not turn an unlicensed tenant into a licensed-looking one.
  assert.doesNotMatch(channel.headline, /requires Entra ID P2/)
  assert.equal(channel.addressable, false)

  // With no records the licence statement is still exactly right.
  assert.equal(microsoftChannel(unlicensed).state, 'UNAVAILABLE')
  assert.match(microsoftChannel(unlicensed).headline, /requires Entra ID P2/)
})

test('a signal that found nothing reads as a result, not as untimed evidence', () => {
  // Live shape: two of the nine findings on the fleet carry a zero lockout
  // count beside a real rejection count. "0 records" describes evidence that
  // exists and was not counted, and beside "no time recorded" it describes
  // evidence that exists and was not dated. Neither is what happened.
  const evaluated = findingEvidenceSummary(
    {
      ruleId: 'HV-ID-AUTH-010.v1',
      evidenceCount: 0,
      evidenceCountCapped: false,
      lastSeen: null,
    },
    (value) => value
  )
  assert.equal(evaluated.count, 'none recorded')
  assert.equal(evaluated.timing, null)

  // A capped zero is a different answer, and the more dangerous one to blur:
  // the window was truncated before the check saw anything, so this is the
  // absence of a reading rather than a finding of none.
  const truncated = findingEvidenceSummary(
    {
      ruleId: 'HV-ID-AUTH-010.v1',
      evidenceCount: 0,
      evidenceCountCapped: true,
      lastSeen: null,
    },
    (value) => value
  )
  assert.match(truncated.count ?? '', /truncated/)
  assert.notEqual(truncated.count, evaluated.count)

  // A state read that found nothing still happened, and when it happened is
  // worth knowing; nothing occurred for an event check to have timed.
  const nothingConfigured = findingEvidenceSummary(
    {
      ruleId: 'HV-ID-MBX-001.v1',
      evidenceCount: 0,
      evidenceCountCapped: false,
      lastSeen: '2026-09-08T00:00:00.000Z',
    },
    () => 'THE-READ-TIME'
  )
  assert.equal(nothingConfigured.count, 'none configured')
  assert.match(
    nothingConfigured.timing ?? '',
    /configuration read THE-READ-TIME/
  )
})

test('no combination of inputs can assemble a zero lower bound', () => {
  // "At least 0" excludes nothing, so it is a bound that claims to inform and
  // does not. This surface removed it once already, from the tenant count card,
  // and it reappeared here by a different path — a capped zero going through
  // the ordinary floor wording. A sweep rather than a case, because the defect
  // is the phrase being assembled from parts, and parts recombine.
  // Positive control, because this sweep has already failed silently once: the
  // patterns were written with a mangled escape and matched nothing, so every
  // case passed and the run looked green. A sweep that cannot fail is worse
  // than no sweep, since its silence is read as a result. These two lines prove
  // the patterns are live before the loop trusts them.
  const banned = [/at least 0\b/, /\b0 record/]
  assert.ok(banned[0].test('at least 0 records'), 'bound pattern is inert')
  assert.ok(banned[1].test('0 records, last Tuesday'), 'count pattern is inert')

  for (const ruleId of [
    'HV-ID-AUTH-010.v1',
    'HV-ID-AUTH-005.v2',
    'HV-ID-MBX-001.v1',
    'HV-ID-UNKNOWN-000.v9',
  ]) {
    for (const evidenceCount of [0, 1, 2]) {
      for (const evidenceCountCapped of [false, true]) {
        for (const lastSeen of [null, '2026-09-08T00:00:00.000Z']) {
          // The coverage panel builds a count phrase from the same parts, in a
          // component that never knew about this ban. That is how "at least 0"
          // got assembled a second time, so it is swept here rather than there.
          const scope = ruleScopeSummary({
            assessedIdentities: evidenceCount,
            countsCapped: evidenceCountCapped,
          })
          for (const pattern of banned) {
            assert.ok(!pattern.test(scope), 'rule scope :: ' + scope)
          }
          const summary = findingEvidenceSummary(
            { ruleId, evidenceCount, evidenceCountCapped, lastSeen },
            (value) => value
          )
          const rendered = [summary.count, summary.timing, summary.note]
            .filter(Boolean)
            .join(' | ')
          const label =
            ruleId + ' n=' + evidenceCount + ' capped=' + evidenceCountCapped
          for (const pattern of banned) {
            assert.ok(!pattern.test(rendered), label + ' :: ' + rendered)
          }
        }
      }
    }
  }
})

test('a check with nobody to examine does not read as a check that found nobody', () => {
  // The state the live engine reports on every tenant today, three of which are
  // under attack: zero eligible subjects. "0 identities evaluated by this
  // check" beside a readiness of Ready describes a check that ran over a
  // population and came back empty. The truth is that it had no population.
  // One is a quiet tenant; the other is a broken pipeline, and they send a
  // technician to different places.
  assert.equal(
    ruleScopeSummary({ assessedIdentities: 0, countsCapped: false }),
    'no identities were in scope for this check'
  )

  // Truncated before anything was counted is a third answer again: the check
  // cannot say nobody was in scope either.
  assert.match(
    ruleScopeSummary({ assessedIdentities: 0, countsCapped: true }),
    /truncated/
  )
  assert.notEqual(
    ruleScopeSummary({ assessedIdentities: 0, countsCapped: true }),
    ruleScopeSummary({ assessedIdentities: 0, countsCapped: false })
  )

  // A real population keeps its number, and a capped one states its bound
  // rather than trailing a parenthetical the reader may not tie to the count.
  assert.equal(
    ruleScopeSummary({ assessedIdentities: 2, countsCapped: false }),
    '2 identities evaluated by this check'
  )
  assert.equal(
    ruleScopeSummary({ assessedIdentities: 2, countsCapped: true }),
    'at least 2 identities evaluated by this check'
  )
  assert.equal(
    ruleScopeSummary({ assessedIdentities: 1, countsCapped: false }),
    '1 identity evaluated by this check'
  )

  // Never reported stays distinct from zero: one is a gap in what the server
  // said, the other is a statement the server made.
  assert.equal(
    ruleScopeSummary({ assessedIdentities: null, countsCapped: false }),
    'identities evaluated not reported'
  )
})
