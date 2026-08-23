import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('A logout B account switch clears queries without unmounting the login flow', () => {
  const auth = source('components/providers/auth-provider.tsx')
  const queries = source('components/providers/query-provider.tsx')

  assert.match(
    auth,
    /clearIdentityBoundCaches\(\)[\s\S]{0,250}transitionGuard\.current\.begin\(user\?\.id \?\? null\)[\s\S]{0,250}commitSession\(null\)/
  )
  assert.match(
    auth,
    /const signOut = useCallback\(async \(\) => \{[\s\S]{0,160}beginIdentityTransition\(null\)[\s\S]{0,160}supabase\.auth\.signOut\(\)/
  )
  assert.match(queries, /<IdentityQueryProvider cacheScope=\{cacheScope\}>/)
  assert.doesNotMatch(queries, /key=\{cacheScope\}/)
  assert.match(queries, /previousScope\.current === cacheScope/)
  assert.match(queries, /queryClient\.cancelQueries\(\)/)
  assert.match(queries, /queryClient\.clear\(\)/)
})

test('dashboard queries and failed-refetch fallbacks are identity scoped', () => {
  const hooks = source('lib/api/hooks.ts')
  const tenantPage = source('app/(protected)/tenants/[id]/page.tsx')

  assert.match(hooks, /queryKey: \['tenants', cacheScope\]/)
  assert.match(hooks, /queryKey: \['tenant', cacheScope, tenantId\]/)
  assert.match(hooks, /queryKey: \['dashboard-summary', cacheScope\]/)
  assert.match(
    tenantPage,
    /const cachedBundle = getCachedTenantBundle\(cacheScope, String\(tenantId\)\)/
  )
  assert.match(
    tenantPage,
    /tenantBundleCache\.set\([\s\S]{0,100}cacheScope,[\s\S]{0,100}String\(tenantId\)/
  )
  assert.doesNotMatch(
    tenantPage,
    /const tenantBundleCache = new Map<string, TenantBundleCacheEntry>/
  )
})

test('topbar cannot display an A tenant name while B is active', () => {
  const topbar = source('components/layout/topbar.tsx')
  assert.match(topbar, /tenantNameCache\.get\(cacheScope, tenantId\)/)
  assert.match(
    topbar,
    /tenantNameState\.scope === cacheScope[\s\S]{0,100}tenantNameState\.tenantId === tenantId/
  )
  assert.match(topbar, /\}, \[cacheScope, tenantId\]\)/)
})

test('late A bootstrap is generation checked and authenticated fetches bypass HTTP cache', () => {
  const auth = source('components/providers/auth-provider.tsx')
  const client = source('lib/api/client.ts')
  assert.match(auth, /transitionGuard\.current\.isCurrent\(ticket\)/)
  assert.match(
    auth,
    /after\?\.data\.session\?\.user\.id !== user\.id[\s\S]{0,120}!transitionGuard\.current\.isCurrent\(ticket\)/
  )
  assert.match(client, /cache: 'no-store'/)
})
