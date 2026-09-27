'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { useTenants } from './hooks'
import { apiClient } from './client'
import type { Tenant } from '@/types/api'
import { projectFleetRisk } from '@/lib/identity-risk/fleet-risk-projection'
export type { FleetRiskyUserRow } from '@/lib/identity-risk/fleet-risk-projection'
export type TenantFleetStatus = ReturnType<typeof projectFleetRisk>['tenantStatuses'][number]

export function useFleetRiskyUsers(selectedTenant = 'ALL') {
  const { cacheScope } = useAuth()
  const queryClient = useQueryClient()
  const lifecycle = useMemo(() => ({ active: false, cacheScope, selectedTenant, queryClient }), [cacheScope, selectedTenant, queryClient])
  useLayoutEffect(() => {
    lifecycle.active = true
    return () => { lifecycle.active = false }
  }, [lifecycle])
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const { data: tenantsResponse, isLoading: tenantsLoading, isError: tenantsError, isFetching: tenantsFetching } = useTenants()

  const safeTenants: Tenant[] = useMemo(() => tenantsResponse?.tenants ?? [], [tenantsResponse])

  const assessmentQueries = useQueries({
    queries: safeTenants.map((tenant) => {
      const encodedId = encodeURIComponent(tenant.id)
      return {
        queryKey: ['fleet-risky-users', cacheScope, tenant.id, 'assessment'],
        queryFn: ({ signal }: { signal?: AbortSignal }) =>
          apiClient.get(`/api/tenants/${encodedId}/risky-users/assessment`, {
            signal,
            cache: 'no-store',
          }),
        enabled: Boolean(tenant.id) && !tenantsLoading,
        retry: false,
        staleTime: 0,
        gcTime: 0,
      }
    }),
  })

  const microsoftQueries = useQueries({
    queries: safeTenants.map((tenant) => {
      const encodedId = encodeURIComponent(tenant.id)
      return {
        queryKey: ['fleet-risky-users', cacheScope, tenant.id, 'microsoft-risky-users'],
        queryFn: ({ signal }: { signal?: AbortSignal }) =>
          apiClient.get(`/api/tenants/${encodedId}/microsoft-entra-risky-users`, {
            signal,
          }),
        enabled: Boolean(tenant.id) && !tenantsLoading,
        retry: false,
        staleTime: 60_000,
      }
    }),
  })

  const isLoading =
    tenantsLoading ||
    assessmentQueries.some((q) => q.isLoading) ||
    microsoftQueries.some((q) => q.isLoading)

  const isError = tenantsError
  const enumerationKnown = !tenantsLoading && !tenantsError && Array.isArray(tenantsResponse?.tenants)
  const pendingReloads = useRef(new Set<string>())
  const hasFailedRequests = Boolean((tenantsError && !tenantsFetching) || (enumerationKnown && safeTenants.some((tenant, index) =>
    (selectedTenant === 'ALL' || tenant.id === selectedTenant) &&
    [assessmentQueries[index], microsoftQueries[index]].some((query) => query?.isError && !query.isFetching && !query.isLoading))))

  const fleetData = useMemo(
    () => projectFleetRisk(safeTenants, assessmentQueries, microsoftQueries, now),
    [safeTenants, assessmentQueries, microsoftQueries, now],
  )

  return {
    tenants: safeTenants,
    ...fleetData,
    isLoading,
    isError,
    cacheScope,
    enumerationKnown,
    hasFailedRequests,
    reloadFailedResults: () => {
      if (!lifecycle.active) return
      const tenantKey = ['tenants', cacheScope] as const
      const failedIdle = (key: readonly unknown[]) => {
        const state = queryClient.getQueryState(key)
        return state?.status === 'error' && state.fetchStatus === 'idle'
      }
      const confirmedTenants = () => {
        const state = queryClient.getQueryState<{ tenants: Tenant[] }>(tenantKey)
        return state?.status === 'success' && Array.isArray(state.data?.tenants) ? state.data.tenants : null
      }
      const reload = (queryKey: readonly unknown[], tenantId?: string) => {
        const key = JSON.stringify(queryKey)
        if (pendingReloads.current.has(key)) return
        pendingReloads.current.add(key)
        void Promise.resolve().then(() => {
          // Recheck at dispatch: React's rendered observer result may lag the
          // query cache, and this queued action may outlive its UI scope.
          if (!lifecycle.active || !failedIdle(queryKey)) return
          if (tenantId && !confirmedTenants()?.some((tenant) => tenant.id === tenantId)) return
          return queryClient.refetchQueries({ queryKey, exact: true, type: 'active' }, { cancelRefetch: false })
        }).catch(() => undefined).finally(() => pendingReloads.current.delete(key))
      }
      if (failedIdle(tenantKey)) {
        reload(tenantKey)
        return // Re-establish scope before reloading any tenant results.
      }
      for (const tenant of confirmedTenants() ?? []) {
        if (selectedTenant !== 'ALL' && tenant.id !== selectedTenant) continue
        for (const source of ['assessment', 'microsoft-risky-users']) {
          const key = ['fleet-risky-users', cacheScope, tenant.id, source]
          if (failedIdle(key)) reload(key, tenant.id)
        }
      }
    },
  }
}
