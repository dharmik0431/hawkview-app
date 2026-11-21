import assert from 'node:assert/strict'
import test from 'node:test'
import { ChangeEvidenceService } from './change-evidence.service.js'
import { TenantVisitLeaseLostError } from '../tenants/tenant-visit-lease-error.js'
import type { TenantVisitLeaseOwner } from '../tenants/tenant-visit-lease-store.js'

const owner: TenantVisitLeaseOwner = {
  organizationId: 'organization-1',
  customerTenantId: 'tenant-1',
  token: 'owner-1',
  generation: 7n,
  expiresAt: new Date('2026-10-31T16:30:00.000Z'),
}
const expiry = new Date('2026-10-31T16:00:00.000Z')

test('a foreign tenant is rejected before the evidence cleanup transaction', async () => {
  let transactions = 0
  const service = new ChangeEvidenceService({
    $transaction: async () => { transactions++; throw new Error('unexpected transaction') },
    changeEvidenceEvent: { deleteMany: async () => assert.fail('foreign evidence deleted') },
  } as never)
  await assert.rejects(service.pruneExpired('tenant-2', expiry, owner), TenantVisitLeaseLostError)
  assert.equal(transactions, 0)
})

test('a lost visit cannot delete evidence and its error is not swallowed', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async () => { calls.push('lease-check'); return [] },
    changeEvidenceEvent: { deleteMany: async () => { calls.push('delete') } },
  }
  const service = new ChangeEvidenceService({
    $transaction: async (work: (database: typeof transaction) => Promise<void>) => work(transaction),
    changeEvidenceEvent: { deleteMany: async () => assert.fail('outside-transaction delete') },
  } as never)
  await assert.rejects(service.pruneExpired(owner.customerTenantId, expiry, owner), TenantVisitLeaseLostError)
  assert.deepEqual(calls, ['lease-check'])
})

test('a live visit locks ownership before deleting evidence in the same transaction', async () => {
  const calls: string[] = []
  const transaction = {
    $queryRawUnsafe: async () => {
      calls.push('lease-check')
      return calls.length < 3 ? [{ id: 'scope' }] : [{ generation: '7' }]
    },
    changeEvidenceEvent: { deleteMany: async ({ where }: { where: unknown }) => {
      calls.push('delete')
      assert.deepEqual(where, { customerTenantId: owner.customerTenantId, expiresAt: { lte: expiry } })
    } },
  }
  const service = new ChangeEvidenceService({
    $transaction: async (work: (database: typeof transaction) => Promise<void>) => work(transaction),
    changeEvidenceEvent: { deleteMany: async () => assert.fail('outside-transaction delete') },
  } as never)
  await service.pruneExpired(owner.customerTenantId, expiry, owner)
  assert.deepEqual(calls, ['lease-check', 'lease-check', 'lease-check', 'delete'])
})

test('legacy cleanup still uses its direct best-effort path', async () => {
  const calls: string[] = []
  const service = new ChangeEvidenceService({
    $transaction: async () => assert.fail('legacy cleanup opened a transaction'),
    changeEvidenceEvent: { deleteMany: async () => { calls.push('delete') } },
  } as never)
  await service.pruneExpired(owner.customerTenantId, expiry)
  assert.deepEqual(calls, ['delete'])
})
