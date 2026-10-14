import assert from 'node:assert/strict'
import test from 'node:test'
import { TenantSyncService } from './tenant-sync.service.js'

test('actual user delta preserves a stored disabled account on missing state and applies reported booleans', async () => {
  let stored: { accountEnabled: boolean } | null = { accountEnabled: false }
  let row: Record<string, unknown> = { id: 'user-1', userPrincipalName: 'user@example.test' }
  const writes: any[] = []
  const prisma = {
    directoryUser: {
      upsert: async (request: any) => {
        writes.push(request)
        if (stored) stored = { ...stored, ...request.update }
        else stored = { accountEnabled: true, ...request.create }
        return stored
      },
    },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  }
  const service = new TenantSyncService(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  )
  ;(service as any).fetchGraphPage = async () => new Response(JSON.stringify({
    value: [row],
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=next',
  }), { headers: { 'content-type': 'application/json' } })
  const collect = async () => (service as any).synchronizeUsers(
    { id: 'tenant-1', organizationId: 'org-1' },
    'synthetic-token',
    'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=prior',
  )

  await collect()
  assert.equal(Object.hasOwn(writes.at(-1).create, 'accountEnabled'), false)
  assert.equal(Object.hasOwn(writes.at(-1).update, 'accountEnabled'), false)
  assert.equal(stored?.accountEnabled, false, 'an omitted delta property overwrote a known disabled account')

  row = { ...row, accountEnabled: null }
  await collect()
  assert.equal(Object.hasOwn(writes.at(-1).update, 'accountEnabled'), false)
  assert.equal(stored?.accountEnabled, false, 'a non-boolean delta property overwrote a known disabled account')

  row = { ...row, accountEnabled: true }
  await collect()
  assert.equal(writes.at(-1).update.accountEnabled, true)
  assert.equal(stored?.accountEnabled, true)

  row = { ...row, accountEnabled: false }
  await collect()
  assert.equal(writes.at(-1).update.accountEnabled, false)
  assert.equal(stored?.accountEnabled, false)

  stored = null
  row = { id: 'new-user', userPrincipalName: 'new@example.test' }
  await collect()
  assert.equal(Object.hasOwn(writes.at(-1).create, 'accountEnabled'), false)
  assert.equal((stored as { accountEnabled: boolean } | null)?.accountEnabled, true,
    'new unknown rows still take the existing schema default')
})
