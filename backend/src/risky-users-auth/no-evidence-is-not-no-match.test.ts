import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { evaluateAuthenticationRules } from './index.js'
import type { AuthEvaluationInput } from './contract.js'
import { projectAuthenticationAssessment } from './to-assessment.js'
import { assessmentReason } from '../identity-risk/risk-assessment-projection.js'
import { SYNTHETIC_SCOPE as scope, SYNTHETIC_NOW, at, graphRecord, evaluation, failures } from './fixtures.js'
import {
  AUTH_WINDOW_SCHEMA_V1, prepareAuthenticationEvaluation,
  type AuthenticationDirectoryUser, type AuthenticationProof,
  type AuthenticationRow, type AuthenticationWindow,
} from '../identity-risk/authentication-source-readiness.js'

/**
 * ASSESSED AND CLEAR IS NOT THE SAME SENTENCE AS NOT LOOKED AT.
 *
 * `NOT_MATCHED` is a claim: the rule ran over evidence and nothing satisfied it.
 * A rule handed zero events has not run over anything, and saying "nothing
 * matched" about an empty window asserts a result nobody measured.
 *
 * PROVENANCE, AND A RETRACTION. This was introduced as a defect measured on
 * production: two of five tenants said to have stopped producing sign-in
 * evidence (2026-09-10 and 2026-08-30) while collection kept succeeding. THAT
 * READING WAS WITHDRAWN by the person who took it. A later query, joined on
 * organization id so tenant identity stayed consistent across tables, found no
 * tenant whose collection had stopped; the dates were RESOURCE-level staleness
 * on otherwise-healthy tenants, reported as tenant-level.
 *
 * None of the tests below depended on it, and none changed. What they test is
 * that `NOT_MATCHED` and "nothing was there to assess" are different sentences
 * — a claim about this code, not about any tenant. The withdrawn example stays
 * here, marked, because a motivating anecdote that quietly disappears is one
 * somebody re-derives later.
 *
 * The distinction is made HERE, in the evaluator, rather than in a screen,
 * because a screen can only render a difference the data already carries.
 */

const now = new Date(SYNTHETIC_NOW)
const user: AuthenticationDirectoryUser = {
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId,
  microsoftUserId: '11111111-1111-4111-8111-111111111111',
  userPrincipalName: 'synthetic.human@example.invalid', userType: 'Member',
}
// TYPED AS PRODUCTION'S RESOLVER ACTUALLY IS — the union of BOTH reference
// vocabularies. `AuthenticationReference` is the narrower four-kind alias
// (subject | application | evidence | context) and omits 'contribution', which
// `projectAuthenticationAssessment` requires; `assessmentManagedReference` in the
// projector returns all five, which is why production compiles and this did not.
// The annotation was the defect, not the function: a five-kind resolver is still
// assignable everywhere the four-kind one is expected.
const reference = async (
  kind: 'subject' | 'application' | 'contribution' | 'evidence' | 'context',
  identifiers: readonly string[],
): Promise<string> =>
  `hvr1_${kind}_${createHash('sha256').update(JSON.stringify(identifiers)).digest('hex')}`
const proof: AuthenticationProof = {
  status: 'SUCCEEDED', lastSuccessfulAt: now, lastAttemptAt: new Date(at(-2)), lastErrorCode: null,
}
const window = (): AuthenticationWindow => ({
  schemaVersion: AUTH_WINDOW_SCHEMA_V1, source: 'GRAPH_SIGN_INS',
  start: at(-24 * 60), end: SYNTHETIC_NOW, paginationComplete: true,
})
const row = (raw: unknown): AuthenticationRow => ({
  organizationId: scope.organizationId, customerTenantId: scope.customerTenantId, raw, ingestedAt: now,
})
const evaluate = async (rows: AuthenticationRow[]) => {
  const prepared = await prepareAuthenticationEvaluation(
    scope, rows, [user], proof, window(), true, now, reference)
  assert.ok(prepared.input, 'the fixture failed to prepare an evaluation input')
  return evaluateAuthenticationRules(prepared.input)
}

/** Evidence a rule can genuinely decline: real sign-ins, all codes recognised,
 *  too few to satisfy a threshold of five or ten. */
const realEvidenceNoMatch = () => {
  const rows = Array.from({ length: 3 }, (_, i) =>
    row(graphRecord({ id: `f-${i}`, createdDateTime: at(-30 + i), status: { errorCode: 50126 } })))
  rows.push(row(graphRecord({ id: 'ok', createdDateTime: at(-5), status: { errorCode: 0 } })))
  return rows
}

test('a rule over real evidence may report NOT_MATCHED', async () => {
  // The control, and it comes first deliberately. Everything below asserts that
  // some state is NOT this one, which is satisfied trivially by a build where
  // nothing ever reaches NOT_MATCHED.
  const evaluated = await evaluate(realEvidenceNoMatch())
  assert.equal(evaluated.admittedEventCount, 4)
  for (const rule of evaluated.rules) {
    assert.equal(rule.status, 'NOT_MATCHED', rule.ruleId + ' declined to decline')
    assert.deepEqual(rule.reasonCodes, [], rule.ruleId + ' carried a reason it should not have')
  }
})

test('a rule over ZERO evidence must not report NOT_MATCHED', async () => {
  // The defect. A window that was collected successfully and contained nothing
  // is not a window in which nothing matched.
  const evaluated = await evaluate([])
  assert.equal(evaluated.admittedEventCount, 0)

  for (const rule of evaluated.rules) {
    assert.notEqual(
      rule.status, 'NOT_MATCHED',
      rule.ruleId + ' claimed nothing matched, having evaluated nothing')
    assert.equal(rule.status, 'NOT_EVALUATED', rule.ruleId)
    assert.ok(
      rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      rule.ruleId + ' gave no reason for declining to evaluate: ' +
        JSON.stringify(rule.reasonCodes))
  }
})

test('the two states are distinguishable as values, not only as labels', async () => {
  // A reader comparing the two screens has to be able to tell them apart from
  // what the evaluator produced, without knowing which fixture made it.
  const clear = await evaluate(realEvidenceNoMatch())
  const empty = await evaluate([])

  assert.notDeepEqual(
    clear.rules.map(r => ({ status: r.status, reasonCodes: r.reasonCodes })),
    empty.rules.map(r => ({ status: r.status, reasonCodes: r.reasonCodes })),
    'assessed-and-clear and nothing-observed produced identical rule state')

  // Neither produces findings, which is exactly why the rule state has to carry
  // the difference: the findings list cannot.
  assert.equal(clear.findings.length, 0)
  assert.equal(empty.findings.length, 0)
})

test('an unrecognised code is a THIRD state, not folded into either', async () => {
  // QA established this one by running the evaluator: an unrecognised code does
  // not silence a run, it removes the ability to report NOT_MATCHED. Asserted
  // here so a fix for the empty-window case cannot quietly collapse it back.
  const withUnknown = [...realEvidenceNoMatch(),
    row(graphRecord({ id: 'lock', createdDateTime: at(-4), status: { errorCode: 50053 } }))]
  const evaluated = await evaluate(withUnknown)

  assert.equal(evaluated.admittedEventCount, 5)
  for (const rule of evaluated.rules) {
    assert.equal(rule.status, 'NOT_EVALUATED')
    assert.ok(rule.reasonCodes.includes('UNKNOWN_OUTCOMES'))
    assert.ok(
      !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      'evidence was present; the empty-window reason must not be claimed')
  }
})

test('the distinction survives the projection into the rule DTO', async () => {
  // THE LAYER THAT NEARLY ATE IT. `readiness()` in to-assessment.ts ends with a
  // catch-all that reports every unnamed reason as INCOMPLETE_WINDOW — the code
  // that cost a day to interpret because it means "something, unmodelled". An
  // empty window would have landed there and been reported as an incomplete
  // one, which is a different fact with a different remedy.
  //
  // Asserted end to end — prepare, evaluate, project — because a distinction
  // that exists in the evaluator and dies one layer up is not a distinction any
  // screen can render.
  const project = async (rows: AuthenticationRow[]) => {
    const prepared = await prepareAuthenticationEvaluation(
      scope, rows, [user], proof, window(), true, now, reference)
    assert.ok(prepared.input)
    const evaluated = evaluateAuthenticationRules(prepared.input)
    return projectAuthenticationAssessment(prepared.input, evaluated, reference)
  }

  const empty = await project([])
  for (const rule of empty.rules) {
    assert.equal(rule.reasonCode, 'NO_EVIDENCE_IN_WINDOW', rule.ruleId)
    assert.equal(rule.status, 'WAITING', rule.ruleId)
    assert.notEqual(
      rule.reasonCode, 'INCOMPLETE_WINDOW',
      rule.ruleId + ' fell into the catch-all')
    // The counts must not be reported either: a number over no evidence is the
    // same false precision as the status was.
    assert.equal(rule.assessedIdentities, null, rule.ruleId)
    assert.equal(rule.matchedIdentities, null, rule.ruleId)
  }

  // CONTROL. A tenant with real evidence and no findings must still reach a
  // clean READY / READY, or this fix has bought the distinction by making every
  // tenant look unassessed.
  const clear = await project(realEvidenceNoMatch())
  for (const rule of clear.rules) {
    assert.equal(rule.status, 'READY', rule.ruleId)
    assert.equal(rule.reasonCode, 'READY', rule.ruleId)
  }

  // And the sentence a person reads must not sound like a result.
  const explanation = assessmentReason('NO_EVIDENCE_IN_WINDOW')
  assert.match(explanation, /could not be evaluated/)
  assert.match(explanation, /not a finding that nothing is wrong/)
})

test('SEEDED POSITIVE: a detector that cannot fire makes every test above vacuous', async () => {
  // THE CONTROL THE REVIEW STANDARD ASKS FOR, and it is the one this file most
  // needs. Every other assertion here is of the form "this state is NOT
  // MATCHED" or "this state is NOT_EVALUATED" — all of which a build where the
  // detectors never fire satisfies perfectly. Quiet production cannot validate
  // detection, and neither can a suite made only of negatives.
  //
  // Ten qualified failures at one subject, application and address, followed by
  // a success: the pattern HV-ID-AUTH-010 exists to find. Production has never
  // produced this — the most failures ever preceding a success at the same
  // triple across all five tenants is one — which is exactly why it has to be
  // seeded here rather than waited for.
  const rows = Array.from({ length: 10 }, (_, i) =>
    row(graphRecord({ id: `hit-${i}`, createdDateTime: at(-10 + i), status: { errorCode: 50126 } })))
  rows.push(row(graphRecord({ id: 'hit-success', createdDateTime: SYNTHETIC_NOW, status: { errorCode: 0 } })))

  const evaluated = await evaluate(rows)
  assert.ok(
    evaluated.findings.length > 0,
    'the seeded positive produced no finding: detection is broken and every ' +
      'negative assertion in this file is vacuous')
  assert.deepEqual(
    evaluated.findings.map(f => f.ruleId).sort(),
    ['HV-ID-AUTH-005.v2', 'HV-ID-AUTH-010.v1'],
    'the seeded pattern no longer satisfies both rules')

  for (const rule of evaluated.rules) {
    assert.equal(rule.status, 'MATCHED', rule.ruleId)
    assert.ok(
      !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      'evidence was abundant; the empty-window reason must not be claimed')
  }
})

test('the four states are four distinct answers, compared as a set', async () => {
  // Swept rather than sampled, so a change collapsing any two fails here. These
  // are the states unit 2 exists to separate, and they must differ in the DATA
  // — a screen can only render a difference the evaluator already made.
  const positive = Array.from({ length: 10 }, (_, i) =>
    row(graphRecord({ id: `p-${i}`, createdDateTime: at(-10 + i), status: { errorCode: 50126 } })))
  positive.push(row(graphRecord({ id: 'p-ok', createdDateTime: SYNTHETIC_NOW, status: { errorCode: 0 } })))

  const states = await Promise.all([
    evaluate(positive),
    evaluate(realEvidenceNoMatch()),
    evaluate([]),
    evaluate([...realEvidenceNoMatch(),
      row(graphRecord({ id: 'u', createdDateTime: at(-4), status: { errorCode: 50053 } }))]),
  ])

  const signatures = states.map(s =>
    JSON.stringify(s.rules.map(r => [r.status, [...r.reasonCodes].sort()])))
  assert.equal(
    new Set(signatures).size, 4,
    'two of the four states produced identical rule signatures:\n  ' +
      signatures.join('\n  '))
})

test('C2: rows collected and ALL EXCLUDED is not an empty window', async () => {
  // Codex's finding, and it is the defect this unit exists to remove arriving
  // one layer in. `NO_EVIDENCE_IN_WINDOW` is added whenever the ADMITTED array
  // is empty — which is also true when preparation rejected every row for an
  // unresolved identity or an unusable application binding. Those rows exist.
  // Collection returned them. Saying "the window contained no authentication
  // activity" about them is reading absence as evidence, and the sentence is
  // simply false.
  //
  // Eleven rows for a user who is not in the directory: every one is dropped by
  // the readiness loop, gapCount goes above zero, and the admitted array is
  // empty for a completely different reason.
  const stranger = Array.from({ length: 11 }, (_, i) =>
    row(graphRecord({
      id: `ghost-${i}`, createdDateTime: at(-30 + i),
      userId: '99999999-9999-4999-8999-999999999999',
      status: { errorCode: 50126 },
    })))

  const prepared = await prepareAuthenticationEvaluation(
    scope, stranger, [user], proof, window(), true, now, reference)
  assert.ok(prepared.input)
  assert.ok(
    prepared.input.readiness.gapCount > 0,
    'the fixture failed to exclude anything; it proves nothing')
  assert.equal(prepared.input.events.length, 0, 'the fixture admitted rows it should have dropped')

  const evaluated = evaluateAuthenticationRules(prepared.input)
  for (const rule of evaluated.rules) {
    assert.ok(
      !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      rule.ruleId + ' claimed the window held no activity, over eleven rows it ' +
        'collected and then could not use: ' + JSON.stringify(rule.reasonCodes))
    assert.ok(
      rule.reasonCodes.includes('SOURCE_GAPS'),
      rule.ruleId + ' lost the reason the rows were unusable')
  }
})

test('C2: the excluded-rows state reaches the DTO as a gap, not as an empty window', async () => {
  const stranger = Array.from({ length: 11 }, (_, i) =>
    row(graphRecord({
      id: `ghost-${i}`, createdDateTime: at(-30 + i),
      userId: '99999999-9999-4999-8999-999999999999',
    })))
  const prepared = await prepareAuthenticationEvaluation(
    scope, stranger, [user], proof, window(), true, now, reference)
  assert.ok(prepared.input)
  const projected = await projectAuthenticationAssessment(
    prepared.input, evaluateAuthenticationRules(prepared.input), reference)

  for (const rule of projected.rules) {
    assert.notEqual(
      rule.reasonCode, 'NO_EVIDENCE_IN_WINDOW',
      rule.ruleId + ' reported a successfully-collected empty window over ' +
        'evidence that was collected and discarded')
  }

  // CONTROL. A genuinely empty window must still reach the new reason, or this
  // correction would be satisfied by removing the distinction entirely.
  const empty = await prepareAuthenticationEvaluation(
    scope, [], [user], proof, window(), true, now, reference)
  assert.ok(empty.input)
  const emptyProjected = await projectAuthenticationAssessment(
    empty.input, evaluateAuthenticationRules(empty.input), reference)
  for (const rule of emptyProjected.rules) {
    assert.equal(rule.reasonCode, 'NO_EVIDENCE_IN_WINDOW', rule.ruleId)
  }
})

/**
 * THE SECOND EXCLUSION LAYER.
 *
 * The two C2 cases above exercise rows refused by PREPARATION: they never reach
 * `input.events`, and `readiness.gapCount` is how the evaluator learns they
 * existed. The evaluator refuses rows of its own — wrong tenant, malformed,
 * conflicting duplicates — and those are invisible to gapCount, because they
 * arrive inside `input.events` and are dropped after it was computed.
 *
 * Without this test the `excludedRows === 0` half of the condition can be
 * deleted and every other test still passes, leaving the defect live for every
 * row the evaluator drops itself.
 */
test('C2: rows the EVALUATOR refuses are not an empty window either', () => {
  // Real rows, correctly formed, belonging to a different tenant. gapCount is
  // zero here: preparation refused nothing. If this layer goes uncounted the
  // condition sees an empty admitted array and no gaps, and fires.
  const foreign = failures(6).map(record => ({ ...record, customerTenantId: 'someone-elses-tenant' }))
  const evaluated = evaluateAuthenticationRules(evaluation(foreign))

  assert.equal(evaluated.admittedEventCount, 0, 'the fixture admitted rows it should have dropped')
  for (const rule of evaluated.rules) {
    assert.ok(
      rule.reasonCodes.includes('SOURCE_SCOPE_MISMATCH'),
      'the fixture was not excluded for the reason this test assumes')
    assert.ok(
      !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      `six rows arrived and were refused; ${rule.ruleId} reports the window as ` +
      'holding no authentication activity, which is false')
  }
})

test('CONTROL: the same evaluator with nothing at all still says NO_EVIDENCE_IN_WINDOW', () => {
  // The control that stops the suppression above being satisfied by deleting
  // the distinction. Same call, same readiness, zero rows — here the sentence
  // is true and must be said.
  const evaluated = evaluateAuthenticationRules(evaluation([]))
  for (const rule of evaluated.rules) {
    assert.ok(
      rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      `${rule.ruleId} lost the reason entirely; the suppression is too broad`)
    assert.equal(rule.status, 'NOT_EVALUATED')
  }

  // A seeded positive, so neither negative is vacuous: the same evaluator over
  // real admitted evidence must not report an empty window.
  const seeded = evaluateAuthenticationRules(evaluation(failures(6)))
  assert.ok(seeded.admittedEventCount > 0, 'the positive control admitted nothing')
  for (const rule of seeded.rules) {
    assert.ok(!rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'))
  }
})

test('rows falling BEFORE the authorized window leave the window genuinely empty', () => {
  // The one case where the admitted array and the raw input disagree without an
  // exclusion being recorded. `eventTime < lowerBound` is a silent `continue`:
  // no reason, no excludedRows, because it is not a refusal — the rows are real
  // and simply belong to a period we are not authorized to assess.
  //
  // So the window we ARE entitled to assess holds nothing, the rules ran over
  // nothing, and the reason must fire. Keying the condition on
  // `input.events.length` instead of the admitted array silently reverses this:
  // rows are present, so no reason is added, and the rules fall through to
  // NOT_MATCHED — the original defect, reachable through the oldest evidence.
  const old = failures(6, -400)
  const evaluated = evaluateAuthenticationRules(
    evaluation(old, { authorizedFrom: at(-60) }))

  assert.ok(evaluated.admittedEventCount === 0, 'the fixture admitted rows it should have skipped')
  for (const rule of evaluated.rules) {
    assert.ok(
      rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      `${rule.ruleId} saw no evidence inside the authorized window and did not say so`)
    assert.equal(rule.status, 'NOT_EVALUATED',
      'a rule that ran over nothing must not report a result')
  }

  // Control: move the same rows inside the authorized window and the reason
  // must disappear, so this is not asserting a constant.
  const inside = evaluateAuthenticationRules(
    evaluation(failures(6), { authorizedFrom: at(-60) }))
  assert.ok(inside.admittedEventCount > 0)
  for (const rule of inside.rules) {
    assert.ok(!rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'))
  }
})

/**
 * C2, THE THIRD KIND OF EMPTY: WE STOPPED READING, WE DID NOT FINISH.
 *
 * Zero admitted, zero refused, and `paginationComplete: false`. Both refusal
 * counts are silent because nothing was refused — the page chain simply never
 * finished, so the rows that would have been there were never fetched at all.
 *
 * An unfinished page chain is not a successfully collected empty window. The
 * first says we do not know what the window held; the second says we looked at
 * all of it and it held nothing. Reporting the second is the same false
 * statement about a customer that this reason was introduced to remove, now at
 * its third layer.
 *
 * Nothing downstream rescues it: PAGINATION_INCOMPLETE falls into the catch-all
 * on the last line of `readiness()`, and the NO_EVIDENCE_IN_WINDOW branch sits
 * above it, so it wins.
 *
 * Found by Codex review (R015).
 */
test('C2: an unfinished page chain is not a successfully collected empty window', () => {
  const evaluated = evaluateAuthenticationRules(
    evaluation([], { readiness: { state: 'PARTIAL', paginationComplete: false, gapCount: 0, capped: false } }))

  assert.equal(evaluated.admittedEventCount, 0)
  for (const rule of evaluated.rules) {
    assert.ok(
      rule.reasonCodes.includes('PAGINATION_INCOMPLETE'),
      'the fixture is not exercising the state this test is about')
    assert.ok(
      !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      `${rule.ruleId} claims the window held no authentication activity, ` +
      'when the page chain never finished and most of it was never read')
  }
})

test('C2: the unfinished chain reaches the DTO as an incomplete window', async () => {
  const input = evaluation([], { readiness: { state: 'PARTIAL', paginationComplete: false, gapCount: 0, capped: false } })
  const projected = await projectAuthenticationAssessment(
    input, evaluateAuthenticationRules(input), reference)

  for (const rule of projected.rules) {
    assert.notEqual(rule.reasonCode, 'NO_EVIDENCE_IN_WINDOW',
      'the DTO reports a successfully collected empty window for a chain that never finished')
    assert.equal(rule.reasonCode, 'INCOMPLETE_WINDOW')
    assert.ok(assessmentReason(rule.reasonCode))
  }
})

test('C2: nor is a stale or capped collection an empty window', () => {
  // Two more states where the admitted array is empty for a reason that is not
  // absence of activity. Enumerated as cases rather than trusted to the
  // projection ordering, because the claim is made in the evaluator and a claim
  // that is wrong there is wrong wherever it is later re-sorted.
  // DECLARED, NOT ASSERTED. Without a type the array infers as
  // `(string | object)[]` and `readiness` arrives as `string | …`. An `as`
  // would have silenced that AND stopped checking these literals — verified by
  // mutation: with an assertion, a bogus field and an invalid `state` both
  // compiled. An annotation on the declaration keeps excess-property and
  // literal checking, so these fixtures still have to match the contract.
  const readinessCases: [string, AuthEvaluationInput['readiness']][] = [
    ['stale', { state: 'STALE', paginationComplete: true, gapCount: 0, capped: false }],
    ['capped', { state: 'READY', paginationComplete: true, gapCount: 0, capped: true }],
    ['source reported a gap', { state: 'READY', paginationComplete: true, gapCount: 0, capped: false, reasonCodes: ['THROTTLED'] }],
  ]
  for (const [label, readiness] of readinessCases) {
    const evaluated = evaluateAuthenticationRules(evaluation([], { readiness }))
    for (const rule of evaluated.rules) {
      assert.ok(
        !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
        `${label}: ${rule.ruleId} reported a successfully collected empty window`)
    }
  }
})

test('C2 CONTROL: a complete collection that found nothing still says so', () => {
  // The control that stops all of the above being satisfied by never emitting
  // the reason. READY, pagination complete, no gaps, nothing capped, nothing
  // refused, nothing admitted — here the sentence is true and must be said.
  const evaluated = evaluateAuthenticationRules(evaluation([]))
  for (const rule of evaluated.rules) {
    assert.ok(
      rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      `${rule.ruleId} lost the reason; the completeness requirement is too broad`)
    assert.ok(!rule.reasonCodes.includes('PAGINATION_INCOMPLETE'))
    assert.equal(rule.status, 'NOT_EVALUATED')
  }
})

/**
 * EACH CLAUSE ON ITS OWN, WITH `state` HELD AT READY.
 *
 * The cases above all arrive with `state: 'PARTIAL'`, because that is what
 * preparation produces when pagination or gaps are bad. That makes the state
 * clause sufficient for every one of them and leaves the other four deletable —
 * measured, not assumed: dropping `paginationComplete === true` or
 * `gapCount === 0` failed nothing.
 *
 * `state` is a SUMMARY supplied by the caller, and the evaluator already
 * refuses to trust it: it checks pagination, gaps, capping and reported gaps as
 * separate fields a few lines above. This is the case that justifies that
 * design. A producer whose summary says READY while its detail says the chain
 * never finished is exactly when a window gets called empty on no evidence, and
 * it is the shape that recurs here — two fields describing one fact, disagreeing.
 */
test('C2: no single readiness defect is excused by a READY summary', () => {
  // Each defect is checked against the real readiness shape; only the ASSEMBLY
  // is cast, and only because of the last case.
  const defectCases: [string, Partial<AuthEvaluationInput['readiness']>][] = [
    ['unfinished page chain', { paginationComplete: false }],
    ['rows dropped in preparation', { gapCount: 3 }],
    ['collection truncated itself', { capped: true }],
    ['source reported its own gap', { reasonCodes: ['THROTTLED'] }],
    ['pagination not reported at all', { paginationComplete: undefined }],
  ]
  for (const [label, defect] of defectCases) {
    // DELIBERATELY OUT OF CONTRACT, and only for the final case. The contract
    // types `paginationComplete` as `boolean`, and this loop sets it to
    // `undefined` on purpose: `evaluate.ts` guards with `!== true` rather than
    // `=== false`, and this is the case that proves the guard does that instead
    // of trusting the type. The cast is the probe, not a repair — if it ever
    // hides a real error, split this case out rather than widening the contract.
    const readiness = { state: 'READY' as const, paginationComplete: true, gapCount: 0, capped: false, ...defect } as AuthEvaluationInput['readiness']
    const evaluated = evaluateAuthenticationRules(evaluation([], { readiness }))
    for (const rule of evaluated.rules) {
      assert.ok(
        !rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
        `${label}: ${rule.ruleId} called the window empty on a READY summary ` +
        'while its own detail says the window was not fully read')
    }
  }
})

test('C2 CONTROL: a READY summary with no defect still reports the empty window', () => {
  // Same construction, same spread, nothing wrong with it — so the loop above
  // cannot be passing because that shape never produces the reason.
  const readiness = { state: 'READY' as const, paginationComplete: true, gapCount: 0, capped: false }
  const evaluated = evaluateAuthenticationRules(evaluation([], { readiness }))
  for (const rule of evaluated.rules) {
    assert.ok(
      rule.reasonCodes.includes('NO_EVIDENCE_IN_WINDOW'),
      `${rule.ruleId} withheld the reason from a collection with nothing wrong with it`)
  }
})
