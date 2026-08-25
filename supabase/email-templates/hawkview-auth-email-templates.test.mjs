import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS,
  HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH,
} from './hawkview-auth-email-templates.mjs'

const templateNames = [
  'confirmation',
  'invite',
  'recovery',
  'magic_link',
  'reauthentication',
  'email_change',
  'password_changed_notification',
  'email_changed_notification',
  'phone_changed_notification',
  'mfa_factor_enrolled_notification',
  'mfa_factor_unenrolled_notification',
  'identity_linked_notification',
  'identity_unlinked_notification',
]

test('the manifest owns every supported authentication and security email subject and body', () => {
  assert.equal(HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS.length, templateNames.length * 2)
  for (const name of templateNames) {
    assert.equal(typeof HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_subjects_${name}`], 'string')
    assert.equal(typeof HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_templates_${name}_content`], 'string')
  }
})

test('all emails use the same accessible HawkView shell without tracking or remote media', () => {
  for (const name of templateNames) {
    const content = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_templates_${name}_content`]
    assert.match(content, /<!doctype html>/i)
    assert.match(content, />HawkView</)
    assert.match(content, /role="presentation"/)
    assert.doesNotMatch(content, /<img\b/i)
    assert.doesNotMatch(content, /https?:\/\//i)
    assert.ok(content.length < 20_000)
  }
})

test('action templates preserve Supabase confirmation links and reauthentication uses only the OTP', () => {
  for (const name of ['confirmation', 'invite', 'recovery', 'magic_link', 'email_change']) {
    const content = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_templates_${name}_content`]
    assert.equal(content.match(/{{ \.ConfirmationURL }}/g)?.length, 1)
  }

  const reauthentication = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH.mailer_templates_reauthentication_content
  assert.equal(reauthentication.match(/{{ \.Token }}/g)?.length, 1)
  assert.doesNotMatch(reauthentication, /ConfirmationURL/)
})

test('templates never interpolate user-controlled profile or address fields', () => {
  const combined = HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS
    .map((key) => HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[key])
    .join('\n')
  assert.doesNotMatch(combined, /{{ \.Data\b/)
  assert.doesNotMatch(combined, /{{ \.(?:Email|NewEmail|OldEmail|Phone|OldPhone|Provider|FactorType) }}/)
})

test('the manifest does not change security-notification enablement', () => {
  assert.equal(
    HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS.some((key) => key.startsWith('mailer_notifications_')),
    false,
  )
})
