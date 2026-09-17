import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasPreferenceChanges,
  notificationPreferencesPatch,
  readNotificationPreferences,
} from './preferences-contract.ts'

const response = (over: Record<string, unknown> = {}) => ({
  id: 'pref-1',
  organizationId: 'org-1',
  securityEnabled: true,
  connectionEnabled: true,
  synchronizationEnabled: true,
  accountEnabled: true,
  inAppEnabled: true,
  emailEnabled: false,
  minimumSeverity: 'medium',
  digestMode: 'off',
  canManagePolicy: false,
  capabilities: {
    version: 1,
    readState: 'AVAILABLE',
    policyWriterRole: 'MSP_OWNER',
    supportedDigestModes: ['off'],
    channels: {
      inApp: { supported: true, availability: 'AVAILABLE' },
      email: {
        supported: true,
        availability: 'DISABLED',
        reason: 'SENDER_OFF',
      },
    },
  },
  ...over,
})

test('reads the additive personal-preference capability contract', () => {
  const read = readNotificationPreferences(response())
  assert.ok(read)
  assert.equal(read.organizationId, 'org-1')
  assert.equal(read.capabilities.channels.email.availability, 'DISABLED')
})

test('missing or malformed capability data fails closed', () => {
  assert.equal(readNotificationPreferences(response({ capabilities: undefined })), null)
  assert.equal(
    readNotificationPreferences(
      response({
        capabilities: {
          ...(response().capabilities as object),
          supportedDigestModes: ['off', 'daily'],
        },
      })
    ),
    null
  )
  assert.equal(
    readNotificationPreferences(response({ canManagePolicy: 'true' })),
    null
  )
  assert.equal(
    readNotificationPreferences(
      response({
        capabilities: {
          version: 1,
          readState: 'AVAILABLE',
          policyWriterRole: 'MSP_OWNER',
          supportedDigestModes: ['off'],
          channels: {
            inApp: { supported: true, availability: 'AVAILABLE' },
            email: {
              supported: true,
              availability: 'DISABLED',
              reason: 'NOT_DESIGNATED_RECIPIENT',
            },
          },
        },
      })
    ),
    null
  )
})

test('unknown severity fails closed instead of becoming the mildest setting', () => {
  assert.equal(
    readNotificationPreferences(response({ minimumSeverity: 'informational' })),
    null
  )
})

test('an unchanged legacy digest is preserved and never posted back as supported', () => {
  const original = readNotificationPreferences(response({ digestMode: 'daily' }))!
  assert.deepEqual(notificationPreferencesPatch(original, { ...original }), {
    organizationId: 'org-1',
  })
  assert.equal(hasPreferenceChanges(original, { ...original }), false)
})

test('the only new digest choice the client can send is off', () => {
  const original = readNotificationPreferences(response({ digestMode: 'weekly' }))!
  const draft = { ...original, digestMode: 'off' as const }
  assert.deepEqual(notificationPreferencesPatch(original, draft), {
    organizationId: 'org-1',
    digestMode: 'off',
  })
})

test('all five supported personal severity thresholds are typed writable values', () => {
  for (const minimumSeverity of ['info', 'low', 'medium', 'high', 'critical'] as const) {
    const original = readNotificationPreferences(response())!
    const draft = { ...original, minimumSeverity }
    const patch = notificationPreferencesPatch(original, draft)
    assert.deepEqual(
      patch,
      minimumSeverity === original.minimumSeverity
        ? { organizationId: 'org-1' }
        : { organizationId: 'org-1', minimumSeverity }
    )
  }
})

test('personal writes contain only known changed fields and explicit organization scope', () => {
  const original = readNotificationPreferences(response())!
  const draft = { ...original, emailEnabled: true, inAppEnabled: false }
  assert.deepEqual(notificationPreferencesPatch(original, draft), {
    organizationId: 'org-1',
    emailEnabled: true,
    inAppEnabled: false,
  })
  assert.equal('minimumSeverity' in notificationPreferencesPatch(original, draft), false)
  assert.equal('capabilities' in notificationPreferencesPatch(original, draft), false)
  assert.equal('canManagePolicy' in notificationPreferencesPatch(original, draft), false)
})
