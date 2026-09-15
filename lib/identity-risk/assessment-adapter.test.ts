import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptRiskAssessmentResponse } from './adapter.ts'
import { hawkViewRiskyUserCountPresentation, riskAssessmentEmptyPresentation } from './presentation.ts'
import {
  assessmentFixture,
  assessmentUser,
  assessmentNow,
  at,
  opaque,
} from './assessment-test-fixtures.ts'

test('out-of-scope authentication evidence remains readable and cannot display a confident zero', () => {
  const value = assessmentFixture()
  value.meta.capability = 'PARTIAL'
  value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  for (const rule of value.rules.filter((rule: { ruleId: string }) => rule.ruleId !== 'HV-ID-MBX-001.v1')) {
    Object.assign(rule, { status: 'PARTIAL', reasonCode: 'OUT_OF_SCOPE_EVENTS',
      assessedIdentities: null, matchedIdentities: null,
      explanation: 'Non-qualifying events outside the assessed scope are not assessed by this check.' })
  }
  const view = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(view)
  assert.match(view.rules[0].explanation, /outside the assessed scope/)
  assert.equal(hawkViewRiskyUserCountPresentation(view).exact, false)
  assert.notEqual(hawkViewRiskyUserCountPresentation(view).value, '0')
  assert.notEqual(riskAssessmentEmptyPresentation(view)?.label, 'No findings in evaluated evidence')
  for (const reason of ['OUT_OF_SCOPE_EVENTS_INVENTED', 'password=synthetic-secret']) {
    value.rules[0].reasonCode = reason
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
  }
})

test('accepts current authoritative assessment metadata and exact three release tuples', () => {
  for (const rule of [
    'HV-ID-AUTH-010.v1',
    'HV-ID-AUTH-005.v2',
    'HV-ID-MBX-001.v1',
  ] as const) {
    const value = assessmentFixture(true)
    value.users = [assessmentUser(rule)]
    const result = adaptRiskAssessmentResponse(value, assessmentNow)
    assert.ok(result)
    assert.equal(result.meta.observedAt, null)
    assert.equal(result.users[0].findings[0].ruleId, rule)
  }
})

test('rejects unsupported priority/version/source/identity combinations and the old break-glass ID', () => {
  for (const patch of [
    { ruleId: 'HV-ID-AUTH-009.v1' },
    { priority: 'CRITICAL' },
    { priority: 'HIGH' },
    { ruleVersion: 'v2' },
    { selectedSource: 'MAILBOX_RULES' },
    { application: { id: null, state: 'NOT_REPORTED', label: 'Guessed app' } },
    { device: { state: 'NOT_REPORTED', label: 'Guessed device' } },
    { clientSource: { reference: '192.0.2.1', qualification: 'QUALIFIED' } },
  ]) {
    const value = assessmentFixture(true)
    Object.assign(value.users[0].findings[0], patch)
    assert.equal(
      adaptRiskAssessmentResponse(value, assessmentNow),
      null,
      JSON.stringify(patch)
    )
  }
  const wrongSubject = assessmentFixture(true)
  wrongSubject.users[0].subjectType = 'MAILBOX'
  wrongSubject.users[0].id = opaque('mailbox')
  assert.equal(adaptRiskAssessmentResponse(wrongSubject, assessmentNow), null)
  const wrongRule = assessmentFixture()
  wrongRule.rules[0].selectedSource = 'MAILBOX_RULES'
  assert.equal(adaptRiskAssessmentResponse(wrongRule, assessmentNow), null)
})

test('qualified positives remain visible with partial coverage or unavailable mailbox evidence', () => {
  const value = assessmentFixture(true)
  Object.assign(value.sources[0], {
    status: 'PARTIAL',
    reasonCode: 'INCOMPLETE_WINDOW',
  })
  Object.assign(value.sources[2], {
    status: 'MISSING_PERMISSION',
    reasonCode: 'MISSING_PERMISSION',
    freshness: 'UNKNOWN',
    lastSuccessfulCollectionAt: null,
  })
  Object.assign(value.rules[0], {
    status: 'PARTIAL',
    reasonCode: 'INCOMPLETE_WINDOW',
    countsCapped: true,
    assessedIdentities: null,
    matchedIdentities: null,
  })
  Object.assign(value.rules[2], {
    status: 'MISSING_PERMISSION',
    reasonCode: 'MISSING_PERMISSION',
    assessedIdentities: null,
    matchedIdentities: null,
  })
  Object.assign(value.meta, {
    capability: 'PARTIAL',
    freshness: 'UNKNOWN',
    limitation: 'Only qualified authentication findings are available.',
  })
  value.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }
  const result = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(result)
  assert.equal(result.users.length, 1)
  assert.equal(result.users[0].priority, 'LOW')
})

test('outage and old historical findings do not become resolved or disappear', () => {
  const value = assessmentFixture(true)
  Object.assign(value.meta, {
    capability: 'UNAVAILABLE',
    status: 'STALE',
    freshness: 'STALE',
    limitation: 'Collection is stale.',
  })
  value.users[0].priority = null
  value.users[0].findings[0].activityState = 'HISTORICAL'
  value.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  const result = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(result)
  assert.equal(result.users[0].findings[0].activityState, 'HISTORICAL')
})

test('empty success requires all current assessed rules, complete windows and a complete page', () => {
  const result = adaptRiskAssessmentResponse(
    assessmentFixture(),
    assessmentNow
  )!
  assert.equal(
    riskAssessmentEmptyPresentation(result)?.label,
    'No findings in evaluated evidence'
  )
  for (const mutate of [
    (v: any) => {
      v.rules[1].status = 'INSUFFICIENT_FIELDS'
    },
    (v: any) => {
      v.rules[0].assessedIdentities = 0
    },
    (v: any) => {
      v.rules[2].window.start = null
    },
    (v: any) => {
      v.sources[2].freshness = 'STALE'
    },
    (v: any) => {
      v.rules[0].countsCapped = true
    },
    (v: any) => {
      v.page = { hasMore: true, nextCursor: 'eyJvZmZzZXQiOjEwMH0' }
    },
  ]) {
    const value = assessmentFixture()
    mutate(value)
    const adapted = adaptRiskAssessmentResponse(value, assessmentNow)
    if (adapted)
      assert.notEqual(
        riskAssessmentEmptyPresentation(adapted)?.label,
        'No findings in evaluated evidence'
      )
  }
})

test('exact identity references remain distinct despite identical display labels', () => {
  const value = assessmentFixture(true)
  value.users.push(assessmentUser('HV-ID-AUTH-010.v1', 'b'))
  value.summary.currentUsers.value = 2
  assert.equal(
    adaptRiskAssessmentResponse(value, assessmentNow)?.users.length,
    2
  )
  value.users[1].id = value.users[0].id
  assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
})

test('accepts server-resolved exact GUID mailbox rollup under a USER without weakening per-finding tuples', () => {
  const value = assessmentFixture(true)
  value.users[0].findings.push(
    assessmentUser('HV-ID-MBX-001.v1', 'b').findings[0]
  )
  value.users[0].priority = 'HIGH'
  const result = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(result)
  assert.equal(result.users[0].subjectType, 'USER')
  assert.equal(result.users[0].findings.length, 2)
  value.users[0].findings[1].selectedSource = 'GRAPH_SIGN_INS'
  assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
})

test('rejects malformed provenance, future event evidence and unsupported schema', () => {
  for (const mutate of [
    (v: any) => {
      v.users[0].protection.legacyPerUserMfa = 'ENFORCED'
    },
    (v: any) => {
      v.users[0].findings[0].lastSeen = at(30)
    },
    (v: any) => {
      v.schemaVersion = 'future/v2'
    },
  ]) {
    const value = assessmentFixture(true)
    mutate(value)
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
  }
})

test('tolerates unknown fields at every level without projecting them', () => {
  // The backend and this client ship from the same repository and there is no
  // external consumer, so the server adding a field must never cost the
  // technician the whole assessment. Unknown fields are ignored, and because
  // every adapter names the fields it reads, none of them can reach the screen.
  const root = assessmentFixture(true)
  root.rawEvent = {}
  root.evaluationTrace = ['ignored']
  const adaptedRoot = adaptRiskAssessmentResponse(root, assessmentNow)
  assert.ok(adaptedRoot)
  assert.ok(!Object.hasOwn(adaptedRoot!, 'rawEvent'))
  assert.ok(!Object.hasOwn(adaptedRoot!, 'evaluationTrace'))

  const nested = assessmentFixture(true)
  nested.meta.experimentArm = 'B'
  nested.sources[0].collectorBuild = 'abc123'
  nested.rules[0].debugCounters = { skipped: 4 }
  nested.users[0].tenantHint = 'ignored'
  nested.users[0].findings[0].rawScore = 0.91
  nested.users[0].protection.experimentalSignal = 'ignored'
  const adaptedNested = adaptRiskAssessmentResponse(nested, assessmentNow)
  assert.ok(adaptedNested)
  assert.ok(!Object.hasOwn(adaptedNested!.meta, 'experimentArm'))
  assert.ok(!Object.hasOwn(adaptedNested!.sources[0], 'collectorBuild'))
  assert.ok(!Object.hasOwn(adaptedNested!.rules[0], 'debugCounters'))
  assert.ok(!Object.hasOwn(adaptedNested!.users[0], 'tenantHint'))
  assert.ok(!Object.hasOwn(adaptedNested!.users[0].findings[0], 'rawScore'))
  assert.ok(
    !Object.hasOwn(adaptedNested!.users[0].protection, 'experimentalSignal')
  )

  const summary = assessmentFixture(true)
  summary.summary.extra = true
  summary.summary.currentUsers.derivation = 'ignored'
  const adaptedSummary = adaptRiskAssessmentResponse(summary, assessmentNow)
  assert.ok(adaptedSummary)
  assert.ok(!Object.hasOwn(adaptedSummary!.summary!, 'extra'))
  assert.ok(!Object.hasOwn(adaptedSummary!.summary!.currentUsers, 'derivation'))
  // The tolerated fields changed nothing about what the count claims.
  assert.equal(adaptedSummary!.summary!.currentUsers.accuracy, 'EXACT')
})

test('still requires every contracted field to be present', () => {
  // Tolerating an unknown field is not the same as tolerating a missing one.
  for (const mutate of [
    (v: any) => delete v.meta,
    (v: any) => delete v.rules,
    (v: any) => delete v.page,
    (v: any) => delete v.meta.freshness,
    (v: any) => delete v.sources[0].window,
    (v: any) => delete v.users[0].findings[0].explanation,
    (v: any) => delete v.summary.currentUsers.accuracy,
  ]) {
    const value = assessmentFixture(true)
    mutate(value)
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
  }
})

function unknownRule(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'HV-ID-NEW-042.v1',
    ruleVersion: 'v1',
    title: 'A check this client has no metadata for',
    status: 'READY',
    reasonCode: 'READY',
    explanation: 'This check evaluated its reported evidence window.',
    selectedSource: 'GRAPH_SIGN_INS',
    window: { start: at(-15), end: at() },
    evaluatedAt: at(),
    assessedIdentities: 2,
    matchedIdentities: 0,
    countsCapped: false,
    ...overrides,
  }
}

test('accepts a rule the client carries no metadata for', () => {
  // The backend rule catalogue changes on its own schedule. A new check must
  // not cost the technician the rest of the assessment.
  const value = assessmentFixture(true)
  value.rules.push(unknownRule())
  const adapted = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(adapted)
  assert.equal(adapted!.rules.length, 4)
  const added = adapted!.rules.find(
    (rule) => rule.ruleId === 'HV-ID-NEW-042.v1'
  )
  assert.ok(added)
  assert.equal(added!.title, 'A check this client has no metadata for')
  assert.equal(added!.status, 'READY')

  // A shorter reported rule set is equally acceptable.
  const fewer = assessmentFixture(false)
  fewer.rules.pop()
  assert.ok(adaptRiskAssessmentResponse(fewer, assessmentNow))
})

test('never drops a finding because it cites an unrecognised rule', () => {
  // Losing a finding is the worst outcome this surface has: it is an
  // investigation lead disappearing with no trace that it existed.
  const value = assessmentFixture(true)
  value.rules.push(unknownRule({ matchedIdentities: 1 }))
  value.users[0].findings[0].ruleId = 'HV-ID-NEW-042.v1'
  value.users[0].findings[0].ruleVersion = 'v1'
  value.users[0].findings[0].selectedSource = 'GRAPH_SIGN_INS'
  const adapted = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(adapted)
  assert.equal(adapted!.users[0].findings.length, 1)
  assert.equal(adapted!.users[0].findings[0].ruleId, 'HV-ID-NEW-042.v1')
})

test('holds a rule the client does know to its published metadata', () => {
  for (const mutate of [
    (v: any) => {
      v.rules[0].ruleVersion = 'v9'
    },
    (v: any) => {
      v.rules[2].selectedSource = 'GRAPH_SIGN_INS'
    },
    (v: any) => {
      v.users[0].findings[0].priority = 'HIGH'
    },
  ]) {
    const value = assessmentFixture(true)
    mutate(value)
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
  }
})

test('still rejects a malformed rule identifier', () => {
  for (const ruleId of [
    'not a rule id',
    'HV-ID-NEW-042',
    'hv-id-new-042.v1',
    '<script>.v1',
    `${'H'.repeat(80)}.v1`,
    '',
    null,
    42,
  ]) {
    const value = assessmentFixture(false)
    value.rules[0].ruleId = ruleId
    assert.equal(
      adaptRiskAssessmentResponse(value, assessmentNow),
      null,
      String(ruleId)
    )
  }
})

test('an unrecognised rule clears the same evidence bar before it counts as clean', () => {
  const clean = assessmentFixture(false)
  clean.rules.push(unknownRule())
  const adapted = adaptRiskAssessmentResponse(clean, assessmentNow)
  assert.ok(adapted)
  const presentation = riskAssessmentEmptyPresentation(adapted!)
  assert.equal(presentation?.label, 'No findings in evaluated evidence')
  // The copy states what was actually evaluated rather than a fixed number.
  assert.match(presentation!.detail, /All 4 checks this tenant/)

  // The same unknown rule without a complete evaluated scope withdraws the
  // clean claim for the whole assessment, exactly as a known rule would. The
  // optional summary is dropped here because an incomplete check also forces
  // capability down to PARTIAL, which an EXACT tenant count would contradict.
  for (const overrides of [
    { status: 'PARTIAL', reasonCode: 'INCOMPLETE_WINDOW' },
    { assessedIdentities: 0 },
    { countsCapped: true },
    { evaluatedAt: null },
    { selectedSource: null },
  ]) {
    const degraded = assessmentFixture(false)
    delete degraded.summary
    degraded.rules.push(unknownRule(overrides))
    const view = adaptRiskAssessmentResponse(degraded, assessmentNow)
    assert.ok(view, JSON.stringify(overrides))
    assert.notEqual(
      riskAssessmentEmptyPresentation(view!)?.label,
      'No findings in evaluated evidence',
      JSON.stringify(overrides)
    )
  }
})

test('accepts actual approved invalid-credential copy without allowing secret-shaped text', () => {
  const value = assessmentFixture(true)
  value.rules[0].title = 'Repeated invalid-credential attempts'
  value.users[0].findings[0].title = 'Repeated invalid-credential attempts'
  value.users[0].findings[0].explanation =
    'At least 10 distinct invalid-credential attempts were recorded for this account and application within 15 minutes.'
  assert.ok(adaptRiskAssessmentResponse(value, assessmentNow))
  value.users[0].findings[0].explanation += ' password=synthetic-secret'
  assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
})

test('matches bounded backend policy, finding and count limits without truncating legitimate users', () => {
  const value = assessmentFixture(true)
  value.users[0].protection.conditionalAccess.policies = Array.from(
    { length: 100 },
    (_, index) => ({
      id: `policy-${index}`,
      name: 'P'.repeat(256),
      state: 'REPORT_ONLY',
      outcome: 'UNIVERSAL',
      materialConditions: [],
    })
  )
  value.users[0].protection.conditionalAccess.reasonCodes = Array.from(
    { length: 32 },
    (_, index) => `REASON_${index}`
  )
  value.users[0].findings = Array.from({ length: 200 }, (_, index) => ({
    ...value.users[0].findings[0],
    id: `hvr1_contribution_${index.toString(16).padStart(64, '0')}`,
    evidenceCount: 1_000_000,
  }))
  value.rules[0].assessedIdentities = 1_000_000
  assert.ok(adaptRiskAssessmentResponse(value, assessmentNow))
  value.users[0].findings.push({
    ...value.users[0].findings[0],
    id: opaque('contribution', 'f'),
  })
  assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
})

test('normal authorized policy vocabulary is not mistaken for a secret value', () => {
  for (const name of [
    'Require MFA and password change',
    'Token protection for staff',
  ]) {
    const value = assessmentFixture(true)
    value.users[0].protection.conditionalAccess.policies = [
      {
        id: 'synthetic-policy',
        name,
        state: 'REPORT_ONLY',
        outcome: 'UNIVERSAL',
        materialConditions: [],
      },
    ]
    value.users[0].findings[0].application.label = name
    assert.ok(adaptRiskAssessmentResponse(value, assessmentNow))
    value.users[0].protection.conditionalAccess.policies[0].name =
      'password=synthetic-secret'
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
  }
})

test('accepts old assessment responses without a summary but never invents one', () => {
  const value = assessmentFixture(true)
  delete value.summary
  const result = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(result)
  assert.equal(result.summary, null)
  assert.equal(result.users.length, 1)
})

test('accepts backend-realistic lower bounds and conservative unknown summaries', () => {
  const partial = assessmentFixture(true)
  Object.assign(partial.meta, {
    capability: 'PARTIAL',
    freshness: 'UNKNOWN',
    limitation: 'Coverage is limited to individually reported evidence.',
  })
  Object.assign(partial.rules[2], {
    status: 'PARTIAL',
    reasonCode: 'INCOMPLETE_WINDOW',
    countsCapped: true,
  })
  partial.summary.currentUsers = { value: 1, accuracy: 'AT_LEAST' }
  assert.equal(
    adaptRiskAssessmentResponse(partial, assessmentNow)?.summary?.currentUsers
      .accuracy,
    'AT_LEAST'
  )

  const conservative = assessmentFixture(true)
  conservative.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  assert.equal(
    adaptRiskAssessmentResponse(conservative, assessmentNow)?.summary
      ?.currentUsers.accuracy,
    'UNKNOWN'
  )
})

test('rejects malformed or contradictory tenant count summaries', () => {
  class UnsafeSummary {
    scope = 'TENANT'
    asOf = at()
    currentUsers = { value: 1, accuracy: 'EXACT' }
  }
  const malformed = [
    new UnsafeSummary(),
    {
      scope: 'WORKSPACE',
      asOf: at(),
      currentUsers: { value: 1, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(30),
      currentUsers: { value: 1, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(-1),
      currentUsers: { value: 1, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: -1, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: 1.5, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: 1_000_001, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: 1, accuracy: 'UNKNOWN' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: null, accuracy: 'EXACT' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: null, accuracy: 'AT_LEAST' },
    },
    {
      scope: 'TENANT',
      asOf: at(),
      currentUsers: { value: 0, accuracy: 'AT_LEAST' },
    },
  ]
  for (const summary of malformed) {
    const value = assessmentFixture(true)
    value.summary = summary
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
  }

  const belowReturned = assessmentFixture(true)
  belowReturned.users.push(assessmentUser('HV-ID-AUTH-010.v1', 'b'))
  belowReturned.summary.currentUsers.value = 1
  assert.equal(adaptRiskAssessmentResponse(belowReturned, assessmentNow), null)
})

test('summary counts distinct current USER identities and excludes mailbox context', () => {
  const value = assessmentFixture(true)
  value.users[0].findings.push(
    assessmentUser('HV-ID-AUTH-005.v2', 'b').findings[0]
  )
  value.users[0].priority = 'MEDIUM'
  value.users.push(assessmentUser('HV-ID-MBX-001.v1', 'c'))
  value.summary.currentUsers.value = 1
  const result = adaptRiskAssessmentResponse(value, assessmentNow)
  assert.ok(result)
  assert.equal(result.summary?.currentUsers.value, 1)
  assert.equal(result.users.length, 2)
})

test('a claim of full coverage is checked against the evidence, not taken', () => {
  // The client recomputes completeness from the per-rule and per-source fields
  // and downgrades a FULL claim the evidence does not support. An exact count
  // then cannot stand, because EXACT is only accepted on a payload that is
  // still FULL after that check.
  //
  // This chain is the reason a server cannot assert an exact tenant total on
  // stale or incomplete evidence -- and until this test it was entirely
  // unguarded. Both halves of it could be deleted with the suite staying green,
  // which is how it was found: mutating it changed nothing, and a guard nothing
  // depends on is indistinguishable from one that was already broken.
  const stale = assessmentFixture(true)
  stale.sources[0].freshness = 'STALE'
  assert.equal(
    adaptRiskAssessmentResponse(stale, assessmentNow),
    null,
    'an exact count was accepted over evidence that cannot support it'
  )

  // The downgrade itself, observed where the count is not exact so the payload
  // survives to be inspected: the server says FULL, the evidence says
  // otherwise, and the client does not repeat the server's word.
  const withheld = assessmentFixture(true)
  withheld.sources[0].freshness = 'STALE'
  withheld.summary.currentUsers = { value: null, accuracy: 'UNKNOWN' }
  const downgraded = adaptRiskAssessmentResponse(withheld, assessmentNow)
  assert.ok(downgraded)
  assert.equal(downgraded!.meta.capability, 'PARTIAL')
  assert.equal(downgraded!.meta.freshness, 'UNKNOWN')
  assert.match(
    downgraded!.meta.limitation ?? '',
    /lack complete current evidence/
  )

  // Control: complete evidence keeps the claim. Without this half the guard
  // passes just as well if the downgrade were unconditional, which would make
  // every tenant permanently partial and the state meaningless.
  const complete = adaptRiskAssessmentResponse(
    assessmentFixture(true),
    assessmentNow
  )
  assert.ok(complete)
  assert.equal(complete!.meta.capability, 'FULL')
  assert.equal(complete!.summary?.currentUsers.accuracy, 'EXACT')
})
