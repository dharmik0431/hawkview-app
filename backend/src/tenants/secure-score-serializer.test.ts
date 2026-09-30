import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantsService } from './tenants.service.js'
// Load the frontend contract only at runtime; it is outside backend rootDir.
const contractPath = '../../../types/api.ts'
const { TenantSchema, MicrosoftSecureScoreDetailsSchema } = await import(contractPath)

const scoreDate = '2026-08-01T00:00:00.000Z'
const saved = new Date('2026-08-10T00:00:00Z')
const completed = new Date('2026-08-10T00:00:01Z')
const other = new Date('2026-09-01T00:00:00Z')
const state = (resourceType: string, status: string, lastSuccessfulAt: Date | null) => ({ resourceType, status, lastSuccessfulAt, lastAttemptAt: other, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 })
const service = new TenantsService({} as never, {
  getRequiredPermissions: () => [], getAccessContract: () => ({ connectionRequiredPermissions: [] }),
} as never, {} as never)
const fixture = () => ({
  id: 'tenant-a', microsoftTenantId: '11111111-1111-4111-8111-111111111111', displayName: 'Tenant A', primaryDomain: null,
  status: 'ACTIVE', organization: { id: 'org-a', name: 'Org A', slug: 'org-a' }, connection: null,
  tenantLicenses: [], syncStates: [state('USERS', 'SUCCEEDED', other), state('SECURE_SCORES', 'FAILED', completed)],
  entraSnapshots: [{ resourceType: 'SECURE_SCORES', observedAt: saved, payload: [{ currentScore: 0, maxScore: 100, createdDateTime: scoreDate }] }],
  m365ActivitySubscriptions: [],
})
function map(tenant: ReturnType<typeof fixture>) { return (service as any).mapTenant(tenant) }

test('actual tenant serializer scopes score clocks and preserves retained zero on failed/new attempt', () => {
  const mapped = map(fixture())
  const parsed = TenantSchema.parse(mapped)
  assert.equal(parsed.secureScore, 0)
  assert.deepEqual(parsed.secureScoreDetails, { version: 1, percentage: 0, scoreCreatedAt: scoreDate, snapshotObservedAt: saved.toISOString(), lastSuccessfulCollectionAt: completed.toISOString() })
  assert.equal(parsed.lastSync, other.toISOString())
})
test('snapshot save newer than last success is not relabeled as paired completion', () => {
  const tenant = fixture()
  tenant.syncStates = [state('SECURE_SCORES', 'RUNNING', new Date(scoreDate))]
  const mapped = map(tenant)
  assert.equal(mapped.secureScoreDetails.snapshotObservedAt, saved.toISOString())
  assert.equal(mapped.secureScoreDetails.lastSuccessfulCollectionAt, scoreDate)
})
test('no secure score resource never borrows another snapshot or success', () => {
  const tenant = fixture()
  tenant.entraSnapshots = []
  tenant.syncStates = [state('USERS', 'SUCCEEDED', other)]
  const mapped = map(tenant)
  assert.equal(mapped.secureScore, null)
  assert.deepEqual(mapped.secureScoreDetails, { version: 1, percentage: null, scoreCreatedAt: null, snapshotObservedAt: null, lastSuccessfulCollectionAt: null })
})
test('rolling contract accepts old scalar-only response and rejects invalid detail shapes', () => {
  const mapped = map(fixture())
  delete mapped.secureScoreDetails
  assert.equal(TenantSchema.parse(mapped).secureScore, 0)
  const valid = map(fixture()).secureScoreDetails
  for (const invalid of [{ ...valid, version: 2 }, { ...valid, percentage: 101 }, { ...valid, scoreCreatedAt: 'yesterday' }]) {
    assert.equal(MicrosoftSecureScoreDetailsSchema.safeParse(invalid).success, false)
  }
})
