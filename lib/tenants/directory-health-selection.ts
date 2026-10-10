/** A selection is a scoped intent, never a retained tenant payload or access grant. */
export type DirectoryHealthSelection = {
  tenantId: string
  cacheScope: string
  identityToken: string
}

export function selectedDirectoryHealthTenant<T extends { id: string; provider: string }>({
  selection, cacheScope, identityToken, authLoading, listSuccessful, tenants,
}: {
  selection: DirectoryHealthSelection | null
  cacheScope: string
  identityToken: string
  authLoading: boolean
  listSuccessful: boolean
  tenants: readonly T[] | undefined
}): T | null {
  if (!selection || authLoading || !listSuccessful
    || !cacheScope.startsWith('identity:') || !cacheScope.includes(':organizations:')
    || selection.cacheScope !== cacheScope
    || selection.identityToken !== identityToken) return null
  return tenants?.find(tenant => tenant.id === selection.tenantId && tenant.provider === 'microsoft') ?? null
}
