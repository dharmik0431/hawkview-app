import assert from 'node:assert/strict'
import test from 'node:test'
import { readNotificationCapabilities, emailAvailabilityCopy } from './preferences-contract.ts'
import { deliveryDescription } from '../alerts/dispositions.ts'

const legacy = {
  version: 1, readState: 'AVAILABLE', policyWriterRole: 'MSP_OWNER', supportedDigestModes: ['off'],
  channels: { inApp: { supported: true, availability: 'AVAILABLE' },
    email: { supported: true, availability: 'UNAVAILABLE', reason: 'CONFIGURATION_UNAVAILABLE' } },
}
const regular = { availability: 'AVAILABLE', scope: 'DESIGNATED_OWNER', requiresOptIn: true }

test('legacy capability remains parseable and an additive regular representation does not expand v1 enums', () => {
  assert.ok(readNotificationCapabilities(legacy))
  const value = { ...legacy, channels: { ...legacy.channels, email: { ...legacy.channels.email, regular } } }
  const parsed = readNotificationCapabilities(value)
  assert.ok(parsed)
  assert.equal(parsed.channels.email.availability, 'UNAVAILABLE')
  assert.deepEqual(parsed.channels.email.regular, regular)
  assert.match(emailAvailabilityCopy(parsed).detail, /explicit email and security opt-ins/)
  assert.match(deliveryDescription('ACT_NOW', parsed).limitation!, /does not enable anyone/)
  const oldRepresentation = { ...value, channels: { ...value.channels, email: { ...legacy.channels.email } } }
  assert.ok(readNotificationCapabilities(oldRepresentation))
})

test('unknown regular modes, global fanout, implicit consent and contradictory capability pairs fail closed', () => {
  for (const invalid of [
    { ...regular, availability: 'ENABLED' }, { ...regular, scope: 'EVERYONE' },
    { ...regular, requiresOptIn: false }, null,
  ]) {
    assert.equal(readNotificationCapabilities({ ...legacy,
      channels: { ...legacy.channels, email: { ...legacy.channels.email, regular: invalid } } }), null)
  }
  assert.equal(readNotificationCapabilities({ ...legacy, channels: { ...legacy.channels,
    email: { supported: true, availability: 'CONTROLLED', reason: 'CONTROLLED_TRIAL_ONLY', regular } } }), null)
})
