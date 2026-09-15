import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_ADDRESS_LENGTH, suppressionFor, suppressionUpsert, suppressionsFrom,
  type SuppressionWrite,
} from './suppression-store.js'
import { operatorAddressOf } from './email-delivery.js'
import { suppressesAddress } from './alert-sender.js'
import { type Settled } from './send-queue.js'
import { type VerifiedRecipient } from './routing-policy.js'

/** The suppression store. The point of the file is that a hard bounce outlives the process. */

const T0 = '2026-09-13T09:00:00.000Z'
const INBOX: VerifiedRecipient = {
  kind: 'MSP_SECURITY_INBOX',
  address: 'ops@an-msp.example',
  verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
}
const hard: Settled = { kind: 'REFUSED_PERMANENT', atIso: T0, because: 'no such mailbox' }
const soft: Settled = { kind: 'REFUSED_RETRYABLE', atIso: T0, because: 'rate limited' }
const ok: Settled = { kind: 'ACCEPTED', providerId: 'p-1' as never, atIso: T0 }

test('A HARD BOUNCE SUPPRESSES; NOTHING ELSE DOES', () => {
  const decision = suppressionFor(hard, 'ops@an-msp.example', 'incident/o|k')
  assert.equal(decision.kind, 'SUPPRESS')
  assert.equal(decision.kind === 'SUPPRESS' ? decision.write.reason : null, 'HARD_BOUNCE')
  assert.equal(decision.kind === 'SUPPRESS' ? decision.write.because : null, 'no such mailbox')

  // THE CONTROL: without these the rule is satisfied by suppressing everything, which would
  // silence the product on its first rate limit.
  assert.equal(suppressionFor(soft, 'ops@an-msp.example', 'incident/o|k').kind, 'NONE')
  assert.equal(suppressionFor(ok, 'ops@an-msp.example', 'incident/o|k').kind, 'NONE')
})

test('IT CANNOT DISAGREE WITH THE SENDER ABOUT WHAT SUPPRESSES', () => {
  // Two functions answering "does this suppress" from the same input is two places holding one
  // fact. This is the check that they still agree, over every settlement kind there is.
  for (const settled of [hard, soft, ok]) {
    const decision = suppressionFor(settled, 'ops@an-msp.example', 'incident/o|k')
    assert.equal(decision.kind === 'SUPPRESS', suppressesAddress(settled),
      `disagreement on ${settled.kind}`)
  }
})

test('AN ADDRESS THAT CANNOT BE RECORDED SAYS SO, rather than reading as nothing to do', () => {
  // COLLAPSING THIS INTO "NONE" IS HOW A PERMANENT HOLE LOOKS LIKE A WORKING GUARD. An address
  // too long for the column would be retried for ever while the code read as if it had handled
  // the bounce.
  const long = `${'a'.repeat(MAX_ADDRESS_LENGTH)}@x.example`
  const decision = suppressionFor(hard, long, 'incident/o|k')
  assert.equal(decision.kind, 'UNSUPPRESSABLE')
  assert.match(decision.kind === 'UNSUPPRESSABLE' ? decision.because : '', /past the 320/)

  assert.equal(suppressionFor(hard, '   ', 'incident/o|k').kind, 'UNSUPPRESSABLE')

  // AND IT IS NOT TRUNCATED TO FIT. A truncated address is a DIFFERENT address, and suppressing
  // it would silence a mailbox that never bounced.
  assert.equal(suppressionFor(hard, 'a'.repeat(MAX_ADDRESS_LENGTH), 'incident/o|k').kind, 'SUPPRESS')
})

test('THE SNAPSHOT MATCHES REGARDLESS OF CASE AND SURROUNDING SPACE', () => {
  // Matching case-sensitively would let one capital letter defeat a suppression and write to a
  // dead mailbox. The error direction decides it: the worst a case-insensitive match can do is
  // withhold from an address already proven dead in another case.
  const suppressions = suppressionsFrom([{ address: 'Ops@An-MSP.example' }])
  assert.equal(suppressions.has(operatorAddressOf(INBOX)), true)
  assert.equal(suppressions.has(operatorAddressOf({ ...INBOX, address: 'OPS@AN-MSP.EXAMPLE' })), true)

  // NOT VACUOUS: a different mailbox is not suppressed, or the set is a global mute.
  assert.equal(suppressions.has(operatorAddressOf({ ...INBOX, address: 'other@an-msp.example' })), false)
  assert.equal(suppressionsFrom([]).has(operatorAddressOf(INBOX)), false)
})

test('A REPEAT BOUNCE MOVES last_seen_at AND NEVER first_suppressed_at', () => {
  // It answers "since when". A repeat moving it would reset the age of every address that is
  // still bouncing, so the ones dead longest would read as the newest — the exact reverse of
  // what anybody opens this table to find out.
  const write: SuppressionWrite = {
    address: 'Ops@An-MSP.example', reason: 'HARD_BOUNCE', because: 'gone', messageId: 'incident/o|k',
  }
  const statement = suppressionUpsert(write, T0)

  assert.match(statement.sql, /ON CONFLICT \(address\) DO UPDATE SET last_seen_at/)
  assert.doesNotMatch(statement.sql, /DO UPDATE[\s\S]*first_suppressed_at/)
  // NOR THE REASON: a complaint arriving after a hard bounce does not make the mailbox exist.
  assert.doesNotMatch(statement.sql, /DO UPDATE[\s\S]*reason/)

  // STORED LOWER-CASE, or the primary key holds two rows for one mailbox and "is this
  // suppressed" has two answers and no owner.
  assert.equal(statement.params[0], 'ops@an-msp.example')
  assert.equal(statement.params[4], T0, 'both timestamps come from one parameter')
})

test('A LONG PROVIDER EXPLANATION IS TRUNCATED, NOT DROPPED', () => {
  // Losing the tail of an explanation is a smaller loss than losing the suppression.
  const statement = suppressionUpsert({
    address: 'ops@an-msp.example', reason: 'HARD_BOUNCE',
    because: 'x'.repeat(900), messageId: 'incident/o|k',
  }, T0)
  assert.equal(String(statement.params[2]).length, 500)
})

test('A MACHINE-MADE SUPPRESSION CARRIES THE SEND THAT PROVED IT', () => {
  // The first question asked of any suppression is what made it happen. MANUAL is the only
  // reason with no send behind it, and the type is what makes the other two unwriteable without
  // one — the CHECK in the migration says the same thing to anything that bypasses this.
  const machine = suppressionUpsert({
    address: 'ops@an-msp.example', reason: 'HARD_BOUNCE', because: 'gone', messageId: 'incident/o|k',
  }, T0)
  assert.equal(machine.params[3], 'incident/o|k')

  const manual = suppressionUpsert({
    address: 'ops@an-msp.example', reason: 'MANUAL', because: 'asked us to stop',
  }, T0)
  assert.equal(manual.params[3], null)

  // @ts-expect-error - a hard bounce with no message id does not typecheck
  const forged: SuppressionWrite = { address: 'a@b.example', reason: 'HARD_BOUNCE', because: 'x' }
  assert.ok(forged !== null)
})
