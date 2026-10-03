import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readApplyReconciliationRows, readDryRunReconciliationRows, type ReconciliationReader,
} from './reconciliation-audit-reader.js'

type Notification = Awaited<ReturnType<ReconciliationReader['notification']['findMany']>>[number]
type Audit = Awaited<ReturnType<ReconciliationReader['directoryAuditLog']['findMany']>>[number]
type Query = Parameters<ReconciliationReader['directoryAuditLog']['findMany']>[0]
const orgA = '00000000-0000-4000-8000-000000000001'
const orgB = '00000000-0000-4000-8000-000000000002'
const tenantA = '00000000-0000-4000-8000-000000000003'
const tenantB = '00000000-0000-4000-8000-000000000004'
const instant = new Date('2026-10-03T00:00:00Z')
function notification(organizationId: string, customerTenantId: string | null, event = 'Directory_shared'): Notification {
  return { id: `${organizationId}/${customerTenantId}/${event}`, organizationId, customerTenantId,
    dedupeKey: `security:directory-audit:${event}`, occurrenceCount: 1, resolvedAt: null }
}
function audit(organizationId: string, customerTenantId: string, actor: string, event = 'Directory_shared'): Audit {
  return { organizationId, customerTenantId, microsoftAuditId: event,
    initiatedBy: actor, targetResources: [{ id: `target-${actor}` }], eventDateTime: instant }
}
function world(notifications: Notification[], audits: Audit[]) {
  const queries: Query[] = []
  const reader: ReconciliationReader = {
    notification: { findMany: async () => notifications },
    directoryAuditLog: { findMany: async (query) => {
      queries.push(query)
      // Deliberately return out-of-scope rows too. Query scoping and returned-row
      // scoping are separately asserted instead of making the double do the fix.
      return audits
    } },
  }
  return { reader, queries }
}

for (const [mode, read] of [['dry-run', readDryRunReconciliationRows], ['apply', readApplyReconciliationRows]] as const) {
  test(`${mode}: duplicate IDs keep their own tenant actor and event time in either order`, async () => {
    for (const secondOrg of [orgA, orgB]) {
      const first = audit(orgA, tenantA, 'actor-a')
      const second = { ...audit(secondOrg, tenantB, 'actor-b'), eventDateTime: new Date(instant.getTime() + 60_000) }
      for (const audits of [[first, second], [second, first]]) {
        const w = world([notification(orgA, tenantA), notification(secondOrg, tenantB)], audits)
        const { rows, auditJoin } = await read(w.reader)
        assert.deepEqual(rows.map((row) => row.audit?.initiatedBy), ['actor-a', 'actor-b'])
        assert.deepEqual(rows.map((row) => row.occurredAt), [first.eventDateTime, second.eventDateTime])
        assert.deepEqual(rows.map((row) => row.audit?.targetResources), mode === 'dry-run' ? [['target-actor-a'], ['target-actor-b']] : [[], []])
        assert.equal(auditJoin.distinctAuditIds, 1)
        assert.equal(auditJoin.distinctAuditIdentities, 2)
        assert.equal(auditJoin.auditRecordsFound, 2)
        assert.equal(auditJoin.notJoined, 0)
        assert.deepEqual(w.queries[0].where.OR, [
          { organizationId: orgA, customerTenantId: tenantA, microsoftAuditId: 'Directory_shared' },
          { organizationId: secondOrg, customerTenantId: tenantB, microsoftAuditId: 'Directory_shared' },
        ])
        assert.equal(w.queries[0].select.customerTenantId, true)
        assert.equal(w.queries[0].select.organizationId, true)
      }
    }
  })

  test(`${mode}: another tenant or organization cannot fill missing evidence`, async () => {
    for (const other of [audit(orgA, tenantB, 'other-tenant'), audit(orgB, tenantA, 'wrong-org')]) {
      const w = world([notification(orgA, tenantA)], [other])
      const { rows, auditJoin } = await read(w.reader)
      assert.equal(rows[0].audit, null)
      assert.equal(rows[0].occurredAt, null)
      assert.equal(auditJoin.notJoined, 1)
      assert.equal(auditJoin.auditRecordsFound, 0)
    }
  })

  test(`${mode}: null or malformed scope and non-audit keys never widen a query`, async () => {
    const entries = [notification(orgA, null), notification('', tenantA), notification(orgA, '%'),
      notification(orgA, tenantA, ''), notification(orgA, tenantA, 'x'.repeat(201)),
      { ...notification(orgA, tenantA), dedupeKey: 'tenant:some-tenant:sync:users' }]
    const w = world(entries, [audit(orgA, tenantA, 'unused')])
    const result = await read(w.reader)
    assert.equal(w.queries.length, 0)
    assert.equal(result.rows.length, entries.length)
    assert.equal(result.rows.every((row) => row.audit === null && row.occurredAt === null), true)
    assert.equal(result.auditJoin.distinctAuditIdentities, 0)
    assert.equal(result.auditJoin.unscopedAuditKeys, 4)
  })

  test(`${mode}: tuple queries do not admit Cartesian tenant/id combinations`, async () => {
    const w = world([notification(orgA, tenantA, 'Directory_a'), notification(orgA, tenantB, 'Directory_b')], [
      audit(orgA, tenantA, 'a', 'Directory_a'), audit(orgA, tenantB, 'b', 'Directory_b'),
      audit(orgA, tenantA, 'wrong', 'Directory_b'), audit(orgA, tenantB, 'wrong', 'Directory_a'),
    ])
    const result = await read(w.reader)
    assert.deepEqual(result.rows.map((row) => row.audit?.initiatedBy), ['a', 'b'])
    assert.equal(w.queries[0].where.OR.length, 2)
    assert.equal(result.auditJoin.auditRecordsFound, 2)
    assert.equal(result.auditJoin.notJoined, 0)
  })

  test(`${mode}: ambiguous duplicate scoped evidence is refused in either order`, async () => {
    for (const actors of [['one', 'two'], ['two', 'one']]) {
      const result = await read(world([notification(orgA, tenantA)], actors.map((actor) => audit(orgA, tenantA, actor))).reader)
      assert.equal(result.rows[0].audit, null)
      assert.equal(result.auditJoin.notJoined, 1)
    }
  })

  test(`${mode}: empty input skips audits; query failure is not an empty report`, async () => {
    const w = world([], [])
    assert.deepEqual((await read(w.reader)).rows, [])
    assert.equal(w.queries.length, 0)
    const broken = world([notification(orgA, tenantA)], [])
    broken.reader.directoryAuditLog.findMany = async () => { throw new Error('synthetic read failure') }
    await assert.rejects(read(broken.reader), /synthetic read failure/)
  })

  test(`${mode}: deduplicated identities are batched without dropping notification rows`, async () => {
    const entries = Array.from({ length: 501 }, (_, i) => notification(orgA, tenantA, `Directory_${i}`))
    entries.push(entries[0])
    const w = world(entries, [])
    const result = await read(w.reader)
    assert.deepEqual(w.queries.map((query) => query.where.OR.length), [500, 1])
    assert.equal(result.rows.length, 502)
    assert.equal(result.auditJoin.keysNamingAnAuditRecord, 502)
    assert.equal(result.auditJoin.distinctAuditIdentities, 501)
    assert.equal(result.auditJoin.notJoined, 501)
  })
}

test('historical dry-run JSON actor/target decoding and conservative apply projection stay distinct', async () => {
  const source = { ...audit(orgA, tenantA, ''), initiatedBy: { user: { userPrincipalName: 'actor-upn', id: 'actor-id' } },
    targetResources: [{ id: 'target-id' }, { displayName: 'fallback-name' }, null, { id: 5 }] }
  const dry = await readDryRunReconciliationRows(world([notification(orgA, tenantA)], [source]).reader)
  assert.deepEqual(dry.rows[0].audit, { initiatedBy: 'actor-upn', targetResources: ['target-id', 'fallback-name'], privileged: null })
  const apply = await readApplyReconciliationRows(world([notification(orgA, tenantA)], [source]).reader)
  assert.deepEqual(apply.rows[0].audit, { initiatedBy: null, targetResources: [], privileged: null })
})
