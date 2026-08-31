export type ConditionalAccessOverviewPolicy = {
  state: 'ON' | 'REPORT_ONLY' | 'OFF'
}

export type ConditionalAccessOverviewEvidence = {
  availability: string
  count: number | null
}

export type ConditionalAccessOverviewState = {
  authoritative: boolean
  value: string
  detail: string
  status: 'healthy' | 'warning' | 'neutral'
  contributesWarning: boolean
}

const unavailable = (
  value: string,
  detail: string,
): ConditionalAccessOverviewState => ({
  authoritative: false,
  value,
  detail,
  status: 'neutral',
  contributesWarning: false,
})

export function conditionalAccessOverviewState(
  evidence: ConditionalAccessOverviewEvidence | null | undefined,
  policies: ConditionalAccessOverviewPolicy[],
): ConditionalAccessOverviewState {
  const availability = evidence?.availability ?? 'UNVERIFIED'
  const count = evidence?.count ?? null

  if (availability === 'NOT_LICENSED') {
    return unavailable(
      'Conditional Access is not licensed for this tenant',
      'Security Defaults is reported separately and does not prove Conditional Access or universal MFA enforcement.',
    )
  }
  if (availability === 'NOT_APPLICABLE') {
    return unavailable(
      'Conditional Access is not applicable',
      'No Conditional Access compliance result is available for this tenant.',
    )
  }
  if (availability === 'BLOCKED_PERMISSION') {
    return unavailable(
      'Conditional Access permission required',
      'HawkView cannot evaluate Conditional Access until the required read permission is granted.',
    )
  }
  if (availability === 'STALE') {
    return unavailable(
      'Conditional Access evidence is stale',
      'HawkView will not calculate policy posture from evidence that is no longer current.',
    )
  }
  if (availability !== 'READY') {
    return unavailable(
      'Conditional Access evidence unavailable',
      'HawkView does not have current authoritative Conditional Access evidence.',
    )
  }

  if (count === 0) {
    return {
      authoritative: true,
      value: 'No Conditional Access policies found',
      detail: 'Microsoft returned a current authoritative empty policy list.',
      status: 'neutral',
      contributesWarning: false,
    }
  }

  if (
    count === null ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    policies.length !== count
  ) {
    return unavailable(
      'Conditional Access policy details unavailable',
      'Current policy details do not match the authoritative evidence count.',
    )
  }

  const enabled = policies.filter((policy) => policy.state === 'ON').length
  const warning = enabled === 0
  return {
    authoritative: true,
    value: `${enabled} of ${count} Conditional Access policies enabled`,
    detail: 'Access control and risk enforcement',
    status: warning ? 'warning' : 'healthy',
    contributesWarning: warning,
  }
}
