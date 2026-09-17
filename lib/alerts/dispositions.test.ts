import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canEditDisposition,
  capabilityCopy,
  deliveryDescription,
  rowDeliveryDescription,
  emptinessCopy,
  SAVED_APPLIES_FROM,
  type AlertDispositionRow,
} from './dispositions.ts'
import type { NotificationCapabilities } from '../notifications/preferences-contract.ts'

const capabilities = (
  availability: 'DISABLED' | 'CONTROLLED' | 'UNAVAILABLE' = 'DISABLED'
): NotificationCapabilities => ({
  version: 1,
  readState: 'AVAILABLE',
  policyWriterRole: 'MSP_OWNER',
  supportedDigestModes: ['off'],
  channels: {
    inApp: { supported: true, availability: 'AVAILABLE' },
    email: {
      supported: true,
      availability,
      reason:
        availability === 'DISABLED'
          ? 'SENDER_OFF'
          : availability === 'CONTROLLED'
            ? 'CONTROLLED_TRIAL_ONLY'
            : 'CONFIGURATION_UNAVAILABLE',
    },
  },
})

const row = (
  capability: AlertDispositionRow['capability']
): AlertDispositionRow => ({
  alertTypeId: 'security.suspected_credential_attack',
  title: 'Suspected credential attack',
  category: 'Security',
  catalogueSeverity: 'ACT_NOW',
  disposition: 'ACT_NOW',
  mapped: true,
  capability,
})

test('workspace policy never promises that a personal email opt-in sends mail', () => {
  assert.match(deliveryDescription('ACT_NOW', capabilities('DISABLED')).today, /In-app/)
  assert.match(
    deliveryDescription('ACT_NOW', capabilities('DISABLED')).limitation ?? '',
    /sending is currently off.*does not activate/i
  )
  assert.match(
    deliveryDescription('ACT_TODAY', capabilities('CONTROLLED')).limitation ?? '',
    /controlled separately/i
  )
  assert.match(
    deliveryDescription('ACT_TODAY', capabilities('UNAVAILABLE')).limitation ?? '',
    /unavailable/i
  )
})

test('record only promises no notification channel and names where evidence remains', () => {
  const shown = deliveryDescription('RECORD_ONLY', capabilities())
  assert.match(shown.today, /risky user/i)
  assert.match(shown.today, /No notification/i)
  assert.equal(shown.limitation, null)
})

test('zero observed findings does not disable a proven wired producer', () => {
  const ready = row({
    intakeWiring: 'MAPPED',
    producerSupport: 'PROVEN',
    observedInput: 'NO_OPEN_FINDING',
    editable: true,
    reason: 'READY',
  })
  assert.equal(canEditDisposition(ready, true), true)
  assert.match(capabilityCopy(ready).detail, /No open finding.*still configurable/i)
})

test('wiring without a proven producer remains read only', () => {
  const unproven = row({
    intakeWiring: 'MAPPED',
    producerSupport: 'NOT_ESTABLISHED',
    observedInput: 'OPEN_FINDING_PRESENT',
    editable: false,
    reason: 'PRODUCER_NOT_ESTABLISHED',
  })
  assert.equal(canEditDisposition(unproven, true), false)
  assert.match(capabilityCopy(unproven).detail, /producer.*not been established/i)
  const delivery = rowDeliveryDescription(unproven, capabilities())
  assert.match(delivery.today, /saved urgency is inactive/i)
  assert.doesNotMatch(delivery.today, /delivery is available/i)
})

test('malformed unsupported editable metadata cannot enable a control', () => {
  const contradictory = row({
    intakeWiring: 'UNMAPPED',
    producerSupport: 'NOT_ESTABLISHED',
    observedInput: 'NO_OPEN_FINDING',
    editable: true,
    reason: 'INTAKE_UNMAPPED',
  })
  assert.equal(canEditDisposition(contradictory, true), false)
})

test('server owner authorization is required even for a ready row', () => {
  const ready = row({
    intakeWiring: 'MAPPED',
    producerSupport: 'PROVEN',
    observedInput: 'OPEN_FINDING_PRESENT',
    editable: true,
    reason: 'READY',
  })
  assert.equal(canEditDisposition(ready, false), false)
})

test('empty and failed reads use different copy', () => {
  const empty = emptinessCopy({ kind: 'NOTHING_MATCHED' })!
  const failed = emptinessCopy({ kind: 'NEVER_OBSERVED' })!
  assert.notEqual(empty.detail, failed.detail)
  assert.match(failed.detail, /No request has succeeded/)
  assert.equal(emptinessCopy({ kind: 'HAS_ITEMS' }), null)
})

test('saved copy states when a policy change takes effect', () => {
  assert.match(SAVED_APPLIES_FROM, /next evaluation run/)
  assert.match(SAVED_APPLIES_FROM, /already raised keep the urgency/)
})
