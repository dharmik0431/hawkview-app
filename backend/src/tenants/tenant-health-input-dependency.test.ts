import 'reflect-metadata'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Logger } from '@nestjs/common'
import { SyncResourceType } from '../generated/prisma/enums.js'
import { CONNECTION_REQUIRED_PERMISSIONS } from '../microsoft/microsoft-access-contract.js'
import { deriveCollectionReadiness } from './collection-readiness.js'
import { deriveTenantHealth, TENANT_HEALTH_RESOURCE_REGISTRY } from './tenant-health.js'
import type { TenantSyncFreshness } from './service-sync-freshness.js'
import { TenantsService } from './tenants.service.js'

// Pin the current persisted projection, not the entire neighboring tenant API
// response. These synthetic mapper/writer witnesses do not prove DB coherence.
const now = new Date('2026-11-16T01:40:00.000Z')
const collected = new Date('2026-11-16T01:35:00.000Z')
function fixture() {
  return {
    id: 'tenant-a', microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Tenant A', primaryDomain: null, status: 'ACTIVE',
    organization: { id: 'org-a', name: 'Org A', slug: 'org-a' },
    connection: { connectionMode: 'HAWKVIEW_MANAGED', status: 'ACTIVE',
      consentedPermissions: [...CONNECTION_REQUIRED_PERMISSIONS, 'Reports.Read.All',
        'IdentityRiskyUser.Read.All', 'Policy.Read.All', 'Sites.Read.All',
        'SharePointTenantSettings.Read.All'], lastVerifiedAt: collected, lastErrorCode: null },
    tenantLicenses: [{ enabledUnits: 1, servicePlans: [
      { servicePlanName: 'SHAREPOINTENTERPRISE', provisioningStatus: 'Success' },
      { servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success' },
    ] }],
    syncStates: [...new Set([...TENANT_HEALTH_RESOURCE_REGISTRY.map(row => row.resourceType),
      'RISKY_USERS', 'AUTHENTICATION_STRENGTHS', 'NAMED_LOCATIONS', 'SECURITY_DEFAULTS'])].map(resourceType => ({
      resourceType, status: 'SUCCEEDED', lastAttemptAt: collected, lastSuccessfulAt: collected,
      lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    })),
    entraSnapshots: [
      { resourceType: SyncResourceType.AUTH_REGISTRATIONS, payload: [{ isMfaRegistered: true }], observedAt: collected },
      { resourceType: SyncResourceType.RISKY_USERS, payload: [], observedAt: collected },
      { resourceType: SyncResourceType.CONDITIONAL_ACCESS, payload: [], observedAt: collected },
      { resourceType: SyncResourceType.SECURITY_DEFAULTS, payload: [{ isEnabled: false }], observedAt: collected },
      { resourceType: SyncResourceType.SECURE_SCORES, payload: [{ currentScore: 10, maxScore: 100, createdDateTime: collected.toISOString() }], observedAt: collected },
    ] as Array<{ resourceType: SyncResourceType; payload: unknown; observedAt: Date }>,
    collectionFieldStates: [
      { fieldKey: 'sharepoint.usage-projection', state: 'AVAILABLE', reasonCode: null },
      { fieldKey: 'onedrive.usage-projection', state: 'AVAILABLE', reasonCode: null },
    ] as Array<{ fieldKey: string; state: string; reasonCode: string | null }>,
    m365ActivitySubscriptions: [],
  }
}
type Mapped = {
  tenantHealth: ReturnType<typeof deriveTenantHealth>; syncFreshness: TenantSyncFreshness;
  collectionReadiness: ReturnType<typeof deriveCollectionReadiness>; secureScore: number | null;
}
type HistoryWrite = { organizationId: string; customerTenantId: string; payload: unknown }
function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now })
  t.mock.method(Logger.prototype, 'debug', () => {})
  const writes: HistoryWrite[] = []
  const service = new TenantsService({ tenantHealthSnapshot: {
    findFirst: async () => null,
    create: async ({ data }: { data: HistoryWrite }) => { writes.push(structuredClone(data)); return data },
  } } as never, {
    getRequiredPermissions: () => CONNECTION_REQUIRED_PERMISSIONS.map(name => ({ name })),
    getAccessContract: () => ({ connectionRequiredPermissions: CONNECTION_REQUIRED_PERMISSIONS }),
  } as never, {} as never) as unknown as {
    mapTenant(tenant: ReturnType<typeof fixture>): Mapped;
    persistTenantHealthSnapshot(tenant: ReturnType<typeof fixture>, health: Mapped['tenantHealth'], freshness: TenantSyncFreshness): Promise<void>;
  }
  return async (tenant: ReturnType<typeof fixture>) => {
    const mapped = service.mapTenant(tenant)
    const before = writes.length
    await service.persistTenantHealthSnapshot(tenant, mapped.tenantHealth, mapped.syncFreshness)
    assert.equal(writes.length, before + 1, 'The actual history writer must reach its synthetic sink')
    const saved = writes.at(-1)!
    assert.equal(saved.organizationId, tenant.organization.id)
    assert.equal(saved.customerTenantId, tenant.id)
    assert.deepEqual(saved.payload, { ...mapped.tenantHealth, syncFreshness: mapped.syncFreshness })
    return { mapped, payload: saved.payload }
  }
}
function usage(mapped: Mapped, key: string) {
  const dataset = mapped.collectionReadiness.workloads.find(row => row.key === 'sharepoint_onedrive')
    ?.datasets?.find(row => row.key === key)
  assert.ok(dataset, `Missing ${key} witness`)
  return dataset.state
}

test('HAW-70 usage projection fields change readiness but not the current saved health projection', async t => {
  const record = harness(t), original = fixture(), baseline = await record(original)
  for (const [fieldKey, datasetKey] of [
    ['sharepoint.usage-projection', 'sharepoint_usage_reports'],
    ['onedrive.usage-projection', 'onedrive_usage_reports'],
  ]) {
    assert.equal(usage(baseline.mapped, datasetKey), 'READY', 'The fixture must exercise an available dataset')
    for (const change of ['missing', 'legacy', 'partial', 'rejected'] as const) {
      const tenant = structuredClone(original)
      if (change === 'missing') tenant.collectionFieldStates = tenant.collectionFieldStates.filter(row => row.fieldKey !== fieldKey)
      else Object.assign(tenant.collectionFieldStates.find(row => row.fieldKey === fieldKey)!, {
        state: change === 'rejected' ? 'FAILED' : 'PENDING',
        reasonCode: change === 'legacy' ? 'USAGE_PROJECTION_NOT_DURABLY_VERIFIED'
          : change === 'partial' ? 'USAGE_PROJECTION_EVIDENCE_INCOMPLETE' : 'SYNTHETIC_REJECTION',
      })
      const result = await record(tenant)
      assert.equal(usage(result.mapped, datasetKey), change === 'missing' || change === 'legacy' ? 'UNVERIFIED' : 'PARTIAL')
      assert.deepEqual(result.mapped.tenantHealth, baseline.mapped.tenantHealth, `${fieldKey}: ${change}`)
      assert.deepEqual(result.payload, baseline.payload, `${fieldKey}: ${change} must not be mistaken for a saved dependency`)
    }
  }
})

test('HAW-70 MFA and Microsoft risk snapshot changes reach the actual saved health projection', async t => {
  const record = harness(t), original = fixture(), baseline = await record(original)
  assert.equal(baseline.mapped.tenantHealth.mfaCoverage, 100)
  assert.equal(baseline.mapped.tenantHealth.microsoftRiskSummary?.availability, 'AVAILABLE')
  assert.equal(baseline.mapped.tenantHealth.riskyIdentityCount, 0)
  for (const resource of [SyncResourceType.AUTH_REGISTRATIONS, SyncResourceType.RISKY_USERS]) {
    const changed = structuredClone(original)
    changed.entraSnapshots.find(row => row.resourceType === resource)!.payload = resource === SyncResourceType.AUTH_REGISTRATIONS
      ? [{ isMfaRegistered: false }] : [{ id: 'synthetic-risk', riskState: 'atRisk', riskLevel: 'high' }]
    const result = await record(changed)
    if (resource === SyncResourceType.AUTH_REGISTRATIONS) assert.equal(result.mapped.tenantHealth.mfaCoverage, 0)
    else assert.equal(result.mapped.tenantHealth.riskyIdentityCount, 1)
    assert.notDeepEqual(result.payload, baseline.payload, `${resource}: payload mutation is health-relevant`)
    const absent = structuredClone(original)
    absent.entraSnapshots = absent.entraSnapshots.filter(row => row.resourceType !== resource)
    const removed = await record(absent)
    if (resource === SyncResourceType.AUTH_REGISTRATIONS) assert.equal(removed.mapped.tenantHealth.mfaCoverage, null)
    else assert.equal(removed.mapped.tenantHealth.microsoftRiskSummary?.availability, 'UNAVAILABLE')
    assert.notDeepEqual(removed.payload, baseline.payload, `${resource}: deletion is health-relevant`)
    const timestampOnly = structuredClone(original)
    const observedAt = new Date(resource === SyncResourceType.AUTH_REGISTRATIONS
      ? '2026-11-16T01:36:00.000Z' : '2026-11-16T01:34:00.000Z')
    timestampOnly.entraSnapshots.find(row => row.resourceType === resource)!.observedAt = observedAt
    const retimed = await record(timestampOnly)
    if (resource === SyncResourceType.AUTH_REGISTRATIONS) {
      assert.equal(retimed.mapped.tenantHealth.mfaCoverage, 100)
      assert.equal(retimed.mapped.tenantHealth.security.lastEvaluatedAt, observedAt.toISOString())
    } else {
      assert.equal(retimed.mapped.tenantHealth.microsoftRiskSummary?.availability, 'AVAILABLE')
      assert.equal(retimed.mapped.tenantHealth.riskyIdentityCount, 0)
      assert.equal(retimed.mapped.tenantHealth.microsoftRiskSummary?.snapshotObservedAt, observedAt.toISOString())
    }
    assert.notDeepEqual(retimed.payload, baseline.payload, `${resource}: observation-time-only change is health-relevant`)
  }
})

test('HAW-70 score and policy snapshot payloads change neighboring evidence, not saved health', async t => {
  const record = harness(t), original = fixture(), baseline = await record(original)
  const cases = [
    { resource: SyncResourceType.SECURE_SCORES, payload: [{ currentScore: 90, maxScore: 100, createdDateTime: collected.toISOString() }] },
    { resource: SyncResourceType.CONDITIONAL_ACCESS, payload: [{ id: 'synthetic-policy' }] },
    { resource: SyncResourceType.SECURITY_DEFAULTS, payload: [{ isEnabled: true }] },
  ]
  for (const { resource, payload } of cases) {
    const changed = structuredClone(original)
    changed.entraSnapshots.find(row => row.resourceType === resource)!.payload = payload
    const result = await record(changed)
    if (resource === SyncResourceType.SECURE_SCORES) {
      assert.equal(baseline.mapped.secureScore, 10)
      assert.equal(result.mapped.secureScore, 90)
    } else if (resource === SyncResourceType.CONDITIONAL_ACCESS) {
      assert.equal(baseline.mapped.collectionReadiness.evidence.conditionalAccess.count, 0)
      assert.equal(result.mapped.collectionReadiness.evidence.conditionalAccess.count, 1)
    } else {
      assert.equal(baseline.mapped.collectionReadiness.evidence.securityDefaults.enabled, false)
      assert.equal(result.mapped.collectionReadiness.evidence.securityDefaults.enabled, true)
    }
    assert.deepEqual(result.payload, baseline.payload, `${resource}: current saved projection stays unchanged`)
  }
})
