import assert from 'node:assert/strict'
import test from 'node:test'
import { exchangeDatasetStatus } from './exchange-dataset-status.ts'

test('derives Exchange dataset truth from resource status, not row count', () => {
  assert.equal(exchangeDatasetStatus({ status: 'succeeded' }, 0).label, 'Synchronized')
  assert.equal(exchangeDatasetStatus({ status: 'failed' }, 12).label, 'Failed · last-known data')
  assert.equal(exchangeDatasetStatus({ status: 'partial' }, 3).label, 'Partial · last-known data')
  assert.equal(exchangeDatasetStatus({ status: 'stale' }, 4).label, 'Stale · last-known data')
  assert.equal(exchangeDatasetStatus({ status: 'running' }, 2).label, 'Syncing · last-known data')
  assert.equal(exchangeDatasetStatus(undefined, 0).label, 'Awaiting sync')
  assert.equal(exchangeDatasetStatus(undefined, 8).label, 'Unverified · cached rows')
})

test('fails closed for inherited status and preserves only a valid success timestamp', () => {
  assert.equal(exchangeDatasetStatus(Object.create({ status: 'succeeded' }), 1).state, 'UNKNOWN')
  assert.equal(
    exchangeDatasetStatus({ status: 'failed', lastSuccessfulAt: '2026-08-18T12:00:00Z' }, 1).lastSuccessfulAt,
    '2026-08-18T12:00:00Z',
  )
  assert.equal(exchangeDatasetStatus({ status: 'failed', lastSuccessfulAt: 'not-a-date' }, 1).lastSuccessfulAt, null)
})
