'use client'

import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { useTenants } from './hooks'
import { apiClient } from './client'
import type { Tenant } from '@/types/api'
import {
  adaptMicrosoftRiskyUsersResponse,
  unavailableMicrosoftEntraRiskyUsers,
} from '@/lib/identity-risk/adapter'
import { adaptNativeAssessment } from '@/lib/identity-risk/native-assessment'
import { microsoftChannel } from '@/lib/identity-risk/risky-users-view'
import {
  nativeRiskyUserCount,
  nativeRiskyUserList,
} from '@/lib/identity-risk/native-view'
import type {
  RiskyUserRow,
  MicrosoftChannel,
  RiskyUserCount,
} from '@/lib/identity-risk/risky-users-view'

export type FleetRiskyUserRow = RiskyUserRow & {
  tenantId: string
  tenantName: string
  tenantDomain?: string | null
}

export type TenantFleetStatus = {
  tenantId: string
  tenantName: string
  tenantDomain?: string | null
  status: 'SUCCESS' | 'FAILED' | 'UNAVAILABLE' | 'LOADING'
  count: RiskyUserCount
  channel: MicrosoftChannel
  userCount: number
}

export function useFleetRiskyUsers() {
  const { cacheScope } = useAuth()
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

  const fleetData = useMemo(() => {
    const allRows: FleetRiskyUserRow[] = []
    const tenantStatuses: TenantFleetStatus[] = []

    let totalHawkViewUsers = 0
    let totalMicrosoftUsers = 0
    let totalBothUsers = 0
    let failedTenantCount = 0

    safeTenants.forEach((tenant, idx) => {
      const assessmentQuery = assessmentQueries[idx]
      const microsoftQuery = microsoftQueries[idx]

      const tenantName = tenant.name || tenant.domain || tenant.id
      const tenantDomain = tenant.domain

      const assessmentData = assessmentQuery?.data
      const assessmentError = assessmentQuery?.isError
      const nativeView =
        assessmentError || !assessmentData
          ? null
          : adaptNativeAssessment(assessmentData)

      const microsoftData = microsoftQuery?.data
      const microsoftError = microsoftQuery?.isError
      const microsoftView = microsoftError
        ? unavailableMicrosoftEntraRiskyUsers(
            'ERROR',
            'Microsoft Entra risky-user evidence could not be loaded.'
          )
        : adaptMicrosoftRiskyUsersResponse(microsoftData)

      const channel = microsoftChannel(microsoftView)
      const count = nativeRiskyUserCount(nativeView)
      const list = nativeRiskyUserList(
        nativeView,
        channel,
        microsoftView.users
      )

      if (assessmentError) {
        failedTenantCount++
      }

      const status: TenantFleetStatus['status'] = assessmentQuery?.isLoading
        ? 'LOADING'
        : assessmentError
        ? 'FAILED'
        : nativeView === null
        ? 'UNAVAILABLE'
        : 'SUCCESS'

      tenantStatuses.push({
        tenantId: tenant.id,
        tenantName,
        tenantDomain,
        status,
        count,
        channel,
        userCount: list.rows.length,
      })

      list.rows.forEach((row) => {
        const fleetRow: FleetRiskyUserRow = {
          ...row,
          tenantId: tenant.id,
          tenantName,
          tenantDomain,
        }
        allRows.push(fleetRow)

        if (row.detection.microsoft === 'REPORTED') {
          totalMicrosoftUsers++
        }
        if (row.reasons.length > 0) {
          totalHawkViewUsers++
        }
        if (row.detection.microsoft === 'REPORTED' && row.reasons.length > 0) {
          totalBothUsers++
        }
      })
    })

    return {
      fleetRows: allRows,
      tenantStatuses,
      totalTenants: safeTenants.length,
      failedTenants: failedTenantCount,
      totalHawkViewUsers,
      totalMicrosoftUsers,
      totalBothUsers,
    }
  }, [safeTenants, assessmentQueries, microsoftQueries])

  return {
    tenants: safeTenants,
    fleetRows: fleetData.fleetRows,
    tenantStatuses: fleetData.tenantStatuses,
    metrics: {
      totalTenants: fleetData.totalTenants,
      failedTenants: fleetData.failedTenants,
      totalHawkViewUsers: fleetData.totalHawkViewUsers,
      totalMicrosoftUsers: fleetData.totalMicrosoftUsers,
      totalBothUsers: fleetData.totalBothUsers,
      totalRiskyUsers: fleetData.fleetRows.length,
    },
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
