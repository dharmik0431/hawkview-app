import assert from 'node:assert/strict'
import test from 'node:test'
import {
  M365_AUDIT_BUDGET_CONSTRAINTS,
  M365_AUDIT_ATTEMPT_ENVELOPE_VERSION,
  beginAttemptEnvelope,
  envelopeWithRefusal,
  parseAttemptEnvelope,
  qualifiedBudgetRefusal,
  selectBudgetConstraint,
  type M365AuditBudgetConstraint,
} from './m365-audit-refusal-observation.js'

const TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ATTEMPT_AT = new Date('2026-11-26T12:00:00.000Z')
const OBSERVED_AT = new Date('2026-11-26T12:00:05.000Z')
const NOW = new Date('2026-11-26T12:00:10.000Z')
const BOUNDARY = new Date('2026-11-27T00:00:00.000Z')

const envelope = (overrides: Record<string, unknown> = {}, refusalOverrides: Record<string, unknown> | null = {}) => ({
  v: M365_AUDIT_ATTEMPT_ENVELOPE_VERSION,
  attemptToken: TOKEN,
  attemptAt: ATTEMPT_AT.toISOString(),
  refusal: refusalOverrides === null ? null : {
    attemptToken: TOKEN,
    path: 'content',
    constraint: 'daily_tenant_bytes',
    observedAt: OBSERVED_AT.toISOString(),
    retryNotBefore: BOUNDARY.toISOString(),
    ...refusalOverrides,
  },
  ...overrides,
})

const state = (overrides: Record<string, unknown> = {}) => ({
  resourceType: 'M365_AUDIT',
  status: 'RUNNING',
  lastErrorCode: 'm365-audit-backlog',
  lastAttemptAt: ATTEMPT_AT,
  m365AuditAttempt: envelope(),
  ...overrides,
})

// --------------------------------------------------------------------------
// Closed sets and the documented selection order
// --------------------------------------------------------------------------

test('the eight closed constraints are exactly the eight caps, in the documented order', () => {
  assert.deepEqual([...M365_AUDIT_BUDGET_CONSTRAINTS], [
    'monthly_tenant_bytes', 'monthly_deployment_bytes',
    'monthly_tenant_records', 'monthly_deployment_records',
    'daily_tenant_bytes', 'daily_deployment_bytes',
    'daily_tenant_records', 'daily_deployment_records',
  ])
})

test('each axis on its own selects itself', () => {
  for (const only of M365_AUDIT_BUDGET_CONSTRAINTS) {
    assert.equal(selectBudgetConstraint({ [only]: true }), only, only)
  }
})

test('monthly precedes daily and the within-period order is fixed', () => {
  // Every monthly axis beats every daily axis.
  for (const monthly of M365_AUDIT_BUDGET_CONSTRAINTS.filter((c) => c.startsWith('monthly_'))) {
    for (const daily of M365_AUDIT_BUDGET_CONSTRAINTS.filter((c) => c.startsWith('daily_'))) {
      assert.equal(selectBudgetConstraint({ [monthly]: true, [daily]: true }), monthly, `${monthly} vs ${daily}`)
    }
  }
  // Within a period: tenant bytes, deployment bytes, tenant records, deployment records.
  assert.equal(selectBudgetConstraint({
    daily_deployment_records: true, daily_tenant_records: true,
    daily_deployment_bytes: true, daily_tenant_bytes: true,
  }), 'daily_tenant_bytes')
  assert.equal(selectBudgetConstraint({
    daily_deployment_records: true, daily_tenant_records: true, daily_deployment_bytes: true,
  }), 'daily_deployment_bytes')
  assert.equal(selectBudgetConstraint({
    daily_deployment_records: true, daily_tenant_records: true,
  }), 'daily_tenant_records')
  // All eight at once still resolves to the first member.
  const all = Object.fromEntries(M365_AUDIT_BUDGET_CONSTRAINTS.map((c) => [c, true]))
  assert.equal(selectBudgetConstraint(all), 'monthly_tenant_bytes')
})

test('no proven constraint yields no fabricated detail', () => {
  assert.equal(selectBudgetConstraint({}), null)
  assert.equal(selectBudgetConstraint(
    Object.fromEntries(M365_AUDIT_BUDGET_CONSTRAINTS.map((c) => [c, false])) as Record<M365AuditBudgetConstraint, boolean>,
  ), null)
})

// --------------------------------------------------------------------------
// Envelope construction
// --------------------------------------------------------------------------

test('a fresh envelope carries no refusal, which is how a new attempt invalidates the old one', () => {
  const fresh = beginAttemptEnvelope(TOKEN, ATTEMPT_AT)
  assert.deepEqual(fresh, {
    v: 1, attemptToken: TOKEN, attemptAt: ATTEMPT_AT.toISOString(), refusal: null,
  })
})

test('a refusal must belong to its own attempt', () => {
  const fresh = beginAttemptEnvelope(TOKEN, ATTEMPT_AT)
  const base = {
    path: 'content' as const, constraint: 'daily_tenant_bytes' as const,
    observedAt: OBSERVED_AT, retryNotBefore: BOUNDARY,
  }
  assert.ok(envelopeWithRefusal(fresh, { ...base, attemptToken: TOKEN }))
  assert.equal(envelopeWithRefusal(fresh, { ...base, attemptToken: 'other-token' }), null)
  assert.equal(envelopeWithRefusal(fresh, { ...base, attemptToken: TOKEN, observedAt: new Date('bad') }), null)
  assert.equal(envelopeWithRefusal(fresh, { ...base, attemptToken: TOKEN, retryNotBefore: new Date('bad') }), null)
})

test('a later refusal in the same attempt replaces the earlier one', () => {
  const fresh = beginAttemptEnvelope(TOKEN, ATTEMPT_AT)
  const first = envelopeWithRefusal(fresh, {
    attemptToken: TOKEN, path: 'content', constraint: 'daily_tenant_bytes',
    observedAt: OBSERVED_AT, retryNotBefore: BOUNDARY,
  })!
  const second = envelopeWithRefusal(first, {
    attemptToken: TOKEN, path: 'discovery', constraint: 'monthly_deployment_records',
    observedAt: new Date('2026-11-26T12:00:08.000Z'), retryNotBefore: new Date('2026-12-01T00:00:00.000Z'),
  })!
  assert.equal(second.refusal?.constraint, 'monthly_deployment_records')
  assert.equal(second.refusal?.path, 'discovery')
  assert.equal(second.attemptToken, TOKEN, 'the attempt identity is unchanged')
})

// --------------------------------------------------------------------------
// Strict parsing
// --------------------------------------------------------------------------

test('a legacy null row and non-objects are unknown, never a receipt', () => {
  for (const value of [null, undefined, 0, '', 'x', [], [envelope()], true]) {
    assert.equal(parseAttemptEnvelope(value), null, JSON.stringify(value ?? null))
  }
})

test('an unsupported version is unknown rather than guessed', () => {
  assert.equal(parseAttemptEnvelope(envelope({ v: 2 })), null)
  assert.equal(parseAttemptEnvelope(envelope({ v: '1' })), null)
})

test('exact own-key sets are required on both levels', () => {
  assert.equal(parseAttemptEnvelope(envelope({ extra: 'x' })), null)
  assert.equal(parseAttemptEnvelope(envelope({}, { extra: 'x' })), null)
  const missing = envelope() as Record<string, unknown>
  delete missing.attemptAt
  assert.equal(parseAttemptEnvelope(missing), null)
})

test('closed enums and bounded tokens are enforced', () => {
  assert.equal(parseAttemptEnvelope(envelope({}, { path: 'subscriptions' })), null)
  assert.equal(parseAttemptEnvelope(envelope({}, { constraint: 'daily_tenant_gigabytes' })), null)
  assert.equal(parseAttemptEnvelope(envelope({ attemptToken: '' })), null)
  assert.equal(parseAttemptEnvelope(envelope({ attemptToken: 'a'.repeat(65) })), null)
  assert.equal(parseAttemptEnvelope(envelope({ attemptToken: 'has space' })), null)
})

test('only canonical finite instants parse', () => {
  assert.equal(parseAttemptEnvelope(envelope({ attemptAt: 'not-a-date' })), null)
  assert.equal(parseAttemptEnvelope(envelope({ attemptAt: '2026-11-26T12:00:00Z' })), null,
    'a non-canonical ISO form is refused rather than normalised')
  assert.equal(parseAttemptEnvelope(envelope({}, { retryNotBefore: 12345 })), null)
})

test('a refusal-free envelope parses and carries no refusal', () => {
  const parsed = parseAttemptEnvelope(envelope({}, null))
  assert.ok(parsed)
  assert.equal(parsed.refusal, null)
})

// --------------------------------------------------------------------------
// The reader gate
// --------------------------------------------------------------------------

test('a fully bound current observation qualifies', () => {
  assert.deepEqual(qualifiedBudgetRefusal(state(), NOW), {
    path: 'content',
    constraint: 'daily_tenant_bytes',
    observedAt: OBSERVED_AT.toISOString(),
    retryNotBefore: BOUNDARY.toISOString(),
  })
})

test('both already-recognised deferred codes may carry it, nothing else may', () => {
  assert.ok(qualifiedBudgetRefusal(state({ lastErrorCode: 'm365-audit-backlog' }), NOW))
  assert.ok(qualifiedBudgetRefusal(state({ lastErrorCode: 'm365-audit-budget-exhausted' }), NOW))
  for (const code of ['m365-audit-content-unavailable', 'm365-audit-sync-failed', null, '', 'anything']) {
    assert.equal(qualifiedBudgetRefusal(state({ lastErrorCode: code }), NOW), null, String(code))
  }
})

test('only M365_AUDIT, only RUNNING', () => {
  assert.equal(qualifiedBudgetRefusal(state({ resourceType: 'SIGN_INS' }), NOW), null)
  assert.equal(qualifiedBudgetRefusal(state({ resourceType: undefined }), NOW), null)
  for (const status of ['SUCCEEDED', 'FAILED', 'IDLE', 'PENDING', 'QUEUED', undefined]) {
    assert.equal(qualifiedBudgetRefusal(state({ status }), NOW), null, String(status))
  }
})

test('the observation must belong to the row current attempt', () => {
  // Refusal token differs from the envelope token.
  assert.equal(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { attemptToken: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }) }), NOW,
  ), null)
  // Envelope attempt time does not equal the stored lastAttemptAt.
  assert.equal(qualifiedBudgetRefusal(
    state({ lastAttemptAt: new Date('2026-11-26T12:00:01.000Z') }), NOW,
  ), null)
  // A successor attempt installed a fresh refusal-free envelope.
  assert.equal(qualifiedBudgetRefusal(state({ m365AuditAttempt: envelope({}, null) }), NOW), null)
  // No stored attempt time at all.
  assert.equal(qualifiedBudgetRefusal(state({ lastAttemptAt: null }), NOW), null)
  assert.equal(qualifiedBudgetRefusal(state({ lastAttemptAt: new Date('bad') }), NOW), null)
})

test('the observation time must be real, not future, and not before its attempt', () => {
  assert.equal(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { observedAt: '2026-11-26T12:00:11.000Z' }) }), NOW,
  ), null, 'future observation')
  assert.equal(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { observedAt: '2026-11-26T11:59:59.000Z' }) }), NOW,
  ), null, 'observed before the attempt started')
  // Exactly at the attempt start and exactly at now are both acceptable.
  assert.ok(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { observedAt: ATTEMPT_AT.toISOString() }) }), NOW,
  ))
  assert.ok(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { observedAt: NOW.toISOString() }) }), NOW,
  ))
})

test('the boundary must be strictly in the future, so exact expiry is suppressed', () => {
  assert.ok(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { retryNotBefore: '2026-11-26T12:00:11.000Z' }) }), NOW,
  ), 'one millisecond ahead still qualifies')
  assert.equal(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { retryNotBefore: NOW.toISOString() }) }), NOW,
  ), null, 'at the exact boundary the detail is withheld')
  assert.equal(qualifiedBudgetRefusal(
    state({ m365AuditAttempt: envelope({}, { retryNotBefore: '2026-11-26T12:00:09.000Z' }) }), NOW,
  ), null, 'a past boundary is withheld')
})

test('a monthly boundary survives a UTC day rollover while the same attempt is current', () => {
  const monthly = state({
    lastErrorCode: 'm365-audit-budget-exhausted',
    m365AuditAttempt: envelope({}, {
      path: 'discovery', constraint: 'monthly_deployment_bytes',
      retryNotBefore: '2026-12-01T00:00:00.000Z',
    }),
  })
  // Read on the next UTC day: nothing here consults a usage date.
  const nextDay = new Date('2026-11-27T09:30:00.000Z')
  const qualified = qualifiedBudgetRefusal(monthly, nextDay)
  assert.equal(qualified?.constraint, 'monthly_deployment_bytes')
  assert.equal(qualified?.retryNotBefore, '2026-12-01T00:00:00.000Z')
  // And once the month boundary passes, it is withheld.
  assert.equal(qualifiedBudgetRefusal(monthly, new Date('2026-12-01T00:00:00.000Z')), null)
})

test('an unusable evaluation clock yields nothing', () => {
  assert.equal(qualifiedBudgetRefusal(state(), new Date('bad')), null)
})

test('missing or malformed metadata is unknown and never turns backlog into success', () => {
  for (const value of [null, undefined, {}, { v: 1 }, 'x', envelope({ v: 9 })]) {
    const result = qualifiedBudgetRefusal(state({ m365AuditAttempt: value }), NOW)
    assert.equal(result, null, JSON.stringify(value ?? null))
  }
  assert.equal(qualifiedBudgetRefusal(null, NOW), null)
  assert.equal(qualifiedBudgetRefusal(undefined, NOW), null)
})
