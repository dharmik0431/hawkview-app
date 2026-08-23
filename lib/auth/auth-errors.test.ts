import assert from 'node:assert/strict'
import test from 'node:test'

import { readableAuthError } from './auth-errors.ts'

test('network and DNS failures receive useful bounded guidance', () => {
  assert.equal(
    readableAuthError(new TypeError('Failed to fetch')),
    'Unable to reach the authentication service. Check your connection and retry.'
  )
  assert.equal(
    readableAuthError(new Error('net::ERR_NAME_NOT_RESOLVED')),
    'Unable to reach the authentication service. Check your connection and retry.'
  )
})

test('known credential, confirmation, rate, and bootstrap states stay distinct', () => {
  assert.equal(
    readableAuthError(new Error('Invalid login credentials')),
    'Invalid email or password.'
  )
  assert.equal(
    readableAuthError(new Error('Email not confirmed')),
    'Verify your email before signing in.'
  )
  assert.equal(
    readableAuthError(new Error('Request rate limit reached')),
    'Too many authentication attempts. Please wait and try again.'
  )
  assert.equal(
    readableAuthError(new Error('HAWKVIEW_SESSION_UNAVAILABLE')),
    'Sign-in succeeded, but your HawkView workspace could not be loaded. Please retry.'
  )
})

test('unknown and hostile provider text is never reflected to the browser', () => {
  const secret = 'password=NeverRenderThis token=eyJhbGciOiJIUzI1NiJ9.payload'
  const result = readableAuthError(new Error(secret))
  assert.equal(result, 'Authentication could not be completed. Please retry.')
  assert.doesNotMatch(result, /password|token|eyJ/i)
})
