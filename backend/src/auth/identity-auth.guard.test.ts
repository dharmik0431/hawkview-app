import assert from 'node:assert/strict'
import test from 'node:test'
import { hasRequiredAssurance } from './identity-auth.guard.js'

const subject = '11111111-2222-4333-8444-555555555555'

test('AAL2 is required for ordinary protected API access', () => {
  assert.equal(hasRequiredAssurance('aal2', subject, {}), true)
  assert.equal(hasRequiredAssurance('aal1', subject, {}), false)
  assert.equal(hasRequiredAssurance(undefined, subject, {}), false)
})

test('only the exact configured synthetic canary identities bypass AAL2', () => {
  const environment = {
    HAWKVIEW_CANARY_ENABLED: 'true',
    HAWKVIEW_CANARY_A_AUTH_USER_ID: subject,
  }
  assert.equal(hasRequiredAssurance('aal1', subject, environment), true)
  assert.equal(
    hasRequiredAssurance(
      'aal1',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      environment
    ),
    false
  )
})
