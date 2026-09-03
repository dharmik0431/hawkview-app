'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/components/providers/auth-provider'
import { apiClient } from './client'
import {
  adaptIdentityRiskResponses,
  unavailableHawkViewIdentitySignals,
  unavailableMicrosoftEntraRiskyUsers,
} from '@/lib/identity-risk/adapter'

export function useIdentityRiskChannels(tenantId: string, enabled: boolean) {
  const { cacheScope } = useAuth()
  const encodedTenantId = encodeURIComponent(tenantId)

  const summary = useQuery<unknown>({
    queryKey: ['identity-risk', cacheScope, tenantId, 'hawkview-summary'],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodedTenantId}/identity-signals/summary`, {
        signal,
      }),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 60_000,
  })
  const findings = useQuery<unknown>({
    queryKey: ['identity-risk', cacheScope, tenantId, 'hawkview-findings'],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodedTenantId}/identity-signals/findings`, {
        signal,
      }),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 60_000,
  })
  const microsoft = useQuery<unknown>({
    queryKey: ['identity-risk', cacheScope, tenantId, 'microsoft-risky-users'],
    queryFn: ({ signal }) =>
      apiClient.get(`/api/tenants/${encodedTenantId}/microsoft-entra-risky-users`, {
        signal,
      }),
    enabled: enabled && Boolean(tenantId),
    retry: false,
    staleTime: 60_000,
  })

  const viewModel = useMemo(() => {
    const adapted = adaptIdentityRiskResponses({
      hawkViewSummary: summary.data,
      hawkViewFindings: findings.data,
      microsoftRiskyUsers: microsoft.data,
    })

    if (summary.isError || findings.isError) {
      adapted.hawkView = unavailableHawkViewIdentitySignals(
        'ERROR',
        'HawkView identity signals could not be loaded. Retry without assuming the absence of findings.'
      )
    }
    if (microsoft.isError) {
      adapted.microsoft = unavailableMicrosoftEntraRiskyUsers(
        'ERROR',
        'Microsoft Entra risky-user evidence could not be loaded. This does not mean no risky users were reported.'
      )
    }
    return adapted
  }, [findings.data, findings.isError, microsoft.data, microsoft.isError, summary.data, summary.isError])

  return {
    viewModel,
    hawkViewLoading: summary.isLoading || findings.isLoading,
    microsoftLoading: microsoft.isLoading,
    retryHawkView: () => Promise.all([summary.refetch(), findings.refetch()]),
    retryMicrosoft: () => microsoft.refetch(),
  }
}
