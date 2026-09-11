'use client'

import React, { useCallback, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Users,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useRiskyUsers } from '@/lib/api/risky-users-hooks'
import { useTenantOperationalProjection } from '@/lib/api/hooks'
import { FleetRiskAssessmentDrawer } from '@/components/identity-risk/fleet-risk-assessment-drawer'
import type { FleetRiskyUserRow } from '@/lib/api/fleet-risky-users-hooks'
import {
  getUserDisplayName,
  getUserEmailOrUpn,
  mapRuleToPresentation,
} from '@/lib/identity-risk/risk-presentation-mapper'
import { microsoftRecordsByPolarity } from '@/lib/identity-risk/risky-users-view'
import type { RiskyUserRow } from '@/lib/identity-risk/risky-users-view'

function formatTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not reported'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function getInitials(name: string, email: string): string {
  if (name && name !== 'Identity not resolved') {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2 && parts[0][0] && parts[parts.length - 1][0]) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    if (parts[0].length >= 2) {
      return parts[0].substring(0, 2).toUpperCase()
    }
  }
  if (email && email.includes('@')) {
    const cleanRef = email.split('@')[0]
    if (cleanRef.length >= 2) return cleanRef.substring(0, 2).toUpperCase()
  }
  return 'RU'
}

function LatestEvidenceCell({ row }: { row: RiskyUserRow }) {
  if (!row.lastSeen) {
    return <span className="text-xs text-slate-400 dark:text-slate-500 italic">No time recorded</span>
  }

  const formattedDate = formatTimestamp(row.lastSeen)

  let qualifier = 'Last observed'
  if (
    row.lastSeenFrom &&
    typeof row.lastSeenFrom === 'object' &&
    row.lastSeenFrom.kind === 'STATE_OBSERVED'
  ) {
    qualifier = 'Last evaluated'
  } else if (row.detection.microsoft === 'REPORTED' && row.reasons.length === 0) {
    qualifier = 'Last reported by Entra'
  }

  return (
    <div className="space-y-0.5">
      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
        {formattedDate}
      </div>
      <div className="text-2xs text-slate-500 dark:text-slate-400 font-medium">
        {qualifier}
      </div>
    </div>
  )
}

function DataStateBadge({ row }: { row: RiskyUserRow }) {
  if (row.detection.microsoft === 'UNAVAILABLE') {
    return (
      <Badge
        variant="outline"
        className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700 text-2xs gap-1 font-medium shrink-0"
      >
        <ShieldOff className="h-3 w-3 text-slate-400 shrink-0" />
        Partial Source
      </Badge>
    )
  }
  if (row.lastSeenState === 'DATELESS') {
    return (
      <Badge
        variant="outline"
        className="bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-800 text-2xs gap-1 font-medium shrink-0"
      >
        <Clock3 className="h-3 w-3 text-amber-500 shrink-0" />
        Dateless
      </Badge>
    )
  }
  if (row.lastSeenState === 'NO_REASONS') {
    return (
      <Badge
        variant="outline"
        className="bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700 text-2xs gap-1 font-medium shrink-0"
      >
        <AlertCircle className="h-3 w-3 text-slate-400 shrink-0" />
        Not Available
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800 text-2xs gap-1 font-medium shrink-0"
    >
      <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
      Current
    </Badge>
  )
}

function FoundByBadges({ row }: { row: RiskyUserRow }) {
  const isHawkView = row.reasons.length > 0
  const isMicrosoft = row.detection.microsoft === 'REPORTED'

  if (isHawkView && isMicrosoft) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800 text-2xs font-semibold">
          HawkView
        </Badge>
        <Badge variant="secondary" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800 text-2xs font-semibold">
          Microsoft
        </Badge>
      </div>
    )
  }

  if (isHawkView && !isMicrosoft) {
    const isPartial =
      row.detection.microsoft === 'UNAVAILABLE' ||
      row.detection.microsoft === 'NOT_COMPARABLE' ||
      Boolean(row.detection.because)

    if (isPartial) {
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800 text-2xs font-semibold">
            HawkView
          </Badge>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800 text-2xs font-medium cursor-help">
                  Microsoft coverage partial
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {row.detection.because || 'Microsoft Entra ID Protection risk data could not be compared or matched for this tenant identity.'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )
    }

    return (
      <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800 text-2xs font-semibold">
        HawkView
      </Badge>
    )
  }

  if (isMicrosoft) {
    return (
      <Badge variant="secondary" className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800 text-2xs font-semibold">
        Microsoft
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="text-2xs font-medium text-slate-500">
      Not reported
    </Badge>
  )
}

function WhyNeedsReviewCell({ row }: { row: RiskyUserRow }) {
  const primaryReason = row.reasons[0]
  const isMicrosoft = row.detection.microsoft === 'REPORTED'

  const mapped = primaryReason
    ? mapRuleToPresentation(primaryReason.ruleId, primaryReason.signal)
    : isMicrosoft
    ? {
        plainTitle: 'Microsoft detected elevated identity risk',
        plainExplanation: 'Microsoft Entra ID Protection reported active risk for this identity based on security telemetry.',
      }
    : {
        plainTitle: 'Security activity needs review',
        plainExplanation: 'Observed security indicators require manual verification in tenant logs.',
      }

  const additionalCount = row.reasons.length > 1 ? row.reasons.length - 1 : 0

  return (
    <div className="space-y-0.5 max-w-md">
      <div className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-100">
        {mapped.plainTitle}
      </div>
      <div className="text-2xs sm:text-xs text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">
        {mapped.plainExplanation}
      </div>
      {additionalCount > 0 && (
        <Badge
          variant="secondary"
          className="mt-1 text-2xs bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 font-normal px-1.5 py-0"
        >
          +{additionalCount} additional finding{additionalCount > 1 ? 's' : ''}
        </Badge>
      )}
    </div>
  )
}

function CompactSummaryStrip({
  count,
  rows,
  microsoftView,
  channel,
  asOf,
}: {
  count: any
  rows: RiskyUserRow[]
  microsoftView: any
  channel: any
  asOf: string | null
}) {
  // 1. Users requiring review
  const usersRequiringReviewText =
    count?.value !== null && count?.value !== undefined
      ? `${count.display} users requiring review`
      : `Users requiring review: ${count?.display || 'Not available'}`

  // 2. HawkView detections
  const hawkViewUsers = rows.filter((r) => r.reasons.length > 0).length
  const hawkViewText = `${hawkViewUsers} detected by HawkView`

  // 3. Active Microsoft risk detections
  const activeMsCount =
    microsoftView?.users !== null && microsoftView?.users !== undefined
      ? microsoftRecordsByPolarity(microsoftView).ACTIVE_RISK.length
      : null
  const microsoftText =
    activeMsCount !== null
      ? `${activeMsCount} active Microsoft risk`
      : 'Microsoft risk: Not available'

  // 4. Assessment date
  const assessedText = asOf ? `Assessed ${formatTimestamp(asOf)}` : 'Assessment time: Not reported'

  const isUnmatchedOrPartial =
    rows.some(
      (r) =>
        Boolean(r.detection.because) ||
        r.detection.microsoft === 'UNAVAILABLE' ||
        r.detection.microsoft === 'NOT_COMPARABLE'
    ) ||
    microsoftView?.meta?.status === 'UNAVAILABLE' ||
    channel?.state === 'CONTRADICTORY'

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs sm:text-sm">
          {/* Fact 1 */}
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-slate-500 shrink-0" />
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {usersRequiringReviewText}
            </span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-slate-200 dark:bg-slate-800" />

          {/* Fact 2 */}
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {hawkViewText}
            </span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-slate-200 dark:bg-slate-800" />

          {/* Fact 3 */}
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-purple-600 dark:text-purple-400 shrink-0" />
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {microsoftText}
            </span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-slate-200 dark:bg-slate-800" />

          {/* Fact 4 */}
          <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 text-xs">
            <Clock3 className="h-4 w-4 shrink-0 text-slate-400" />
            <span>{assessedText}</span>
          </div>
        </div>
      </div>

      {isUnmatchedOrPartial && (
        <div className="rounded-lg border border-amber-200/80 bg-amber-50/80 p-3 dark:border-amber-900/60 dark:bg-amber-950/40 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
          <ShieldOff className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span>
            Some Microsoft risk records could not be matched to HawkView identities. Microsoft coverage may be incomplete.
          </span>
        </div>
      )}
    </div>
  )
}

export default function RiskyUsersSection({ tenantId }: { tenantId: string }) {
  const { tenant } = useTenantOperationalProjection(tenantId)
  const {
    native,
    channel,
    count,
    list,
    microsoftView,
    loading,
    requestFailed,
    contractFailed,
    cacheScope,
    retry,
  } = useRiskyUsers(tenantId)

  const [searchQuery, setSearchQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'HAWKVIEW' | 'MICROSOFT' | 'BOTH'>('ALL')
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | 'HIGH' | 'MEDIUM' | 'LOW'>('ALL')
  const [dataStateFilter, setDataStateFilter] = useState<'ALL' | 'CURRENT' | 'STALE' | 'PARTIAL' | 'NOT_AVAILABLE'>('ALL')

  const [drawerRow, setDrawerRow] = useState<RiskyUserRow | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  const isFiltersActive =
    Boolean(searchQuery.trim()) ||
    sourceFilter !== 'ALL' ||
    priorityFilter !== 'ALL' ||
    dataStateFilter !== 'ALL'

  const resetFilters = useCallback(() => {
    setSearchQuery('')
    setSourceFilter('ALL')
    setPriorityFilter('ALL')
    setDataStateFilter('ALL')
  }, [])

  const filteredRows = useMemo(() => {
    return (list?.rows ?? []).filter((row) => {
      const displayName = getUserDisplayName(row).toLowerCase()
      const userEmail = getUserEmailOrUpn(row).toLowerCase()
      const ref = (row.reference || '').toLowerCase()

      const q = searchQuery.trim().toLowerCase()
      if (q) {
        if (!displayName.includes(q) && !userEmail.includes(q) && !ref.includes(q)) {
          return false
        }
      }

      const isHawkView = row.reasons.length > 0
      const isMicrosoft = row.detection.microsoft === 'REPORTED'
      if (sourceFilter === 'HAWKVIEW' && !isHawkView) return false
      if (sourceFilter === 'MICROSOFT' && !isMicrosoft) return false
      if (sourceFilter === 'BOTH' && (!isHawkView || !isMicrosoft)) return false

      if (priorityFilter !== 'ALL' && row.priority !== priorityFilter) {
        return false
      }

      if (dataStateFilter === 'CURRENT' && (row.lastSeenState === 'DATELESS' || row.detection.microsoft === 'UNAVAILABLE')) {
        return false
      }
      if (dataStateFilter === 'STALE' && row.lastSeenState !== 'DATELESS') {
        return false
      }
      if (dataStateFilter === 'PARTIAL' && row.detection.microsoft !== 'UNAVAILABLE' && !row.detection.because) {
        return false
      }
      if (dataStateFilter === 'NOT_AVAILABLE' && row.lastSeenState !== 'NO_REASONS') {
        return false
      }

      return true
    })
  }, [list?.rows, searchQuery, sourceFilter, priorityFilter, dataStateFilter])

  const openDrawer = (row: RiskyUserRow) => {
    setDrawerRow(row)
    setIsDrawerOpen(true)
  }

  const drawerFleetRow: FleetRiskyUserRow | null = useMemo(() => {
    if (!drawerRow) return null
    return {
      ...drawerRow,
      tenantId,
      tenantName: tenant?.name ?? 'Tenant',
      tenantDomain: tenant?.domain ?? null,
    }
  }, [drawerRow, tenantId, tenant])

  const nativeCompletedAt = native && 'run' in native && native.run ? native.run.completedAt : null
  const asOf = count?.asOf || nativeCompletedAt || microsoftView?.meta?.observedAt

  return (
    <div className="space-y-4" key={`${cacheScope}:${tenantId}`}>
      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-2xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 flex items-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin text-blue-600" />
          <span>Loading identity security assessment…</span>
        </div>
      ) : (
        <>
          {(requestFailed || contractFailed) && (
            <div
              role="alert"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <p className="font-semibold">
                {requestFailed
                  ? 'The latest assessment could not be loaded'
                  : 'The latest response could not be read'}
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                {native
                  ? 'Users below are from an earlier read and remain open. Missing evidence is not a no-findings result.'
                  : 'No current result can be confirmed.'}
              </p>
            </div>
          )}

          <CompactSummaryStrip
            count={count}
            rows={list?.rows ?? []}
            microsoftView={microsoftView}
            channel={channel}
            asOf={asOf}
          />

          <section
            aria-labelledby="risky-users-table-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900 space-y-4"
          >
            {/* Header & How it works */}
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <h2
                  id="risky-users-table-heading"
                  className="text-base sm:text-lg font-semibold text-slate-900 dark:text-white"
                >
                  Users requiring review
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Ordered by the most important current finding.
                </p>
                <details className="group mt-1">
                  <summary className="text-2xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer select-none inline-flex items-center gap-1">
                    How this works
                  </summary>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">
                    HawkView orders findings by investigation priority. HawkView rules and Microsoft Entra ID Protection operate independently and their results are never combined into a single score.
                  </p>
                </details>
              </div>

              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0 self-start sm:self-auto">
                Showing {filteredRows.length} of {(list?.rows ?? []).length} users
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px] max-w-md">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name or email..."
                    className="pl-9 h-9 text-xs"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {/* Filters */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Source filter */}
                  <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value as any)}
                    className="h-9 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="ALL">All sources</option>
                    <option value="HAWKVIEW">HawkView</option>
                    <option value="MICROSOFT">Microsoft</option>
                    <option value="BOTH">Both sources</option>
                  </select>

                  {/* Priority filter */}
                  <select
                    value={priorityFilter}
                    onChange={(e) => setPriorityFilter(e.target.value as any)}
                    className="h-9 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="ALL">All priorities</option>
                    <option value="HIGH">High priority</option>
                    <option value="MEDIUM">Medium priority</option>
                    <option value="LOW">Low priority</option>
                  </select>

                  {/* Data state filter */}
                  <select
                    value={dataStateFilter}
                    onChange={(e) => setDataStateFilter(e.target.value as any)}
                    className="h-9 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="ALL">All data states</option>
                    <option value="CURRENT">Current</option>
                    <option value="STALE">Stale</option>
                    <option value="PARTIAL">Partial</option>
                    <option value="NOT_AVAILABLE">Not available</option>
                  </select>

                  {isFiltersActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={resetFilters}
                      className="h-9 px-2.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
                    >
                      Reset filters
                    </Button>
                  )}
                </div>
              </div>

              {/* Secondary Refresh Assessment Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={retry}
                className="h-9 text-xs font-medium shrink-0 self-start md:self-auto"
                title="Refresh risk assessment"
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5 text-slate-500" />
                Refresh assessment
              </Button>
            </div>

            {/* Desktop Table View */}
            <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-200/80 dark:border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50/70 hover:bg-slate-50/70 dark:bg-slate-900/50">
                    <TableHead className="w-[220px] text-xs font-semibold text-slate-700 dark:text-slate-300">
                      User
                    </TableHead>
                    <TableHead className="min-w-[240px] text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Why this user needs review
                    </TableHead>
                    <TableHead className="w-[160px] text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Found by
                    </TableHead>
                    <TableHead className="w-[160px] text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Latest evidence
                    </TableHead>
                    <TableHead className="w-[120px] text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Data state
                    </TableHead>
                    <TableHead className="w-[100px] text-right text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Action
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center py-8 text-xs text-slate-500 dark:text-slate-400"
                      >
                        {isFiltersActive
                          ? 'No users match the active search or filters.'
                          : 'No users requiring review found.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRows.map((row) => {
                      const displayName = getUserDisplayName(row)
                      const userEmail = getUserEmailOrUpn(row)

                      return (
                        <TableRow
                          key={row.id}
                          className="hover:bg-slate-50/60 dark:hover:bg-slate-900/40 cursor-pointer transition-colors"
                          onClick={() => openDrawer(row)}
                        >
                          {/* User */}
                          <TableCell className="align-top py-3.5">
                            <div className="flex items-start gap-3 min-w-0">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-bold text-xs border border-slate-200 dark:border-slate-700">
                                {getInitials(displayName, userEmail)}
                              </div>
                              <div className="min-w-0 space-y-0.5">
                                <div className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                                  {displayName}
                                </div>
                                <div className="text-2xs sm:text-xs text-slate-500 dark:text-slate-400 truncate">
                                  {userEmail}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          {/* Why needs review */}
                          <TableCell className="align-top py-3.5">
                            <WhyNeedsReviewCell row={row} />
                          </TableCell>

                          {/* Found by */}
                          <TableCell className="align-top py-3.5">
                            <FoundByBadges row={row} />
                          </TableCell>

                          {/* Latest evidence */}
                          <TableCell className="align-top py-3.5">
                            <LatestEvidenceCell row={row} />
                          </TableCell>

                          {/* Data state */}
                          <TableCell className="align-top py-3.5">
                            <DataStateBadge row={row} />
                          </TableCell>

                          {/* Action */}
                          <TableCell className="align-top py-3.5 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                openDrawer(row)
                              }}
                              className="h-8 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              Investigate
                              <ChevronRight className="ml-1 h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Mobile / Tablet Cards View */}
            <div className="md:hidden space-y-3">
              {filteredRows.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-800 rounded-xl">
                  {isFiltersActive
                    ? 'No users match the active search or filters.'
                    : 'No users requiring review found.'}
                </div>
              ) : (
                filteredRows.map((row) => {
                  const displayName = getUserDisplayName(row)
                  const userEmail = getUserEmailOrUpn(row)

                  return (
                    <div
                      key={row.id}
                      onClick={() => openDrawer(row)}
                      className="p-4 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 space-y-3 cursor-pointer hover:border-slate-300 dark:hover:border-slate-700 transition"
                    >
                      {/* Identity Header */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-bold text-xs border border-slate-200 dark:border-slate-700">
                            {getInitials(displayName, userEmail)}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {displayName}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                              {userEmail}
                            </div>
                          </div>
                        </div>

                        <DataStateBadge row={row} />
                      </div>

                      {/* Reason */}
                      <WhyNeedsReviewCell row={row} />

                      {/* Source & Evidence Footer */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                        <FoundByBadges row={row} />
                        <LatestEvidenceCell row={row} />
                      </div>

                      {/* Action */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDrawer(row)
                        }}
                        className="w-full justify-between h-9 text-xs font-semibold mt-1"
                      >
                        <span>Investigate findings</span>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          {/* Context / Supporting Evidence Section if present */}
          {Boolean(list?.context?.length) && (
            <section
              aria-labelledby="risky-users-context-heading"
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-slate-800 dark:bg-slate-900 space-y-3"
            >
              <h3
                id="risky-users-context-heading"
                className="text-sm font-semibold text-slate-900 dark:text-slate-50"
              >
                Supporting evidence
              </h3>
              <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Mailbox-scoped and historical evidence. It is deliberately not counted above to avoid overstating today&rsquo;s actionable user count.
              </p>
              <div className="space-y-2">
                {list.context.map((row) => {
                  const displayName = getUserDisplayName(row)
                  const userEmail = getUserEmailOrUpn(row)
                  return (
                    <div
                      key={row.id}
                      onClick={() => openDrawer(row)}
                      className="p-3 rounded-lg border border-slate-200/80 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900/40 flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-100/60 dark:hover:bg-slate-800/50"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                          {displayName}
                        </div>
                        <div className="text-2xs text-slate-500 dark:text-slate-400 truncate">
                          {userEmail}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDrawer(row)
                        }}
                        className="h-7 text-2xs px-2"
                      >
                        Investigate
                      </Button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}

      {/* Shared Investigation Drawer */}
      <FleetRiskAssessmentDrawer
        row={drawerFleetRow}
        isOpen={isDrawerOpen && Boolean(drawerFleetRow)}
        onClose={() => {
          setIsDrawerOpen(false)
          setDrawerRow(null)
        }}
      />
    </div>
  )
}
