import { useQuery } from '@tanstack/react-query'
import type { TenantsResponse, DashboardSummaryResponse } from '@/types/api'
import { apiClient } from './client'
import { useAuth } from '@/components/providers/auth-provider'
import {
  projectTenantOperationalHealth,
  type TenantOperationalProjection,
} from '@/lib/tenants/operational-health-projection'

export function useTenants() {
  const { cacheScope } = useAuth()
  return useQuery<TenantsResponse>({
    queryKey: ['tenants', cacheScope],
    queryFn: ({ signal }) =>
      apiClient.get<TenantsResponse>('/api/tenants', { signal }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Shared tenant-list projection used by Directory, Overview, and Settings.
 * The list endpoint owns tenant-wide health; a detail bundle must never
 * overwrite its verified findings or turn an unavailable result into zero.
 */
export function useTenantOperationalProjection(
  tenantId?: string | null,
): TenantOperationalProjection & { refetch: ReturnType<typeof useTenants>['refetch'] } {
  const query = useTenants()
  const projection = projectTenantOperationalHealth({
    tenantId,
    response: query.data,
    queryState: query.isLoading ? 'LOADING' : query.isError ? 'ERROR' : 'SUCCESS',
  })

  return {
    ...projection,
    refetch: query.refetch,
  }
}

export function useTenantBundle(tenantId?: string) {
  const { cacheScope } = useAuth()
  return useQuery<any>({
    queryKey: ['tenant', cacheScope, tenantId],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodeURIComponent(tenantId!)}`, { signal }),
    enabled: Boolean(tenantId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useDashboardSummary() {
  const { cacheScope } = useAuth()
  return useQuery<DashboardSummaryResponse>({
    queryKey: ['dashboard-summary', cacheScope],
    queryFn: ({ signal }) =>
      apiClient.get<DashboardSummaryResponse>('/api/dashboard/summary', {
        signal,
      }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}
