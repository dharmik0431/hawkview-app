import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import {
  TERMINAL, accounting, afterAttempt, backoffMs, beginAttempt, claimOutcome, claimStatement,
  cancelReason, cancelStatement, classifyCancellation, eligibility, inFlight, wouldCancel,
  neverSent, sentMoreThanOnce, withdrawStatement, workerId,
  type Attempt, type CancelOrder, type CancelScope, type SendJob, type SendPermit,
  type SendState, type Settled,
} from './send-queue.js'
import { idempotencyKey, messageId, providerMessageId } from './email-delivery.js'
import { WITHDRAWN_REASONS } from './send-worker.js'

/** The retry layer. Built from the constraints as relayed; the pre-registration blobs were not
 * read, so the independent check stays independent. */

const T0 = '2026-09-12T09:00:00.000Z'
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
/** Created before and after the instant the operator pressed stop. */
const BEFORE = at(-60_000)
const AFTER = at(60_000)

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
  // SPELLED OUT ON PURPOSE, unlike the SQL assertions below. This is the one place a second copy
  // earns its keep: derived from `TERMINAL` it could not notice a state being added to the
  // constant, which is the change a reviewer most needs to see in a diff. The type makes the list
  // exhaustive — a seventh state fails to compile here.
  const all: readonly SendState[] =
    ['READY', 'CLAIMED', 'SENT', 'EXHAUSTED', 'GAVE_UP', 'CANCELLED', 'WITHDRAWN']
  assert.equal(new Set(all).size, 7)
  assert.deepEqual([...TERMINAL].sort(),
    ['CANCELLED', 'EXHAUSTED', 'GAVE_UP', 'SENT', 'WITHDRAWN'])
  // Two of seven are non-terminal, so a job always has somewhere to be while it is working. (The
  // count said "two of five" while the list held six, which is what a stale comment costs: it was
  // the only line here that named how many states there were, and it had been wrong since
  // CANCELLED.)
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
    claim: { by: workerId('w-1'), atIso: T0, expiresIso: at(60_000) },
  })

  const everything: CancelScope = { kind: 'EVERYTHING', createdBeforeIso: T0 }
  assert.equal(wouldCancel(unattempted, everything, BEFORE), true)
  assert.equal(wouldCancel(attempted, everything, BEFORE), true, 'or stop does not stop')
  assert.equal(wouldCancel(claimed, everything, BEFORE), true, 'a dead worker holding a job must not win')

  // BUT HISTORY IS NEVER RELABELLED, or the cancel is satisfied by cancelling everything. This is
  // the control: a settled send stays settled, and `CANCELLED` never overwrites what happened.
  const sent = job({ messageId: messageId('incident/org-1|k3'), state: 'SENT', providerId: providerMessageId('p') })
  assert.equal(wouldCancel(sent, everything, BEFORE), false)
  assert.equal(wouldCancel(job({ state: 'GAVE_UP' }), everything, BEFORE), false)
  assert.equal(wouldCancel(job({ state: 'EXHAUSTED' }), everything, BEFORE), false)

  // AND THE SQL CARRIES THE RULE, so it is the database's rather than the caller's — a worker
  // that never calls `wouldCancel` is still stopped.
  const sql = cancelStatement({ scope: everything, by: 'ops', because: cancelReason('spam') }, T0).sql
  assert.doesNotMatch(sql, /attempts_made = 0/, 'an attempted job is stopped too')
  // DERIVED FROM `TERMINAL`, NOT SPELLED OUT. This assertion held its own copy of the list and
  // went red the moment WITHDRAWN was added — a test pinning the four states it was written with
  // rather than the rule "history is excluded", which is what it is named for.
  assert.ok(sql.includes(`state NOT IN (${TERMINAL.map(state => `'${state}'`).join(', ')})`),
    'history is excluded by the database, not by the caller')
  assert.equal(sql.split(';').filter((part) => part.trim() !== '').length, 1, 'one statement')
  assert.doesNotMatch(sql, /alert_incidents/, 'it never touches the record')
  assert.doesNotMatch(sql, /alert_send_attempts/, 'nor what actually reached a provider')
})

test('THE RESULT DISTINGUISHES STOPPED FROM MAY-HAVE-GONE, PER JOB', () => {
  // A COUNT OF ROWS UPDATED IS NOT AN ANSWER. Told "3 stopped", an operator stops watching the
  // inbox and tells the customer it was caught — and two of those three may be at the provider.
  const jobs = classifyCancellation([
    { message_id: 'incident/org-1|k1', state_before: 'READY', attempts_made: 0, was_claimed: false },
    { message_id: 'incident/org-1|k2', state_before: 'READY', attempts_made: 1, was_claimed: false },
    { message_id: 'incident/org-1|k4', state_before: 'CLAIMED', attempts_made: 0, was_claimed: true },
  ])

  assert.equal(jobs[0]?.outcome, 'STOPPED_BEFORE_ANY_ATTEMPT')
  // AN OPEN ATTEMPT MEANS A SEND MAY HAVE LEFT: the attempt row is written BEFORE the side effect.
  assert.equal(jobs[1]?.outcome, 'MAY_HAVE_REACHED_PROVIDER')
  // AND SO DOES A LIVE CLAIM AT ZERO ATTEMPTS — the worker can be inside `attemptSend` right now.
  // This is the case a rule keyed only on `attempts_made` would report as safely stopped.
  assert.equal(jobs[2]?.outcome, 'MAY_HAVE_REACHED_PROVIDER')

  // THE PRE-IMAGE TRAVELS WITH IT, so the report can be argued with rather than trusted.
  assert.equal(jobs[2]?.stateBefore, 'CLAIMED')
  assert.equal(jobs[2]?.wasClaimed, true)
  assert.deepEqual(jobs.map((each) => each.messageId),
    ['incident/org-1|k1', 'incident/org-1|k2', 'incident/org-1|k4'])

  // NOT VACUOUS: cancelling nothing returns nothing, rather than one reassuring row.
  assert.deepEqual(classifyCancellation([]), [])
})

test('THE STATEMENT CAPTURES THE PRE-IMAGE INSIDE ITSELF, or the race returns', () => {
  // The read-then-write form cancels a job a worker has already claimed — measured 25 out of 25
  // against a real database. The columns that classify a job are the ones the cancel overwrites,
  // so capturing them in a separate SELECT would reintroduce exactly that race.
  const sql = cancelStatement({
    scope: { kind: 'EVERYTHING', createdBeforeIso: T0 }, by: 'ops', because: cancelReason('spam'),
  }, T0).sql

  assert.match(sql, /FOR UPDATE/, 'the targets are locked as they are read')
  assert.match(sql, /^WITH targets AS \(/, 'and the read is inside the same statement')
  assert.match(sql, /RETURNING[\s\S]*t\.state_before/, 'the report reads the pre-image, not the new row')
  assert.match(sql, /RETURNING[\s\S]*claimed_by IS NOT NULL/)
  assert.equal(sql.split(';').filter((part) => part.trim() !== '').length, 1, 'STILL ONE STATEMENT')
})

test('WHO, WHEN AND WHY GO ON THE ROW, and the reason cannot be blank', () => {
  // Six months from now "why was this MSP never told" has to be answerable from the record. The
  // state alone says somebody stopped it and nothing says who or on what grounds.
  const statement = cancelStatement({
    scope: { kind: 'EVERYTHING', createdBeforeIso: T0 },
    by: 'dharmik@hawkview.example',
    because: cancelReason('  duplicate storm from the 09:00 tick  '),
  }, T0)

  assert.match(statement.sql, /cancelled_at = \$1::timestamptz/)
  assert.match(statement.sql, /cancelled_by = \$2/)
  assert.match(statement.sql, /cancelled_because = \$3/)
  assert.equal(statement.params[1], 'dharmik@hawkview.example')
  assert.equal(statement.params[2], 'duplicate storm from the 09:00 tick', 'trimmed')

  // AN UNEXPLAINED STOP IS UNAVAILABLE, not discouraged. Empty and whitespace both satisfy a NOT
  // NULL column and neither answers the question the column exists for.
  assert.throws(() => cancelReason(''), /must carry a reason/)
  assert.throws(() => cancelReason('   '), /must carry a reason/)

  // @ts-expect-error - and a bare string is not a reason
  const forged: CancelOrder = { scope: { kind: 'EVERYTHING', createdBeforeIso: T0 }, by: 'ops', because: 'spam' }
  assert.ok(forged !== null)
})

test('createdBeforeIso IS REQUIRED, because the next tick is a real category', () => {
  // Intake runs every five minutes. Whether "stop" means the jobs that exist now or also the ones
  // the next tick writes is a decision the operator must make, not one they inherit from a WHERE
  // clause they never read.
  const scope: CancelScope = { kind: 'EVERYTHING', createdBeforeIso: T0 }
  const statement = cancelStatement({ scope, by: 'ops', because: cancelReason('spam') }, T0)
  assert.match(statement.sql, /created_at < \$4::timestamptz/)
  assert.equal(statement.params[3], T0)

  // A JOB CREATED AFTER THE PRESS IS NOT STOPPED, which is the whole reason the bound exists.
  assert.equal(wouldCancel(job(), scope, BEFORE), true)
  assert.equal(wouldCancel(job(), scope, AFTER), false, 'formed after the operator pressed stop')
  assert.equal(wouldCancel(job(), scope, T0), false, 'strictly before, so the boundary is not both')

  // @ts-expect-error - a scope without it does not typecheck
  const forged: CancelScope = { kind: 'EVERYTHING' }
  assert.ok(forged !== null)
})

test('CANCEL IS SCOPABLE, and the scope cannot catch a neighbouring organisation', () => {
  // A stop button that can only stop everything is one nobody dares press.
  const scope: CancelScope = { kind: 'ORGANISATION', organizationId: 'org-1', createdBeforeIso: T0 }
  assert.equal(wouldCancel(job({ messageId: messageId('incident/org-1|k') }), scope, BEFORE), true)
  assert.equal(wouldCancel(job({ messageId: messageId('incident/org-2|k') }), scope, BEFORE), false)

  // THE SEPARATOR IS INSIDE THE PREFIX, or `org-1` would also stop `org-12`.
  assert.equal(wouldCancel(job({ messageId: messageId('incident/org-12|k') }), scope, BEFORE), false)
  const statement = cancelStatement({ scope, by: 'ops', because: cancelReason('spam') }, T0)
  assert.match(statement.sql, /message_id LIKE \$5 \|\| '%'/)
  assert.deepEqual(statement.params, [T0, 'ops', 'spam', T0, 'incident/org-1|'])
})

test('A CANCELLED JOB CANNOT BE CLAIMED AGAIN, or the stop button is decorative', () => {
  // Exactly the R2 defect, in a new state: if CANCELLED were claimable the operator would press
  // stop and the next worker would pick the job straight back up.
  const verdict = eligibility(job({ state: 'CANCELLED' }), T0)
  assert.equal(verdict.mayAttempt, false)
  assert.equal(verdict.mayAttempt === false ? verdict.because.kind : null, 'TERMINAL')
  assert.ok(TERMINAL.includes('CANCELLED'))
  assert.ok(cancelStatement({
    scope: { kind: 'EVERYTHING', createdBeforeIso: T0 }, by: 'ops', because: cancelReason('spam'),
  }, T0).sql.includes("'CANCELLED'"), 'and a second cancel does not re-cancel')
})

// ---------------------------------------------------------------------------------------
// WITHDRAWAL, AND THE SEAM A DOUBLE CANNOT REACH
// ---------------------------------------------------------------------------------------

/**
 * **THE INSTRUMENT HAS TO SIT ON THE OTHER SIDE OF THE DOUBLE.**
 *
 * `withdraw` had no honest implementation for a day while forty suites stayed green, because the
 * store used everywhere is in memory and enforces no constraint. *An interface can be satisfied by
 * a double long after it has stopped being satisfiable by a database.* What was pinned was that
 * the worker CALLS `withdraw`; nothing checked that a withdrawal could be RECORDED.
 *
 * A database-integration test is the complete answer and needs a database. These tests are the
 * part that does not: they read the MIGRATION TEXT — the other side of the seam, and the artefact
 * that actually reaches Postgres — and hold the statements and the vocabulary against it. Not
 * proof that the write succeeds; proof that what the code names and what the schema defines are
 * the same set of things, which is the failure that was actually available.
 */

const MIGRATIONS = new URL('../../prisma/migrations/', import.meta.url)

/** Every migration that mentions the table, oldest first. Read from disk rather than listed here:
 * a hand-maintained list is one more copy that drifts, and the drift would silently narrow what
 * these tests look at. */
function sendJobMigrations(): string {
  const texts = readdirSync(MIGRATIONS)
    .sort()
    .filter(name => !name.endsWith('.toml'))
    .map(name => {
      try { return readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8') }
      catch { return '' }
    })
    .filter(text => text.includes('alert_send_jobs'))
  // LOUD RATHER THAN EMPTY. A search that finds nothing passes every "is X absent" assertion
  // below, which is the exact shape that made three instruments lie today.
  assert.ok(texts.length >= 4, `expected several alert_send_jobs migrations, found ${texts.length}`)
  return texts.join('\n')
}

/** The columns the table actually has, from the CREATE TABLE and every ADD COLUMN. */
function columnsInSchema(): ReadonlySet<string> {
  const sql = sendJobMigrations()
  const created = sql.match(/CREATE TABLE[^;]*?"alert_send_jobs" \(([\s\S]*?)\n\);/)
  assert.ok(created, 'could not find the CREATE TABLE for alert_send_jobs')
  const columns = new Set<string>()
  for (const line of created[1].split('\n')) {
    const match = line.match(/^\s*"([a-z_]+)"\s+[A-Z]/)
    if (match) columns.add(match[1])
  }
  for (const [, name] of sql.matchAll(/ADD COLUMN IF NOT EXISTS "([a-z_]+)"/g)) columns.add(name)
  assert.ok(columns.size > 10, `parsed only ${columns.size} columns; the parser is wrong, not the schema`)
  return columns
}

/** Every column a statement assigns to or filters on. */
const columnsNamedIn = (sql: string): readonly string[] => {
  const reserved = ['and', 'or', 'not', 'in', 'null', 'set', 'where', 'update', 'state']
  return [...sql.matchAll(/\b([a-z_]{3,})\b\s*=/g)]
    .map(match => match[1])
    .filter(name => !reserved.includes(name))
}

test('every column `withdrawStatement` writes exists in the migrations', () => {
  // THE ASSERTION THAT WOULD HAVE FAILED YESTERDAY. Before the migration a withdrawal had nowhere
  // to go, and every in-memory suite still passed.
  const schema = columnsInSchema()
  const statement = withdrawStatement(messageId('incident/org-1|k'), 'ALERT_TYPE_DISABLED', T0)

  const named = columnsNamedIn(statement.sql)
  assert.ok(named.includes('withdrawn_at') && named.includes('withdrawn_because'),
    `the parser found no withdrawal columns in the statement: ${named.join(', ')}`)
  for (const column of named) {
    assert.ok(schema.has(column), `${column} is written by withdrawStatement and is in no migration`)
  }
})

test('the reason vocabulary in the schema is exactly WITHDRAWN_REASONS', () => {
  // A CHECK constraint and a TypeScript union are two copies of one decision. Drift does not show
  // up as a failing test — it shows up as an insert refused in production, months later, the
  // first time the fifth reason is produced.
  const check = sendJobMigrations()
    .match(/alert_send_jobs_withdrawn_reason_check"\s*\n?\s*CHECK \([\s\S]*?IN \(([\s\S]*?)\)\)/)
  assert.ok(check, 'could not find the withdrawn reason CHECK')

  const inSchema = [...check[1].matchAll(/'([A-Z_]+)'/g)].map(match => match[1]).sort()
  assert.deepEqual(inSchema, [...WITHDRAWN_REASONS].sort())
})

test('the state CHECK accepts every terminal state, WITHDRAWN included', () => {
  // The LAST definition wins: the CHECK is dropped and re-added by each widening, so matching the
  // first would test a constraint that no longer exists.
  const all = [...sendJobMigrations()
    .matchAll(/alert_send_jobs_state_check"\s*\n?\s*CHECK \("state" IN \(([^)]*)\)\)/g)]
  assert.ok(all.length >= 2, `expected the state CHECK to have been widened; found ${all.length}`)
  const current = [...all[all.length - 1][1].matchAll(/'([A-Z_]+)'/g)].map(match => match[1])

  for (const state of TERMINAL) {
    assert.ok(current.includes(state), `${state} is terminal in code and not accepted by the schema`)
  }
  assert.ok(current.includes('WITHDRAWN'))
})

test('NO STATEMENT MAY CLAIM OR RELABEL A TERMINAL JOB — the drift guard', () => {
  // THIS IS THE TEST THE HAND-WRITTEN COPIES NEEDED. `TERMINAL` carried a comment saying it was
  // exported so nobody kept a second list, and two SQL clauses kept one anyway — so adding
  // WITHDRAWN to the constant alone would have left a withdrawn job claimable and relabellable.
  // Asserted against every terminal state rather than against WITHDRAWN, so the NEXT state added
  // is covered by a test that already exists.
  const statements = {
    claim: claimStatement(messageId('incident/org-1|k'), workerId('w1'), T0, 60_000).sql,
    cancel: cancelStatement(
      { scope: { kind: 'EVERYTHING', createdBeforeIso: T0 }, by: 'op', because: cancelReason('stop') },
      T0,
    ).sql,
    withdraw: withdrawStatement(messageId('incident/org-1|k'), 'ALERT_TYPE_DISABLED', T0).sql,
  }

  for (const [name, sql] of Object.entries(statements)) {
    const exclusion = sql.match(/state NOT IN \(([^)]*)\)/)
    assert.ok(exclusion, `${name} has no terminal-state exclusion at all`)
    const excluded = [...exclusion[1].matchAll(/'([A-Z_]+)'/g)].map(match => match[1]).sort()
    assert.deepEqual(excluded, [...TERMINAL].sort(), `${name} keeps its own copy of the terminal states`)
  }
})

test('a withdrawal writes its state and its reason in one statement', () => {
  // The biconditional refuses a half-written withdrawal, so the statement that would trip it is
  // one that sets the columns in a second write. One UPDATE, or the database says no.
  const statement = withdrawStatement(messageId('incident/org-1|k'), 'NO_VERIFIED_RECIPIENT', T0)

  assert.match(statement.sql, /SET state = 'WITHDRAWN'/)
  assert.match(statement.sql, /withdrawn_at = \$3/)
  assert.match(statement.sql, /withdrawn_because = \$2/)
  assert.deepEqual(statement.params, ['incident/org-1|k', 'NO_VERIFIED_RECIPIENT', T0])
})

test('a withdrawal releases the claim, or the claim provenance CHECK refuses the row', () => {
  // `alert_send_jobs_claim_check` takes claimed_by, claimed_at and claim_expires_at all or none.
  // Clearing two of three is a row Postgres will not accept — and leaving all three would keep a
  // dead worker's name on a job nobody will ever claim again.
  const sql = withdrawStatement(messageId('incident/org-1|k'), 'ALERT_TYPE_DISABLED', T0).sql

  for (const column of ['claimed_by', 'claimed_at', 'claim_expires_at']) {
    assert.match(sql, new RegExp(`${column} = NULL`), `${column} is left behind on a withdrawn job`)
  }
})

test('zero rows is not an error, and the statement says which count means success', () => {
  // A job that reached SENT between the resolve and this write was sent. Relabelling it would be
  // the record lying about what the product did, so the guard excludes it and the worker reads
  // the count — the same shape as a lost claim.
  assert.equal(
    withdrawStatement(messageId('incident/org-1|k'), 'ALERT_TYPE_DISABLED', T0).expectedRowCount, 1)
})

test('THE WITHDRAWAL COLUMNS ARE NULLABLE, or the pipeline cannot insert a job at all', () => {
  // NOT A STYLE RULE — A CROSS-BRANCH INTEGRATION CONSTRAINT, found by the pipeline owner RUNNING
  // the merge rather than reading it. `alert_send_jobs` is written by the pipeline (it inserts
  // state='READY' and never touches these columns) and only transitioned by this worker. A
  // NOT NULL without a default would fail every job insert the moment this migration landed —
  // on the table that starts every send.
  //
  // The biconditional is safe for that insert and this is the reasoning, which only a real
  // cluster can confirm: ('READY' = 'WITHDRAWN') is false, (NULL IS NOT NULL AND NULL IS NOT
  // NULL) is false, and false = false is TRUE. The reason CHECK is `IS NULL OR IN (...)`, so a
  // NULL passes it outright. What IS asserted here is the part a text can carry: the columns are
  // added without a NOT NULL and nothing later tightens them.
  const sql = sendJobMigrations()

  for (const column of ['withdrawn_at', 'withdrawn_because']) {
    const added = sql.match(new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"[^;]*;`))
    assert.ok(added, `${column} is never added by any migration`)
    assert.doesNotMatch(added[0], /NOT NULL/, `${column} would refuse the pipeline's insert`)
    assert.doesNotMatch(sql, new RegExp(`ALTER COLUMN "${column}" SET NOT NULL`),
      `${column} is tightened later, which has the same effect one migration further on`)
  }
})

test('this migration sorts after every migration it has to follow', () => {
  // THE MERGE ORDER IS LEXICOGRAPHIC AND THE FORK MAKES IT LUCK, not coordination: 160000 was
  // chosen here without being able to see the other branch's 140000. Prisma applies in directory
  // order, so a timestamp that sorts BEFORE a migration whose table it depends on applies against
  // a table that does not exist yet.
  //
  // This asserts the local half — the only half this worktree can see. The other branch's
  // migrations are not here, so this cannot and does not claim anything about them.
  const local = readdirSync(MIGRATIONS).filter(name => !name.endsWith('.toml')).sort()
  const mine = '20260913200000_send_job_withdrawn'

  // THE ASSERTION USED TO BE `mine` IS LAST, and that is a PROXY rather than the property in
  // this test's name. It was true when written and false the moment any later migration exists
  // for any reason -- a 20260914 identity-risk widening broke it while violating nothing it
  // cares about. Asserting the real relationship instead: it must follow the table it alters
  // and the migration it was sequenced behind.
  const mustFollow = ['20260912223000_alert_send_jobs', '20260913180000_bound_unverifiable_webhooks']

  assert.ok(local.includes(mine), 'the withdrawal migration is missing')
  for (const earlier of mustFollow) {
    assert.ok(local.includes(earlier), earlier + ' is missing; this ordering claim is unanchored')
    assert.ok(mine > earlier,
      mine + ' sorts BEFORE ' + earlier + ', so Prisma would apply it against a table that does ' +
      'not exist yet')
  }
})
