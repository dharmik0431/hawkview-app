import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  HAWKVIEW_AUTH_CONFIRMATION_URL,
  resolveHawkViewAuthRedirectUrl,
} from './auth-email-config.js'

test('authentication redirects resolve only to the canonical HawkView confirmation route', () => {
  assert.equal(resolveHawkViewAuthRedirectUrl(undefined), HAWKVIEW_AUTH_CONFIRMATION_URL)
  assert.equal(resolveHawkViewAuthRedirectUrl(''), HAWKVIEW_AUTH_CONFIRMATION_URL)
  assert.equal(
    resolveHawkViewAuthRedirectUrl(`  ${HAWKVIEW_AUTH_CONFIRMATION_URL}  `),
    HAWKVIEW_AUTH_CONFIRMATION_URL,
  )
})

test('authentication redirects reject sentinel, foreign, relative, and ambiguous values', () => {
  const rejected = [
    'None',
    'null',
    'undefined',
    '/auth/confirm',
    'https://attacker.example/auth/confirm',
    'https://console.hawkviewapp.com.evil.example/auth/confirm',
    'https://console.hawkviewapp.com/auth/confirm/',
    'https://console.hawkviewapp.com/auth/confirm?next=https://attacker.example',
    'https://console.hawkviewapp.com/auth/confirm#token',
    'https://user:password@console.hawkviewapp.com/auth/confirm',
    'https://console.hawkviewapp.com/auth/confirm\nhttps://attacker.example',
  ]

  rejected.forEach((value) => {
    assert.throws(
      () => resolveHawkViewAuthRedirectUrl(value),
      /configuration is invalid/,
    )
  })
})

test('every backend invitation and recovery request uses the fail-closed redirect resolver', () => {
  const workspaceService = readFileSync(
    new URL('./workspace.service.ts', import.meta.url),
    'utf8',
  )
  assert.equal(workspaceService.match(/redirect_to: this\.authEmailRedirectUrl\(\)/g)?.length, 3)
  assert.doesNotMatch(
    workspaceService,
    /redirect_to: process\.env\.HAWKVIEW_AUTH_REDIRECT_URL/,
  )
})
