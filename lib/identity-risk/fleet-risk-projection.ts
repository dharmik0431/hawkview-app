import { adaptMicrosoftRiskyUsersResponse } from './adapter.ts'
import { adaptNativeAssessment } from './native-assessment.ts'
import { nativeRiskyUserCount, nativeRiskyUserList } from './native-view.ts'
import { microsoftChannel, microsoftVerdictPolarity, type RiskyUserRow } from './risky-users-view.ts'
import type { CorrelationRef } from './types.ts'

// Matches SERVICE_FRESHNESS_WINDOWS.incremental.agingMs. The detail contract
// carries persisted clocks, not the collector's present operational state.
export const FLEET_EVIDENCE_MAX_AGE_MS = 2 * 60 * 60 * 1000
// Microsoft risk snapshots use the producer's independent 36-hour policy.
export const MICROSOFT_EVIDENCE_MAX_AGE_MS = 36 * 60 * 60 * 1000
export type FleetEvidenceState = 'CURRENT' | 'HISTORICAL' | 'UNKNOWN'
export type FleetQuery = { data?: unknown; isError?: boolean; isLoading?: boolean; isFetching?: boolean }
export type FleetTenant = {
  id: string; name?: string | null; domain?: string | null
  status?: 'pending' | 'active' | 'suspended' | 'disconnected'
  connectionStatus?: 'pending-consent' | 'connected' | 'error' | 'revoked' | null
}
export type FleetRiskyUserRow = RiskyUserRow & {
  tenantId: string; tenantName: string; tenantDomain?: string | null
  evidenceState?: FleetEvidenceState
}

export type FleetSourceState = 'READY' | 'LOADING' | 'READ_FAILED' | 'LICENSE_REQUIRED' | 'PERMISSION_REQUIRED' | 'DISABLED' | 'STALE' | 'MISSING' | 'SOURCE_UNAVAILABLE' | 'UNCONFIRMED' | 'INCOMPLETE'

export const fleetSourceStateCopy: Record<FleetSourceState, string> = {
  READY: 'Complete current evidence',
  LOADING: 'Loading results',
  READ_FAILED: 'Results could not be loaded',
  LICENSE_REQUIRED: 'Microsoft reports a license requirement',
  PERMISSION_REQUIRED: 'Microsoft reports missing permission',
  DISABLED: 'Assessment is not enabled',
  STALE: 'Retained evidence is older than the freshness window',
  MISSING: 'No assessment or collection result is available',
  SOURCE_UNAVAILABLE: 'Source evidence is unavailable',
  UNCONFIRMED: 'Evidence freshness or validity could not be confirmed',
  INCOMPLETE: 'Evidence or delivered user details are incomplete',
}

function readState(query: FleetQuery | undefined): FleetSourceState | null {
  if (query?.isLoading || query?.isFetching) return 'LOADING'
  if (query?.isError) return 'READ_FAILED'
  return null
}

function clockState(values: (string | null | undefined)[], now: number, maxAge = FLEET_EVIDENCE_MAX_AGE_MS): FleetEvidenceState {
  const clocks = values.map((value) => value ? Date.parse(value) : NaN)
  if (!clocks.length || clocks.some((value) => !Number.isFinite(value) || value > now)) return 'UNKNOWN'
  return clocks.some((value) => now - value > maxAge) ? 'HISTORICAL' : 'CURRENT'
}
function key(ref: CorrelationRef | null) {
  return ref?.available ? `${ref.shape}:${ref.ref}` : null
}

export function projectFleetRisk(tenants: readonly FleetTenant[], nativeQueries: readonly FleetQuery[], microsoftQueries: readonly FleetQuery[], now = Date.now()) {
  const fleetRows: FleetRiskyUserRow[] = []
  const deliveryGaps: { tenantId: string; tenantName: string; source: string; reported: number; lowerBound: boolean; shown: number; evidenceState: FleetEvidenceState; asOf: string | null }[] = []
  const tenantStatuses = tenants.map((tenant, index) => {
    const query = nativeQueries[index]
    const msQuery = microsoftQueries[index]
    // Retain cached positives during refetch/failure, but never certify them current.
    const native = adaptNativeAssessment(query?.data)
    const ms = adaptMicrosoftRiskyUsersResponse(msQuery?.data)
    const nativeReadPending = Boolean(query?.isError || query?.isLoading || query?.isFetching)
    const msReadPending = Boolean(msQuery?.isError || msQuery?.isLoading || msQuery?.isFetching)
    const channel = microsoftChannel(ms)
    const count = nativeRiskyUserCount(native)
    const selectedCollectors = native?.available
      ? native.coverage.map((stream) => native.collectors.filter((collector) => collector.source === stream.stream)) : []
    const raw = query?.data as { claim?: { permitted?: unknown }; collectors?: { source?: unknown; status?: unknown }[] } | undefined
    const rawCollectorsValid = Array.isArray(raw?.collectors) && raw.collectors.every((collector) =>
      collector && typeof collector.source === 'string' && typeof collector.status === 'string') &&
      selectedCollectors.every((collectors) => collectors.length === 1 && raw!.collectors!.filter((collector) => collector.source === collectors[0].source).length === 1)
    const nativeState = native?.available
      ? clockState([native.run.completedAt, native.run.windowEnd, ...selectedCollectors.flatMap((collectors) => collectors.length === 1 ? [collectors[0].lastSuccessfulCollectionAt] : [null])], now)
      : 'UNKNOWN'
    const nativeCurrent = native?.available && nativeState === 'CURRENT' && rawCollectorsValid && !nativeReadPending &&
      native.coverage.every(({ stream }) => ['GRAPH_SIGN_INS', 'M365_AUDIT_STS'].includes(stream)) &&
      Number.isFinite(Date.parse(native.run.windowStart!)) && Date.parse(native.run.windowStart!) <= Date.parse(native.run.windowEnd!) &&
      Date.parse(native.run.windowEnd!) <= Date.parse(native.run.completedAt!) && selectedCollectors.length > 0 &&
      selectedCollectors.every((collectors) => collectors.length === 1 && ['SUCCESS', 'EMPTY'].includes(collectors[0].status) &&
        Date.parse(collectors[0].lastSuccessfulCollectionAt!) <= Date.parse(native.run.completedAt!))
    const summary = ms.microsoftRiskSummary
    const msClock = clockState([summary?.snapshotObservedAt, summary?.collectionSucceededAt], now, MICROSOFT_EVIDENCE_MAX_AGE_MS)
    const msState: FleetEvidenceState = msClock === 'HISTORICAL' || ms.meta.status === 'STALE' ? 'HISTORICAL'
      : msClock === 'CURRENT' && Date.parse(summary!.collectionSucceededAt!) >= Date.parse(summary!.snapshotObservedAt!) && !msReadPending && channel.state === 'REPORTING' && summary?.availability !== 'UNAVAILABLE' ? 'CURRENT' : 'UNKNOWN'
    // Duplicate record IDs with conflicting keys must not bridge two people.
    const byId = new Map<string, Set<string | null>>()
    for (const user of ms.users ?? []) {
      const refs = byId.get(user.id) ?? new Set<string | null>()
      refs.add(key(user.correlation)); byId.set(user.id, refs)
    }
    const active = (ms.users ?? []).filter((user) => microsoftVerdictPolarity(user) === 'ACTIVE_RISK')
      .map((user) => ({ ...user, correlation: (byId.get(user.id)?.size ?? 0) > 1 ? null : user.correlation }))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id) || a.identityLabel.localeCompare(b.identityLabel))
    const unique = new Map<string, typeof active[number]>()
    for (const user of active) {
      const identity = key(user.correlation) ?? `record:${user.id}`
      if (!unique.has(identity)) unique.set(identity, user)
    }
    const microsoftRows = Array.from(unique.values())
    const msComplete = channel.state === 'REPORTING' && msState === 'CURRENT' && summary?.availability === 'AVAILABLE' &&
      summary.completeness === 'COMPLETE' && ms.pageInfo?.hasMore === false &&
      summary.rawRecordCount === ms.users?.length && summary.activeDistinctUserCount === microsoftRows.length &&
      Array.from(byId.values()).every((refs) => refs.size === 1)
    // The native helper groups by ref; mailbox references must not merge into users.
    const usersNative = native?.available ? { ...native, findings: native.findings.filter((finding) => finding.subject.kind === 'DIRECTORY_USER') } : native
    const list = nativeRiskyUserList(usersNative, channel, microsoftRows)
    const nativeComplete = Boolean(raw?.claim?.permitted === true && rawCollectorsValid && nativeCurrent && native?.available && native.complete && count.accuracy === 'EXACT' &&
      count.listCoverage === 'COMPLETE' && count.value === list.rows.length && native.count.covered.length > 0 &&
      native.count.notCovered.length === 0 && native.withheld.length === 0)
    // These are read/evidence states, not collector commands or diagnoses inferred
    // from missing rows. Keep the two channels independent of combined coverage.
    const nativeSource: FleetSourceState = readState(query) ?? (
      !native ? (query?.data == null ? 'MISSING' : 'UNCONFIRMED')
        : !native.available ? (['EVALUATION_DISABLED', 'NOT_ENABLED_FOR_TENANT'].includes(native.because) ? 'DISABLED' : native.because === 'NO_RUN' ? 'MISSING' : 'SOURCE_UNAVAILABLE')
        : nativeComplete ? 'READY'
        : nativeState === 'HISTORICAL' ? 'STALE'
        : selectedCollectors.some((collectors) => collectors.some((collector) => !['SUCCESS', 'EMPTY'].includes(collector.status))) ? 'SOURCE_UNAVAILABLE'
        : !nativeCurrent ? 'UNCONFIRMED' : 'INCOMPLETE'
    )
    const microsoftSource: FleetSourceState = readState(msQuery) ?? (
      msComplete ? 'READY'
        : channel.state === 'CONTRADICTORY' ? 'INCOMPLETE'
        : ms.meta.reasonCode === 'LICENSE_REQUIRED' ? 'LICENSE_REQUIRED'
        : ms.meta.reasonCode === 'MISSING_PERMISSION' ? 'PERMISSION_REQUIRED'
        : msState === 'HISTORICAL' ? 'STALE'
        : ms.meta.reasonCode === 'WAITING_FOR_COLLECTION' || msQuery?.data == null ? 'MISSING'
        : ms.meta.reasonCode === 'COLLECTION_FAILED' || summary?.reasonCode === 'COLLECTION_NOT_SUCCEEDED' || summary?.availability === 'UNAVAILABLE' ? 'SOURCE_UNAVAILABLE'
        : msState !== 'CURRENT' ? 'UNCONFIRMED' : 'INCOMPLETE'
    )
    // Presentation observations only: completeness is not operational health.
    // A failed read says nothing about whether a collector itself failed.
    const operationalWarnings: string[] = []
    if (tenant.status === 'disconnected') operationalWarnings.push('Tenant is disconnected.')
    if (tenant.connectionStatus === 'revoked') operationalWarnings.push('Tenant connection is revoked.')
    if (tenant.connectionStatus === 'error') operationalWarnings.push('Tenant connection reports an error; its cause is not established here.')
    if (rawCollectorsValid && selectedCollectors.some((collectors) => collectors.length === 1 && collectors[0].status === 'FAILED')) {
      operationalWarnings.push('A selected HawkView evidence collector reports failure.')
    }
    // COLLECTION_NOT_SUCCEEDED also describes pending/unknown collection.
    // Require a validated ERROR envelope before calling that reason a failure.
    // Adapter-generated contract errors have users=null, not a validated DTO.
    const microsoftAvailabilityLimitation = ms.meta.reasonCode === 'LICENSE_REQUIRED' || ms.meta.reasonCode === 'MISSING_PERMISSION'
    if (ms.meta.reasonCode === 'COLLECTION_FAILED' ||
      (!microsoftAvailabilityLimitation && ms.meta.status === 'ERROR' && ms.users !== null && summary?.reasonCode === 'COLLECTION_NOT_SUCCEEDED')) {
      operationalWarnings.push('Microsoft risky-user collection reports failure.')
    } else if (!microsoftAvailabilityLimitation && ms.meta.status === 'ERROR' && ms.users !== null) {
      operationalWarnings.push('Microsoft risk source reports an error; its cause is not established here.')
    }
    if (query?.isError) operationalWarnings.push('HawkView assessment results could not be loaded.')
    if (msQuery?.isError) operationalWarnings.push('Microsoft risk results could not be loaded.')
    if (nativeSource === 'STALE') operationalWarnings.push('HawkView evidence is older than its freshness window.')
    if (microsoftSource === 'STALE') operationalWarnings.push('Microsoft risk evidence is older than its freshness window.')
    const connectionObservation = tenant.status === 'disconnected' ? 'Tenant is disconnected.'
      : tenant.connectionStatus === 'revoked' ? 'Tenant connection is revoked.'
      : tenant.connectionStatus === 'connected' ? 'Tenant connection is reported connected.'
      : tenant.connectionStatus === 'pending-consent' ? 'Tenant connection is awaiting consent.'
      : tenant.connectionStatus === 'error' ? 'Tenant connection reports an error; its cause is not established here.'
      : 'Tenant connection status is unconfirmed.'
    const microsoftUnmatchedRecords = microsoftRows.filter((record) => !key(record.correlation)).length
    const matched = new Set<string>()
    const rows = list.rows.map((row) => {
      const findings = native?.available ? native.findings.filter((finding) => finding.subject.kind === 'DIRECTORY_USER' && finding.subject.ref === row.reference) : []
      const correlations = new Set(findings.map((finding) => key(finding.subject.correlation)))
      const correlation = correlations.size === 1 ? key(findings[0]?.subject.correlation ?? null) : null
      const record = correlation ? microsoftRows.find((user) => key(user.correlation) === correlation) : undefined
      if (record) matched.add(key(record.correlation) ?? `record:${record.id}`)
      return { ...row,
        evidenceState: nativeCurrent ? (record && msState !== 'CURRENT' ? msState : 'CURRENT') : nativeState === 'HISTORICAL' ? 'HISTORICAL' : 'UNKNOWN',
        detection: { hawkView: true, microsoft: record ? 'REPORTED' : msComplete && correlation ? 'NOT_REPORTED' : 'NOT_COMPARABLE',
          microsoftRecord: record ?? null, because: record ? null : 'Microsoft comparison is incomplete or this identity cannot be matched.' },
      } as RiskyUserRow & { evidenceState: FleetEvidenceState }
    })
    for (const record of microsoftRows) {
      if (matched.has(key(record.correlation) ?? `record:${record.id}`)) continue
      rows.push({ id: `microsoft:${record.id}`, name: record.identityLabel, email: null, reference: record.id,
        subjectType: 'USER', priority: null, priorityLabel: 'Not ranked', lastSeen: record.observedAt,
        lastSeenFrom: null, lastSeenState: 'DATED', reasons: [],
        detection: { hawkView: false, microsoft: 'REPORTED', microsoftRecord: record, because: null },
        protection: { label: 'Protection not reported on this response', tone: 'unknown' }, user: null,
        evidenceState: msState,
      } as unknown as RiskyUserRow & { evidenceState: FleetEvidenceState })
    }
    const tenantName = tenant.name || tenant.domain || tenant.id
    if (count.value !== null && count.value > list.rows.length) deliveryGaps.push({ tenantId: tenant.id, tenantName, source: 'HawkView', reported: count.value, lowerBound: count.accuracy !== 'EXACT', shown: list.rows.length, evidenceState: nativeCurrent ? 'CURRENT' : nativeState === 'HISTORICAL' ? 'HISTORICAL' : 'UNKNOWN', asOf: native?.available ? native.run.completedAt : null })
    const msReported = summary?.activeDistinctUserCount ?? summary?.observedActiveDistinctUserCount
    if (msReported != null && msReported > microsoftRows.length) deliveryGaps.push({ tenantId: tenant.id, tenantName, source: 'Microsoft', reported: msReported, lowerBound: summary?.activeDistinctUserCount == null, shown: microsoftRows.length, evidenceState: msState, asOf: summary?.snapshotObservedAt ?? null })
    for (const row of rows) fleetRows.push({ ...row, id: `${tenant.id}:${row.id}`, tenantId: tenant.id, tenantName, tenantDomain: tenant.domain })
    return { tenantId: tenant.id, tenantName, tenantDomain: tenant.domain,
      status: query?.isLoading || msQuery?.isLoading ? 'LOADING' as const : query?.isError ? 'FAILED' as const
        : nativeComplete && msComplete ? 'SUCCESS' as const : 'UNAVAILABLE' as const,
      count, channel, userCount: rows.length, nativeSource, microsoftSource,
      operationalWarnings, connectionObservation, microsoftUnmatchedRecords,
    }
  })
  return { fleetRows, tenantStatuses, deliveryGaps, metrics: {
    totalTenants: tenants.length, failedTenants: tenantStatuses.filter((tenant) => tenant.status === 'FAILED').length,
    totalRiskyUsers: fleetRows.length,
    totalHawkViewUsers: fleetRows.filter((row) => row.reasons.length > 0).length,
    totalMicrosoftUsers: fleetRows.filter((row) => row.detection.microsoft === 'REPORTED').length,
    totalBothUsers: fleetRows.filter((row) => row.reasons.length > 0 && row.detection.microsoft === 'REPORTED').length,
  } }
}
