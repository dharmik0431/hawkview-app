import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { TenantSyncService } from './tenant-sync.service.js'
const NOW = new Date('2026-10-12T12:00:00Z')
const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const GROUP = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const SP = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
const APP = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
const ROLE = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'
const DEFINITION = 'ffffffff-ffff-4fff-ffff-ffffffffffff'
const UNKNOWN = '00000000-0000-4000-8000-000000000099'

type SyncOverride = Record<string, { status?: string; lastSuccessfulAt?: Date | null } | null>
async function bundle(tenantId: string, name: string, conflicts = false, omitOptionalEvidence = false, syncOverride: SyncOverride = {}) {
  const org = `org-${tenantId}`
  const tenant = { id: tenantId, organizationId: org, microsoftTenantId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Synthetic tenant', primaryDomain: 'example.invalid', status: 'CONNECTED',
    connection: { lastVerifiedAt: NOW, consentedAt: NOW, onboardingCompletedAt: NOW, exchangeReadOnlyEnabledAt: null } }
  const user = { id: 'local-user', microsoftUserId: USER, displayName: name, userPrincipalName: 'alice@example.invalid',
    userType: 'Member', accountEnabled: true, assignedLicenseSkuIds: [], groupMemberships: [] }
  const group = { id: 'local-group', microsoftGroupId: GROUP, displayName: 'Operations',
    groupTypes: [], mailEnabled: false, securityEnabled: true, memberships: [] }
  const assigned = [
    { principalType: 'User', principalId: USER.toUpperCase(), principalDisplayName: ' ' },
    { principalType: 'Group', principalId: GROUP, principalDisplayName: GROUP },
    { principalType: 'ServicePrincipal', principalId: SP },
    { principalType: 'User', principalId: UNKNOWN },
    { principalType: 'User', principalId: GROUP }, // wrong kind must not borrow the group name
    { principalType: 'User', principalId: USER, principalDisplayName: 'Observed assignment name' },
  ]
  const policy = (id: string, users: Record<string, string[]>) => ({ id, displayName: id, state: 'enabled',
    conditions: { users, applications: { includeApplications: ['All', APP, SP, UNKNOWN] } },
    grantControls: { builtInControls: ['mfa'] } })
  const payloads = {
    SERVICE_PRINCIPALS: [{ id: SP, appId: APP, displayName: 'Service application',
      ...(omitOptionalEvidence ? {} : { appRoleAssignedTo: assigned }) }],
    APPLICATIONS: [{ id: 'registration', ...(omitOptionalEvidence ? {} : { owners: [{ id: USER }, { id: SP }, { id: UNKNOWN },
      { id: USER, displayName: 'Observed owner name' }] }) }],
    DIRECTORY_ROLES: [{ principalId: USER, roleDefinition: { id: DEFINITION, templateId: ROLE, displayName: 'Global Reader' } }],
    CONDITIONAL_ACCESS: [policy('selected', { includeUsers: [USER.toUpperCase(), UNKNOWN], includeGroups: [GROUP],
      includeRoles: [ROLE, DEFINITION], excludeUsers: ['GuestsOrExternalUsers'], excludeGroups: [GROUP], excludeRoles: [ROLE] }),
      policy('all', { includeUsers: ['All'] }), policy('none', { includeUsers: ['None'] })],
    AUTH_METHOD_POLICIES: [], AUTH_REGISTRATIONS: [], NAMED_LOCATIONS: [],
  }
  let identityReads = 0, tenantReads = 0, scopedReads = 0
  const scoped = (args: any) => {
    assert.equal(args.where.organizationId, org)
    assert.equal(args.where.customerTenantId, tenantId)
    scopedReads++
  }
  const many = (rows: any[]) => ({ findMany: async (args: any) => { scoped(args); return rows } })
  const prisma: any = {
    user: { findUnique: async () => { identityReads++; return { disabledAt: null, memberships: [{ organizationId: org }] } } },
    customerTenant: { findFirst: async (args: any) => {
      assert.equal(args.where.id, tenantId); assert.deepEqual(args.where.organizationId, { in: [org] }); tenantReads++; return tenant
    } },
    directoryUser: many(conflicts ? [user, { ...user, displayName: 'Conflicting name' }] : [user]),
    directoryGroup: many([group]), tenantLicense: many([]), tenantDomain: many([]), tenantCollectionFieldState: many([]),
    signInLog: many([]), directoryAuditLog: many([]), m365ActivitySubscription: many([]),
    tenantEntraSnapshot: many(Object.entries(payloads).map(([resourceType, payload]) => ({ resourceType, payload, observedAt: NOW }))),
    syncState: many(Object.keys(payloads).filter(resourceType => syncOverride[resourceType] !== null).map(resourceType => ({
      resourceType, status: syncOverride[resourceType]?.status ?? 'SUCCEEDED', lastAttemptAt: NOW,
      lastSuccessfulAt: syncOverride[resourceType]?.lastSuccessfulAt === undefined ? NOW : syncOverride[resourceType]?.lastSuccessfulAt,
      lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    }))),
    m365ActivityContent: { groupBy: async (args: any) => { scoped(args); return [] }, findFirst: async (args: any) => { scoped(args); return null } },
    m365AuditDailyUsage: { findFirst: async (args: any) => { scoped(args); return null }, aggregate: async (args: any) => {
      scoped(args); return { _sum: { downloadedBytes: null, recordsStored: null, blobsProcessed: null } }
    } },
  }
  const service = new TenantSyncService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never)
  const result = await service.getBundleForIdentity({ subject: 'synthetic-identity' } as never, tenantId)
  assert.equal(identityReads, 1); assert.equal(tenantReads, 1); assert.equal(scopedReads, 14, 'no added reads')
  return result.bundle
}

test('real authorized bundle resolves labels while preserving CA IDs, kinds, and app namespaces', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden') })
  const result = await bundle('tenant-A', 'Alice')
  const [selected, all, none] = result.entra.caPolicies
  assert.deepEqual(selected.assignments.usersAndGroups.include, [USER.toUpperCase(), UNKNOWN, GROUP, ROLE, DEFINITION])
  assert.deepEqual(selected.assignments.usersAndGroups.includeTargets, [
    { id: USER.toUpperCase(), kind: 'User', name: 'Alice' }, { id: UNKNOWN, kind: 'User', name: null },
    { id: GROUP, kind: 'Group', name: 'Operations' }, { id: ROLE, kind: 'Role', name: 'Global Reader' },
    { id: DEFINITION, kind: 'Role', name: null },
  ])
  assert.deepEqual(selected.assignments.usersAndGroups.excludeTargets.map(x => x.name), ['Guests or external users', 'Operations', 'Global Reader'])
  assert.deepEqual(selected.assignments.cloudApps.include, ['All cloud apps', 'Service application', SP, UNKNOWN])
  assert.equal(all.assignments.usersAndGroups.includeTargets[0].name, 'All users')
  assert.equal(all.targetSummary, 'All users'); assert.equal(none.targetSummary, 'No users')
  const app = result.entra.enterpriseApplications[0]
  assert.deepEqual(app.assignedUsers, ['Alice', UNKNOWN, GROUP, 'Observed assignment name'])
  assert.deepEqual(app.assignedGroups, ['Operations'])
  assert.deepEqual(app.assignedServicePrincipals, ['Service application'])
  assert.equal(app.publisher, 'Not reported')
  assert.equal(app.verifiedPublisher, null)
  assert.equal(app.delegatedGrants, null)
  assert.equal(app.applicationPermissions, null)
  assert.equal(result.entra.appRegistrations[0].credentials, null)
  assert.equal(result.entra.appRegistrations[0].apiPermissions, null)
  assert.equal(result.entra.groups[0].owners, null)
  assert.equal(result.entra.groups[0].onPremisesSyncEnabled, null)
  assert.deepEqual(result.entra.appRegistrations[0].owners, ['Alice', 'Service application', UNKNOWN, 'Observed owner name'])

  // Exercise the real frontend resolver using the actual service-produced bundle, not an invented bundle shape.
  const require = createRequire(new URL('../../../package.json', import.meta.url)), ts = require('typescript')
  const source = readFileSync(new URL('../../../lib/tenants/stored-principal-name.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: any = {}; new Function('exports', output)(exports)
  const names = exports.storedPrincipalNames(result, 'tenant-A')
  assert.equal(exports.storedPrincipalName(names, USER), 'Alice')
  assert.equal(exports.storedPrincipalName(names, GROUP), 'Operations')
  assert.equal(exports.storedPrincipalName(names, SP), 'Service application')
  assert.equal(exports.storedPrincipalName(names, APP), null)
  assert.equal(exports.storedPrincipalNames(result, 'tenant-B').size, 0)
})

test('real bundle keeps omitted principal and application evidence unreported', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden') })
  const result = await bundle('tenant-A', 'Alice', false, true)
  const app = result.entra.enterpriseApplications[0]
  assert.equal(app.assignedUsers, null)
  assert.equal(app.assignedGroups, null)
  assert.equal(app.assignedServicePrincipals, null)
  assert.equal(app.delegatedGrants, null)
  assert.equal(app.applicationPermissions, null)
  assert.equal(result.entra.appRegistrations[0].owners, null)
  assert.equal(result.entra.appRegistrations[0].credentials, null)
  assert.equal(result.entra.appRegistrations[0].apiPermissions, null)
})

test('bundle projects empty, absent, and latest-failed Entra collection evidence independently of array size', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden') })
  const reported = await bundle('tenant-A', 'Alice')
  for (const key of ['authMethodPolicies', 'authRegistrations', 'namedLocations'] as const) {
    assert.equal(reported.sync[key].lastSuccessfulAt, NOW.toISOString())
    assert.equal(reported.sync[key].outcomeProjection.recordedOutcome.kind, 'SUCCEEDED')
  }
  assert.deepEqual(reported.entra.authMethods, [])
  assert.deepEqual(reported.entra.namedLocations, [])

  const absent = await bundle('tenant-A', 'Alice', false, false, {
    AUTH_METHOD_POLICIES: null, AUTH_REGISTRATIONS: null, NAMED_LOCATIONS: null,
  })
  for (const key of ['authMethodPolicies', 'authRegistrations', 'namedLocations'] as const) {
    assert.equal(absent.sync[key].lastSuccessfulAt, null)
    assert.equal(absent.sync[key].outcomeProjection.recordedOutcome.kind, 'UNKNOWN')
  }
  assert.deepEqual(absent.entra.authMethods, [])
  assert.deepEqual(absent.entra.namedLocations, [])

  const failed = await bundle('tenant-A', 'Alice', false, false, {
    AUTH_METHOD_POLICIES: { status: 'FAILED', lastSuccessfulAt: new Date('2026-10-11T12:00:00Z') },
    AUTH_REGISTRATIONS: { status: 'FAILED', lastSuccessfulAt: new Date('2026-10-11T12:00:00Z') },
    NAMED_LOCATIONS: { status: 'FAILED', lastSuccessfulAt: new Date('2026-10-11T12:00:00Z') },
  })
  for (const key of ['authMethodPolicies', 'authRegistrations', 'namedLocations'] as const) {
    assert.equal(failed.sync[key].lastSuccessfulAt, '2026-10-11T12:00:00.000Z')
    assert.equal(failed.sync[key].outcomeProjection.recordedOutcome.kind, 'FAILED')
  }
})

test('separate tenant invocations never share names; conflicting stored identities remain unresolved', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden') })
  for (const [tenant, name] of [['tenant-A', 'Alice'], ['tenant-B', 'Bob']]) {
    const result = await bundle(tenant, name)
    assert.equal(result.entra.caPolicies[0].assignments.usersAndGroups.includeTargets[0].name, name)
  }
  const conflict = await bundle('tenant-A', 'Alice', true)
  assert.equal(conflict.entra.caPolicies[0].assignments.usersAndGroups.includeTargets[0].name, null)
  assert.equal(conflict.entra.enterpriseApplications[0].assignedUsers[0], USER.toUpperCase())
})

test('name indexes keep object IDs, login identities, app IDs and role templates separate', async () => {
  const { storedObjectLabels } = await import('./stored-object-labels.js')
  const labels = storedObjectLabels({
    users: [{ microsoftUserId: USER, displayName: USER, userPrincipalName: 'alice@example.invalid' }],
    groups: [{ microsoftGroupId: GROUP, displayName: '  ' }],
    servicePrincipals: [
      { id: SP, appId: APP, displayName: 'First app' },
      { id: 'other-object', appId: APP.toUpperCase(), displayName: 'Conflicting app' },
    ], roleAssignments: [],
  })
  assert.equal(labels.principalTarget('User', USER).name, 'alice@example.invalid')
  assert.equal(labels.principalTarget('User', 'alice@example.invalid').name, null)
  assert.equal(labels.userIdentityName('ALICE@example.invalid'), 'alice@example.invalid')
  assert.equal(labels.principalTarget('Group', GROUP).name, null)
  assert.equal(labels.principalTarget('User', APP).name, null)
  assert.equal(labels.principalTarget('ServicePrincipal', SP).name, 'First app')
  assert.equal(labels.applicationTarget(APP), APP, 'conflicting app IDs do not select an arbitrary label')
  assert.equal(labels.applicationTarget('__proto__'), '__proto__')
  assert.equal(labels.principalTarget('User', '__proto__').name, null)
  assert.equal(labels.assignmentName('User', UNKNOWN, '  Observed  '), 'Observed')
})
