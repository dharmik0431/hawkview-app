import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKEND_EMITTED_SOURCE_LABELS,
  mergeChangesPages,
  normalizeChangeCategory,
  normalizeChangeEvent,
  normalizeChangeSource,
  normalizeChangesResponse,
  PRODUCT_GUIDANCE,
  productGuidanceForImpactId,
} from './change-types.ts'

const baseEvent = {
  id: 'evidence:SNAPSHOT_DIFFERENCE:event-1',
  ts: '2026-08-18T12:00:00.000Z',
  tenantId: 'tenant-1',
  tenantName: 'Contoso',
  provider: 'Microsoft',
  severity: 'Medium',
  classification: 'configuration_change',
  title: 'Configuration changed',
  summary: 'HawkView detected a state difference.',
}

test('normalizes every current backend What Changed source/workload label to a truthful presentation value', () => {
  const cases: Array<[unknown, unknown, string, string]> = [
    ['Organization', 'Microsoft 365 organization', 'Organization', 'Microsoft 365'],
    ['Domains', 'Microsoft 365 domains', 'Domains', 'Microsoft 365'],
    ['Exchange', 'Exchange Online', 'Exchange', 'Exchange Online'],
    ['SharePoint', 'SharePoint Online', 'SharePoint', 'SharePoint and OneDrive'],
    ['Roles', 'Entra', 'Roles', 'Entra'],
    ['Apps', 'M365', 'Apps', 'Microsoft 365'],
  ]
  for (const [category, source, expectedCategory, expectedSource] of cases) {
    const event = normalizeChangeEvent({ ...baseEvent, category, source })
    assert.equal(event?.category, expectedCategory)
    assert.equal(event?.source, expectedSource)
  }
  for (const [source, expected] of Object.entries(BACKEND_EMITTED_SOURCE_LABELS)) {
    assert.equal(normalizeChangeSource(source), expected, source)
  }
})

test('fails closed for malformed, non-primary, invalid-date, and duplicate evidence rows', () => {
  assert.equal(normalizeChangeEvent({ ...baseEvent, classification: 'system_or_collection_event' }), null)
  assert.equal(normalizeChangeEvent({ ...baseEvent, ts: 'not-a-date' }), null)
  assert.equal(normalizeChangeEvent(Object.create({ ...baseEvent })), null)

  const normalized = normalizeChangesResponse({
    changes: [
      baseEvent,
      { ...baseEvent },
      { ...baseEvent, id: '', title: 'malformed' },
    ],
    tenants: [],
    summary: { total: 3, changes: 3, signIns: 0, highRisk: 0, apps: 0 },
    pagination: { page: 1, pageSize: 250, total: 1, totalPages: 1 },
  })
  assert.equal(normalized.validPayload, true)
  assert.equal(normalized.partialPayload, false)
  assert.equal(normalized.discardedCount, 2)
  assert.equal(normalized.changes.length, 1)
  assert.equal(normalized.changes[0]?.rowKey, 'tenant-1:evidence:SNAPSHOT_DIFFERENCE:event-1')
  assert.deepEqual(normalized.pagination, { page: 1, pageSize: 250, total: 1, totalPages: 1 })

  const invalid = normalizeChangesResponse({ changes: null })
  assert.equal(invalid.validPayload, false)
  assert.equal(invalid.changes.length, 0)

  const partial = normalizeChangesResponse({ changes: [], tenants: [] })
  assert.equal(partial.validPayload, true)
  assert.equal(partial.partialPayload, true)

  for (const malformedCount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    const malformedSummary = normalizeChangesResponse({
      changes: [], tenants: [],
      summary: { total: malformedCount, changes: 0, signIns: 0, highRisk: 0, apps: 0 },
    })
    assert.equal(malformedSummary.summary, undefined)
    assert.equal(malformedSummary.partialPayload, true)
  }

  const malformedPagination = normalizeChangesResponse({
    changes: [], tenants: [], summary: { total: 0, changes: 0, signIns: 0, highRisk: 0, apps: 0 },
    pagination: { page: 1, pageSize: 0, total: -1, totalPages: 99 },
  })
  assert.equal(malformedPagination.pagination, undefined)
})

test('uses Unknown fallbacks for unrecognized or malicious category/source values', () => {
  assert.equal(normalizeChangeCategory('<img src=x onerror=alert(1)>'), 'Unknown')
  assert.equal(normalizeChangeSource('javascript:alert(1)'), 'Unknown')
  const event = normalizeChangeEvent({ ...baseEvent, category: 'Organization<script>', source: '//evil.example' })
  assert.equal(event?.category, 'Unknown')
  assert.equal(event?.source, 'Unknown')
})

test('merges bounded pages without collapsing identical source IDs across tenants', () => {
  const first = normalizeChangesResponse({
    changes: [baseEvent], tenants: [{ id: 'tenant-1', name: 'Contoso' }],
    summary: { total: 2, changes: 2, signIns: 0, highRisk: 0, apps: 0 },
    pagination: { page: 1, pageSize: 1, total: 2, totalPages: 2 },
  })
  const second = normalizeChangesResponse({
    changes: [{ ...baseEvent, tenantId: 'tenant-2', tenantName: 'Fabrikam' }],
    tenants: [{ id: 'tenant-2', name: 'Fabrikam' }],
    summary: { total: 2, changes: 2, signIns: 0, highRisk: 0, apps: 0 },
    pagination: { page: 2, pageSize: 1, total: 2, totalPages: 2 },
  })
  const merged = mergeChangesPages([first, second])
  assert.deepEqual(merged?.changes.map((event) => event.tenantId), ['tenant-1', 'tenant-2'])
  assert.deepEqual(merged?.pagination, { page: 2, pageSize: 1, total: 2, totalPages: 2 })
  assert.equal(merged?.discardedCount, 0)
})

test('normalizes only the closed review and recovery guidance labels', () => {
  assert.equal(normalizeChangeEvent({ ...baseEvent, guidanceKind: 'review' })?.guidanceKind, 'review')
  assert.equal(normalizeChangeEvent({ ...baseEvent, guidanceKind: 'recovery' })?.guidanceKind, 'recovery')
  assert.equal(normalizeChangeEvent({ ...baseEvent, guidanceKind: 'attacker-label' })?.guidanceKind, undefined)
})

test('normalizes list and detail-shaped events consistently and drops malformed records', () => {
  const list = normalizeChangesResponse({
    changes: [
      { ...baseEvent, category: 'Exchange', source: 'Exchange' },
      { id: '', ts: 'not-an-event', tenantId: '', category: 'Exchange', source: 'Exchange' },
    ],
    tenants: [{ id: 'tenant-1', name: 'Contoso' }, { id: '', name: 'Dropped' }],
  })
  const detail = normalizeChangeEvent({ ...baseEvent, category: 'Exchange', source: 'Exchange' })
  assert.equal(list.changes.length, 1)
  assert.equal(list.changes[0]?.category, detail?.category)
  assert.equal(list.changes[0]?.source, detail?.source)
  assert.deepEqual(list.tenants, [{ id: 'tenant-1', name: 'Contoso' }])
})

test('preserves the complete supported evidence contract while dropping unknown or unsafe nested values', () => {
  const event = normalizeChangeEvent({
    ...baseEvent,
    category: 'Organization',
    source: 'Microsoft 365 organization',
    evidence: {
      result: 'Succeeded', resultReason: 'Updated', operationType: 'Update', loggedByService: 'Core Directory',
      normalized: true, changedFields: ['displayName'], workload: 'Microsoft 365 organization', source: 'Microsoft 365 organization',
      provenance: 'HawkView snapshot comparison', microsoftSource: 'Microsoft Graph /organization',
      actor: { displayName: 'Admin', principalName: 'admin@example.test', type: 'User', objectId: 'actor-1', ipAddress: '203.0.113.1', automatedBy: 'Automation' },
      application: { displayName: 'Admin Portal', appId: 'app-1', objectId: 'object-1', servicePrincipalId: 'sp-1', publisher: 'Microsoft', appType: 'web', signInAudience: 'AzureADMyOrg', description: 'Known app', homepage: ['https://example.test'] },
      permissions: { permissionName: ['Mail.Read', 'User.Read'], permissionType: 'Application', consentType: 'AllPrincipals', scope: ['Mail.Read'], resourceApi: 'Microsoft Graph', appRole: 'Reader', assignedTo: 'admin@example.test', grantingAdmin: 'owner@example.test', consentStatus: 'Granted' },
      targets: [{ displayName: 'Target user', targetType: 'User', objectId: 'target-1', upn: 'target@example.test', injected: 'drop-me' }],
      potentialImpact: { kind: 'product_guidance', impactId: 'organization.identity_changed', label: 'attacker label', category: 'license', guidance: 'attacker guidance' },
      unknown: { nested: 'drop-me' },
    },
    before: { displayName: 'Before', nested: { valid: true, __proto__: { poisoned: true } } },
    after: { displayName: 'After' },
  })
  assert.deepEqual(event?.evidence, {
    result: 'Succeeded', resultReason: 'Updated', operationType: 'Update', loggedByService: 'Core Directory', normalized: true,
    changedFields: ['displayName'], workload: 'Microsoft 365 organization', source: 'Microsoft 365', provenance: 'HawkView snapshot comparison', microsoftSource: 'Microsoft Graph /organization',
    actor: { displayName: 'Admin', principalName: 'admin@example.test', type: 'User', objectId: 'actor-1', ipAddress: '203.0.113.1', automatedBy: 'Automation' },
    application: { displayName: 'Admin Portal', appId: 'app-1', objectId: 'object-1', servicePrincipalId: 'sp-1', publisher: 'Microsoft', appType: 'web', signInAudience: 'AzureADMyOrg', description: 'Known app', homepage: ['https://example.test'] },
    permissions: { permissionName: ['Mail.Read', 'User.Read'], permissionType: 'Application', consentType: 'AllPrincipals', scope: ['Mail.Read'], resourceApi: 'Microsoft Graph', appRole: 'Reader', assignedTo: 'admin@example.test', grantingAdmin: 'owner@example.test', consentStatus: 'Granted' },
    targets: [{ displayName: 'Target user', targetType: 'User', objectId: 'target-1', upn: 'target@example.test' }],
    potentialImpact: { kind: 'product_guidance', impactId: 'organization.identity_changed' },
  })
  assert.deepEqual(event?.before, { displayName: 'Before' })
  assert.doesNotMatch(JSON.stringify(event), /drop-me|poisoned/)
})

test('uses frontend-owned immutable product guidance and rejects unknown or legacy display payloads', () => {
  const expected = productGuidanceForImpactId('organization.identity_changed')
  assert.deepEqual(expected, {
    label: 'Potential impact', category: 'identity',
    guidance: 'Tenant identity information changed. Confirm the change is expected because it can affect administrator recognition and tenant communications.',
  })
  const valid = normalizeChangeEvent({ ...baseEvent, evidence: { potentialImpact: { kind: 'product_guidance', impactId: 'organization.identity_changed', label: 'attacker label', category: 'license', guidance: 'attacker guidance' } } })
  assert.deepEqual(valid?.evidence?.potentialImpact, { kind: 'product_guidance', impactId: 'organization.identity_changed' })
  assert.equal(normalizeChangeEvent({ ...baseEvent, evidence: { potentialImpact: { kind: 'product_guidance', impactId: 'unknown', guidance: 'bad' } } })?.evidence, undefined)
  assert.equal(normalizeChangeEvent({ ...baseEvent, evidence: { potentialImpact: { kind: 'product_guidance', category: 'identity', guidance: 'legacy payload' } } })?.evidence, undefined)
  assert.equal(normalizeChangeEvent({ ...baseEvent, evidence: { potentialImpact: { kind: 'attacker', guidance: 'bad' } } })?.evidence, undefined)
})

test('accepts only own exact product-impact IDs and rejects inherited, malformed, and normalized variants', () => {
  const accepted = [
    'organization.identity_changed',
    'domains.configuration_changed',
    'licenses.subscription_changed',
  ]
  for (const impactId of accepted) {
    const event = normalizeChangeEvent({ ...baseEvent, evidence: { potentialImpact: { kind: 'product_guidance', impactId } } })
    assert.deepEqual(event?.evidence?.potentialImpact, { kind: 'product_guidance', impactId })
    assert.ok(productGuidanceForImpactId(impactId))
  }
  const rejected: unknown[] = [
    'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'prototype',
    'Organization.Identity_Changed', ' organization.identity_changed', 'organization.identity_changed ',
    'organization.identity_changed\n', '', null, undefined, 1, true, Symbol('impact'), {}, [],
  ]
  for (const impactId of rejected) {
    const event = normalizeChangeEvent({ ...baseEvent, evidence: { potentialImpact: { kind: 'product_guidance', impactId } } })
    assert.equal(event?.evidence, undefined, String(impactId))
    assert.equal(productGuidanceForImpactId(impactId), undefined, String(impactId))
  }
})

test('keeps the product-guidance table and every entry deeply immutable', () => {
  const impactIds = [
    'organization.identity_changed',
    'domains.configuration_changed',
    'licenses.subscription_changed',
  ] as const
  assert.ok(Object.isFrozen(PRODUCT_GUIDANCE))

  for (const impactId of impactIds) {
    const canonical = productGuidanceForImpactId(impactId)
    const entry = PRODUCT_GUIDANCE[impactId as keyof typeof PRODUCT_GUIDANCE]
    assert.ok(Object.isFrozen(entry), impactId)

    const mutableTable = PRODUCT_GUIDANCE as unknown as Record<string, unknown>
    const mutableEntry = entry as unknown as Record<string, unknown>
    Reflect.set(mutableTable, impactId, { label: 'attacker' })
    Reflect.deleteProperty(mutableTable, impactId)
    Reflect.set(mutableEntry, 'label', 'attacker')
    Reflect.set(mutableEntry, 'category', 'attacker')
    Reflect.set(mutableEntry, 'guidance', 'attacker')
    Reflect.deleteProperty(mutableEntry, 'label')

    assert.deepEqual(productGuidanceForImpactId(impactId), canonical)
    assert.deepEqual(PRODUCT_GUIDANCE[impactId as keyof typeof PRODUCT_GUIDANCE], canonical)
  }
})
