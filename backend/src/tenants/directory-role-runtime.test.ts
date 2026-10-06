import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const ts = createRequire(new URL('../../../package.json', import.meta.url))('typescript')
import { TenantSyncService } from './tenant-sync.service.js'

test('all three checked-in dispatch closures invoke the directory boundary, not generic snapshot sync', async () => {
  const file = ts.createSourceFile('tenant-sync.service.ts', readFileSync(new URL('./tenant-sync.service.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const closures: any[] = []
  const visit = (node: any) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'DIRECTORY_ROLES' && ts.isArrowFunction(node.initializer)) closures.push(node.initializer)
    if (ts.isObjectLiteralExpression(node) && node.properties.some((p: any) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'resource' && p.initializer.getText(file) === "'DIRECTORY_ROLES'")) {
      const sync = node.properties.find((p: any) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'synchronize')
      assert.ok(ts.isArrowFunction(sync.initializer)); closures.push(sync.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(file); assert.equal(closures.length, 3)
  const tenant = { id: 'tenant' }, calls: unknown[][] = []
  const service = { syncDirectoryRoles: async (...args: unknown[]) => { calls.push(args) },
    syncEntraCollection: () => { throw Error('generic directory dispatch') } }
  for (const arrow of closures) {
    const invoke = new Function('tenant', 'accessToken', 'snapshotAccessToken', `return (${arrow.getText(file)})()`)
    await invoke.call(service, tenant, 'legacy-token', 'legacy-token')
  }
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [tenant, 'legacy-token']))
})

test('runtime rejects revoked activated scope without generic terminal/notification effects', async () => {
  const service: any = Object.create(TenantSyncService.prototype)
  const id = '11111111-1111-4111-8111-111111111111'
  let generic = 0, writes = 0, providers = 0
  service.syncEntraCollection = async () => { generic++ }
  service.microsoftConsent = { getCapturedDirectoryRoleToken: async () => { providers++; throw Error('unexpected') } }
  service.changeEvidence = { buildSnapshotDifferenceEvidence: () => [] }
  service.prisma = { $transaction: async (work: any) => work({
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('pg_advisory')) return []
      if (sql.includes('platform_microsoft_connectors')) return []
      if (sql.includes('customer_tenants')) return [{ status: 'ACTIVE' }]
      if (sql.includes('tenant_connections')) return [{ status: 'REVOKED', mode: 'HAWKVIEW_MANAGED', incarnation: id }]
      if (sql.includes('sync_states')) return [{ role_scope_version: 'directory-role-assignments/v1', role_scope_incarnation: id }]
      throw Error('unexpected SQL')
    }, $executeRawUnsafe: async () => { writes++; return 1 },
  }) }
  await assert.rejects(service.syncDirectoryRoles({ id, organizationId: id, microsoftTenantId: id }, 'bare'), /NOT_COMMITTED/)
  assert.deepEqual({ generic, writes, providers }, { generic: 0, writes: 0, providers: 0 })
})
