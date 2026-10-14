import test from 'node:test'
import assert from 'node:assert/strict'
import { tenantPermissionStatus } from './tenant-permission-status.ts'
import type { Tenant } from '../../types/api.ts'

const verifiedAt = '2026-10-14T18:00:00.000Z'
const permission = (name: string, grantStatus: 'CONFIRMED' | 'MISSING' | 'UNVERIFIED') => ({
  resource: 'MICROSOFT_GRAPH', name, type: 'APPLICATION', consentMode: 'DEFAULT', grantStatus,
})
const dataset = (options: {
  name: string
  tier?: 'CORE' | 'CAPABILITY_OPTIONAL' | 'FALLBACK'
  grantStatus: 'CONFIRMED' | 'MISSING' | 'UNVERIFIED'
  licenseState?: 'SATISFIED' | 'NOT_LICENSED'
}) => ({
  key: options.name.toLowerCase(), label: options.name, tier: options.tier ?? 'CORE',
  state: options.grantStatus === 'MISSING' ? 'BLOCKED_PERMISSION' : options.grantStatus === 'UNVERIFIED' ? 'UNVERIFIED' : 'READY',
  permissionStatus: options.grantStatus, permissions: [permission(options.name, options.grantStatus)],
  permissionMatch: 'ALL', evidenceMode: 'RESOURCE_STATE',
  licensePrerequisite: { kind: options.licenseState === 'NOT_LICENSED' ? 'ENTRA_ID_P2' : 'NONE', state: options.licenseState ?? 'SATISFIED' },
  fallbackDatasetKey: null as string | null, failureScope: 'DATASET_ONLY', resourceTypes: ['USERS'], endpointPatterns: ['/users'],
  documentationUrl: 'https://learn.microsoft.com/graph/', lastAttemptAt: null, lastSuccessfulAt: null,
  freshness: 'CURRENT', reasonCode: null as string | null, reason: null, remediation: 'Review the grant.',
})
const readiness = (...datasets: ReturnType<typeof dataset>[]) => ({
  accessContractVersion: 1, permissionVerifiedAt: verifiedAt,
  workloads: [{ key: 'directory', workload: 'Directory', state: 'READY', configuredCapability: 'CONFIGURED',
    permissionStatus: 'CONFIRMED', requiredPermissions: [], freshness: 'CURRENT', remediation: 'Review access.',
    datasets, components: [], capabilities: [], exchangeRbac: null }],
})
const tenant = (overrides: Record<string, unknown> = {}) => ({
  status: 'active', connectionStatus: 'connected', connectionErrorCode: null, missingRequiredPermissions: [],
  collectionReadiness: readiness(dataset({ name: 'User.Read.All', grantStatus: 'CONFIRMED' })),
  ...overrides,
}) as Pick<Tenant, 'status' | 'connectionStatus' | 'connectionErrorCode' | 'missingRequiredPermissions' | 'collectionReadiness'>

test('only a verified required grant gap is called missing', () => {
  const result = tenantPermissionStatus(tenant({
    missingRequiredPermissions: ['User.Read.All'],
    collectionReadiness: readiness(dataset({ name: 'User.Read.All', grantStatus: 'MISSING' })),
  }))
  assert.equal(result.label, '1 required permission missing')
  assert.deepEqual(result.missing, ['User.Read.All'])
  assert.match(result.detail, /Last permission verification/)
})

test('optional missing scope is visible without treating licensing or stale collection as a broken required permission', () => {
  const result = tenantPermissionStatus(tenant({
    collectionReadiness: readiness(
      dataset({ name: 'User.Read.All', grantStatus: 'CONFIRMED' }),
      dataset({ name: 'RiskyUser.Read.All', tier: 'CAPABILITY_OPTIONAL', grantStatus: 'MISSING' }),
      dataset({ name: 'Premium.Read.All', grantStatus: 'MISSING', licenseState: 'NOT_LICENSED' }),
    ),
    syncFreshness: { services: { entraId: { status: 'STALE' } } },
  }))
  assert.equal(result.label, '1 optional permission not granted')
  assert.equal(result.tone, 'neutral')
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.optional, ['RiskyUser.Read.All'])
})

test('missing or unverified access evidence never produces a green result', () => {
  assert.equal(tenantPermissionStatus(tenant({ collectionReadiness: undefined })).tone, 'neutral')
  assert.equal(tenantPermissionStatus(tenant({ missingRequiredPermissions: undefined })).tone, 'neutral')
  assert.equal(tenantPermissionStatus(tenant({
    collectionReadiness: readiness(dataset({ name: 'User.Read.All', grantStatus: 'UNVERIFIED' })),
  })).tone, 'neutral')
  assert.equal(tenantPermissionStatus(tenant({ connectionStatus: 'revoked' })).label, 'Permission check unavailable')
})

test('an access-denied dataset is surfaced without inventing a missing grant', () => {
  const blocked = dataset({ name: 'User.Read.All', grantStatus: 'CONFIRMED' })
  const result = tenantPermissionStatus(tenant({
    collectionReadiness: readiness({ ...blocked, state: 'BLOCKED_PERMISSION', reasonCode: 'MICROSOFT_FORBIDDEN' }),
  }))
  assert.equal(result.label, 'Required access blocked')
  assert.deepEqual(result.missing, [])
  assert.match(result.detail, /last grant check did not identify a specific missing permission/)
})

test('a verified missing connection grant remains visible when that gap disconnects the tenant', () => {
  const result = tenantPermissionStatus(tenant({
    status: 'disconnected', connectionStatus: 'error', connectionErrorCode: 'missing-permissions',
    missingRequiredPermissions: ['Organization.Read.All'],
  }))
  assert.equal(result.label, '1 required permission missing')
  assert.deepEqual(result.missing, ['Organization.Read.All'])
})

test('a ready fallback does not turn its unavailable primary source into a required grant failure', () => {
  const primary = { ...dataset({ name: 'Primary.Read.All', grantStatus: 'MISSING' }), key: 'primary', fallbackDatasetKey: 'fallback' }
  const fallback = { ...dataset({ name: 'Fallback.Read.All', tier: 'FALLBACK', grantStatus: 'CONFIRMED' }), key: 'fallback' }
  const result = tenantPermissionStatus(tenant({ collectionReadiness: readiness(primary, fallback) }))
  assert.equal(result.label, 'No required permission gap')
})

test('an optional-only or empty access contract cannot produce a green required-permission claim', () => {
  assert.equal(tenantPermissionStatus(tenant({ collectionReadiness: readiness() })).tone, 'neutral')
  assert.equal(tenantPermissionStatus(tenant({
    collectionReadiness: readiness(dataset({ name: 'Optional.Read.All', tier: 'CAPABILITY_OPTIONAL', grantStatus: 'MISSING' })),
  })).tone, 'neutral')
})
