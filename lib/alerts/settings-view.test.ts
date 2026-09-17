import assert from 'node:assert/strict'
import test from 'node:test'
import type { AlertDispositionRow } from './dispositions.ts'
import { readDispositions, type DispositionsRead } from './read-dispositions.ts'
import { settingsView } from './settings-view.ts'

const row: AlertDispositionRow = {
  alertTypeId: 'security.suspected_credential_attack',
  title: 'Suspected credential attack',
  category: 'Security',
  catalogueSeverity: 'ACT_NOW',
  disposition: 'ACT_NOW',
  mapped: true,
  capability: {
    intakeWiring: 'MAPPED',
    producerSupport: 'PROVEN',
    observedInput: 'NO_OPEN_FINDING',
    editable: true,
    reason: 'READY',
  },
}

const response = (dispositions: unknown[]) => ({
  organizationId: '11111111-1111-4111-8111-111111111111',
  dispositions,
  unrecognisedKeys: [],
  canManagePolicy: true,
  capabilities: {
    version: 1,
    readState: 'AVAILABLE',
    policyWriterRole: 'MSP_OWNER',
    supportedDigestModes: ['off'],
    channels: {
      inApp: { supported: true, availability: 'AVAILABLE' },
      email: { supported: true, availability: 'DISABLED', reason: 'SENDER_OFF' },
    },
  },
})

test('the empty card and list are mutually exclusive', () => {
  const states = [
    settingsView({ phase: 'LOADING' }, []),
    settingsView({ phase: 'READ', read: readDispositions(response([row])) }, [row]),
    settingsView({ phase: 'READ', read: readDispositions(response([])) }, []),
    settingsView(
      { phase: 'READ', read: { outcome: 'FAILED', because: 'offline' } },
      [row]
    ),
  ]
  for (const view of states) {
    assert.equal(Boolean(view.empty) && view.rows.length > 0, false)
    assert.equal(view.loading && (Boolean(view.empty) || view.rows.length > 0), false)
    assert.equal(
      view.loading || Boolean(view.empty) || view.rows.length > 0,
      true
    )
  }
})

test('failed and malformed reads do not preserve writable rows', () => {
  const failed: DispositionsRead = { outcome: 'FAILED', because: 'offline' }
  const failedView = settingsView({ phase: 'READ', read: failed }, [row])
  assert.equal(failedView.rows.length, 0)
  assert.match(failedView.because ?? '', /offline/)

  const malformed = settingsView(
    { phase: 'READ', read: readDispositions({ dispositions: [row] }) },
    [row]
  )
  assert.equal(malformed.rows.length, 0)
  assert.ok(malformed.empty)
})

test('partial rows and unrecognised keys remain visible diagnostics', () => {
  const read = readDispositions({
    ...response([row, { alertTypeId: 'bad' }]),
    unrecognisedKeys: ['security.retired'],
  })
  const view = settingsView({ phase: 'READ', read }, [row])
  assert.equal(view.rows.length, 1)
  assert.equal(view.discarded, 1)
  assert.deepEqual(view.unrecognisedKeys, ['security.retired'])
})
