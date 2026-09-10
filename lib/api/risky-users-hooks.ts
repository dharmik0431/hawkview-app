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

  // Microsoft's records go in so the join can be made per user. The matching
  // rule lives in the view model, which is where it is tested: same shape and
  // same ref, never across shapes, and never a claim that Microsoft cleared
  // someone it could not be asked about.
  const list = useMemo(
    () => riskyUserList(assessmentView, channel, microsoftView.users),
    [assessmentView, channel, microsoftView.users]
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
