'use client'

import { useMemo } from 'react'
import {
  microsoftChannel,
  riskyUserCount,
  riskyUserList,
} from '@/lib/identity-risk/risky-users-view'
import { useIdentityRiskChannels } from './identity-risk-hooks'

/**
 * The single read behind all three Risky Users views. The count on the tenant
 * overview, the list and the detail all derive from one assessment, so they
 * cannot show a technician three different answers about the same tenant.
 */
export function useRiskyUsers(tenantId: string, enabled = true) {
  const {
    assessmentView,
    assessmentLoading,
    assessmentRequestError,
    assessmentContractError,
    microsoftView,
    microsoftLoading,
    cacheScope,
    retryAssessment,
    retryMicrosoft,
  } = useIdentityRiskChannels(tenantId, enabled)

  const channel = useMemo(
    () => microsoftChannel(microsoftView),
    [microsoftView]
  )

  const count = useMemo(
    () =>
      riskyUserCount({
        assessment: assessmentView,
        channel,
        requestFailed: assessmentRequestError,
        contractFailed: assessmentContractError,
      }),
    [assessmentView, channel, assessmentRequestError, assessmentContractError]
  )

  // Correlating a HawkView pseudonym to a Microsoft directory object needs a key
  // both channels agree on, which the contract does not yet carry. Passing none
  // is what makes a row say "not comparable" rather than claiming Microsoft
  // reported nothing about that person.
  const list = useMemo(
    () => riskyUserList(assessmentView, channel, null),
    [assessmentView, channel]
  )

  return {
    assessment: assessmentView,
    channel,
    count,
    list,
    microsoftView,
    loading: assessmentLoading || microsoftLoading,
    requestFailed: assessmentRequestError,
    contractFailed: assessmentContractError,
    cacheScope,
    retry: () => {
      void retryAssessment()
      void retryMicrosoft()
    },
  }
}
