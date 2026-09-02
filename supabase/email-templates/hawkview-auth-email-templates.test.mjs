import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  HAWKVIEW_AUTH_EMAIL_CONFIRM_PATH,
  HAWKVIEW_AUTH_EMAIL_DELIVERY_POLICY,
  HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS,
  HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH,
  HAWKVIEW_AUTH_EMAIL_MAX_HTML_BYTES,
  HAWKVIEW_AUTH_EMAIL_MAX_IMAGE_BYTES,
  HAWKVIEW_AUTH_EMAIL_ORIGIN,
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

const actionTypes = {
  confirmation: 'signup',
  invite: 'invite',
  recovery: 'recovery',
  magic_link: 'magiclink',
  email_change: 'email_change',
}

function oneHref(content) {
  const matches = Array.from(content.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi))
  assert.equal(matches.length, 1)
  return matches[0][1].replaceAll('&amp;', '&')
}

test('the manifest owns every supported authentication and security email subject and body', () => {
  assert.equal(HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS.length, templateNames.length * 2)
  for (const name of templateNames) {
    assert.equal(typeof HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_subjects_${name}`], 'string')
    assert.equal(typeof HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_templates_${name}_content`], 'string')
  }
})

test('all emails use one bounded embedded HawkView mark and compact HTML', () => {
  for (const name of templateNames) {
    const content = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_templates_${name}_content`]
    assert.match(content, /<!doctype html>/i)
    assert.match(content, />HawkView</)
    assert.match(content, /role="presentation"/)
    assert.match(content, /<img src="data:image\/png;base64,/i)
    assert.equal(content.match(/<img\b/gi)?.length, 1)
    assert.ok(Buffer.byteLength(content) <= HAWKVIEW_AUTH_EMAIL_MAX_HTML_BYTES)

    const image = content.match(/data:image\/png;base64,([^"]+)/i)
    assert.ok(image)
    assert.ok(Buffer.from(image[1], 'base64').length <= HAWKVIEW_AUTH_EMAIL_MAX_IMAGE_BYTES)
  }
})

test('every action uses one HawkView-owned token-hash URL with the correct type', () => {
  const safeTokenHash = 'a'.repeat(64)
  for (const [name, type] of Object.entries(actionTypes)) {
    const content = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[`mailer_templates_${name}_content`]
    assert.equal(content.match(/{{ \.TokenHash }}/g)?.length, 1)
    assert.doesNotMatch(content, /ConfirmationURL|supabase\.co/i)
    const rendered = content.replace('{{ .TokenHash }}', safeTokenHash)
    const href = oneHref(rendered)
    assert.doesNotMatch(href, /{{|}}|(?:None|undefined|null|<no value>)/i)
    const url = new URL(href)
    assert.equal(url.origin, HAWKVIEW_AUTH_EMAIL_ORIGIN)
    assert.equal(url.pathname, HAWKVIEW_AUTH_EMAIL_CONFIRM_PATH)
    assert.equal(url.search, '')
    const fragment = new URLSearchParams(url.hash.slice(1))
    assert.equal(fragment.get('token_hash'), safeTokenHash)
    assert.equal(fragment.get('type'), type)
    assert.deepEqual(Array.from(fragment.keys()).sort(), ['token_hash', 'type'])
  }

  const reauthentication = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH.mailer_templates_reauthentication_content
  assert.equal(reauthentication.match(/{{ \.Token }}/g)?.length, 1)
  assert.doesNotMatch(reauthentication, /ConfirmationURL|TokenHash|<a\b/i)
})

test('the delivery policy requires the dedicated authentication identity and disables tracking', () => {
  assert.deepEqual(HAWKVIEW_AUTH_EMAIL_DELIVERY_POLICY, {
    senderEmail: 'no-reply@auth.hawkviewapp.com',
    senderName: 'HawkView',
    sendingDomain: 'auth.hawkviewapp.com',
    clickTracking: false,
    openTracking: false,
  })
})

test('the deployment utility fails closed on oversized or provider-hosted template actions', () => {
  const utility = readFileSync(
    new URL('../../scripts/manage-supabase-auth-email-templates.mjs', import.meta.url),
    'utf8',
  )
  assert.match(utility, /HAWKVIEW_AUTH_EMAIL_MAX_HTML_BYTES/)
  assert.match(utility, /ConfirmationURL\|supabase\\\.co/)
  assert.match(utility, /auth sender identity requires a controlled provider rollout/)
})

test('templates never interpolate user-controlled profile or address fields', () => {
  const combined = HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS
    .map((key) => HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH[key])
    .join('\n')
  assert.doesNotMatch(combined, /{{ \.Data\b/)
  assert.doesNotMatch(combined, /{{ \.(?:Email|NewEmail|OldEmail|Phone|OldPhone|Provider|FactorType) }}/)
})

test('the invitation template is invitation-only for first delivery and resend', () => {
  const subject = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH.mailer_subjects_invite
  const content = HAWKVIEW_AUTH_EMAIL_TEMPLATE_PATCH.mailer_templates_invite_content
  assert.equal(subject, 'HawkView invitation sent or resent')
  assert.match(content, /sent or resent this invitation/i)
  assert.match(content, /type=invite/)
  assert.doesNotMatch(`${subject}\n${content}`, /password|recovery|reset/i)
})

test('the manifest does not change security-notification enablement', () => {
  assert.equal(
    HAWKVIEW_AUTH_EMAIL_TEMPLATE_KEYS.some((key) => key.startsWith('mailer_notifications_')),
    false,
  )
})
