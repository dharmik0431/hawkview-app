import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageSourceOf, type CurrentState, type IncidentNow } from './message-source.js'
import type { SendJob } from './send-queue.js'

/**
 * THE ORDER INSIDE `resolve()` IS LOAD-BEARING FOR THE GRADE, AND NOTHING ENFORCED IT.
 *
 * C1 measures the drain-time repair by the reason recorded on the withdrawal. That only works
 * while the disposition check runs BEFORE the recipient read. If the two ever swap, a null or
 * refusing recipient answers first, every job withdraws as `NO_VERIFIED_RECIPIENT`, and C1 goes
 * green with the repair never exercised once -- green precisely because the check cannot reach
 * its subject.
 *
 * That is not hypothetical arithmetic about a future edit. The recipient gate is the one thing
 * in this function with no source of truth today, so it is the arm most likely to be moved,
 * stubbed or short-circuited by someone making verification work -- and they would have no
 * reason to think they were touching a suppression guarantee.
 *
 * So the property is pinned behaviourally rather than asserted in a message: with BOTH
 * conditions true at once, the reason must be the suppression, not the missing recipient.
 */

const ORG = '7f1d5a1e-0000-4000-8000-000000000001'
const KEY = 'security.suspected_credential_attack|tenant:contoso'
const job = { messageId: `incident/${ORG}|${KEY}` } as SendJob
const incident = (over: Partial<IncidentNow> = {}): IncidentNow => ({
  alertTypeId: 'security.suspected_credential_attack',
  condition: 'ACTIVE', ownership: 'UNACKNOWLEDGED', investigation: 'OPEN',
  firstSeenIso: '2026-09-13T08:00:00.000Z', lastSeenIso: '2026-09-13T12:00:00.000Z',
  tenantsAffected: 1, incidentsAffected: 3, ...over,
})
const state = (over: Partial<CurrentState> = {}): CurrentState => ({
  incident: async () => incident(),
  disposition: async () => 'ACT_TODAY',
  visibility: async () => 'SURFACED' as const,
  recipient: async () => ({
    kind: 'MSP_SECURITY_INBOX', address: 'ops@example.invalid', verifiedAt: new Date(),
  } as never),
  ...over,
})
const reasonOf = async (over: Partial<CurrentState>) => {
  const resolution = await messageSourceOf(state(over)).resolve(job)
  return resolution.send === false ? resolution.because : 'SENT'
}

test('a record-only type withdraws as ALERT_TYPE_DISABLED even with NO recipient', async () => {
  // Both conditions true at once. This is the exact state the grading runs in if the recipient
  // substitution is ever dropped, and the answer must still name the suppression.
  assert.equal(
    await reasonOf({ disposition: async () => 'RECORD_ONLY', recipient: async () => null }),
    'ALERT_TYPE_DISABLED',
    'the recipient read now answers first — C1 would go green without exercising the repair')
})

test('a resolved incident outranks both, with no recipient', async () => {
  // The lifecycle arm is earlier still, and the same reasoning applies to it.
  assert.equal(
    await reasonOf({
      incident: async () => incident({ investigation: 'RESOLVED' }),
      disposition: async () => 'RECORD_ONLY',
      visibility: async () => 'SURFACED' as const,
      recipient: async () => null,
    }),
    'INCIDENT_NO_LONGER_ACTIONABLE')
})

test('CONTROL: a missing recipient is still reported when nothing else refuses', async () => {
  // Without this the ordering could be satisfied by never reporting the recipient at all, which
  // would hide a real delivery gap instead of a suppression.
  assert.equal(
    await reasonOf({ recipient: async () => null }),
    'NO_VERIFIED_RECIPIENT')
})

test('CONTROL: an eligible message with a verified recipient still sends', async () => {
  // So none of the above passes by refusing everything.
  assert.equal(await reasonOf({}), 'SENT')
})

test('CASE B: a re-enabled type does not deliver what was withheld while it was off', async () => {
  // The defect the current disposition cannot see. The finding arrived while the type was
  // record-only, so nothing was surfaced in the product; the operator re-enabled the type, and
  // the job queued by the earlier tick is still in the queue. Reading the disposition NOW says
  // "send", and sending would email an MSP about a finding they cannot find anywhere.
  assert.equal(
    await reasonOf({
      visibility: async () => 'CONTENT_UNAVAILABLE' as const,
      disposition: async () => 'ACT_NOW',
    }),
    'MESSAGE_CONTENT_UNAVAILABLE',
    'a re-enabled type delivered a finding that is not visible in the product')
})

test('CASE C CONTROL: an ordinary eligible job still reaches a send', async () => {
  // Paired deliberately. A suppression assertion is satisfied by a build that cannot send
  // anything at all, so it proves nothing on its own -- which is how a dead send path passed a
  // refusal criterion earlier tonight.
  assert.equal(await reasonOf({ visibility: async () => 'SURFACED' as const }), 'SENT')
})

test('S1: an absent notification is never blamed on a disabled alert type', async () => {
  // "No notification" has two causes -- withheld, or pruned -- and this layer cannot tell
  // them apart: alert_withheld_notices has no incident_key, and an incident key is DERIVED
  // from the finding's subject at pipeline time. Asking whether ANY withheld row exists for
  // the org and type would let another incident's suppression mislabel this one's pruned
  // content.
  //
  // So the reason must not assert one. ALERT_TYPE_DISABLED says somebody turned the type off;
  // here the type is ACT_NOW -- enabled -- and claiming otherwise sends whoever investigates
  // the missing email somewhere else entirely.
  assert.equal(
    await reasonOf({
      visibility: async () => 'CONTENT_UNAVAILABLE' as const,
      disposition: async () => 'ACT_NOW',
    }),
    'MESSAGE_CONTENT_UNAVAILABLE',
    'an absence of unknown cause was recorded as a deliberate suppression')
})

test('S1 CONTROL: a record-only type STILL reports the suppression', async () => {
  // The reason that CAN be established still is, from the disposition read, which does know.
  // Otherwise this is a renamed silence rather than an honest one.
  assert.equal(await reasonOf({ disposition: async () => 'RECORD_ONLY' }), 'ALERT_TYPE_DISABLED')
})