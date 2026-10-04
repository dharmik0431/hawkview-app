import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService } from './change-evidence.service.js'
import { ChangesService } from './changes.service.js'
import { DIRECTORY_AUDIT_METADATA_KEY as key, readDirectoryAuditMetadata } from './directory-audit-projection-metadata.js'

const identity = { subject: 'owner-a' } as never
const tenant = { id: 'tenant-a', organizationId: 'org-a', displayName: 'Tenant A' }
const time = new Date('2026-10-03T12:00:00Z')
const range = { tenantId: tenant.id, from: '2026-10-03T00:00:00Z', to: '2026-10-04T00:00:00Z' }
const roles = [{ displayName: 'Role.DisplayName', oldValue: null, newValue: 'Global Administrator' }]

function audit(kind = 'role', overrides: Record<string, unknown> = {}): any {
  const invitation = kind === 'invitation'
  return {
    id: 'raw-'+kind, microsoftAuditId: 'event-'+kind,
    organizationId: tenant.organizationId, customerTenantId: tenant.id,
    eventDateTime: time, ingestedAt: time, expiresAt: new Date('2027-01-01T00:00:00Z'),
    activityDisplayName: invitation ? 'Invite external user' : 'Add member to role',
    category: invitation ? 'UserManagement' : 'RoleManagement',
    operationType: invitation ? 'Add' : 'Assign', result: 'success', resultReason: null,
    targetResources: [{ id: 'target-a', type: kind === 'app-role' ? 'ServicePrincipal' : 'User', displayName: 'Target A', modifiedProperties: invitation ? [] : roles.map(value => ({ ...value })) }],
    initiatedBy: { user: { id: 'actor-a', displayName: 'Actor A' } },
    additionalDetails: [], correlationId: null, raw: {}, ...overrides,
  }
}

async function project(record: any): Promise<any> {
  let captured: any
  await new ChangeEvidenceService({ changeEvidenceEvent: { createMany: async (args: any) => {
    assert.equal(args.skipDuplicates, true)
    captured = args.data[0]
    return { count: 1 }
  } } } as never).projectDirectoryAudits({ id: record.customerTenantId, organizationId: record.organizationId }, [record])
  // Only the JSON fields cross this synthetic serialization boundary. This is
  // not physical JSONB/Prisma evidence; dates retain their database return type.
  return { id: 'projection-'+record.id, ...captured, raw: JSON.parse(JSON.stringify(captured.raw)) }
}

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([field, value]: [string, any]) => {
    if (field === 'OR') return true // association queries stay constrained by the other predicates
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[field])
      if ('gte' in value && row[field] < value.gte) return false
      if ('lte' in value && row[field] > value.lte) return false
      if ('equals' in value) return row[field] === value.equals
      return true
    }
    return row[field] === value
  })
}

function reader(projected: any[], raw: any[] = [], tenants: any[] = [tenant]) {
  const queries: Array<{ model: string; args: any }> = []
  const model = (name: string, rows: any[]) => ({
    findMany: async (args: any) => {
      queries.push({ model: name, args })
      return rows.filter(row => matches(row, args.where)).slice(0, args.take ?? rows.length)
    },
    findFirst: async (args: any) => {
      queries.push({ model: name, args })
      return rows.find(row => matches(row, args.where)) ?? null
    },
  })
  const service = new ChangesService({
    user: { findUnique: async () => ({ disabledAt: null, memberships: [{ organizationId: 'org-a' }] }) },
    customerTenant: model('tenant', tenants),
    directoryAuditLog: model('audit', raw), changeEvidenceEvent: model('projection', projected),
    m365AuditRecord: model('m365', []), signInLog: model('signin', []),
  } as never)
  return { service, queries }
}

async function hidden(record: any) {
  const event = await project(record)
  const { service } = reader([event])
  assert.equal((await service.list(identity, range)).changes.length, 0)
  await assert.rejects(service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id), /telemetry rather than/)
}

for (const kind of ['role', 'app-role', 'invitation']) {
  for (const rawValue of [undefined, {}, { category: 'WrongCategory', operationType: 'Read', targetResources: [{ type: 'Group' }], result: 'failure', [key]: { version: 1, category: 'WrongCategory', operationType: 'Read', targetResourceTypes: ['Group'] } }]) {
    test(`writer to list and detail: ${kind}, raw ${rawValue === undefined ? 'missing' : Object.keys(rawValue).length ? 'conflicting' : 'empty'}`, async () => {
      const record = audit(kind, { raw: rawValue })
      const event = await project(record)
      const expected = kind === 'invitation'
        ? { classification: 'identity_change', category: 'Users', severity: 'Medium' }
        : { classification: 'administrative_action', category: 'Roles', severity: 'High' }
      for (const [projected, rawRows] of [[[event], []], [[event], [record]], [[], [record]]] as any[]) {
        const { service } = reader(projected, rawRows)
        const result = await service.list(identity, range)
        assert.equal(result.changes.length, 1)
        assert.deepEqual(Object.fromEntries(Object.keys(expected).map(name => [name, result.changes[0][name]])), expected)
        const detail = await service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id)
        assert.equal(detail.classification, expected.classification)
        assert.equal(detail.event.category, expected.category)
        assert.equal(detail.event.severity, expected.severity)
      }
      assert.equal(event.raw[key].category, record.category)
      assert.equal(event.raw[key].operationType, record.operationType)
      assert.deepEqual(event.raw[key].targetResourceTypes, record.targetResources.map((target: any) => target.type))
    })
  }
}

const rejects: Array<[string, Record<string, unknown>]> = [
  ['failure', { result: 'failure' }], ['no result', { result: null, raw: { result: 'success' } }],
  ['wrong category', { category: 'UserManagement', raw: { category: 'RoleManagement' } }],
  ['wrong operation type', { operationType: 'Add' }], ['read', { operationType: 'Read' }],
  ['role suffix', { activityDisplayName: 'Add member to role completed' }],
  ['no role state', { targetResources: [{ type: 'User', modifiedProperties: [] }] }],
  ['mixed role targets', { targetResources: [{ type: 'User', modifiedProperties: roles }, { type: 'Group' }] }],
  ['missing secondary type', { targetResources: [{ type: 'User', modifiedProperties: roles }, {}] }],
  ['non-string secondary type', { targetResources: [{ type: 'User', modifiedProperties: roles }, { type: 2 }] }],
  ['null target', { targetResources: [{ type: 'User', modifiedProperties: roles }, null] }],
  ['empty targets', { targetResources: [] }], ['malformed targets', { targetResources: {} }],
  ['malformed category', { category: ['RoleManagement'] }],
  ['malformed operation type', { operationType: ['Assign'] }],
]
for (const [name, override] of rejects) test(`writer negative: ${name}`, () => hidden(audit('role', override)))
test('writer negative: mixed invitation target set', () => hidden(audit('invitation', { targetResources: [{ type: 'User' }, { type: 'ServicePrincipal' }] })))
test('writer negative: invitation suffix', () => hidden(audit('invitation', { activityDisplayName: 'Invite external user approved' })))
test('writer negative: reserved raw success cannot rescue canonical failure', () => hidden(audit('role', {
  result: 'failure', raw: { result: 'success', [key]: { version: 1, category: 'RoleManagement', operationType: 'Assign', targetResourceTypes: ['User'] } },
})))

test('writer keeps redaction, canonical nulls and deduplication', async () => {
  const record = audit('role', { raw: { password: 'not-storable', nested: { accessToken: 'not-storable' } } })
  record.targetResources[0].modifiedProperties.push({ displayName: 'clientSecret', oldValue: 'old', newValue: 'new' })
  const event = await project(record)
  assert.equal(event.raw.password, '[REDACTED]')
  assert.equal(event.raw.nested.accessToken, '[REDACTED]')
  assert.equal(event.afterState.clientSecret, '[REDACTED]')
  assert.equal(JSON.stringify(event).includes('not-storable'), false)
})

for (const kind of ['role', 'invitation']) test(`historical complete provider JSON is sufficient: ${kind}`, async () => {
  const record = audit(kind)
  const event = await project(record)
  event.raw = { category: record.category, operationType: record.operationType, targetResources: record.targetResources }
  const { service } = reader([event])
  assert.equal((await service.list(identity, range)).changes.length, 1)
  assert.notEqual((await service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id)).classification, 'system_or_collection_event')
})

for (const [name, rawValue] of [
  ['empty', {}],
  ['category only', { category: 'RoleManagement' }],
  ['targets incomplete', { category: 'RoleManagement', operationType: 'Assign', targetResources: [{ type: 'User' }, {}] }],
  ['wrong raw category', { category: 'UserManagement', operationType: 'Assign', targetResources: [{ type: 'User' }] }],
  ['mixed raw targets', { category: 'RoleManagement', operationType: 'Assign', targetResources: [{ type: 'User' }, { type: 'Group' }] }],
  ['null envelope', { [key]: null }],
  ['future envelope', { [key]: { version: 2, category: 'RoleManagement', operationType: 'Assign', targetResourceTypes: ['User'] } }],
  ['malformed envelope', { [key]: { version: 1, category: 'RoleManagement', operationType: 'Assign', targetResourceTypes: ['User', null] } }],
] as const) test(`historical/malformed metadata remains hidden: ${name}`, async () => {
  const record = audit()
  const event = await project(record)
  event.raw = rawValue
  const { service } = reader([event])
  assert.equal((await service.list(identity, range)).changes.length, 0)
  await assert.rejects(service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id), /telemetry rather than/)
})

test('present invalid envelope cannot activate reviewed legacy fallback', async () => {
  const event = { ...await project(audit()), operationName: 'Update user', category: 'Users', targetType: null, raw: {} }
  assert.equal((await reader([event]).service.list(identity, range)).changes.length, 1)
  event.raw = { [key]: { version: 2 } }
  assert.equal((await reader([event]).service.list(identity, range)).changes.length, 0)
})

test('inherited metadata and fields do not create provider facts', () => {
  assert.deepEqual(readDirectoryAuditMetadata(Object.create({ [key]: { version: 1 } })), { kind: 'legacy' })
  assert.deepEqual(readDirectoryAuditMetadata({ [key]: Object.create({ version: 1, category: 'RoleManagement', operationType: 'Assign', targetResourceTypes: ['User'] }) }), { kind: 'invalid' })
})

test('current envelope cannot contradict the canonical first target', async () => {
  const record = audit()
  const event = await project(record)
  event.targetType = 'Group'
  const { service } = reader([event])
  assert.equal((await service.list(identity, range)).changes.length, 0)
  await assert.rejects(service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id), /telemetry rather than/)
})

for (const [field, value] of [['result', 'failure'], ['activityDisplayName', 'Invite external user'], ['targetResources', [{ type: 'ServicePrincipal' }]]] as const) {
  test(`historical raw/canonical conflict stays hidden: ${field}`, async () => {
    const record = audit()
    const event = await project(record)
    event.raw = { category: record.category, operationType: record.operationType, targetResources: record.targetResources, [field]: value }
    const { service } = reader([event])
    assert.equal((await service.list(identity, range)).changes.length, 0)
    await assert.rejects(service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id), /telemetry rather than/)
  })
}

test('tenant and organization predicates fence shared source IDs in list and detail', async () => {
  const record = audit()
  const a = await project(record)
  const foreignOrg = { ...a, id: 'foreign-org', organizationId: 'org-b', targetDisplayName: 'Foreign organization' }
  const foreignTenant = { ...a, id: 'foreign-tenant', customerTenantId: 'tenant-b', targetDisplayName: 'Other tenant' }
  const { service, queries } = reader([foreignOrg, foreignTenant, a], [], [
    { ...tenant, id: 'tenant-b', displayName: 'Tenant B' },
    { ...tenant, id: 'tenant-c', organizationId: 'org-b', displayName: 'Foreign tenant' }, tenant,
  ])
  const result = await service.list(identity, range)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].target, a.targetDisplayName)
  const detail = await service.detail(identity, 'audit:'+record.microsoftAuditId, tenant.id)
  assert.equal(detail.event.targetDisplayName, a.targetDisplayName)
  await assert.rejects(service.detail(identity, 'audit:'+record.microsoftAuditId, 'tenant-c'), /unavailable or outside retention/)
  for (const query of queries.filter(q => q.model === 'projection' || q.model === 'audit')) {
    assert.deepEqual(query.args.where.organizationId, { in: ['org-a'] })
    assert.ok(query.args.where.customerTenantId === tenant.id || query.args.where.customerTenantId.in?.includes(tenant.id))
  }
})
