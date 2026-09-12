import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_LEDGER, accept, accounting, authenticate, digestId, idempotencyKey, messageId,
  operatorAddressOf, providerMessageId, record, unconfirmed,
  type Acceptance, type Body, type Job, type Ledger, type OperatorAddress, type RawWebhook,
  type SendAttempt,
} from './email-delivery.js'
import { type VerifiedRecipient } from './routing-policy.js'

/** Step 06. Nothing here touches a network, a key or an inbox — see the module header for what
 * that means and does not mean. */

const INBOX: VerifiedRecipient = {
  kind: 'MSP_SECURITY_INBOX',
  address: 'security@an-msp.example',
  verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
}

const BODY: Body = [
  { kind: 'TYPE_COUNT', alertTypeId: 'monitoring.collector_failing', tenantsAffected: 3, incidentsAffected: 5 },
  { kind: 'WINDOW', fromIso: '2026-09-12T09:00:00.000Z', toIso: '2026-09-12T09:05:00.000Z' },
  { kind: 'OPEN', digest: digestId('r4nd0m') },
]

const attempt = (id: string): SendAttempt => ({
  messageId: messageId(id),
  to: operatorAddressOf(INBOX),
  body: BODY,
  idempotencyKey: idempotencyKey(`idem-${id}`),
})

const ACCEPTED = (providerId: string, atIso = '2026-09-12T09:00:00.000Z'): Acceptance =>
  ({ kind: 'ACCEPTED', providerId: providerMessageId(providerId), atIso })

const webhook = (over: Partial<RawWebhook> = {}): RawWebhook => ({
  providerId: providerMessageId('p-1'),
  kind: 'DELIVERED',
  atIso: '2026-09-12T09:00:30.000Z',
  bounce: null,
  ...over,
})

const sent = (): Ledger => accept(EMPTY_LEDGER, attempt('m-1'), ACCEPTED('p-1'))

test('ACCEPTED IS NOT AN OUTCOME - a taken message is UNRESOLVED, not delivered', () => {
  // The finding the whole file is shaped by. The provider answers synchronously; whether it
  // ARRIVED is a different fact that turns up later, about a send that already returned. A
  // `send(): Promise<Outcome>` seam cannot hold both, and the property it cannot express reads
  // exactly like a property that passed.
  const ledger = sent()
  assert.equal(ledger.jobs.length, 1)
  assert.equal(ledger.jobs[0]?.state, 'UNRESOLVED')

  // AND THERE IS NOWHERE TO PUT "DELIVERED" IN AN ACCEPTANCE. The two unions share no member,
  // so nothing can read one as the other by accident — see the negatives at the bottom.
  const states = new Set(ledger.jobs.map((job) => job.state))
  assert.ok(!states.has('RESOLVED'))

  // A refusal produces a job with NO provider id, because the provider never gave one.
  const refused = accept(EMPTY_LEDGER, attempt('m-2'),
    { kind: 'REFUSED', code: 'RATE_LIMITED', atIso: '2026-09-12T09:00:00.000Z' })
  const job = refused.jobs[0]
  assert.equal(job?.state, 'REFUSED')
  assert.ok(job !== undefined && !('providerId' in job))
})

test('AN ACCEPTED JOB NOBODY MENTIONS AGAIN IS REPORTED, not left reading as success', () => {
  // QA's own first draft sat in ACCEPTED forever while every accounting identity passed. A
  // bounce nobody reads is the same silence as a hold that expires — the fifth member of that
  // family in this feature, and the reason `unresolvedSince` is a field you cannot omit.
  const ledger = sent()
  const HOUR = 3_600_000

  assert.deepEqual(unconfirmed(ledger, '2026-09-12T09:10:00.000Z', HOUR), [],
    'ten minutes in, nothing is overdue')
  assert.equal(unconfirmed(ledger, '2026-09-12T11:00:00.000Z', HOUR).length, 1,
    'two hours in, it is')

  // AND IT STOPS BEING REPORTED ONCE RESOLVED, or "everything is overdue" satisfies the above.
  const delivered = record(ledger, authenticate(webhook(), 'AUTHENTIC'))
  assert.deepEqual(unconfirmed(delivered, '2026-09-12T11:00:00.000Z', HOUR), [])

  // A REFUSED JOB IS NOT UNCONFIRMED EITHER. It is finished; the provider said no.
  const refused = accept(EMPTY_LEDGER, attempt('m-2'),
    { kind: 'REFUSED', code: 'INVALID_ADDRESS', atIso: '2026-09-12T09:00:00.000Z' })
  assert.deepEqual(unconfirmed(refused, '2026-09-13T09:00:00.000Z', HOUR), [])
})

test('AN EVENT FOR A JOB WE DO NOT HOLD IS NAMED, never dropped', () => {
  // The unmapped-row shape from the apply, arriving in a new place. Three different facts —
  // somebody else's message, a job we lost, an id we never recorded — and discarding the event
  // makes all three look like nothing happening.
  const ledger = record(sent(), authenticate(webhook({ providerId: providerMessageId('p-unknown') }), 'AUTHENTIC'))

  assert.equal(ledger.unmatched.length, 1)
  assert.equal(ledger.unmatched[0]?.because, 'NO_SUCH_JOB')
  assert.equal(ledger.unmatched[0]?.providerId, 'p-unknown')
  assert.equal(ledger.jobs[0]?.state, 'UNRESOLVED', 'and the real job is untouched')
  assert.deepEqual(accounting(ledger, 1), [], 'one event in, one accounted for')
})

test('AN UNSIGNED EVENT CANNOT BECOME AN OUTCOME - structurally, not by a check', () => {
  // QA cannot verify a webhook is authentic rather than forged, so it is pinned from the other
  // side: `record` takes only a `Received`, and the sole constructor is `authenticate`. An
  // unauthenticated endpoint that updates delivery state is an endpoint anybody can use to mark
  // our messages delivered.
  for (const verdict of ['SIGNATURE_MISSING', 'SIGNATURE_INVALID'] as const) {
    const ledger = record(sent(), authenticate(webhook(), verdict))
    assert.equal(ledger.jobs[0]?.state, 'UNRESOLVED', `${verdict} must not resolve the job`)
    assert.equal(ledger.unmatched[0]?.because, verdict)
    assert.deepEqual(accounting(ledger, 1), [])
  }

  // POSITIVE CONTROL: the same event, authentic, does resolve it — so the refusal is about the
  // signature and not about the event being unmatchable.
  const good = record(sent(), authenticate(webhook(), 'AUTHENTIC'))
  assert.equal(good.jobs[0]?.state, 'RESOLVED')
})

test('A SECOND OUTCOME DOES NOT OVERWRITE THE FIRST', () => {
  // Resend can redeliver a webhook, and a delivered message can later be complained about.
  // Overwriting leaves the first fact gone with nothing recording it was ever true.
  const once = record(sent(), authenticate(webhook(), 'AUTHENTIC'))
  const twice = record(once, authenticate(webhook({ kind: 'COMPLAINED', atIso: '2026-09-12T10:00:00.000Z' }), 'AUTHENTIC'))

  const job = twice.jobs[0]
  assert.equal(job?.state, 'RESOLVED')
  assert.equal(job?.state === 'RESOLVED' ? job.outcome.kind : null, 'DELIVERED', 'the first one stands')
  assert.equal(twice.unmatched[0]?.because, 'ALREADY_RESOLVED')
  assert.deepEqual(accounting(twice, 2), [], 'and the second event is still accounted for')
})

test('AN UNCLASSIFIED BOUNCE IS HARD, and that direction is the deliberate one', () => {
  // HARD and SOFT are different facts about the future, not severities. Treating an
  // unclassified bounce as soft retries forever against an address that may never work; HARD
  // stops, and stopping is the recoverable mistake — somebody re-verifies the inbox.
  const ledger = record(sent(), authenticate(webhook({ kind: 'BOUNCED', bounce: null }), 'AUTHENTIC'))
  const job = ledger.jobs[0]
  assert.equal(job?.state === 'RESOLVED' && job.outcome.kind === 'BOUNCED' ? job.outcome.bounce : null, 'HARD')

  // A STATED CLASS IS NOT OVERRIDDEN, or the above is satisfied by ignoring the field.
  const soft = record(sent(), authenticate(webhook({ kind: 'BOUNCED', bounce: 'SOFT' }), 'AUTHENTIC'))
  const softJob = soft.jobs[0]
  assert.equal(softJob?.state === 'RESOLVED' && softJob.outcome.kind === 'BOUNCED' ? softJob.outcome.bounce : null, 'SOFT')
})

test('EVERY EVENT IS IN EXACTLY ONE PLACE, and the books say when they are not', () => {
  let ledger = accept(EMPTY_LEDGER, attempt('m-1'), ACCEPTED('p-1'))
  ledger = accept(ledger, attempt('m-2'), ACCEPTED('p-2'))
  ledger = record(ledger, authenticate(webhook({ providerId: providerMessageId('p-1') }), 'AUTHENTIC'))
  ledger = record(ledger, authenticate(webhook({ providerId: providerMessageId('p-3') }), 'AUTHENTIC'))
  ledger = record(ledger, authenticate(webhook({ providerId: providerMessageId('p-2') }), 'SIGNATURE_INVALID'))

  assert.deepEqual(accounting(ledger, 3), [])
  assert.equal(ledger.unmatched.length, 2)

  // IT IS NOT VACUOUS: miscount the events and it names the gap with its size.
  const problems = accounting(ledger, 4)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /4 events received, 3 accounted for/)

  // AND A PROVIDER ID ON TWO OPEN JOBS IS A PROBLEM, because an event could resolve either.
  const doubled = accept(ledger, attempt('m-3'), ACCEPTED('p-2'))
  assert.equal(accounting(doubled, 3).filter((line) => line.includes('share provider id')).length, 1)
})

test('THE BODY HAS NO SLOT FOR A PERSON OR A TENANT - the file type-checking is the evidence', () => {
  // M8 and M9 are type-level with no runtime variant ON PURPOSE. A leak searched for is a leak
  // you can spell wrong; the absence of a slot cannot be spelled wrong. Each negative below is
  // a compile error, so `tsc` failing to complain IS the failure — an unused `@ts-expect-error`
  // is itself an error, which is what makes these assertions rather than comments.

  // 1. A tenant name has nowhere to go.
  const withTenantName: Body = [{
    kind: 'TYPE_COUNT', alertTypeId: 'monitoring.collector_failing',
    tenantsAffected: 1, incidentsAffected: 1,
    // @ts-expect-error - no slot for a customer name
    tenantName: 'Contoso Ltd',
  }]

  // 2. Neither does a person.
  const withPerson: Body = [{
    kind: 'TYPE_COUNT', alertTypeId: 'monitoring.collector_failing',
    tenantsAffected: 1, incidentsAffected: 1,
    // @ts-expect-error - no slot for a person
    actor: 'ada@contoso.example',
  }]

  // 3. There is no free-text line, so there is nowhere to paste one either.
  // @ts-expect-error - FREE_TEXT is not a body line
  const withProse: Body = [{ kind: 'FREE_TEXT', text: 'Contoso Ltd had a problem' }]

  // 4. An empty body is not a body.
  // @ts-expect-error - a body is non-empty
  const empty: Body = []

  // 5. The alert type comes from the catalogue, not from a caller.
  const madeUpType: Body = [{
    // @ts-expect-error - not a catalogue id
    kind: 'TYPE_COUNT', alertTypeId: 'security.something_i_invented',
    tenantsAffected: 1, incidentsAffected: 1,
  }]

  // 6. The link is an opaque id. A path naming a customer is not one.
  // @ts-expect-error - a raw string is not a DigestId
  const withPath: Body = [{ kind: 'OPEN', digest: '/tenants/contoso-ltd/incidents' }]

  // 7. A hold reason is closed, because `because: string` is free text in a reason's clothes.
  const withProseReason: Body = [{
    // @ts-expect-error - not a HoldReason
    kind: 'HELD_UNTIL', untilIso: '2026-09-12T07:00:00.000Z', reason: 'the customer asked us to wait',
  }]

  // 8. AND THE RECIPIENT CANNOT BE A CUSTOMER, because it cannot be a string.
  // @ts-expect-error - the only constructor takes a VerifiedRecipient
  const customer: OperatorAddress = 'someone@a-customer.example'

  // 9. An unverified webhook has no path into the ledger.
  // @ts-expect-error - record takes a Received, never a RawWebhook
  const skipped = record(EMPTY_LEDGER, webhook())

  // Referenced so none of the above is dead code the compiler may skip.
  assert.ok([withTenantName, withPerson, withProse, empty, madeUpType, withPath,
    withProseReason, customer, skipped].length === 9)
})

test('THE ONLY WAY TO ADDRESS A MESSAGE IS THROUGH A VERIFIED RECIPIENT', () => {
  // The positive half of negative 8. Every arm of `VerifiedRecipient` is an MSP-side inbox
  // somebody verified, so an address derived from one is an operator address by construction —
  // "never a customer end user" is a value this code cannot build, not a rule it follows.
  assert.equal(operatorAddressOf(INBOX), 'security@an-msp.example')
  assert.equal(
    operatorAddressOf({
      kind: 'DESIGNATED_OWNER', userId: 'u-1', address: 'owner@an-msp.example',
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    }),
    'owner@an-msp.example')
})

test('A JOB IS IN EXACTLY ONE STATE, and the union has no fourth reading', () => {
  // The shape that would have let ACCEPTED be a resting state is an `outcome: Outcome | null`
  // field, where null reads as "fine so far" and nothing says since when.
  const states: Job['state'][] = ['UNRESOLVED', 'RESOLVED', 'REFUSED']
  assert.equal(new Set(states).size, 3)

  const ledger = sent()
  const job = ledger.jobs[0]
  assert.ok(job !== undefined && job.state === 'UNRESOLVED')
  assert.equal(job.unresolvedSinceIso, job.acceptedAtIso,
    'equal today, and separate fields because a re-opened job waits from then, not from the send')
})
