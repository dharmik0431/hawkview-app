import assert from 'node:assert/strict'
import test from 'node:test'
import { admitEvent, eventKey, type AlertEventIdentity } from './alert-event-key.js'

/** The event key: idempotency only, and unable to do grouping's job. */

const event: AlertEventIdentity = {
  source: 'microsoft.directoryAudit',
  organizationId: 'org-1',
  customerTenantId: 'tenant-1',
  eventId: 'audit-1',
}

test('a replayed event is refused, and adds nothing', () => {
  const first = admitEvent(event, new Set())
  assert.equal(first.admit, true)

  const replay = admitEvent(event, new Set([first.key]))
  assert.equal(replay.admit, false, 'the same event must not be processed twice')
  assert.equal(replay.key, first.key, 'and it must be recognised by the same key')

  // POSITIVE CONTROL: a genuinely different event from the same source IS
  // admitted, so the refusal is about the replay rather than a gate that refuses
  // everything after the first.
  assert.equal(admitEvent({ ...event, eventId: 'audit-2' }, new Set([first.key])).admit, true)
})

test('every component participates in the key', () => {
  // If any one did not, two distinct events would share an idempotency key and the
  // second would be silently dropped.
  const base = eventKey(event)
  const variations: Array<Partial<AlertEventIdentity>> = [
    { source: 'microsoft.signIns' },
    { organizationId: 'org-2' },
    { customerTenantId: 'tenant-2' },
    { eventId: 'audit-2' },
  ]
  for (const variation of variations) {
    assert.notEqual(eventKey({ ...event, ...variation }), base, JSON.stringify(variation))
  }
  // And it is stable: the same input twice is the same key.
  assert.equal(eventKey(event), base)
})

test('THE SAME SOURCE EVENT ID IN TWO TENANTS IS TWO EVENTS', () => {
  // Cross-tenant isolation at the idempotency layer. If these collided, an alert
  // in one organisation would be suppressed because an unrelated event had been
  // seen in another — a silent suppression, which is the worst failure this layer
  // can have.
  const ours = eventKey(event)
  const theirs = eventKey({ ...event, organizationId: 'org-2', customerTenantId: 'tenant-2' })
  assert.notEqual(ours, theirs)
  assert.equal(admitEvent({ ...event, organizationId: 'org-2', customerTenantId: 'tenant-2' }, new Set([ours])).admit, true)
})

test('a component containing the delimiter cannot forge another tuple', () => {
  // A plain `a:b:c:d` join is ambiguous as soon as a component may contain the
  // separator, and these two tuples would produce the same string under one.
  // Microsoft identifiers are not obviously colon-free, and the cost of assuming
  // is a suppressed alert rather than a visible error.
  const left = eventKey({ ...event, organizationId: 'x:y', customerTenantId: 'z' })
  const right = eventKey({ ...event, organizationId: 'x', customerTenantId: 'y:z' })
  assert.notEqual(left, right, 'a separator in a component must not be able to shift a boundary')

  // The same shape with the length prefix itself: a component that looks like a
  // prefix must not be able to fake one.
  assert.notEqual(
    eventKey({ ...event, organizationId: '2:ab', customerTenantId: 'c' }),
    eventKey({ ...event, organizationId: '2', customerTenantId: 'abc' }))
})

test('the event key CANNOT group, and that is the point', () => {
  // Two events that belong to the same incident — same tenant, same subject, same
  // class, minutes apart — have different event keys, because the event id differs.
  // This key exists to stop reprocessing and is structurally unable to gather
  // related events. Grouping is the incident key's job, and the current system's
  // defect is that one field was asked to do both.
  const first = eventKey({ ...event, eventId: 'audit-1' })
  const second = eventKey({ ...event, eventId: 'audit-2' })
  assert.notEqual(first, second)

  // Neither admits the other, so nothing here collapses 301 events into one
  // incident — nor should it.
  assert.equal(admitEvent({ ...event, eventId: 'audit-2' }, new Set([first])).admit, true)
})
