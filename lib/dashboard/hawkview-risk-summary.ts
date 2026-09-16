export type NativeRiskCountAccuracy = 'EXACT' | 'AT_LEAST' | 'NOT_AVAILABLE'
export type NativeRiskAvailability = 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE'

export type NativeTenantRiskSummary = {
  tenantId: string
  availability: NativeRiskAvailability
  accuracy: NativeRiskCountAccuracy
  distinctUserCount: number | null
  evaluatedAt: string | null
  windowStart: string | null
  windowEnd: string | null
  complete: boolean
  limitations: string[]
}

export type NativeFleetRiskSummary = {
  availability: NativeRiskAvailability
  accuracy: NativeRiskCountAccuracy
  distinctUserCount: number | null
  assessedTenants: number
  totalTenants: number
  enumeratedTenants: number
  scopeComplete: boolean
  limitations: string[]
}

export type NativeRiskSummaryResponse = {
  contractVersion: 'hawkview-native-risk-summary/v1'
  source: 'HAWKVIEW_NATIVE_ASSESSMENT'
  countUnit: 'TENANT_USER_IDENTITIES'
  generatedAt: string
  fleet: NativeFleetRiskSummary
  tenants: NativeTenantRiskSummary[]
}

export type HawkViewRiskStatus = {
  count: number | null
  exact: boolean
  display: string
  accessibleValue: string
  state: 'available' | 'partial' | 'withheld' | 'loading' | 'failed' | 'unavailable'
  detail: string
}

export function formatNativeRiskClock(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not reported'
  return new Date(value).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
}

function tenantLimitation(status: NativeTenantRiskSummary): string {
  if (status.limitations.includes('NOT_ENABLED_FOR_TENANT')) return 'HawkView assessment is not enabled for this tenant.'
  if (status.limitations.includes('EVALUATION_DISABLED')) return 'HawkView assessment is currently disabled.'
  if (status.limitations.includes('COUNT_WITHHELD')) return 'The saved assessment does not support a user count.'
  if (status.limitations.includes('INVALID_RUN')) return 'The saved assessment could not be validated; its count is withheld.'
  if (status.limitations.includes('READ_LIMIT_EXCEEDED')) return 'The saved assessment exceeds this summary’s read limit; its count is withheld.'
  return 'No current HawkView assessment is available for this tenant.'
}

export function presentHawkViewTenantRisk(
  status: NativeTenantRiskSummary | undefined,
  requestState: 'LOADING' | 'ERROR' | 'SUCCESS' = 'SUCCESS',
): HawkViewRiskStatus {
  if (requestState !== 'SUCCESS' || !status) {
    if (requestState === 'ERROR') {
      return {
        count: null,
        exact: false,
        display: 'Could not load',
        accessibleValue: 'HawkView assessment could not be loaded',
        state: 'failed',
        detail: 'HawkView assessment could not be loaded',
      }
    }
    return {
      count: null,
      exact: false,
      display: requestState === 'LOADING' ? 'Loading' : 'Not available',
      accessibleValue:
        requestState === 'LOADING'
          ? 'HawkView assessment loading'
          : 'HawkView assessment not available',
      state: requestState === 'LOADING' ? 'loading' : 'unavailable',
      detail:
        requestState === 'LOADING'
          ? 'HawkView assessment is still loading'
          : 'No HawkView assessment summary was returned for this tenant',
    }
  }

  if (status.availability === 'UNAVAILABLE') {
    return {
      count: null,
      exact: false,
      display: 'Not available',
      accessibleValue: 'HawkView assessment not available',
      state: 'unavailable',
      detail: tenantLimitation(status),
    }
  }

  if (status.distinctUserCount === null) {
    return {
      count: null,
      exact: false,
      display: status.accuracy === 'NOT_AVAILABLE' ? 'Not available' : 'Not counted',
      accessibleValue: 'HawkView risky-user count not available',
      state: status.accuracy === 'NOT_AVAILABLE' ? 'withheld' : 'unavailable',
      detail: status.limitations.length > 0
        ? 'HawkView cannot state a tenant total for the current assessment.'
        : 'HawkView did not return a tenant count.',
    }
  }

  const exact =
    status.availability === 'AVAILABLE' &&
    status.accuracy === 'EXACT' &&
    status.complete
  return {
    count: status.distinctUserCount,
    exact,
    display: exact
      ? status.distinctUserCount.toLocaleString()
      : `≥${status.distinctUserCount.toLocaleString()}`,
    accessibleValue: exact
      ? status.distinctUserCount.toLocaleString()
      : `At least ${status.distinctUserCount.toLocaleString()}`,
    state: exact ? 'available' : 'partial',
    detail: exact
      ? 'Distinct users with at least one current HawkView finding.'
      : 'A lower bound from the current HawkView assessment; some scope was unavailable.',
  }
}

export type HawkViewPortfolioRisk = HawkViewRiskStatus & {
  assessedTenants: number
  totalTenants: number | null
}

/**
 * Present the server-owned fleet aggregate. This deliberately never rebuilds
 * the total from rendered or paginated rows.
 */
export function summarizeHawkViewPortfolioRisk(
  fleet: NativeFleetRiskSummary | undefined,
  requestState: 'LOADING' | 'ERROR' | 'SUCCESS'
): HawkViewPortfolioRisk {
  if (requestState === 'LOADING') {
    return {
      count: null,
      exact: false,
      display: 'Loading',
      accessibleValue: 'HawkView fleet assessment loading',
      state: 'loading',
      detail: 'HawkView is loading the fleet risk summary.',
      assessedTenants: 0,
      totalTenants: null,
    }
  }

  if (requestState === 'ERROR' || !fleet) {
    return {
      count: null,
      exact: false,
      display: 'Unavailable',
      accessibleValue: 'HawkView fleet assessment unavailable',
      state: 'failed',
      detail: 'The HawkView risk summary could not be loaded. Counts are withheld until a retry succeeds.',
      assessedTenants: 0,
      totalTenants: null,
    }
  }

  if (fleet.distinctUserCount === null) {
    return {
      count: null,
      exact: false,
      display: 'Not available',
      accessibleValue: 'HawkView fleet assessment not available',
      state: fleet.availability === 'UNAVAILABLE' ? 'unavailable' : 'withheld',
      detail: fleet.totalTenants === 0
        ? 'No managed tenants are in scope.'
        : 'HawkView cannot state a fleet total for the current assessment scope.',
      assessedTenants: fleet.assessedTenants,
      totalTenants: fleet.totalTenants,
    }
  }

  const exact =
    fleet.availability === 'AVAILABLE' &&
    fleet.accuracy === 'EXACT' &&
    fleet.scopeComplete

  return {
    count: fleet.distinctUserCount,
    exact,
    display: exact
      ? fleet.distinctUserCount.toLocaleString()
      : `≥${fleet.distinctUserCount.toLocaleString()}`,
    accessibleValue: exact
      ? fleet.distinctUserCount.toLocaleString()
      : `At least ${fleet.distinctUserCount.toLocaleString()}`,
    state: exact ? 'available' : 'partial',
    detail: (exact
      ? `Users with HawkView findings across all ${fleet.totalTenants.toLocaleString()} assessed tenants.`
      : `At least ${fleet.distinctUserCount.toLocaleString()} users were found across ${fleet.assessedTenants.toLocaleString()} of ${fleet.totalTenants.toLocaleString()} tenant assessments.`) +
      (!fleet.scopeComplete ? ` Summary limited to ${fleet.enumeratedTenants.toLocaleString()} tenants.` : '') + ' Users are counted separately in each tenant.',
    assessedTenants: fleet.assessedTenants,
    totalTenants: fleet.totalTenants,
  }
}
