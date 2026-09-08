import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptRiskAssessmentResponse } from './adapter.ts'
import { riskAssessmentEmptyPresentation } from './presentation.ts'
import {
  assessmentFixture,
  assessmentUser,
  assessmentNow,
  at,
  opaque,
} from './assessment-test-fixtures.ts'

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

test('rejects malformed provenance, future event evidence, unknown fields and unsupported schema', () => {
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
    (v: any) => {
      v.rawEvent = {}
    },
    (v: any) => {
      v.rules.pop()
    },
  ]) {
    const value = assessmentFixture(true)
    mutate(value)
    assert.equal(adaptRiskAssessmentResponse(value, assessmentNow), null)
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
