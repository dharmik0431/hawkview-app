import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient } from '@tanstack/react-query'

import {
  AuthTransitionGuard,
  IdentityScopedMemoryCache,
  authDataScope,
  clearIdentityBoundCaches,
  registerIdentityCacheReset,
  scopedCacheKey,
} from './data-isolation.ts'

const session = (userId: string, organizationIds: string[]) => ({
  user: {
    id: userId,
    email: `${userId}@example.test`,
    displayName: userId,
    timeZone: null,
    dateFormat: 'yyyy-MM-dd',
    timeFormat: '12h' as const,
    platformRole: 'STANDARD_USER' as const,
    memberships: organizationIds.map((organizationId) => ({
      id: `${userId}-${organizationId}`,
      role: 'MSP_OWNER' as const,
      status: 'ACTIVE' as const,
      organization: {
        id: organizationId,
        name: organizationId,
        slug: organizationId,
        status: 'ACTIVE',
      },
    })),
  },
})

test('A bootstrap cannot commit after logout or a B identity transition', () => {
  const guard = new AuthTransitionGuard()
  const a = guard.begin('identity-a')
  assert.equal(guard.isCurrent(a), true)

  const signedOut = guard.begin(null)
  assert.equal(guard.isCurrent(a), false)
  assert.equal(guard.isCurrent(signedOut), true)

  const b = guard.begin('identity-b')
  assert.equal(guard.isCurrent(a), false)
  assert.equal(guard.isCurrent(signedOut), false)
  assert.equal(guard.isCurrent(b), true)
})

test('query and memory keys change across identity and organization scope', () => {
  const a = authDataScope('identity-a', session('user-a', ['org-b', 'org-a']))
  const b = authDataScope('identity-b', session('user-b', ['org-a']))
  assert.equal(a, 'identity:identity-a:organizations:org-a,org-b')
  assert.notEqual(a, b)
  assert.notEqual(scopedCacheKey(a, 'tenants'), scopedCacheKey(b, 'tenants'))
})

test('tenant and topbar values never fall back across identity scope', () => {
  const cache = new IdentityScopedMemoryCache<{ name: string }>()
  cache.set('identity-a', 'tenant-1', { name: 'Tenant A' })

  assert.deepEqual(cache.get('identity-a', 'tenant-1'), { name: 'Tenant A' })
  assert.equal(cache.get('identity-b', 'tenant-1'), null)
  assert.equal(cache.get('signed-out', 'tenant-1'), null)
})

test('identity transition resets registered sensitive caches before reuse', () => {
  let resetCount = 0
  const unregister = registerIdentityCacheReset(() => {
    resetCount += 1
  })
  clearIdentityBoundCaches()
  assert.equal(resetCount, 1)
  unregister()
  clearIdentityBoundCaches()
  assert.equal(resetCount, 1)
})

test('A dashboard data is gone before B can mount a query observer', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['tenants', 'identity-a'], {
    tenants: [{ id: 'tenant-a' }],
  })
  const unregister = registerIdentityCacheReset(() => {
    void queryClient.cancelQueries()
    queryClient.clear()
  })

  clearIdentityBoundCaches()
  assert.equal(queryClient.getQueryData(['tenants', 'identity-a']), undefined)
  assert.equal(queryClient.getQueryData(['tenants', 'identity-b']), undefined)
  unregister()
})
