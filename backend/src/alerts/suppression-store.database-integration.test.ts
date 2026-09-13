import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import {
  SUPPRESSION_SELECT_SQL, suppressionFor, suppressionUpsert, suppressionsFrom,
} from './suppression-store.js'
import { attemptSend, suppressionsOf, type ProviderAnswer, type SendTransport } from './alert-sender.js'
import { claimOutcome, claimStatement, workerId, type SendJob } from './send-queue.js'
import { digestId, idempotencyKey, messageId, operatorAddressOf, type Body } from './email-delivery.js'
import { type VerifiedRecipient } from './routing-policy.js'

/**
 * THE CLAIM THIS FILE EXISTS FOR: a hard bounce outlives the process.
 *
 * `Suppressions` was an interface with one in-memory implementation, so a bounce was forgotten on
 * the next deploy and the dead address was attempted again. A unit test cannot see that — the
 * failure IS the process ending — so the restart is simulated here by discarding the snapshot and
 * loading a fresh one from the table, which is exactly what a new process does.
 *
 * NOTHING IS SENT. The transport is a local double; no provider client exists in this repository.
 */

const RUN = process.env.HAWKVIEW_RUN_DATABASE_INTEGRATION_TESTS === '1'
const URL = process.env.DATABASE_URL
const T0 = '2026-09-13T09:00:00.000Z'
const LATER = '2026-09-14T09:00:00.000Z'
const MSG = 'incident/11111111-1111-1111-1111-111111111111|k1'
const BODY: Body = [{ kind: 'OPEN', digest: digestId('r4nd0m') }]

const INBOX: VerifiedRecipient = {
  kind: 'MSP_SECURITY_INBOX',
  address: 'ops@an-msp.example',
  verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
}

const job = (): SendJob => ({
  messageId: messageId(MSG), idempotencyKey: idempotencyKey('idem-1'), state: 'READY',
  attemptsMade: 0, maxAttempts: 3, notBeforeIso: T0, claim: null, providerId: null,
})

const permit = () => {
  const outcome = claimOutcome(claimStatement(messageId(MSG), workerId('w-1'), T0, 60_000), 1, job())
  assert.ok(outcome.won)
  return outcome.permit
}

const transportSaying = (answer: ProviderAnswer): SendTransport & { calls: number } => {
  const t = { calls: 0, send: async () => { t.calls += 1; return answer } }
  return t
}

const load = async (client: pg.Client) =>
  suppressionsFrom((await client.query(SUPPRESSION_SELECT_SQL)).rows)

const outboundTo = (address: string, key: string) => ({
  permit: permit(),
  to: operatorAddressOf({ ...INBOX, address }),
  body: BODY,
  idempotencyKey: idempotencyKey(key),
})

test('A HARD BOUNCE OUTLIVES THE PROCESS', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await client.query('TRUNCATE alert_suppressed_addresses')

    // A send that hard-bounces. The address is not suppressed yet, so it is attempted.
    const bouncing = transportSaying({ accepted: false, permanent: true, because: 'no such mailbox' })
    const first = await attemptSend(bouncing, outboundTo(INBOX.address, 'idem-1'), await load(client), T0)
    assert.ok(first.sent, 'the first send is attempted — nothing knows the mailbox is dead yet')
    assert.equal(bouncing.calls, 1)

    // The settlement is turned into a suppression and WRITTEN.
    const decision = suppressionFor(first.settled, INBOX.address, MSG)
    assert.equal(decision.kind, 'SUPPRESS')
    if (decision.kind !== 'SUPPRESS') return
    const upsert = suppressionUpsert(decision.write, T0)
    await client.query(upsert.sql, [...upsert.params])

    // THE RESTART. Everything in memory is discarded and a fresh snapshot is loaded from the
    // table, which is what a new process does. Before this table existed, this is where the
    // suppression was lost and the dead mailbox was written to again.
    const afterRestart = await load(client)
    assert.equal(afterRestart.has(operatorAddressOf(INBOX)), true, 'THE BOUNCE SURVIVED')

    const second = await attemptSend(bouncing, outboundTo(INBOX.address, 'idem-2'), afterRestart, T0)
    assert.equal(second.sent, false)
    assert.equal(second.sent === false ? second.refused.kind : null, 'ADDRESS_SUPPRESSED')
    assert.equal(bouncing.calls, 1, 'THE PROVIDER WAS NOT CALLED A SECOND TIME')

    // NOT VACUOUS: an empty snapshot still sends to the same address, so the refusal above is the
    // stored suppression rather than a sender that has stopped sending.
    const blind = await attemptSend(bouncing, outboundTo(INBOX.address, 'idem-3'), suppressionsOf([]), T0)
    assert.ok(blind.sent, 'the suppression comes from the table, not from the sender')

    // AND A DIFFERENT MAILBOX IS UNAFFECTED by the loaded snapshot — suppression is per address,
    // not a global mute that a full table would impose.
    const elsewhere = await attemptSend(
      bouncing, outboundTo('other@an-msp.example', 'idem-4'), afterRestart, T0)
    assert.ok(elsewhere.sent)
  } finally {
    await client.end()
  }
})

test('A REPEAT BOUNCE MOVES last_seen_at AND NEVER first_suppressed_at', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await client.query('TRUNCATE alert_suppressed_addresses')
    const write = { address: 'ops@an-msp.example', reason: 'HARD_BOUNCE', because: 'gone', messageId: MSG } as const

    const first = suppressionUpsert(write, T0)
    await client.query(first.sql, [...first.params])
    const again = suppressionUpsert({ ...write, because: 'still gone' }, LATER)
    await client.query(again.sql, [...again.params])

    const { rows, rowCount } = await client.query(
      'SELECT address, reason, because, first_suppressed_at, last_seen_at FROM alert_suppressed_addresses')
    assert.equal(rowCount, 1, 'ONE ROW PER ADDRESS — the primary key is the address')
    assert.equal(new Date(rows[0].first_suppressed_at).toISOString(), T0, 'the age is not reset')
    assert.equal(new Date(rows[0].last_seen_at).toISOString(), LATER, 'but it is known to be current')
    assert.equal(rows[0].because, 'gone', 'the first fact that stopped us writing is the one kept')
  } finally {
    await client.end()
  }
})

test('THE DATABASE REFUSES A SUPPRESSION WITH NO PROVENANCE', { skip: !RUN || !URL }, async () => {
  const client = new pg.Client({ connectionString: URL })
  await client.connect()
  try {
    await client.query('TRUNCATE alert_suppressed_addresses')
    const insert = `INSERT INTO alert_suppressed_addresses
        (address, reason, because, message_id, first_suppressed_at, last_seen_at)
        VALUES ($1, $2, 'x', $3, $4::timestamptz, $5::timestamptz)`

    // The first question asked of any suppression is what made it happen. A machine-made one with
    // no send behind it is indistinguishable from a person's decision.
    await assert.rejects(
      client.query(insert, ['a@b.example', 'HARD_BOUNCE', null, T0, T0]),
      /provenance_check/, 'a hard bounce must name the send that proved it')

    // MANUAL is the exception, because a person has no message id.
    await client.query(insert, ['c@d.example', 'MANUAL', null, T0, T0])

    // An invented reason is refused rather than stored, or the vocabulary is whatever was typed.
    await assert.rejects(
      client.query(insert, ['e@f.example', 'PROBABLY_DEAD', MSG, T0, T0]), /reason_check/)

    // AND THE ORDERING, which otherwise makes every "how long has this been dead" answer negative.
    await assert.rejects(
      client.query(insert, ['g@h.example', 'HARD_BOUNCE', MSG, LATER, T0]), /time_check/)

    // NOT VACUOUS: the well-formed row goes in, so the three refusals above are about the
    // constraints rather than about a table nothing can be written to.
    await client.query(insert, ['i@j.example', 'HARD_BOUNCE', MSG, T0, LATER])
    assert.equal((await client.query('SELECT count(*) FROM alert_suppressed_addresses')).rows[0].count, '2')
  } finally {
    await client.end()
  }
})
