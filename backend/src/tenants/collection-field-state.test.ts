import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bytesToGigabytes,
  deriveCollectionFieldState,
} from './collection-field-state.js'

test('derives every supported collection state without treating zero data as unavailable', () => {
  assert.equal(deriveCollectionFieldState({ syncStatus: 'SUCCEEDED' }).state, 'AVAILABLE')
  assert.equal(deriveCollectionFieldState({}).state, 'PENDING')
  assert.equal(deriveCollectionFieldState({ syncStatus: 'RUNNING' }).state, 'PENDING')
  assert.equal(deriveCollectionFieldState({ syncStatus: 'FAILED', lastErrorMessage: 'server error' }).state, 'FAILED')
  assert.equal(deriveCollectionFieldState({ syncStatus: 'FAILED', hasPriorSnapshot: true }).state, 'STALE')
  assert.equal(deriveCollectionFieldState({ unsupported: true }).state, 'UNSUPPORTED')
  assert.equal(deriveCollectionFieldState({ syncStatus: 'FAILED', lastErrorMessage: 'premium license required' }).state, 'NOT_LICENSED')
  assert.equal(deriveCollectionFieldState({ syncStatus: 'FAILED', lastErrorMessage: '403 forbidden' }).state, 'PERMISSION_REQUIRED')
  const exchangeRbac = deriveCollectionFieldState({
    syncStatus: 'FAILED',
    lastErrorMessage: 'Confirm Exchange.ManageAsAppV2 and the HawkView Get-Mailbox Exchange RBAC role.',
  })
  assert.equal(exchangeRbac.state, 'PERMISSION_REQUIRED')
  assert.equal(exchangeRbac.reasonCode, 'EXCHANGE_RBAC_ROLE_REQUIRED')
  const notConfigured = deriveCollectionFieldState({ notConfigured: true })
  assert.equal(notConfigured.state, 'NOT_CONFIGURED')
  assert.equal(notConfigured.message, 'No Conditional Access policies configured.')
})

test('converts reported byte values to GiB without conflating them with tenant quota', () => {
  assert.equal(bytesToGigabytes(0), 0)
  assert.equal(bytesToGigabytes(1024 ** 3), 1)
  assert.equal(bytesToGigabytes(1536 * 1024 ** 2), 1.5)
  assert.equal(bytesToGigabytes(null), null)
  assert.equal(bytesToGigabytes(Number.NaN), null)
})
