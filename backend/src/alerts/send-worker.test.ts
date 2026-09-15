import assert from 'node:assert/strict'
import test from 'node:test'
import { NO_TRANSPORT_CONFIGURED, suppressionsOf, type Suppressions } from './alert-sender.js'
import {
  idempotencyKey, messageId, operatorAddressOf,
  type Body, type OperatorAddress,
} from './email-delivery.js'
import {
  acceptsEverything, distinctKeys, inSequence, recordingTransport,
  refusesPermanently, refusesRetryably,
} from './recording-transport.js'
import { workerId, type Attempt, type SendJob, type Settled } from './send-queue.js'
import {
  WITHDRAWN_REASONS, accepted, drainOnce,
  type MessageSource, type Resolution, type SendStore, type WithdrawnReason,
} from './send-worker.js'

/** The queue consumer. Everything it composes was already built and tested as a unit; what is
 * new here is the ORDER, and the order is where the failures were. */

const T0 = '2026-09-13T09:00:00.000Z'
const WORKER = workerId('worker-a')
const ADDRESS = operatorAddressOf({
  kind: 'MSP_SECURITY_INBOX', address: 'soc@msp.example', verifiedAt: new Date(T0),
})
const BODY: Body = [{ kind: 'WINDOW', fromIso: T0, toIso: T0 }]

function job(overrides: Partial<SendJob> = {}): SendJob {
  return {
    messageId: messageId('msg-1'),
    idempotencyKey: idempotencyKey('key-1'),
    state: 'READY',
    attemptsMade: 0,
    maxAttempts: 3,
    notBeforeIso: T0,
    claim: null,
    providerId: null,
    ...overrides,
  }
}

/** A store that records every write in order, and can be told to fail one of them. */
function store(jobs: readonly SendJob[], failAt?: keyof SendStore) {
  const writes: string[] = []
  const opened: Attempt[] = []
  const settled: Readonly<{ attempt: Attempt; settled: Settled; job: SendJob }>[] = []
  const withdrawn: Readonly<{ messageId: string; because: WithdrawnReason }>[] = []
  const suppressed: Readonly<{ address: string; messageId: string }>[] = []
  let claimRows = 1
  let withdrawRows = 1
  const guard = (name: keyof SendStore) => {
    writes.push(name)
    if (failAt === name) throw new Error(`${name} failed`)
  }
  const api: SendStore = {
    dueJobs: async () => { guard('dueJobs'); return jobs },
    runClaim: async () => { guard('runClaim'); return claimRows },
    openAttempt: async (attempt) => { guard('openAttempt'); opened.push(attempt) },
    settleAttempt: async (attempt, s, j) => { guard('settleAttempt'); settled.push({ attempt, settled: s, job: j }) },
    // READS THE PARAMS THE DATABASE WOULD BE GIVEN, not arguments a helper was handed. The reason
    // asserted in these tests is now the one that would reach `withdrawn_because` — the column
    // the CHECK constrains, and the seam the old signature let a double stand in for.
    runWithdraw: async (_sql, params) => {
      guard('runWithdraw')
      withdrawn.push({ messageId: String(params[0]), because: params[1] as WithdrawnReason })
      return withdrawRows
    },
    suppress: async (address, id) => { guard('suppress'); suppressed.push({ address, messageId: id }) },
  }
  return {
    api, writes, opened, settled, withdrawn, suppressed,
    loseClaim: () => { claimRows = 0 },
    /** A stop landing between the claim and the withdrawal: the row is already terminal, so the
     * guarded UPDATE matches nothing. */
    settleFirst: () => { withdrawRows = 0 },
  }
}

const sends = (to: OperatorAddress = ADDRESS, body: Body = BODY): MessageSource =>
  ({ resolve: async (): Promise<Resolution> => ({ send: true, to, body }) })

const withdraws = (why: WithdrawnReason): MessageSource =>
  ({ resolve: async (): Promise<Resolution> => ({ send: false, because: why }) })

const NOTHING_SUPPRESSED: Suppressions = suppressionsOf([])

const drain = (over: Partial<Parameters<typeof drainOnce>[0]> & {
  store: SendStore
}) => drainOnce({
  transport: NO_TRANSPORT_CONFIGURED,
  source: sends(),
  suppressions: NOTHING_SUPPRESSED,
  by: WORKER,
  nowIso: T0,
  holdForMs: 60_000,
  limit: 10,
  ...over,
})

// ---------------------------------------------------------------------------------------

test('a job travels claim -> resolve -> attempt -> send -> settle, in that order', async () => {
  // THE ORDER IS THE CONTRIBUTION OF THIS MODULE. Every function it calls was already tested;
  // what could not be tested before is that they are called in the sequence that survives a
  // crash — attempt written BEFORE the side effect, settlement and job advance together.
  const s = store([job()])
  const transport = recordingTransport(acceptsEverything)
  const report = await drain({ store: s.api, transport })

  assert.deepEqual(s.writes, ['dueJobs', 'runClaim', 'openAttempt', 'settleAttempt'])
  assert.equal(s.opened.length, 1)
  assert.equal(s.opened[0]!.settled, null, 'the attempt is written unsettled, before the send')
  assert.equal(s.settled.length, 1)
  assert.equal(s.settled[0]!.job.state, 'SENT')
  assert.deepEqual(accepted(report), [messageId('msg-1')])
})

test('the attempt row exists even when the transport throws', async () => {
  // A crash mid-send must leave the evidence that something was in flight. If the attempt were
  // written on return, the retry would send a second email believing it is the first — and
  // nothing would show that it had.
  const s = store([job()])
  const exploding = { send: async () => { throw new Error('socket died') } }
  const report = await drain({ store: s.api, transport: exploding })

  assert.equal(s.opened.length, 1, 'the attempt was opened before the send')
  assert.equal(s.settled.length, 0, 'and left unsettled, which is what inFlight reads')
  assert.deepEqual(report.results.map((r) => r.kind), ['FAILED'])
})

test('losing the claim sends nothing and is not an error', async () => {
  // Another worker won. The row count decides, and sending anyway is the duplicate this whole
  // layer exists to prevent.
  const s = store([job()])
  s.loseClaim()
  const transport = recordingTransport(acceptsEverything)
  const report = await drain({ store: s.api, transport })

  assert.deepEqual(transport.handoffs, [], 'nothing reached the transport')
  assert.deepEqual(s.writes, ['dueJobs', 'runClaim'], 'and no attempt was opened')
  assert.deepEqual(report.results.map((r) => r.kind), ['LOST_CLAIM'])
})

test('preferences are read AFTER the claim, so a change between queueing and now is honoured', async () => {
  // THE REQUIREMENT THAT MAKES THE RESOLVER A SEAM RATHER THAN A LOADER. An operator who turns
  // the type off after the job was queued has changed their mind; a queue that delivers the old
  // decision ignores them.
  //
  // THE ORDERING ASSERTION IS THE POINT AND THE FIRST VERSION OF THIS TEST DID NOT MAKE IT.
  // Checking only that the withdrawal happened passes whether the resolve runs before or after
  // the claim — a mutation moving it before the claim survived. Resolving first would read
  // preferences for a job another worker is about to win, and would read them for every job in
  // the batch rather than for the ones this worker actually holds.
  const s = store([job()])
  const transport = recordingTransport(acceptsEverything)
  const resolvedAfter: string[] = []
  const watchingSource: MessageSource = {
    resolve: async () => {
      resolvedAfter.push(...s.writes)
      return { send: false, because: 'ALERT_TYPE_DISABLED' }
    },
  }
  const report = await drain({ store: s.api, transport, source: watchingSource })

  assert.ok(
    resolvedAfter.includes('runClaim'),
    'the message was resolved before the claim was run; current preferences must mean current',
  )
  assert.deepEqual(transport.handoffs, [], 'nothing was sent')
  assert.deepEqual(s.opened, [], 'and no attempt row was opened for a send that never happened')
  assert.deepEqual(s.withdrawn, [{ messageId: 'msg-1', because: 'ALERT_TYPE_DISABLED' }])
  assert.deepEqual(report.results, [
    { messageId: messageId('msg-1'), kind: 'WITHDRAWN', because: 'ALERT_TYPE_DISABLED' },
  ])
})

test('a suppressed address is refused before an attempt is opened', async () => {
  const s = store([job()])
  const transport = recordingTransport(acceptsEverything)
  const report = await drain({
    store: s.api, transport, suppressions: suppressionsOf([ADDRESS]),
  })

  assert.deepEqual(transport.handoffs, [])
  assert.deepEqual(s.opened, [], 'an attempt row here would make inFlight report a phantom send')
  assert.deepEqual(report.results.map((r) => r.kind), ['SUPPRESSED_ADDRESS'])
})

test('a permanent refusal suppresses the address AND records which message killed it', async () => {
  // Two subjects, two writes, in that order: the job's fate, then the address's. Doing them in
  // one write is how a bad day for one message silences an entire inbox.
  const s = store([job()])
  const transport = recordingTransport(refusesPermanently('mailbox does not exist'))
  await drain({ store: s.api, transport })

  assert.equal(s.settled[0]!.job.state, 'GAVE_UP')
  assert.deepEqual(s.suppressed, [{ address: ADDRESS, messageId: 'msg-1' }])
  assert.ok(
    s.writes.indexOf('settleAttempt') < s.writes.indexOf('suppress'),
    'the settlement is durable before the address-level consequence',
  )
})

test('a retryable refusal spends one attempt and leaves the job ready, backed off', async () => {
  const s = store([job()])
  const transport = recordingTransport(refusesRetryably())
  await drain({ store: s.api, transport })

  const next = s.settled[0]!.job
  assert.equal(next.state, 'READY')
  assert.equal(next.attemptsMade, 1)
  assert.ok(Date.parse(next.notBeforeIso) > Date.parse(T0), 'it waits, and the wait is a fact')
  assert.deepEqual(s.suppressed, [], 'a retryable refusal says nothing about the address')
})

test('the budget is spent from the job, so a restart cannot reset it', async () => {
  // maxAttempts lives on the row precisely because a worker-held count restarts with the worker.
  const s = store([job({ attemptsMade: 2, maxAttempts: 3 })])
  const transport = recordingTransport(refusesRetryably())
  await drain({ store: s.api, transport })

  assert.equal(s.settled[0]!.job.state, 'EXHAUSTED')
})

test('an ineligible job is named, never silently skipped', async () => {
  // A count is not something an operator can act on, and "not in the queue" is the same
  // observation as "succeeded" if absence is the only signal.
  const s = store([job({ state: 'CANCELLED' })])
  const transport = recordingTransport(acceptsEverything)
  const report = await drain({ store: s.api, transport })

  assert.deepEqual(transport.handoffs, [])
  const [only] = report.results
  assert.equal(only!.kind, 'INELIGIBLE')
  assert.deepEqual((only as { because: { kind: string } }).because.kind, 'TERMINAL')
})

test('one bad job does not stop the pass, and nothing throws out of the worker', async () => {
  // COLLECTION OUTRANKS ALERTING. A worker that throws can fail whatever shares its process, and
  // a sync must not be failable by an alert.
  const s = store([job({ messageId: messageId('bad') }), job({ messageId: messageId('good') })])
  const transport = recordingTransport(inSequence([
    () => { throw new Error('provider exploded') },
    acceptsEverything,
  ]))
  const report = await drain({ store: s.api, transport })

  assert.deepEqual(report.results.map((r) => r.kind), ['FAILED', 'SENT'])
  assert.equal(report.considered, 2)
})

test('a store that cannot be read is reported, not thrown', async () => {
  const s = store([job()], 'dueJobs')
  const report = await drain({ store: s.api })
  assert.deepEqual(report.results.map((r) => r.kind), ['FAILED'])
  assert.equal(report.considered, 0)
})

// ---------------------------------------------------------------------------------------
// IDEMPOTENCY. The property the provider needs from us, stated in both directions.
// ---------------------------------------------------------------------------------------

test('retries of one message reuse its key; different messages never share one', async () => {
  // BOTH HALVES, because checking only the first passes on a transport handed one key for
  // everything — and a shared key across messages is a provider deduplicating away a real alert,
  // which is the catastrophic direction.
  const first = store([job({ messageId: messageId('m1'), idempotencyKey: idempotencyKey('k1') })])
  const retried = store([job({ messageId: messageId('m1'), idempotencyKey: idempotencyKey('k1'), attemptsMade: 1 })])
  const transport = recordingTransport(refusesRetryably())

  await drain({ store: first.api, transport })
  await drain({ store: retried.api, transport })
  assert.deepEqual(distinctKeys(transport), ['k1'], 'one message, one key, across attempts')
  assert.deepEqual(
    transport.handoffs.map((h) => h.outbound.permit.attemptNo), [1, 2],
    'and the attempt number came from the job, not from a counter in the worker',
  )

  const other = store([job({ messageId: messageId('m2'), idempotencyKey: idempotencyKey('k2') })])
  await drain({ store: other.api, transport })
  assert.deepEqual(distinctKeys(transport), ['k1', 'k2'], 'two messages, two keys')
})

test('the default transport in this repository cannot send and does not burn the budget', async () => {
  // NO_TRANSPORT_CONFIGURED refuses RETRYABLY on purpose: a permanent refusal would leave a queue
  // of jobs that had already given up by the time somebody wired a real provider.
  const s = store([job()])
  await drain({ store: s.api })
  assert.equal(s.settled[0]!.job.state, 'READY')
  assert.equal(s.suppressed.length, 0, 'and it must not look like a dead address')
})

test('accepted() counts only what a provider took, and excludes every other outcome', async () => {
  // A QUEUED JOB IS NOT A DELIVERED EMAIL, AND NEITHER IS AN ACCEPTED ONE. Whether it arrived is
  // a different fact that arrives later by webhook.
  //
  // BOTH DIRECTIONS, and the first version of this test only had one. Asserting that an accepted
  // send appears passes on an implementation that counts everything — a mutation adding REFUSED
  // to the filter survived it. The over-count is the dangerous direction: this number is what a
  // report means by "we sent these", and a refusal counted as a send is the product claiming to
  // have told an MSP something it did not tell them.
  const sent = store([job({ messageId: messageId('ok') })])
  const okTransport = recordingTransport(acceptsEverything)
  const sentReport = await drain({ store: sent.api, transport: okTransport })
  assert.deepEqual(accepted(sentReport), [messageId('ok')])

  for (const [label, answering] of [
    ['retryable refusal', refusesRetryably()],
    ['permanent refusal', refusesPermanently()],
  ] as const) {
    const s = store([job({ messageId: messageId('no') })])
    const report = await drain({ store: s.api, transport: recordingTransport(answering) })
    assert.deepEqual(accepted(report), [], `${label} must not count as a send`)
  }

  // Withdrawn and suppressed are not sends either, and they are the two that never reach a
  // provider at all — so an implementation counting "everything that left the queue" fails here.
  const withdrawnStore = store([job({ messageId: messageId('off') })])
  const withdrawnReport = await drain({
    store: withdrawnStore.api,
    transport: recordingTransport(acceptsEverything),
    source: withdraws('ALERT_TYPE_DISABLED'),
  })
  assert.deepEqual(accepted(withdrawnReport), [])

  const deadStore = store([job({ messageId: messageId('dead') })])
  const deadReport = await drain({
    store: deadStore.api,
    transport: recordingTransport(acceptsEverything),
    suppressions: suppressionsOf([ADDRESS]),
  })
  assert.deepEqual(accepted(deadReport), [])

  assert.equal(
    Object.keys(sentReport).includes('delivered'), false,
    'no field in this report may claim delivery',
  )
})

test('A WITHDRAWAL THAT UPDATES NO ROW IS NOT REPORTED AS A WITHDRAWAL', async () => {
  // THE ROW COUNT IS THE ANSWER, exactly as it is for a claim. `withdrawStatement` excludes
  // terminal jobs, so zero rows means the job finished between the resolve and the write — an
  // operator pressing stop in between is the reachable case. Nothing went wrong and nothing was
  // withdrawn, so neither WITHDRAWN nor FAILED is true.
  //
  // WHY IT MATTERS MORE THAN IT LOOKS: reporting it as WITHDRAWN would make the drain report
  // disagree with the table — the report would say the send was withdrawn for a reason, and the
  // row would say CANCELLED by a person. Somebody reconciling the two six months later finds two
  // different accounts of the same job and no way to tell which is the record.
  const s = store([job()])
  s.settleFirst()
  const transport = recordingTransport(acceptsEverything)

  const report = await drain({ store: s.api, transport, source: withdraws('ALERT_TYPE_DISABLED') })

  assert.deepEqual(report.results, [
    { messageId: messageId('msg-1'), kind: 'ALREADY_SETTLED', because: 'ALERT_TYPE_DISABLED' },
  ])
  assert.deepEqual(transport.handoffs, [], 'and still nothing was sent')
  assert.deepEqual(s.opened, [], 'nor was an attempt opened')
  // The write was ATTEMPTED — the distinction is the count it came back with, not a skipped call.
  assert.ok(s.writes.includes('runWithdraw'))
})

test('the withdrawal statement carries the reason the schema will accept', async () => {
  // EVERY ARM, not one witness. The CHECK on `withdrawn_because` lists exactly these four, so a
  // reason the resolver can produce and the column refuses is an insert that fails in production
  // — and `send-queue.test.ts` holds the two lists together. This is the other half: that each
  // one actually survives the worker and reaches the params.
  for (const reason of WITHDRAWN_REASONS) {
    const s = store([job()])
    const report = await drain({
      store: s.api, transport: recordingTransport(acceptsEverything), source: withdraws(reason),
    })

    assert.deepEqual(s.withdrawn, [{ messageId: 'msg-1', because: reason }])
    assert.deepEqual(report.results, [
      { messageId: messageId('msg-1'), kind: 'WITHDRAWN', because: reason },
    ])
  }
})
