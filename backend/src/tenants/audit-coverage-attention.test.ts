import assert from 'node:assert/strict'
import test from 'node:test'
import { readAttentionProvenance, type AttentionProvenance } from './attention-provenance.js'
import {
  AUDIT_COVERAGE_LIMITATION_KEY,
  TENANT_HEALTH_RESOURCE_REGISTRY,
  deriveTenantHealth,
  type TenantAuditEvent,
  type TenantAuditEvidenceSummary,
} from './tenant-health.js'

/**
 * Incomplete audit coverage must reach the customer attention contract.
 *
 * These call the ACTUAL unchanged consumers in `lib/attention/customer-attention.ts`
 * — `customerAttention`, `customerStatus`, `customerTarget` — against the actual
 * `deriveTenantHealth` output. Nothing here reimplements the consumer as a local
 * oracle, and no frontend file is modified.
 *
 * The gap being closed: the consumer decides completeness from `data.status` and
 * from recognized attention provenance. It does not read the audit summary. So a
 * response with complete collectors, an unread audit window and no other
 * attention could still answer "No findings reported".
 */

/**
 * Load the ACTUAL unchanged consumer at runtime. It lives outside the backend
 * rootDir, so it is imported through a non-literal specifier, which is the
 * pattern `secure-score-serializer.test.ts` already uses for `types/api.ts`.
 * Only the call signatures are declared here; every behaviour under test comes
 * from that real module, which is neither copied nor modified.
 */
const consumerPath = '../../../lib/attention/customer-attention.ts'
const consumer = await import(consumerPath) as {
  customerAttention: (value: unknown) => {
    sourceAvailable: boolean
    incomplete: boolean
    findings: Array<{ key: string; label: string; severity: string; provenance: AttentionProvenance }>
    accessActions: unknown[]
    operations: unknown[]
    limitations: unknown[]
    unknown: unknown[]
  }
  customerStatus: (view: { findings: unknown[]; accessActions: unknown[]; incomplete: boolean }) => string
  customerTarget: (provenance: AttentionProvenance | undefined) => string
}
const { customerAttention, customerStatus, customerTarget } = consumer

const NOW = new Date('2026-11-25T12:00:00.000Z')
const TENANT = 'tenant-audit-coverage'

/** Every health-registry collector currently successful, so `data.status` is
 *  COMPLETE and the consumer's own completeness test cannot be what fails. */
const completeCollectors = () => TENANT_HEALTH_RESOURCE_REGISTRY.map(resource => ({
  resourceType: resource.resourceType, status: 'SUCCEEDED',
  lastAttemptAt: NOW, lastSuccessfulAt: NOW,
  lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
}))

const summary = (
  partial: Partial<TenantAuditEvidenceSummary> & Pick<TenantAuditEvidenceSummary, 'status' | 'reason'>,
): TenantAuditEvidenceSummary => ({
  windowComplete: false, observedCount: 0, withheldPayloads: 0,
  assessedAt: NOW.toISOString(), ...partial,
})

const COMPLETE_EVIDENCE = summary({ status: 'COMPLETE', reason: 'OK', windowComplete: true })

const baseInput = (auditEvidence: TenantAuditEvidenceSummary | undefined) => ({
  tenantId: TENANT,
  effectiveStatus: 'active',
  connectionStatus: 'ACTIVE',
  missingPermissions: [] as string[],
  syncStates: completeCollectors(),
  authSnapshot: null,
  riskyIdentityCount: 0,
  auditEvents: [] as TenantAuditEvent[],
  now: NOW,
  ...(auditEvidence ? { auditEvidence } : {}),
})

const auditEvent = (microsoftAuditId: string, activityDisplayName: string, type: string): TenantAuditEvent => ({
  microsoftAuditId, eventDateTime: NOW, activityDisplayName,
  category: 'UserManagement', operationType: 'Update', result: 'success',
  initiatedBy: { user: { userPrincipalName: 'admin@example.invalid' } },
  targetResources: [{ displayName: 'Synthetic target', type }],
})

// ---------------------------------------------------------------------------
// The contract: incomplete coverage reaches the real consumer
// ---------------------------------------------------------------------------

const INCOMPLETE_CASES: Array<{ name: string; evidence: TenantAuditEvidenceSummary | undefined }> = [
  { name: 'no audit metadata at all', evidence: undefined },
  { name: 'capped window', evidence: summary({ status: 'CAPPED', reason: 'TENANT_EVENT_CAP_REACHED', observedCount: 500 }) },
  { name: 'read failed', evidence: summary({ status: 'UNREAD', reason: 'READ_FAILED' }) },
  { name: 'scope mismatch', evidence: summary({ status: 'UNREAD', reason: 'SCOPE_MISMATCH' }) },
  { name: 'row validation failed', evidence: summary({ status: 'UNREAD', reason: 'ROW_VALIDATION_FAILED' }) },
  { name: 'oversize payload field', evidence: summary({ status: 'UNREAD', reason: 'PAYLOAD_FIELD_OVERSIZE', observedCount: 2 }) },
  { name: 'payload bytes withheld', evidence: summary({ status: 'UNREAD', reason: 'PAYLOAD_BYTES_WITHHELD', observedCount: 2, withheldPayloads: 1 }) },
  // COMPLETE and OK, but a value was withheld: the window is still not complete.
  { name: 'complete read that withheld a value', evidence: summary({ status: 'COMPLETE', reason: 'OK', windowComplete: true, observedCount: 2, withheldPayloads: 1 }) },
]

for (const incomplete of INCOMPLETE_CASES) {
  test(`an otherwise quiet tenant is incomplete to the real consumer: ${incomplete.name}`, () => {
    const health = deriveTenantHealth(baseInput(incomplete.evidence))
    const view = customerAttention(health)

    // The consumer's OWN completeness inputs are clean, so the limitation is
    // the only thing that can make this incomplete.
    assert.equal(health.data.status, 'COMPLETE', 'collector coverage is complete')
    assert.equal(view.sourceAvailable, true)
    assert.equal(view.operations.length, 0, 'no collector operation drives this')
    assert.equal(view.unknown.length, 0, 'no unclassified item drives this')
    assert.equal(view.findings.length, 0)
    assert.equal(view.accessActions.length, 0)

    // THE CONTRACT FIRST: the consumer must report this coverage as incomplete
    // and must not answer with a clean finding total. Asserted ahead of the
    // item's shape on purpose, so a regression that stops emitting the
    // limitation fails on the contract rather than on a detail of the item.
    assert.equal(view.incomplete, true,
      'the real consumer must report this audit coverage as incomplete')
    assert.equal(customerStatus(view), 'Finding total unavailable',
      'and must not answer with a clean finding total')

    // Then the mechanism: exactly one recognized limitation.
    assert.equal(view.limitations.length, 1)
    const item = view.limitations[0] as { key: string; severity: string; provenance: unknown; detectedAt: unknown }
    assert.equal(item.key, AUDIT_COVERAGE_LIMITATION_KEY)
    assert.equal(item.key.startsWith('audit-'), false, 'it cannot consume an audit finding budget slot')
    assert.deepEqual(readAttentionProvenance(item.provenance),
      { version: 1, origin: 'EVIDENCE_LIMITATION', kind: 'INCOMPLETE_AUDIT_EVIDENCE', remediationOwner: 'UNDETERMINED' })
    assert.equal(item.detectedAt, null)
    // It is not routed anywhere a customer is asked to act.
    assert.equal(customerTarget(readAttentionProvenance(item.provenance)), 'overview')

    // No count, recommendation or score moved.
    assert.equal(health.security.criticalFindings, 0)
    assert.equal(health.security.highFindings, 0)
    assert.equal(health.security.mediumFindings, 0)
    assert.equal(health.security.lowFindings, 0)
    assert.equal(health.security.recommendationCount, 0)
    assert.equal(health.healthScore, 100)
    assert.equal(health.operations.activeIssues, 0)
  })
}

test('the complete-empty positive control still reports no findings', () => {
  const health = deriveTenantHealth(baseInput(COMPLETE_EVIDENCE))
  const view = customerAttention(health)
  assert.equal(health.data.status, 'COMPLETE')
  assert.deepEqual(health.attention, [], 'a complete read with nothing withheld emits no limitation')
  assert.equal(view.limitations.length, 0)
  assert.equal(view.incomplete, false)
  assert.equal(customerStatus(view), 'No findings reported')
  // And the same fixture one case away is NOT clean, so this control is live.
  const unread = customerAttention(deriveTenantHealth(baseInput(summary({ status: 'UNREAD', reason: 'READ_FAILED' }))))
  assert.equal(unread.incomplete, true)
  assert.equal(customerStatus(unread), 'Finding total unavailable')
})

// ---------------------------------------------------------------------------
// Coexistence with real findings
// ---------------------------------------------------------------------------

/** Four distinct finding labels; the derivation's budget admits three. */
const FOUR_EVENTS: TenantAuditEvent[] = [
  auditEvent('ca-disabled', 'Disable conditional access policy', 'conditionalAccessPolicy'),
  auditEvent('auth-deleted', 'Delete authentication method', 'authenticationMethod'),
  auditEvent('app-updated', 'Update application', 'application'),
  auditEvent('role-updated', 'Update directory role', 'Role'),
]

test('the limitation coexists with three real audit findings without becoming a fourth', () => {
  const capped = summary({ status: 'CAPPED', reason: 'TENANT_EVENT_CAP_REACHED', observedCount: 500 })
  const withLimitation = deriveTenantHealth({ ...baseInput(capped), auditEvents: FOUR_EVENTS })
  const control = deriveTenantHealth({ ...baseInput(COMPLETE_EVIDENCE), auditEvents: FOUR_EVENTS })

  // The three-finding budget is untouched: same keys, same order, same severities.
  const findingKeys = (health: typeof control) =>
    health.attention.filter(item => item.key.startsWith('audit-')).map(item => [item.key, item.severity])
  assert.equal(findingKeys(control).length, 3, 'the budget admits exactly three')
  assert.deepEqual(findingKeys(withLimitation), findingKeys(control))

  // Counts, recommendations, score and precedence are identical.
  assert.equal(withLimitation.security.criticalFindings, control.security.criticalFindings)
  assert.equal(withLimitation.security.highFindings, control.security.highFindings)
  assert.equal(withLimitation.security.mediumFindings, control.security.mediumFindings)
  assert.equal(withLimitation.security.lowFindings, control.security.lowFindings)
  assert.equal(withLimitation.security.recommendationCount, control.security.recommendationCount)
  assert.equal(withLimitation.healthScore, control.healthScore)
  assert.equal(withLimitation.security.status, control.security.status)
  assert.equal(withLimitation.overallStatus, control.overallStatus)
  assert.equal(withLimitation.operations.activeIssues, control.operations.activeIssues)

  // The real consumer sees three findings plus one limitation, no access action.
  const view = customerAttention(withLimitation)
  assert.equal(view.findings.length, 3)
  assert.equal(view.limitations.length, 1)
  assert.equal(view.accessActions.length, 0)
  assert.equal(view.unknown.length, 0)
  assert.equal(view.incomplete, true)
  // Findings are still counted and reported: the limitation does not hide them.
  assert.equal(customerStatus(view), '3 reported findings')
  assert.equal(customerStatus(customerAttention(control)), '3 reported findings')
  assert.equal(customerAttention(control).incomplete, false)
})

test('the limitation does not outrank or soften an observed critical finding', () => {
  const critical = [auditEvent('ca-disabled', 'Disable conditional access policy', 'conditionalAccessPolicy')]
  const unread = summary({ status: 'UNREAD', reason: 'READ_FAILED' })
  const withLimitation = deriveTenantHealth({ ...baseInput(unread), auditEvents: critical })
  const control = deriveTenantHealth({ ...baseInput(COMPLETE_EVIDENCE), auditEvents: critical })
  assert.equal(control.security.criticalFindings, 1)
  assert.equal(control.security.status, 'CRITICAL')
  assert.equal(control.overallStatus, 'CRITICAL')
  assert.equal(withLimitation.security.criticalFindings, 1)
  assert.equal(withLimitation.security.status, 'CRITICAL')
  assert.equal(withLimitation.overallStatus, 'CRITICAL', 'adverse precedence is unchanged')
  assert.equal(withLimitation.healthScore, control.healthScore)
  const view = customerAttention(withLimitation)
  assert.equal(view.findings.length, 1)
  assert.equal(view.findings[0]!.severity, 'critical')
  assert.equal(view.limitations.length, 1)
  assert.equal(customerStatus(view), '1 reported finding')
})

// ---------------------------------------------------------------------------
// Distinctness, safety and the existing sign-in behaviour
// ---------------------------------------------------------------------------

test('the audit limitation never impersonates the sign-in limitation', () => {
  const signInState = {
    resourceType: 'SIGN_INS', status: 'RUNNING',
    lastAttemptAt: NOW, lastSuccessfulAt: NOW,
    lastErrorCode: 'sign-ins-non-premium-fallback-active',
    lastErrorMessage: 'opaque test message', consecutiveFailures: 0,
  }
  const health = deriveTenantHealth({
    ...baseInput(summary({ status: 'UNREAD', reason: 'READ_FAILED' })),
    syncStates: [...completeCollectors().filter(state => state.resourceType !== 'SIGN_INS'), signInState],
  })
  const kinds = health.attention
    .filter(item => readAttentionProvenance(item.provenance).origin === 'EVIDENCE_LIMITATION')
    .map(item => [item.key, readAttentionProvenance(item.provenance).kind])
  // Both limitations are present and each keeps its own kind.
  assert.deepEqual(kinds.sort(), [
    ['evidence-audit-window', 'INCOMPLETE_AUDIT_EVIDENCE'],
    ['sign-ins-limited-evidence', 'LIMITED_SIGN_IN_EVIDENCE'],
  ].sort())
  const view = customerAttention(health)
  assert.equal(view.limitations.length, 2)
  assert.equal(view.incomplete, true)
})

test('the limitation copy carries no raw error, payload, statement or identifier text', () => {
  for (const incomplete of INCOMPLETE_CASES) {
    const health = deriveTenantHealth(baseInput(incomplete.evidence))
    const item = health.attention.find(row => row.key === AUDIT_COVERAGE_LIMITATION_KEY)!
    const serialized = JSON.stringify({ label: item.label, why: item.why, actionLabel: item.actionLabel })
    for (const forbidden of ['SELECT', 'directory_audit_logs', 'initiated_by', 'target_resources',
      'READ_FAILED', 'SCOPE_MISMATCH', 'ROW_VALIDATION_FAILED', 'PAYLOAD_BYTES_WITHHELD',
      'octet_length', 'postgres', 'Error', '$1']) {
      assert.equal(serialized.includes(forbidden), false, `${incomplete.name}: ${forbidden}`)
    }
    // Plain, bounded copy with no control characters.
    assert.ok(item.label.length > 0 && item.label.length <= 120, incomplete.name)
    assert.ok(item.why.length > 0 && item.why.length <= 400, incomplete.name)
    for (const value of [item.label, item.why, item.actionLabel, item.actionUrl]) {
      assert.equal(/[\u0000-\u001f\u007f]/.test(value), false, incomplete.name)
    }
    // The action is read-only navigation scoped to this tenant.
    assert.equal(item.actionUrl, `/tenants/${TENANT}`)
    assert.equal(/refresh|reconnect|consent|permission|retry|sync/i.test(item.actionLabel), false,
      'no customer remediation action')
  }
})

test('the limitation identity does not depend on the clock or on event counts', () => {
  const identity = (evidence: TenantAuditEvidenceSummary, now: Date, events: TenantAuditEvent[]) => {
    const health = deriveTenantHealth({ ...baseInput(evidence), now, syncStates: completeCollectors(), auditEvents: events })
    const item = health.attention.find(row => row.key === AUDIT_COVERAGE_LIMITATION_KEY)!
    return { key: item.key, severity: item.severity, label: item.label, why: item.why,
      detectedAt: item.detectedAt, provenance: item.provenance }
  }
  const later = new Date(NOW.getTime() + 37 * 60 * 1000)
  const unread = summary({ status: 'UNREAD', reason: 'READ_FAILED' })
  assert.deepEqual(
    identity({ ...unread, assessedAt: later.toISOString() }, later, FOUR_EVENTS),
    identity(unread, NOW, []),
    'neither the assessment time nor the observed events change the item')
})
