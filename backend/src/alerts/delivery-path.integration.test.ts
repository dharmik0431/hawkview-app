import assert from 'node:assert/strict'
import test from 'node:test'
import { suppressionsOf } from './alert-sender.js'
import { outcomeRow, suppressesOnOutcome, parseResendEvent } from './delivery-events.js'
import { authenticate, idempotencyKey, messageId } from './email-delivery.js'
import { type ObservedCondition } from './alert-lifecycle.js'
import { type CurrentState, type IncidentNow, messageSourceOf, parseMessageId } from './message-source.js'
import { acceptsEverything, recordingTransport, refusesPermanently } from './recording-transport.js'
import { workerId, type SendJob } from './send-queue.js'
import { accepted, drainOnce, type SendStore } from './send-worker.js'

/**
 * THE INTEGRATION CHECKPOINT. One synthetic incident travelling the joined path.
 *
 * **THIS IS A PROBE, NOT A DELIVERY, AND NOT A REDUCED RELEASE.** Nothing here reaches a network.
 * The transport is the recording double, the store is in memory, and what the test establishes is
 * that the SEAMS line up — that a message id minted by the pipeline parses back into the incident
 * the resolver needs, that the worker's `Outbound` is built from current state rather than frozen
 * state, and that an outcome arriving later lands against the same message. Whether an email
 * arrives is a different fact that no test in this repository can reach.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM: that the provider honours an idempotency key, that
 * `accepted` means the provider took responsibility, or anything about real bounce rates. Those
 * need the provider and are on the acceptance checklist for exactly that reason.
 */

const T0 = '2026-09-13T09:00:00.000Z'
const ORG = '11111111-1111-4111-8111-111111111111'
const INCIDENT_KEY = 'security.suspected_credential_attack|tenant:contoso'
const MESSAGE_ID = `incident/${ORG}|${INCIDENT_KEY}`

const INCIDENT: IncidentNow = {
  alertTypeId: 'security.suspected_credential_attack',
  // ALL THREE AXES, ALL LEGAL. This fixture said `condition: 'OPEN'` — a value the column's
  // CHECK would refuse, because OPEN belongs to `investigation`.
  condition: 'ACTIVE',
  ownership: 'UNACKNOWLEDGED',
  investigation: 'OPEN',
  firstSeenIso: '2026-09-13T08:00:00.000Z',
  lastSeenIso: T0,
  tenantsAffected: 1,
  incidentsAffected: 3,
}

const job: SendJob = {
  messageId: messageId(MESSAGE_ID),
  idempotencyKey: idempotencyKey(MESSAGE_ID),
  state: 'READY',
  attemptsMade: 0,
  maxAttempts: 3,
  notBeforeIso: T0,
  claim: null,
  providerId: null,
}

function currentState(over: Partial<CurrentState> = {}): CurrentState {
  return {
    incident: async () => INCIDENT,
    disposition: async () => 'ACT_NOW',
    visibility: async () => 'SURFACED' as const,
    recipient: async () => ({
      kind: 'MSP_SECURITY_INBOX', address: 'soc@msp.example', verifiedAt: new Date(T0),
    }),
    ...over,
  }
}

/** In-memory, and it records what the real store would have written. */
function memoryStore(jobs: readonly SendJob[]) {
  const attempts: { messageId: string; attemptNo: number; providerId?: string }[] = []
  const withdrawn: string[] = []
  const states: string[] = []
  const store: SendStore = {
    dueJobs: async () => jobs,
    runClaim: async () => 1,
    openAttempt: async (a) => { attempts.push({ messageId: a.messageId, attemptNo: a.attemptNo }) },
    settleAttempt: async (a, settled, next) => {
      states.push(next.state)
      const found = attempts.find((x) => x.messageId === a.messageId && x.attemptNo === a.attemptNo)
      if (found && settled.kind === 'ACCEPTED') found.providerId = settled.providerId
    },
    // From the statement's params, so what this records is what the column would receive.
    runWithdraw: async (_sql, params) => { withdrawn.push(`${params[0]}:${params[1]}`); return 1 },
    suppress: async () => {},
  }
  return { store, attempts, withdrawn, states }
}

// ---------------------------------------------------------------------------------------

test('the pipeline s message id parses back into the incident the resolver needs', () => {
  // THE SEAM MOST LIKELY TO BE WRONG, because two modules agree about a string format and
  // nothing makes them agree. The producer mints `incident/<organizationId>|<incidentKey>`; this
  // asserts the consumer reads back exactly what was written, including an incident key that
  // itself contains a `|`.
  assert.deepEqual(parseMessageId(MESSAGE_ID), { organizationId: ORG, incidentKey: INCIDENT_KEY })
})

test('a message id in any other shape is refused rather than guessed at', () => {
  for (const bad of ['', 'incident/', `incident/${ORG}`, `incident/${ORG}|`, `digest/${ORG}|k`, ORG]) {
    assert.equal(parseMessageId(bad), null, bad)
  }
})

test('one synthetic incident travels the joined path and an outcome lands against it', async () => {
  // THE CHECKPOINT. Queue -> claim -> resolve from current state -> attempt -> transport ->
  // settle, then a webhook outcome arriving later and matching the same message.
  const { store, attempts, states } = memoryStore([job])
  const transport = recordingTransport(acceptsEverything)

  const report = await drainOnce({
    store,
    transport,
    source: messageSourceOf(currentState()),
    suppressions: suppressionsOf([]),
    by: workerId('probe'),
    nowIso: T0,
    holdForMs: 60_000,
    limit: 10,
  })

  // The worker handed the provider a message built from CURRENT state.
  assert.equal(transport.handoffs.length, 1)
  const handed = transport.handoffs[0]!.outbound
  assert.equal(handed.to, 'soc@msp.example')
  assert.equal(handed.idempotencyKey, MESSAGE_ID, 'the key is the message id, stable across retries')
  assert.deepEqual(handed.body[0], {
    kind: 'TYPE_COUNT',
    alertTypeId: 'security.suspected_credential_attack',
    tenantsAffected: 1,
    incidentsAffected: 3,
  })
  // NOTHING IN THE BODY NAMES A TENANT OR A PERSON, and it is the type that guarantees it —
  // asserted here anyway, because this is the test somebody will read before shipping.
  assert.equal(
    JSON.stringify(handed.body).includes('contoso'), false,
    'the incident key names a tenant; the body must not carry it',
  )

  assert.deepEqual(states, ['SENT'])
  assert.deepEqual(accepted(report), [messageId(MESSAGE_ID)])
  assert.equal(attempts[0]!.providerId !== undefined, true, 'the provider id is attached to the attempt')

  // THE SECOND HALF, ARRIVING LATER. A webhook about the same provider id becomes an outcome
  // against the same message — which is the join the durable-outcome table exists for.
  const providerId = attempts[0]!.providerId!
  const webhook = parseResendEvent(JSON.stringify({
    type: 'email.delivered', created_at: T0, data: { email_id: providerId },
  }))
  assert.equal(webhook.parsed, true)
  const received = authenticate(webhook.parsed ? webhook.raw : ({} as never), 'AUTHENTIC')
  assert.equal(received.authentic, true)
  const row = outcomeRow(
    (received as Extract<typeof received, { authentic: true }>).event,
    messageId(MESSAGE_ID),
  )
  assert.equal(row.kind, 'DELIVERED')
  assert.equal(row.messageId, MESSAGE_ID)
  assert.equal(suppressesOnOutcome(row), false)
})

test('a preference changed after queueing stops the send, and says which change did it', async () => {
  // THE PROPERTY THE WHOLE SEAM EXISTS FOR. Each of these is a different operator action with a
  // different remedy, so a single "not sent" would be unanswerable six months later.
  const cases = [
    ['ALERT_TYPE_DISABLED', currentState({ disposition: async () => 'RECORD_ONLY' })],
    ['NO_VERIFIED_RECIPIENT', currentState({ recipient: async () => null })],
    // CLEARED ALONE IS NOT ENOUGH. needsAttention keeps an UNACKNOWLEDGED incident actionable
    // even once the condition has cleared — the situation stopping is not the same as anybody
    // having seen that it stopped.
    ['INCIDENT_NO_LONGER_ACTIONABLE', currentState({ incident: async () => ({ ...INCIDENT, condition: 'CLEARED', ownership: 'ACKNOWLEDGED' }) })],
    ['MESSAGE_CONTENT_UNAVAILABLE', currentState({ incident: async () => null })],
  ] as const

  for (const [because, state] of cases) {
    const { store, withdrawn, attempts } = memoryStore([job])
    const transport = recordingTransport(acceptsEverything)
    await drainOnce({
      store, transport, source: messageSourceOf(state), suppressions: suppressionsOf([]),
      by: workerId('probe'), nowIso: T0, holdForMs: 60_000, limit: 10,
    })
    assert.deepEqual(transport.handoffs, [], `${because}: nothing may be sent`)
    assert.deepEqual(attempts, [], `${because}: and no attempt row is opened`)
    assert.deepEqual(withdrawn, [`${MESSAGE_ID}:${because}`])
  }
})

test('EVERY CONDITION THE DATABASE PERMITS, and only one of them stops the send', async () => {
  // **THIS TEST USED TO ASSERT WITH `condition: 'RESOLVED'`, A VALUE THE DATABASE WOULD REFUSE.**
  // `alert_incidents_condition_check` permits only ACTIVE | CLEARED | UNKNOWN, and the closed set
  // it was checking said `['CLOSED', 'RESOLVED', 'CLEARED']` — so two of three arms were
  // unreachable and **resolving an incident did not stop its email**. The test agreed with the
  // code because one author wrote both, which is why neither side could notice.
  //
  // SO IT IS NOW A SWEEP OVER THE UNION RATHER THAN A WITNESS. `ObservedCondition` is closed, the
  // map below is exhaustive by type, and a fourth condition added upstream fails to COMPILE here
  // rather than quietly defaulting to "send" — which is the property the original test was named
  // for and could not deliver.
  const expected: Record<ObservedCondition, 'SENDS' | 'WITHDRAWS'> = {
    ACTIVE: 'SENDS',
    // WITHDRAWS ONLY BECAUSE THE SWEEP ACKNOWLEDGES IT, below. Cleared-and-unacknowledged
    // still sends, and that is a separate test rather than a footnote here.
    CLEARED: 'WITHDRAWS',
    // NOT "no longer actionable". UNKNOWN means HawkView cannot currently see whether the
    // condition still holds, and treating "we cannot tell" as "nothing to say" is the
    // absence-reads-as-reassurance failure this product exists to prevent.
    UNKNOWN: 'SENDS',
  }

  for (const [condition, outcome] of Object.entries(expected) as [ObservedCondition, string][]) {
    const { store, withdrawn } = memoryStore([job])
    const transport = recordingTransport(acceptsEverything)
    await drainOnce({
      store,
      transport,
      source: messageSourceOf(currentState({ incident: async () => ({ ...INCIDENT, condition, ownership: 'ACKNOWLEDGED' }) })),
      suppressions: suppressionsOf([]),
      by: workerId('probe'), nowIso: T0, holdForMs: 60_000, limit: 10,
    })

    if (outcome === 'WITHDRAWS') {
      assert.deepEqual(transport.handoffs, [], `${condition} must not send`)
      assert.deepEqual(withdrawn, [`${MESSAGE_ID}:INCIDENT_NO_LONGER_ACTIONABLE`],
        `${condition} must leave the queue saying why`)
    } else {
      // THE DEMONSTRATED NON-FIRING. Without it the guard could refuse everything and still look
      // correct — and a guard that withdraws an ACTIVE incident is the silent-failure direction.
      assert.equal(transport.handoffs.length, 1, `${condition} must still send`)
      assert.deepEqual(withdrawn, [], `${condition} must not be withdrawn`)
    }
  }
})

test('a new lifecycle condition does not silently become a reason to email', async () => {
  // The actionable test is a CLOSED SET rather than `!== 'OPEN'`. The inverted form treats every
  // value it has not seen as actionable, so a state added upstream would quietly start sending.
  const { store } = memoryStore([job])
  const transport = recordingTransport(acceptsEverything)
  await drainOnce({
    store,
    transport,
    // RESOLVED is an INVESTIGATION state — a person deciding the incident is finished — and
    // asserting it as a condition is why this arm never fired for the case it exists for.
    source: messageSourceOf(currentState({ incident: async () => ({ ...INCIDENT, investigation: 'RESOLVED' }) })),
    suppressions: suppressionsOf([]),
    by: workerId('probe'), nowIso: T0, holdForMs: 60_000, limit: 10,
  })
  assert.deepEqual(transport.handoffs, [], 'RESOLVED is in the closed set and must not send')
})

test('a hard bounce on the probe path suppresses the address and names the message', async () => {
  // End to end for the consequence rather than the happy path: the address-level fact and the
  // message-level fact are recorded separately, and the suppression names the send that proved it.
  const suppressed: { address: string; messageId: string }[] = []
  const { store } = memoryStore([job])
  const withSuppress: SendStore = {
    ...store,
    suppress: async (address, id) => { suppressed.push({ address, messageId: id }) },
  }
  await drainOnce({
    store: withSuppress,
    transport: recordingTransport(refusesPermanently('mailbox does not exist')),
    source: messageSourceOf(currentState()),
    suppressions: suppressionsOf([]),
    by: workerId('probe'), nowIso: T0, holdForMs: 60_000, limit: 10,
  })
  assert.deepEqual(suppressed, [{ address: 'soc@msp.example', messageId: MESSAGE_ID }])
})
