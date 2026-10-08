'use client'

import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from './client'
import { isReadyDataScope } from './pim-schedule-summary-hooks'
import {
  parseDirectoryRoleResults,
  type DirectoryRoleResultsView,
} from '@/lib/tenants/directory-role-results-view'

/** Stored directory-role results for one tenant.
 *
 * Keyed by authenticated cache scope and customer tenant together, and enabled only for a ready
 * scope, so a delayed answer for a previous identity or tenant can never be read as the current
 * one's data. Read-only: no polling, no automatic retry, and a manual refetch re-reads this summary
 * and collects nothing.
 *
 * Consumers must read `dataUpdatedAt` alongside `data`: the server's `ageMs` was measured when IT
 * read, so the only correct elapsed age is that value plus the time since THIS response was accepted.
 * `dataUpdatedAt` changes on every accepted response, including a cached one replayed later, which
 * is what lets the view re-anchor even when the new numeric age is identical to the old one. */
export function useDirectoryRoleResults(customerTenantId: string) {
  const { cacheScope, isLoading } = useAuth()
  const enabled = !isLoading && isReadyDataScope(cacheScope) && Boolean(customerTenantId)

  return useQuery<DirectoryRoleResultsView>({
    queryKey: ['directory-role-results', cacheScope, customerTenantId],
    enabled,
    queryFn: async ({ signal }) => {
      const raw = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(customerTenantId)}/directory-roles/results`,
        { signal, cache: 'no-store' }
      )
      const parsed = parseDirectoryRoleResults(raw)
      if (!parsed) {
        // An unreadable answer surfaces as a failure, never as "nothing collected".
        throw new Error('HawkView returned an unsupported directory role result.')
      }
      return parsed
    },
    retry: false,
    staleTime: 60_000,
  })
}
