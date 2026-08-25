import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CANONICAL_HAWKVIEW_API_ORIGIN,
  CANONICAL_HAWKVIEW_APP_ORIGIN,
  CANONICAL_SUPABASE_ORIGIN,
  buildHawkViewAppUrl,
  buildHawkViewApiUrl,
  isBrowserSafeSupabasePublishableKey,
  resolveHawkViewApiOrigin,
  resolveHawkViewAppOrigin,
  resolveSupabaseOrigin,
} from './public-runtime-config.ts'

test('pins production HawkView traffic to the branded public domains', () => {
  assert.equal(CANONICAL_HAWKVIEW_API_ORIGIN, 'https://api.hawkviewapp.com')
  assert.equal(CANONICAL_HAWKVIEW_APP_ORIGIN, 'https://console.hawkviewapp.com')
})

test('production always resolves Supabase authentication to the canonical project', () => {
  for (const value of [
    undefined,
    '',
    'https://lvigyvrlkkmhseelofda.supabase.co',
    'https://lvjqyvrllkmhseelofda.supabase.co',
    CANONICAL_HAWKVIEW_API_ORIGIN,
    'https://attacker.example',
    `${CANONICAL_SUPABASE_ORIGIN}/auth/v1`,
    `${CANONICAL_SUPABASE_ORIGIN}?redirect=attacker.example`,
    'https://user:password@lvjqyvrtlkmhseelofda.supabase.co',
  ]) {
    assert.equal(
      resolveSupabaseOrigin(value, 'production'),
      CANONICAL_SUPABASE_ORIGIN
    )
  }
})

test('production always resolves HawkView data requests to the canonical API', () => {
  for (const value of [
    undefined,
    '',
    CANONICAL_SUPABASE_ORIGIN,
    'https://api.example.hawkview.net',
    'https://attacker.example',
    `${CANONICAL_HAWKVIEW_API_ORIGIN}/auth/bootstrap`,
    `${CANONICAL_HAWKVIEW_API_ORIGIN}#fragment`,
    'https://user:password@api.hawkviewapp.com',
  ]) {
    assert.equal(
      resolveHawkViewApiOrigin(value, 'production'),
      CANONICAL_HAWKVIEW_API_ORIGIN
    )
  }
})

test('development accepts only loopback overrides', () => {
  assert.equal(
    resolveHawkViewApiOrigin('http://localhost:4000/', 'development'),
    'http://localhost:4000'
  )
  assert.equal(
    resolveSupabaseOrigin('http://127.0.0.1:54321', 'development'),
    'http://127.0.0.1:54321'
  )
  assert.equal(
    resolveHawkViewApiOrigin('https://preview.example', 'development'),
    CANONICAL_HAWKVIEW_API_ORIGIN
  )
})

test('confirmation and recovery links cannot drift to an editor preview origin', () => {
  for (const value of [
    undefined,
    '',
    CANONICAL_SUPABASE_ORIGIN,
    CANONICAL_HAWKVIEW_API_ORIGIN,
    'https://ais-dev-example.run.app',
    `${CANONICAL_HAWKVIEW_APP_ORIGIN}/login`,
  ]) {
    assert.equal(
      resolveHawkViewAppOrigin(value, 'production'),
      CANONICAL_HAWKVIEW_APP_ORIGIN
    )
  }

  assert.equal(
    buildHawkViewAppUrl(
      '/login',
      'https://ais-dev-example.run.app',
      'production'
    ).href,
    `${CANONICAL_HAWKVIEW_APP_ORIGIN}/login`
  )
  assert.equal(
    buildHawkViewAppUrl(
      '/reset-password',
      CANONICAL_HAWKVIEW_APP_ORIGIN,
      'production'
    ).href,
    `${CANONICAL_HAWKVIEW_APP_ORIGIN}/reset-password`
  )
  assert.throws(() =>
    buildHawkViewAppUrl('//attacker.example', undefined, 'production')
  )
})

test('bootstrap and API paths cannot be routed to Supabase by environment drift', () => {
  assert.equal(
    buildHawkViewApiUrl(
      '/auth/bootstrap',
      CANONICAL_SUPABASE_ORIGIN,
      'production'
    ).href,
    `${CANONICAL_HAWKVIEW_API_ORIGIN}/auth/bootstrap`
  )
  assert.equal(
    buildHawkViewApiUrl(
      '/api/tenants',
      'https://attacker.example',
      'production'
    ).href,
    `${CANONICAL_HAWKVIEW_API_ORIGIN}/api/tenants`
  )
  assert.throws(() =>
    buildHawkViewApiUrl('//attacker.example', undefined, 'production')
  )
  assert.throws(() =>
    buildHawkViewApiUrl('https://attacker.example', undefined, 'production')
  )
})

test('only bounded Supabase publishable keys are browser eligible', () => {
  assert.equal(
    isBrowserSafeSupabasePublishableKey('sb_publishable_abcdefghijklmnop'),
    true
  )
  assert.equal(isBrowserSafeSupabasePublishableKey(undefined), false)
  assert.equal(isBrowserSafeSupabasePublishableKey('sb_secret_example'), false)
  assert.equal(
    isBrowserSafeSupabasePublishableKey('sb_publishable_bad key'),
    false
  )
})

test('browser clients use the centralized destinations without legacy fallbacks', () => {
  const apiClient = readFileSync(
    new URL('../api/client.ts', import.meta.url),
    'utf8'
  )
  const supabaseClient = readFileSync(
    new URL('../auth/supabase.ts', import.meta.url),
    'utf8'
  )

  assert.match(apiClient, /buildHawkViewApiUrl\(endpoint\)/)
  assert.doesNotMatch(apiClient, /NEXT_PUBLIC_API_BASE_URL/)
  assert.doesNotMatch(apiClient, /NEXT_PUBLIC_SUPABASE_URL/)
  assert.match(supabaseClient, /publicRuntimeConfig\.supabaseOrigin/)
  assert.doesNotMatch(supabaseClient, /createClient\(\s*process\.env/)
})

test('auth forms use stable links and never navigate without HawkView bootstrap', () => {
  const authForm = readFileSync(
    new URL('../../components/auth/auth-form.tsx', import.meta.url),
    'utf8'
  )

  assert.match(authForm, /buildHawkViewAppUrl\('\/login'\)/)
  assert.match(authForm, /buildHawkViewAppUrl\('\/reset-password'\)/)
  assert.doesNotMatch(authForm, /window\.location\.origin/)
  assert.match(
    authForm,
    /const nextSession = await refreshSession\(\)[\s\S]{0,100}if \(!nextSession\)/
  )
  assert.match(
    authForm,
    /If this address is eligible for a new or unconfirmed account/
  )
  assert.doesNotMatch(authForm, /Your account was created/)
})
