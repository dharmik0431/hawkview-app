import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCollectionReadiness } from './collection-readiness.ts'
import type { AccessDatasetReadiness } from './collection-readiness.ts'
import { datasetStateNeedsTenantAction, microsoftAccessDatasetView, microsoftAccessSummary, normalizeMicrosoftAccessCatalog, normalizeMicrosoftConsentReview, normalizeMicrosoftVerificationTimestamp } from './microsoft-access-contract.ts'

function dataset(
  key: string,
  tier: AccessDatasetReadiness['tier'],
  state: AccessDatasetReadiness['state'] = 'READY',
  permissionStatus: AccessDatasetReadiness['permissionStatus'] = 'CONFIRMED',
): AccessDatasetReadiness {
  return {
    key,
    label: key.replaceAll('_', ' '),
    tier,
    state,
    permissionStatus,
    permissions: [{ resource: 'MICROSOFT_GRAPH', name: `${key}.Read.All`, type: 'APPLICATION', consentMode: tier === 'CORE' ? 'DEFAULT' : 'SEPARATE_OPT_IN', grantStatus: permissionStatus === 'CONFIRMED' ? 'CONFIRMED' : permissionStatus === 'MISSING' ? 'MISSING' : 'UNVERIFIED' }],
    permissionMatch: 'ALL',
    evidenceMode: 'RESOURCE_STATE',
    licensePrerequisite: { kind: 'NONE', state: 'NOT_REQUIRED' },
    fallbackDatasetKey: tier === 'FALLBACK' ? 'core_inventory' : null,
    failureScope: tier === 'CORE' ? 'WORKLOAD' : 'DATASET_ONLY',
    resourceTypes: ['USERS'],
    endpointPatterns: ['/v1.0/users'],
    documentationUrl: 'https://learn.microsoft.com/graph/api/user-list',
    lastAttemptAt: '2026-08-23T10:00:00.000Z',
    lastSuccessfulAt: state === 'READY' ? '2026-08-23T10:00:00.000Z' : null,
    freshness: state === 'READY' ? 'CURRENT' : 'UNKNOWN',
    reasonCode: state === 'READY' ? null : 'MISSING_PERMISSION',
    reason: state === 'READY' ? null : 'Permission is not granted.',
    remediation: state === 'READY' ? 'No action required.' : 'Review this dataset permission.',
  }
}

function contract(datasets: unknown[]) {
  return normalizeCollectionReadiness({
    version: 1,
    accessContractVersion: 1,
    overallState: 'READY',
    evaluatedAt: '2026-08-23T10:00:00.000Z',
    permissionVerifiedAt: '2026-08-23T09:55:00.000Z',
    workloads: [{
      key: 'entra', workload: 'Entra', state: 'READY', configuredCapability: 'CONFIGURED', permissionStatus: 'CONFIRMED', requiredPermissions: [],
      lastAttemptAt: '2026-08-23T10:00:00.000Z', lastSuccessfulAt: '2026-08-23T10:00:00.000Z', freshness: 'CURRENT',
      reasonCode: null, reason: null, remediation: 'No action required.', datasets, components: [],
    }],
  })
}

function catalog(datasets: AccessDatasetReadiness[]) {
  const permissions = datasets.flatMap((entry) => entry.permissions).filter((permission, index, all) => all.findIndex((candidate) => candidate.resource === permission.resource && candidate.name === permission.name && candidate.consentMode === permission.consentMode) === index)
  return normalizeMicrosoftAccessCatalog({
    version: 1,
    requestedPermissions: permissions.map((permission) => ({ ...permission, description: `Read for ${permission.name}.`, connectionRequired: permission.name === 'core_inventory.Read.All', tier: permission.name === 'core_inventory.Read.All' ? 'CORE' : 'CAPABILITY_OPTIONAL', purpose: ['Test dataset'] })),
    connectionRequiredPermissions: permissions.filter((permission) => permission.name === 'core_inventory.Read.All').map((permission) => permission.name),
    capabilities: datasets.map((entry) => ({
      key: entry.key,
      workloadKey: 'entra',
      label: `Canonical ${entry.label}`,
      tier: entry.tier,
      applicationPermissions: entry.permissions.map(({ resource, name }) => ({ resource, name })),
      permissionMatch: entry.permissionMatch,
      evidenceMode: entry.evidenceMode,
      licensePrerequisite: entry.licensePrerequisite.kind,
      fallbackCapabilityKey: entry.fallbackDatasetKey,
      failureScope: entry.failureScope,
      resourceTypes: entry.resourceTypes,
      endpointPatterns: entry.endpointPatterns,
      documentationUrl: entry.documentationUrl,
    })),
  })
}

test('keeps optional and fallback permission failures scoped to their datasets', () => {
  const readiness = contract([
    dataset('core_inventory', 'CORE'),
    dataset('optional_enrichment', 'CAPABILITY_OPTIONAL', 'BLOCKED_PERMISSION', 'MISSING'),
    dataset('fallback_path', 'FALLBACK', 'UNVERIFIED', 'UNVERIFIED'),
  ])
  assert.equal(readiness?.overallState, 'READY')
  const summary = microsoftAccessSummary(readiness, catalog(readiness!.workloads[0].datasets)!)
  assert.equal(summary.missingConnectionRequired, 0)
  assert.equal(summary.missingCore, 0)
  assert.equal(summary.missingOptional, 1)
  assert.equal(summary.unverified, 1)
  assert.equal(datasetStateNeedsTenantAction(readiness!.workloads[0].datasets[1]), false)
})

test('does not guess granted permissions when access contract data is absent', () => {
  const legacy = normalizeCollectionReadiness({
    version: 1,
    workloads: [{ key: 'legacy', workload: 'Legacy', state: 'READY', configuredCapability: 'CONFIGURED', permissionStatus: 'CONFIRMED', requiredPermissions: ['User.Read.All'], lastAttemptAt: null, lastSuccessfulAt: null, freshness: 'CURRENT', remediation: 'No action.' }],
  })
  assert.deepEqual(microsoftAccessSummary(legacy, null), {
    contractAvailable: false, connectionRequired: 0, core: 0, optional: 0, fallback: 0, alternative: 0, granted: 0,
    missingConnectionRequired: 0, missingCore: 0, missingOptional: 0, unverified: 0, permissions: [],
  })
})

test('fails malformed and unknown dataset fields closed and visibly unsupported', () => {
  const readiness = contract([{ ...dataset('bad', 'CORE'), tier: 'FUTURE', permissions: [{ resource: 'EVIL', name: 'Bad', type: 'APPLICATION', consentMode: 'DEFAULT' }] }])
  assert.equal(readiness?.workloads[0].datasets[0].state, 'UNSUPPORTED')
  assert.equal(readiness?.workloads[0].datasets[0].permissionStatus, 'UNVERIFIED')
  assert.equal(microsoftAccessSummary(readiness, catalog(readiness!.workloads[0].datasets)).permissions.length, 0)
})

test('retains normalized permission evidence when only catalog enrichment is unavailable', () => {
  const readiness = contract([dataset('core_inventory', 'CORE')])
  const summary = microsoftAccessSummary(readiness, null)
  assert.equal(summary.contractAvailable, true)
  assert.equal(summary.permissions[0]?.name, 'core_inventory.Read.All')
  assert.equal(summary.permissions[0]?.status, 'Granted')
  assert.equal(summary.permissions[0]?.requirement, 'Core dataset')
})

test('accepts the canonical P2 license boundary without invalidating the access catalog', () => {
  const p2 = {
    ...dataset('identity_risk', 'CAPABILITY_OPTIONAL'),
    licensePrerequisite: { kind: 'ENTRA_ID_P2' as const, state: 'SATISFIED' as const },
  }
  const readiness = contract([p2])
  const accessCatalog = catalog(readiness!.workloads[0].datasets)
  assert.ok(accessCatalog)
  assert.equal(accessCatalog?.capabilities[0]?.licensePrerequisite, 'ENTRA_ID_P2')
  assert.equal(microsoftAccessSummary(readiness, accessCatalog).contractAvailable, true)
})

test('fails a contradictory aggregate permission claim closed', () => {
  const contradictory = {
    ...dataset('directory', 'CORE', 'READY', 'CONFIRMED'),
    permissions: [{ resource: 'MICROSOFT_GRAPH', name: 'directory.Read.All', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'MISSING' }],
  }
  const readiness = contract([contradictory])
  assert.equal(readiness?.workloads[0].state, 'UNSUPPORTED')
  assert.equal(readiness?.workloads[0].permissionStatus, 'UNVERIFIED')
  assert.equal(readiness?.workloads[0].datasets[0].reasonCode, 'MALFORMED_ACCESS_DATASET')
})

test('deduplicates permissions and keeps the strongest requirement and worst verification state', () => {
  const shared = dataset('optional', 'CAPABILITY_OPTIONAL', 'BLOCKED_PERMISSION', 'MISSING')
  const core = { ...dataset('core', 'CORE', 'BLOCKED_PERMISSION', 'MISSING'), permissions: shared.permissions }
  const readiness = contract([shared, core])
  const summary = microsoftAccessSummary(readiness, catalog(readiness!.workloads[0].datasets))
  assert.equal(summary.permissions.length, 1)
  assert.equal(summary.permissions[0].requirement, 'Core dataset')
  assert.equal(summary.permissions[0].status, 'Missing')
  assert.equal(summary.missingConnectionRequired, 0)
  assert.equal(summary.missingCore, 1)
})

test('strictly normalizes canonical consent purpose and requirement fields', () => {
  const review = normalizeMicrosoftConsentReview({
    consentUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=safe',
    requiredPermissions: [{
      name: 'Organization.Read.All', description: 'Read organization identity.', resource: 'MICROSOFT_GRAPH', type: 'APPLICATION', consentMode: 'DEFAULT', tier: 'CORE', purpose: ['Organization identity'], ignored: 'drop me',
      connectionRequired: true,
    }],
  })
  assert.equal(review?.requiredPermissions[0].tier, 'CORE')
  assert.deepEqual(Object.keys(review!.requiredPermissions[0]).sort(), ['connectionRequired', 'consentMode', 'description', 'name', 'purpose', 'resource', 'tier', 'type'])
  assert.equal(normalizeMicrosoftConsentReview({ consentUrl: 'https://evil.example/', requiredPermissions: [] }), null)
  assert.equal(normalizeMicrosoftConsentReview({
    consentUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent',
    requiredPermissions: [{ name: 'Unsafe', description: 'x', resource: 'UNKNOWN', type: 'APPLICATION', consentMode: 'DEFAULT', tier: 'CORE', connectionRequired: false, purpose: [] }],
  }), null)
})

test('uses only a strict backend connection verification timestamp for permission evidence', () => {
  const now = new Date('2026-08-23T12:00:00.000Z')
  assert.equal(contract([dataset('core_inventory', 'CORE')])?.permissionVerifiedAt, '2026-08-23T09:55:00.000Z')
  assert.equal(normalizeMicrosoftVerificationTimestamp('2026-08-23T11:55:00.000Z', now), '2026-08-23T11:55:00.000Z')
  assert.equal(normalizeMicrosoftVerificationTimestamp('2026-08-23T13:00:00.000Z', now), null)
  assert.equal(normalizeMicrosoftVerificationTimestamp('Aug 23, 2026', now), null)
  assert.equal(normalizeMicrosoftVerificationTimestamp('2026-08-23T11:55:00.000Z\u0000', now), null)
  assert.equal(normalizeMicrosoftVerificationTimestamp(null, now), null)
})

test('joins static dataset presentation by exact canonical capability key', () => {
  const raw = dataset('core_inventory', 'CORE')
  const accessCatalog = catalog([raw])
  const view = microsoftAccessDatasetView(raw, accessCatalog)
  assert.equal(view?.label, 'Canonical core inventory')
  assert.equal(view?.tier, 'CORE')
  assert.equal(microsoftAccessDatasetView({ ...raw, key: 'missing_join' }, accessCatalog), null)
  assert.equal(microsoftAccessDatasetView(raw, null), null)
  const readinessWithUnknownKey = contract([{ ...raw, key: 'missing_join' }])
  assert.equal(microsoftAccessSummary(readinessWithUnknownKey, accessCatalog).contractAvailable, false)
})

test('uses exact per-permission grant truth for composite ANY alternatives', () => {
  const base = dataset('authentication_coverage', 'CORE', 'READY', 'CONFIRMED')
  const primaryPresent: AccessDatasetReadiness = {
    ...base,
    permissionMatch: 'ANY',
    evidenceMode: 'COMPOSITE_RESOURCE_STATE',
    permissions: [
      { resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'CONFIRMED' },
      { resource: 'MICROSOFT_GRAPH', name: 'UserAuthenticationMethod.Read.All', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'MISSING' },
    ],
  }
  const first = microsoftAccessSummary(contract([primaryPresent]), catalog([primaryPresent]))
  assert.deepEqual(first.permissions.map((permission) => [permission.name, permission.status, permission.requirement]), [
    ['AuditLog.Read.All', 'Granted', 'Alternative source'],
    ['UserAuthenticationMethod.Read.All', 'Missing', 'Alternative source'],
  ])
  assert.equal(first.missingCore, 0)
  assert.equal(first.missingOptional, 1)

  const fallbackPresent: AccessDatasetReadiness = {
    ...primaryPresent,
    permissions: [
      { ...primaryPresent.permissions[0], grantStatus: 'MISSING' },
      { ...primaryPresent.permissions[1], grantStatus: 'CONFIRMED' },
    ],
  }
  const second = microsoftAccessSummary(contract([fallbackPresent]), catalog([fallbackPresent]))
  assert.deepEqual(second.permissions.map((permission) => [permission.name, permission.status]), [
    ['AuditLog.Read.All', 'Missing'],
    ['UserAuthenticationMethod.Read.All', 'Granted'],
  ])
  assert.equal(second.missingCore, 0)
})

test('does not hide one missing permission in an ALL dataset behind aggregate state', () => {
  const allDataset: AccessDatasetReadiness = {
    ...dataset('directory_audit', 'CORE', 'BLOCKED_PERMISSION', 'MISSING'),
    permissions: [
      { resource: 'MICROSOFT_GRAPH', name: 'AuditLog.Read.All', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'CONFIRMED' },
      { resource: 'MICROSOFT_GRAPH', name: 'Directory.Read.All', type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus: 'MISSING' },
    ],
  }
  const summary = microsoftAccessSummary(contract([allDataset]), catalog([allDataset]))
  assert.equal(summary.permissions.find((permission) => permission.name === 'AuditLog.Read.All')?.status, 'Granted')
  assert.equal(summary.permissions.find((permission) => permission.name === 'Directory.Read.All')?.status, 'Missing')
  assert.equal(summary.missingCore, 1)
})
