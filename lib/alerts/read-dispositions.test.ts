import assert from 'node:assert/strict'
import test from 'node:test'
import { emptinessOf, readDispositionRow, readDispositions } from './read-dispositions.ts'

const capabilities = {
  version: 1,
  readState: 'AVAILABLE',
  policyWriterRole: 'MSP_OWNER',
  supportedDigestModes: ['off'],
  channels: {
    inApp: { supported: true, availability: 'AVAILABLE' },
    email: { supported: true, availability: 'DISABLED', reason: 'SENDER_OFF' },
  },
}

const capability = (over: Record<string, unknown> = {}) => ({
  intakeWiring: 'MAPPED',
  producerSupport: 'PROVEN',
  observedInput: 'NO_OPEN_FINDING',
  editable: true,
  reason: 'READY',
  ...over,
})

const row = (over: Record<string, unknown> = {}) => ({
  alertTypeId: 'security.suspected_credential_attack',
  title: 'Suspected credential attack',
  category: 'Security',
  catalogueSeverity: 'ACT_NOW',
  disposition: 'ACT_NOW',
  mapped: true,
  capability: capability(),
  ...over,
})

const response = (over: Record<string, unknown> = {}) => ({
  organizationId: '11111111-1111-4111-8111-111111111111',
  dispositions: [row()],
  unrecognisedKeys: [],
  canManagePolicy: true,
  capabilities,
  ...over,
})

test('reads the exact additive workspace policy contract', () => {
  const read = readDispositions(response())
  assert.equal(read.outcome, 'LOADED')
  if (read.outcome !== 'LOADED') return
  assert.equal(read.canManagePolicy, true)
  assert.equal(read.rows[0].capability.producerSupport, 'PROVEN')
  assert.equal(read.rows[0].capability.observedInput, 'NO_OPEN_FINDING')
})

test('zero findings remains an editable proven producer', () => {
  const parsed = readDispositionRow(row())
  assert.equal(parsed?.capability.editable, true)
  assert.equal(parsed?.capability.observedInput, 'NO_OPEN_FINDING')
})

test('wiring-only capability remains readable but not editable', () => {
  const parsed = readDispositionRow(
    row({
      capability: capability({
        producerSupport: 'NOT_ESTABLISHED',
        observedInput: 'OPEN_FINDING_PRESENT',
        editable: false,
        reason: 'PRODUCER_NOT_ESTABLISHED',
      }),
    })
  )
  assert.equal(parsed?.capability.editable, false)
  assert.equal(parsed?.capability.reason, 'PRODUCER_NOT_ESTABLISHED')
})

test('missing or malformed capability disables the whole read', () => {
  for (const body of [
    response({ capabilities: undefined }),
    response({ canManagePolicy: undefined }),
    response({ capabilities: { ...capabilities, supportedDigestModes: ['daily'] } }),
  ]) {
    const read = readDispositions(body)
    assert.equal(read.outcome, 'UNREADABLE')
    assert.deepEqual(emptinessOf(read), { kind: 'NEVER_OBSERVED' })
  }
})

test('a malformed row capability is discarded instead of enabling a control', () => {
  for (const malformed of [
    capability({ editable: true, reason: 'INTAKE_UNMAPPED' }),
    capability({ editable: false, reason: 'INTAKE_UNMAPPED' }),
    capability({
      intakeWiring: 'UNMAPPED',
      editable: false,
      reason: 'OWNER_REQUIRED',
    }),
    capability({
      producerSupport: 'NOT_ESTABLISHED',
      editable: false,
      reason: 'OWNER_REQUIRED',
    }),
    capability({
      intakeWiring: 'UNMAPPED',
      producerSupport: 'NOT_ESTABLISHED',
      editable: true,
      reason: 'INTAKE_UNMAPPED',
    }),
  ]) {
    const read = readDispositions(
      response({ dispositions: [row({ capability: malformed })] })
    )
    assert.equal(read.outcome, 'UNREADABLE')
  }
})

test('envelope authorization and supported-row manageability must agree', () => {
  assert.equal(
    readDispositions(response({ canManagePolicy: false })).outcome,
    'UNREADABLE'
  )
  assert.equal(
    readDispositions(
      response({
        canManagePolicy: true,
        dispositions: [
          row({
            capability: capability({ editable: false, reason: 'OWNER_REQUIRED' }),
          }),
        ],
      })
    ).outcome,
    'UNREADABLE'
  )
  const viewer = readDispositions(
    response({
      canManagePolicy: false,
      dispositions: [
        row({
          capability: capability({ editable: false, reason: 'OWNER_REQUIRED' }),
        }),
      ],
    })
  )
  assert.equal(viewer.outcome, 'LOADED')
})

test('a partly readable response carries its shortfall', () => {
  const read = readDispositions(
    response({
      dispositions: [row(), row({ alertTypeId: 'bad', capability: null })],
    })
  )
  assert.equal(read.outcome, 'LOADED')
  if (read.outcome !== 'LOADED') return
  assert.equal(read.rows.length, 1)
  assert.equal(read.discarded, 1)
  assert.deepEqual(emptinessOf(read), { kind: 'HAS_ITEMS' })
})

test('only a valid empty server result is an empty organization', () => {
  const empty = readDispositions(response({ dispositions: [] }))
  const failed = readDispositions({ organizationId: 'x', dispositions: [] })
  assert.deepEqual(emptinessOf(empty), { kind: 'NOTHING_MATCHED' })
  assert.deepEqual(emptinessOf(failed), { kind: 'NEVER_OBSERVED' })
})

test('legacy array and items envelopes fail closed without capabilities', () => {
  assert.equal(readDispositions([row()]).outcome, 'UNREADABLE')
  assert.equal(readDispositions({ items: [row()] }).outcome, 'UNREADABLE')
})

test('stored unreadable values and unknown keys remain visible diagnostics', () => {
  const read = readDispositions(
    response({
      dispositions: [row({ storedValueIgnored: 'RING' })],
      unrecognisedKeys: ['security.retired'],
    })
  )
  assert.equal(read.outcome, 'LOADED')
  if (read.outcome !== 'LOADED') return
  assert.equal(read.rows[0].storedValueIgnored, 'RING')
  assert.deepEqual(read.unrecognisedKeys, ['security.retired'])
})
