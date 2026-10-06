'use client'

import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from './client'
import {
  parsePimPlaneSummary,
  type PimSchedulePlane,
  type PimPlaneSummaryView,
} from '@/lib/tenants/pim-schedule-summary-view'

/** Read-only summary of the persisted PIM schedule observations for one tenant and plane.
 *
 * Keyed by authenticated cache scope, customer tenant and plane together, so a result can never be
 * reused across identities, tenants or planes. Disabled until both a current scope and a selected
 * tenant exist, which is what stops a delayed response from a previous scope being rendered as the
 * current one's data.
 *
 * Read-only by construction: no provider trigger, no automatic retry, and deliberately NO
 * refetchInterval — a manual refetch re-reads this summary and collects nothing. */
/** True only for a scope that names an identity **and** its resolved organizations.
 *
 * `authDataScope` returns truthy strings for states that are not ready to read tenant data:
 * `'signed-out'`, and `identity:<subject>:bootstrap-pending` while the workspace bootstrap has not
 * resolved. A truthiness test admits both, which is why this predicate exists. */
export function isReadyDataScope(cacheScope: string): boolean {
  return cacheScope.startsWith('identity:') && cacheScope.includes(':organizations:')
}

export function usePimScheduleSummary(customerTenantId: string, plane: PimSchedulePlane) {
  const { cacheScope, isLoading } = useAuth()
  // Readiness, not truthiness: a loading session and the signed-out / bootstrap-pending scopes
  // must not issue a tenant read.
  const enabled = !isLoading && isReadyDataScope(cacheScope) && Boolean(customerTenantId)

  return useQuery<PimPlaneSummaryView>({
    queryKey: ['pim-schedule-summary', cacheScope, customerTenantId, plane],
    enabled,
    queryFn: async ({ signal }) => {
      const raw = await apiClient.get<unknown>(
        `/api/tenants/${encodeURIComponent(customerTenantId)}/pim/schedules/${plane}/summary`,
        { signal, cache: 'no-store' }
      )
      const parsed = parsePimPlaneSummary(plane, raw)
      if (!parsed) {
        // An unreadable answer is surfaced as a failure, never as "no observations".
        throw new Error('HawkView returned an unsupported PIM schedule summary.')
      }
      return parsed
    },
    retry: false,
    staleTime: 60_000,
  })
}
