import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TERMINAL, accounting, afterAttempt, backoffMs, beginAttempt, claimOutcome, claimStatement,
  cancelStatement, eligibility, inFlight, wouldCancel,
  neverSent, sentMoreThanOnce, workerId,
  type Attempt, type CancelScope, type SendJob, type SendPermit, type SendState, type Settled,
} from './send-queue.js'
import { idempotencyKey, messageId, providerMessageId } from './email-delivery.js'

/** The retry layer. Built from the constraints as relayed; the pre-registration blobs were not
 * read, so the independent check stays independent. */

const T0 = '2026-09-12T09:00:00.000Z'
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()

const job = (over: Partial<SendJob> = {}): SendJob => ({
  messageId: messageId('m-1'),
  idempotencyKey: idempotencyKey('idem-1'),
  state: 'READY',
  attemptsMade: 0,
  maxAttempts: 3,
  notBeforeIso: T0,
  claim: null,
  providerId: null,
  ...over,
})

test('THE BOUND IS A FACT ON THE JOB, so a redeploy cannot restart the count', () => {
  // THE FINDING THIS MODULE IS SHAPED BY. `maxAttempts` as a runner argument lives in the
  // process: a redeploy restarts the count from zero, and so does a second worker picking the
  // job up. The job then retries forever while every test of the runner shows it stopping at
  // three — because the runner really does stop at three, it is just not the only runner there
  // has ever been.
  //
  // Modelled here as the thing a new process can see: a job carrying its own spent budget.
  const spent = job({ attemptsMade: 3, maxAttempts: 3 })
  const verdict = eligibility(spent, at(60 * 60_000))
  assert.equal(verdict.mayAttempt, false)
  assert.equal(verdict.mayAttempt === false ? verdict.because.kind : null, 'BUDGET_SPENT')

  // A FRESH WORKER, A FRESH PROCESS, THE SAME ANSWER — because nothing about the decision is
  // held in whatever is currently draining the queue.
  const anotherWorker = eligibility(spent, at(48 * 60 * 60_000))
  assert.equal(anotherWorker.mayAttempt, false)

  // AND THE BUDGET IS CHECKED SEPARATELY FROM THE STATE. A crash between the last attempt and
  // the state write leaves a job that is over budget and still says READY; trusting the state
  // alone would make it claimable.
  const overBudgetButReady = job({ state: 'READY', attemptsMade: 5, maxAttempts: 3 })
  assert.equal(eligibility(overBudgetButReady, T0).mayAttempt, false)
})

test('SENT, EXHAUSTED AND GAVE_UP ALL REFUSE A CLAIM, or the bound is decorative', () => {
  // A job that has EXHAUSTED being claimable again means the count stops the loop and the next
  // claim starts a new loop. The bound then exists and does nothing.
  for (const state of ['SENT', 'EXHAUSTED', 'GAVE_UP'] as const) {
    const verdict = eligibility(job({ state, attemptsMade: 0 }), T0)
    assert.equal(verdict.mayAttempt, false, `${state} must refuse`)
    assert.equal(verdict.mayAttempt === false ? verdict.because.kind : null, 'TERMINAL')
  }

  // NOT VACUOUS: the non-terminal states still allow it.
  assert.equal(eligibility(job({ state: 'READY' }), T0).mayAttempt, true)
  assert.equal(eligibility(job({ state: 'CLAIMED', claim: null }), T0).mayAttempt, true,
    'CLAIMED with an expired or absent claim is reclaimable, which is how a dead worker releases')

  // AND THE SQL CARRIES THE SAME THREE, because a claim guarded by application logic and a claim
  // guarded by the database are two places that can disagree about who may send.
  const sql = claimStatement(messageId('m-1'), workerId('w-1'), T0, 60_000).sql
  for (const state of TERMINAL) assert.ok(sql.includes(`'${state}'`), `${state} missing from the predicate`)
  assert.match(sql, /attempts_made < max_attempts/)
})

test('THE CLAIM IS ONE STATEMENT, and the row count is who won', () => {
  // Two workers claiming one job is the apply's lesson in a new place. A SELECT of a READY job
  // followed by an UPDATE is the naive shape that lost every round of the apply's concurrency
  // test: both read READY, both write, both send.
  const statement = claimStatement(messageId('m-1'), workerId('w-1'), T0, 60_000)

  assert.equal(statement.sql.split(';').filter((part) => part.trim() !== '').length, 1)
  assert.match(statement.sql, /^UPDATE alert_send_jobs/)
  assert.equal(statement.expectedRowCount, 1)

  // Every eligibility rule is in the WHERE clause rather than checked before it.
  assert.match(statement.sql, /not_before_at <= /)
  assert.match(statement.sql, /claim_expires_at IS NULL OR claim_expires_at <= /)

  // Values travel as parameters; the hold is computed into an absolute time so two workers with
  // different clocks cannot disagree about when it ends.
  assert.deepEqual(statement.params, ['m-1', 'w-1', T0, at(60_000)])
  assert.doesNotMatch(statement.sql, /w-1/)
})

test('AN ATTEMPT IS WRITTEN BEFORE THE SIDE EFFECT, so a crash leaves a trace', () => {
  // If the row is written when the send RETURNS, a crash mid-send leaves no trace that anything
  // was sent — and the retry sends a second email believing it is the first. An unsettled
  // attempt past its deadline is exactly the evidence that something was in flight.
  const attempts: readonly Attempt[] = [
    { messageId: messageId('m-1'), attemptNo: 1, startedAtIso: T0, settled: null },
    { messageId: messageId('m-2'), attemptNo: 1, startedAtIso: T0,
      settled: { kind: 'ACCEPTED', providerId: providerMessageId('p-2'), atIso: at(500) } },
  ]

  assert.deepEqual(inFlight(attempts, at(1_000), 60_000), [],
    'a send in flight for a second is not a finding')
  assert.equal(inFlight(attempts, at(10 * 60_000), 60_000).length, 1,
    'ten minutes later it is')
  assert.equal(inFlight(attempts, at(10 * 60_000), 60_000)[0]?.messageId, 'm-1')

  // A SETTLED ATTEMPT IS NEVER IN FLIGHT, however old — or "everything is stuck" satisfies this.
  assert.ok(!inFlight(attempts, at(48 * 60 * 60_000), 60_000)
    .some((attempt) => attempt.messageId === 'm-2'))
})

test('ONE SEND PER MESSAGE IS A PROPERTY OF A HISTORY, not of a call', () => {
  // Nothing about a single invocation can establish it, which is why this reads the whole list.
  const twice: readonly Attempt[] = [
    { messageId: messageId('m-1'), attemptNo: 1, startedAtIso: T0,
      settled: { kind: 'ACCEPTED', providerId: providerMessageId('p-1'), atIso: at(1) } },
    { messageId: messageId('m-1'), attemptNo: 2, startedAtIso: at(2),
      settled: { kind: 'ACCEPTED', providerId: providerMessageId('p-1'), atIso: at(3) } },
  ]
  const problems = sentMoreThanOnce(twice)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /accepted 2 times/)
  // AND IT SAYS WHAT IT CANNOT KNOW. Two accepts under one idempotency key are one email if the
  // provider honours it and two if not, and nothing in this layer can tell.
  assert.match(problems[0] ?? '', /idempotency key, which nothing here can establish/)

  // A retry that was REFUSED and then accepted is one send, not two.
  const retried: readonly Attempt[] = [
    { messageId: messageId('m-1'), attemptNo: 1, startedAtIso: T0,
      settled: { kind: 'REFUSED_RETRYABLE', atIso: at(1), because: 'rate limited' } },
    { messageId: messageId('m-1'), attemptNo: 2, startedAtIso: at(2),
      settled: { kind: 'ACCEPTED', providerId: providerMessageId('p-1'), atIso: at(3) } },
  ]
  assert.deepEqual(sentMoreThanOnce(retried), [])
})

test('BACKOFF IS PURE AND THE CLOCK IS A PARAMETER, or the property is unaskable', () => {
  // A backoff computed through `Date.now()` inside the function has no input that puts the clock
  // anywhere, so "it waits" cannot be tested and reads as passing.
  assert.equal(backoffMs(0), 30_000)
  assert.equal(backoffMs(1), 60_000)
  assert.equal(backoffMs(2), 120_000)
  assert.equal(backoffMs(99), 900_000, 'capped, or a large budget schedules a retry nobody waits for')

  // AND IT IS OBSERVABLE ON THE JOB rather than held in a sleeping worker, whose wait a redeploy
  // would discard.
  const backedOff = afterAttempt(job(), { kind: 'REFUSED_RETRYABLE', atIso: T0, because: 'rate limited' })
  assert.equal(backedOff.state, 'READY')
  assert.equal(backedOff.notBeforeIso, at(60_000))
  assert.equal(eligibility(backedOff, at(30_000)).mayAttempt, false)
  assert.equal(eligibility(backedOff, at(60_000)).mayAttempt, true)
})

test('STOPPING IS REPORTED, because absence from a queue looks like success', () => {
  // "Stopped retrying" and "succeeded" are the same observation if the only signal is a job no
  // longer being there. Third time this shape has appeared in this feature.
  const jobs = [
    job({ messageId: messageId('m-sent'), state: 'SENT', attemptsMade: 1 }),
    job({ messageId: messageId('m-out'), state: 'EXHAUSTED', attemptsMade: 3 }),
    job({ messageId: messageId('m-bad'), state: 'GAVE_UP', attemptsMade: 1 }),
    job({ messageId: messageId('m-open'), state: 'READY' }),
  ]
  const stopped = neverSent(jobs)

  assert.deepEqual(stopped.map((each) => each.messageId).sort(), ['m-bad', 'm-out'])
  assert.ok(!stopped.some((each) => each.messageId === 'm-sent'), 'a sent message is not a failure')
  assert.ok(!stopped.some((each) => each.messageId === 'm-open'), 'nor is one still trying')

  // EXHAUSTED AND GAVE_UP ARE KEPT APART. One ran out of patience and its last attempt might
  // have worked; the other was told the address does not exist.
  assert.deepEqual(stopped.map((each) => each.state).sort(), ['EXHAUSTED', 'GAVE_UP'])
})

test('A PERMANENT REFUSAL STOPS AT ONCE rather than spending the budget', () => {
  // Retrying a hard bounce is repeated delivery attempts to a server that already said no, which
  // is how a sending domain earns a reputation problem.
  const permanent: Settled = { kind: 'REFUSED_PERMANENT', atIso: T0, because: 'invalid address' }
  const gaveUp = afterAttempt(job({ maxAttempts: 5 }), permanent)
  assert.equal(gaveUp.state, 'GAVE_UP')
  assert.equal(gaveUp.attemptsMade, 1, 'with budget left, and it is not spent')
  assert.equal(eligibility(gaveUp, at(60 * 60_000)).mayAttempt, false)

  // THE CONTRAST: a retryable refusal at the last attempt exhausts instead.
  const last = afterAttempt(job({ attemptsMade: 2, maxAttempts: 3 }),
    { kind: 'REFUSED_RETRYABLE', atIso: T0, because: 'rate limited' })
  assert.equal(last.state, 'EXHAUSTED')

  // AND AN ACCEPT CARRIES ITS EVIDENCE, so SENT is a state with a provider id attached.
  const sent = afterAttempt(job(), { kind: 'ACCEPTED', providerId: providerMessageId('p-1'), atIso: T0 })
  assert.equal(sent.state, 'SENT')
  assert.equal(sent.providerId, 'p-1')
  assert.equal(sent.claim, null, 'and the claim is released')
})

test('THE BUDGET AND THE HISTORY MUST AGREE, and the books say when they do not', () => {
  const jobs = [job({ attemptsMade: 2 })]
  const attempts: readonly Attempt[] = [
    { messageId: messageId('m-1'), attemptNo: 1, startedAtIso: T0,
      settled: { kind: 'REFUSED_RETRYABLE', atIso: at(1), because: 'x' } },
    { messageId: messageId('m-1'), attemptNo: 2, startedAtIso: at(2), settled: null },
  ]
  assert.deepEqual(accounting(jobs, attempts), [])

  // A job that thinks it has spent less than it has is the dangerous direction: it keeps trying.
  const understated = accounting([job({ attemptsMade: 1 })], attempts)
  assert.equal(understated.length, 1)
  assert.match(understated[0] ?? '', /records 1 attempts made and 2 attempt rows/)

  // An attempt with no job at all is named rather than dropped.
  const orphan = accounting([], [attempts[0]!])
  assert.match(orphan[0] ?? '', /which has no job/)
})

test('NOTHING HERE IS TENANT-SHAPED, so a per-tenant queue is unwriteable', () => {
  // R8 as a structural fact rather than a rule: there is no tenant field to partition on, so the
  // 1,500-message failure cannot be built by accident.
  const keys = Object.keys(job())
  for (const forbidden of ['tenantId', 'customerTenantId', 'organizationId', 'tenant']) {
    assert.ok(!keys.includes(forbidden), `SendJob must not carry ${forbidden}`)
  }
  assert.deepEqual(keys.sort(), [
    'attemptsMade', 'claim', 'idempotencyKey', 'maxAttempts', 'messageId', 'notBeforeIso',
    'providerId', 'state',
  ], 'the whole shape, pinned — a new field is a decision rather than a drift')

  // The claim carries a worker, never a scope.
  assert.doesNotMatch(claimStatement(messageId('m-1'), workerId('w-1'), T0, 1).sql, /tenant|organization/i)
})

test('THE STATE SET IS CLOSED, and every state is reachable or terminal', () => {
  const all: readonly SendState[] = ['READY', 'CLAIMED', 'SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED']
  assert.equal(new Set(all).size, 6)
  assert.deepEqual([...TERMINAL].sort(), ['CANCELLED', 'EXHAUSTED', 'GAVE_UP', 'SENT'])
  // Two of five are non-terminal, so a job always has somewhere to be while it is working.
  assert.equal(all.filter((state) => !TERMINAL.includes(state)).length, 2)
})

test('A SEND NEEDS A PERMIT, AND ONLY A ROW COUNT OF ONE MAKES ONE', () => {
  // THIS REPLACED A COMMENT SAYING "THE CALLER MUST READ THE ROW COUNT". It must — a claim
  // returning zero rows is the other worker winning, and sending anyway is the duplicate this
  // whole layer exists to prevent — and a comment is advice to somebody who has not written the
  // caller yet. That is exactly where the `accept` trap was when the obvious implementation
  // walked into it.
  const statement = claimStatement(messageId('m-1'), workerId('w-1'), T0, 60_000)

  const lost = claimOutcome(statement, 0, job())
  assert.equal(lost.won, false)
  assert.equal(lost.won === false ? lost.because : null, 'ANOTHER_WORKER_WON')

  const won = claimOutcome(statement, 1, job({ attemptsMade: 1 }))
  assert.ok(won.won)
  assert.equal(won.permit.messageId, 'm-1')
  assert.equal(won.permit.attemptNo, 2, 'from the job, not counted by the worker')

  // THE ATTEMPT COMES FROM THE PERMIT, so a worker that ignored the row count has nothing to
  // open an attempt with.
  const attempt = beginAttempt(won.permit, T0)
  assert.equal(attempt.attemptNo, 2)
  assert.equal(attempt.settled, null, 'open, because it is written before the send')

  // AND A HAND-MADE PERMIT DOES NOT COMPILE. The mistake is unavailable rather than discouraged.
  // @ts-expect-error - the brand cannot be written
  const forged: SendPermit = { messageId: messageId('m-1'), idempotencyKey: idempotencyKey('k'), attemptNo: 1 }
  // @ts-expect-error - and beginAttempt takes nothing else
  const bypass = beginAttempt({ messageId: messageId('m-1'), idempotencyKey: idempotencyKey('k'), attemptNo: 1 }, T0)
  assert.equal([forged, bypass].length, 2)

  // NOT VACUOUS: a real permit does reach beginAttempt, so the two errors above are about the
  // brand rather than about a type nobody can satisfy.
  assert.equal(beginAttempt(won.permit, T0).messageId, 'm-1')
})

test('CANCEL STOPS INTENT, INCLUDING INTENT THAT HAS ALREADY BEEN ATTEMPTED', () => {
  // THE BOUND THAT WOULD MAKE THE BUTTON DECORATIVE. A job attempted once and refused RETRYABLY
  // is still READY with budget left, so excluding it from cancel means the operator presses stop
  // and an email goes out afterwards. That is what an earlier `attempts_made = 0` bound did.
  const unattempted = job({ messageId: messageId('incident/org-1|k1') })
  const attempted = job({ messageId: messageId('incident/org-1|k2'), attemptsMade: 1 })
  const claimed = job({
    messageId: messageId('incident/org-1|k4'), state: 'CLAIMED', attemptsMade: 2,
    claim: { by: workerId('w-1'), atIso: T0, expiresIso: '2026-09-13T09:01:00.000Z' },
  })

  const everything: CancelScope = { kind: 'EVERYTHING' }
  assert.equal(wouldCancel(unattempted, everything), true)
  assert.equal(wouldCancel(attempted, everything), true, 'or stop does not stop')
  assert.equal(wouldCancel(claimed, everything), true, 'a dead worker holding a job must not win')

  // BUT HISTORY IS NEVER RELABELLED, or the cancel is satisfied by cancelling everything. This is
  // the control: a settled send stays settled, and `CANCELLED` never overwrites what happened.
  const sent = job({ messageId: messageId('incident/org-1|k3'), state: 'SENT', providerId: providerMessageId('p') })
  assert.equal(wouldCancel(sent, everything), false)
  assert.equal(wouldCancel(job({ state: 'GAVE_UP' }), everything), false)
  assert.equal(wouldCancel(job({ state: 'EXHAUSTED' }), everything), false)

  // AND THE SQL CARRIES THE RULE, so it is the database's rather than the caller's — a worker
  // that never calls `wouldCancel` is still stopped.
  const sql = cancelStatement(everything, T0).sql
  assert.doesNotMatch(sql, /attempts_made/, 'an attempted job is stopped too')
  assert.ok(sql.includes("state NOT IN ('SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED')"),
    'history is excluded by the database, not by the caller')
  assert.equal(sql.split(';').filter((part) => part.trim() !== '').length, 1, 'one statement')
  assert.doesNotMatch(sql, /alert_incidents/, 'it never touches the record')
  assert.doesNotMatch(sql, /alert_send_attempts/, 'nor what actually reached a provider')
})

test('CANCEL IS SCOPABLE, and the scope cannot catch a neighbouring organisation', () => {
  // A stop button that can only stop everything is one nobody dares press.
  const scope: CancelScope = { kind: 'ORGANISATION', organizationId: 'org-1' }
  assert.equal(wouldCancel(job({ messageId: messageId('incident/org-1|k') }), scope), true)
  assert.equal(wouldCancel(job({ messageId: messageId('incident/org-2|k') }), scope), false)

  // THE SEPARATOR IS INSIDE THE PREFIX, or `org-1` would also stop `org-12`.
  assert.equal(wouldCancel(job({ messageId: messageId('incident/org-12|k') }), scope), false)
  assert.match(cancelStatement(scope, T0).sql, /message_id LIKE \$2 \|\| '%'/)
  assert.deepEqual(cancelStatement(scope, T0).params, [T0, 'incident/org-1|'])
})

test('A CANCELLED JOB CANNOT BE CLAIMED AGAIN, or the stop button is decorative', () => {
  // Exactly the R2 defect, in a new state: if CANCELLED were claimable the operator would press
  // stop and the next worker would pick the job straight back up.
  const verdict = eligibility(job({ state: 'CANCELLED' }), T0)
  assert.equal(verdict.mayAttempt, false)
  assert.equal(verdict.mayAttempt === false ? verdict.because.kind : null, 'TERMINAL')
  assert.ok(TERMINAL.includes('CANCELLED'))
  assert.ok(cancelStatement({ kind: 'EVERYTHING' }, T0).sql.includes("'CANCELLED'"),
    'and a second cancel does not re-cancel')
})
