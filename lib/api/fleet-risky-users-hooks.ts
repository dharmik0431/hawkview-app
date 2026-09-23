'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { useTenants } from './hooks'
import { apiClient } from './client'
import type { Tenant } from '@/types/api'
import { projectFleetRisk } from '@/lib/identity-risk/fleet-risk-projection'
export type { FleetRiskyUserRow } from '@/lib/identity-risk/fleet-risk-projection'
export type TenantFleetStatus = ReturnType<typeof projectFleetRisk>['tenantStatuses'][number]

export function useFleetRiskyUsers() {
  const { cacheScope } = useAuth()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const { data: tenantsResponse, isLoading: tenantsLoading, isError: tenantsError, refetch: refetchTenants } = useTenants()

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
    retryAll: () => {
      void refetchTenants()
      assessmentQueries.forEach((q) => void q.refetch())
      microsoftQueries.forEach((q) => void q.refetch())
    },
  }
}
