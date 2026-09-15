'use client'

import React, { useMemo, useState } from 'react'
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Filter,
  Globe,
  RefreshCw,
  AlertTriangle,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Users,
} from 'lucide-react'
import {
  fleetCoverage,
  riskyUsersSummary,
  type FleetSize,
} from '@/lib/identity-risk/fleet-coverage'
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
import type { Tenant } from '@/types/api'
import { useFleetRiskyUsers, FleetRiskyUserRow } from '@/lib/api/fleet-risky-users-hooks'
import { FleetRiskAssessmentDrawer } from '@/components/identity-risk/fleet-risk-assessment-drawer'
import {
  getUserDisplayName,
  getUserEmailOrUpn,
  mapRuleToPresentation,
} from '@/lib/identity-risk/risk-presentation-mapper'
import { cn } from '@/lib/utils'

function formatTimestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not reported'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function priorityBadgeColor(priority: FleetRiskyUserRow['priority']) {
  if (priority === 'HIGH')
    return 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200 font-semibold'
  if (priority === 'MEDIUM')
    return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300 font-semibold'
  return 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 font-medium'
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

function LatestEvidenceCell({ row }: { row: FleetRiskyUserRow }) {
  if (!row.lastSeen) {
    return <span className="text-xs text-slate-400 dark:text-slate-500 italic">No time recorded</span>
  }

  const formattedDate = formatTimestamp(row.lastSeen)

  let qualifier = 'Event occurred'
  if (
    row.lastSeenFrom &&
    typeof row.lastSeenFrom === 'object' &&
    row.lastSeenFrom.kind === 'STATE_OBSERVED'
  ) {
    qualifier = 'Setting observed'
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

function DataStateBadge({ row }: { row: FleetRiskyUserRow }) {
  if (row.detection.microsoft === 'UNAVAILABLE') {
    return (
      <Badge
        variant="outline"
        className="bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700 text-2xs gap-1 font-medium"
      >
        <ShieldOff className="h-3 w-3 text-slate-400" />
        Partial Source
      </Badge>
    )
  }
  if (row.lastSeenState === 'DATELESS') {
    return (
      <Badge
        variant="outline"
        className="bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-800 text-2xs gap-1 font-medium"
      >
        <Clock3 className="h-3 w-3 text-amber-500" />
        Dateless
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800 text-2xs gap-1 font-medium"
    >
      <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      Current
    </Badge>
  )
}

export default function FleetRiskyUsersPage() {
  const {
    tenants,
    fleetRows,
    tenantStatuses,
    metrics,
    isLoading,
    isError,
    retryAll,
  } = useFleetRiskyUsers()

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTenant, setSelectedTenant] = useState<string>('ALL')
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'HAWKVIEW' | 'MICROSOFT' | 'BOTH'>('ALL')
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | 'HIGH' | 'MEDIUM' | 'LOW'>('ALL')

  const [drawerRow, setDrawerRow] = useState<FleetRiskyUserRow | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  // ONE FACT, ONE RENDERING. The badge showed `{filteredRows.length} users`
  // and a KPI tile several inches away showed "N tenants unavailable", and
  // neither knew about the other -- so a reader asking "is my fleet clean"
  // read a number over a subset with nothing saying so.
  //
  // Derived from tenantStatuses, which the hook already computed and this page
  // discarded. It distinguishes LOADING, FAILED, UNAVAILABLE and SUCCESS;
  // `metrics.failedTenants` counts only assessmentError, so a tenant that came
  // back with no assessment was counted as fine.
  // THE KPI ROW IS ABOUT THE WHOLE FLEET, not the filtered view -- the counts
  // beside it (totalRiskyUsers and the rest) are unfiltered, so its coverage
  // has to be too or the tile would disagree with the numbers it sits under.
  // WHETHER THE FLEET COULD BE ENUMERATED AT ALL, which this page never asked.
  // `useFleetRiskyUsers` does `tenantsResponse?.tenants ?? []`, so a failed
  // tenant-list request is an empty array -- indistinguishable from an
  // organisation with nothing onboarded, and it made every coverage ratio
  // below it vacuously true. The hook has exposed `isError` all along.
  // Memoised because it is an OBJECT: a fresh literal each render would change
  // the identity the two useMemos below depend on, recomputing coverage every
  // time. Caught by lint rather than by me.
  const fleetSize: FleetSize = useMemo(
    () =>
      isError
        ? {
            kind: 'UNKNOWN',
            because:
              'The list of tenants could not be loaded, so HawkView does not know which tenants exist.',
          }
        : { kind: 'KNOWN' },
    [isError]
  )

  const fleetWide = useMemo(
    () => fleetCoverage(tenantStatuses, 'ALL', fleetSize),
    [tenantStatuses, fleetSize]
  )

  // EVERY COVERAGE CLAIM ON THIS PAGE CAME OFF `metrics.failedTenants`, which
  // counts only assessmentError. Eight sites: the tile, the heading, the
  // "N of M evaluated" lines, the styling, and the partial-coverage banner --
  // which, because it renders only when failedTenants > 0, did not appear AT
  // ALL for a fleet whose tenants came back UNAVAILABLE rather than errored.
  // One derived number now, so the page cannot tell two coverage stories.
  const notAssessed = fleetWide.inScope - fleetWide.assessed

  const coverage = useMemo(
    () => fleetCoverage(tenantStatuses, selectedTenant, fleetSize),
    [tenantStatuses, selectedTenant, fleetSize]
  )

  // Only a filter that is narrowing something may be blamed for an empty list.
  // The same four controls the "Clear filters" button resets.
  const filtersActive =
    searchQuery.trim() !== '' ||
    selectedTenant !== 'ALL' ||
    sourceFilter !== 'ALL' ||
    priorityFilter !== 'ALL'

  const filteredRows = useMemo(() => {
    return fleetRows.filter((row) => {
      const displayName = getUserDisplayName(row).toLowerCase()
      const userEmail = getUserEmailOrUpn(row).toLowerCase()
      const tenantName = (row.tenantName || '').toLowerCase()
      const tenantDomain = (row.tenantDomain || '').toLowerCase()

      // Search Query Match
      const q = searchQuery.trim().toLowerCase()
      if (q) {
        const matchesName = displayName.includes(q)
        const matchesEmail = userEmail.includes(q)
        const matchesTenant = tenantName.includes(q) || tenantDomain.includes(q)
        if (!matchesName && !matchesEmail && !matchesTenant) return false
      }

      // Tenant Filter Match
      if (selectedTenant !== 'ALL' && row.tenantId !== selectedTenant) {
        return false
      }

      // Source Filter Match
      const isHawkView = row.reasons.length > 0
      const isMicrosoft = row.detection.microsoft === 'REPORTED'
      if (sourceFilter === 'HAWKVIEW' && !isHawkView) return false
      if (sourceFilter === 'MICROSOFT' && !isMicrosoft) return false
      if (sourceFilter === 'BOTH' && (!isHawkView || !isMicrosoft)) return false

      // Priority Filter Match
      if (priorityFilter !== 'ALL' && row.priority !== priorityFilter) {
        return false
      }

      return true
    })
  }, [fleetRows, searchQuery, selectedTenant, sourceFilter, priorityFilter])

  // The badge and all three empty states come from here, so the count and the
  // coverage cannot drift apart again.
  const summary = riskyUsersSummary(
    filteredRows.length,
    coverage,
    filtersActive
  )

  const openDrawer = (row: FleetRiskyUserRow) => {
    setDrawerRow(row)
    setIsDrawerOpen(true)
  }

  // Source distributions for summary card
  const hawkViewOnlyCount = metrics.totalHawkViewUsers - metrics.totalBothUsers
  const microsoftOnlyCount = metrics.totalMicrosoftUsers - metrics.totalBothUsers
  const bothCount = metrics.totalBothUsers
  const totalDistributionSum = hawkViewOnlyCount + microsoftOnlyCount + bothCount

  const totalFindingsCount = useMemo(() => {
    return fleetRows.reduce((acc, r) => acc + r.reasons.length, 0)
  }, [fleetRows])

  const isFilterActive =
    searchQuery !== '' ||
    selectedTenant !== 'ALL' ||
    sourceFilter !== 'ALL' ||
    priorityFilter !== 'ALL'

  return (
    <div className="space-y-6 px-4 sm:px-6 py-6 md:py-8 max-w-[1440px] mx-auto text-slate-800 dark:text-slate-200">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200/80 dark:border-slate-800">
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50/80 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/80 dark:border-blue-900/50 shadow-2xs">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-[26px] font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Risky Users
            </h1>
            <p className="text-13px sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Review users requiring investigation across the Microsoft 365 tenants you manage.
            </p>
            <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 dark:text-slate-400 font-medium">
              <span>{fleetWide.assessed} of {fleetWide.inScope} tenants assessed</span>
              <span className="text-slate-300 dark:text-slate-700">•</span>
              <span>Updated continuously</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0 self-start sm:self-center">
          <Button
            variant="outline"
            size="sm"
            onClick={retryAll}
            disabled={isLoading}
            aria-label="Refresh assessment"
            aria-busy={isLoading}
            className="h-9 px-3.5 text-xs font-medium text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors shadow-2xs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-2 text-slate-500 dark:text-slate-400', isLoading && 'animate-spin')} />
            {isLoading ? 'Refreshing...' : 'Refresh assessment'}
          </Button>
        </div>
      </div>

      {/* Fleet Summary Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Primary Card: Users Requiring Review */}
        <div className="lg:col-span-5 p-5 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {notAssessed > 0 ? 'Users Shown (Partial Fleet)' : 'Users Requiring Review'}
              </span>
              <Users className="h-4 w-4 text-slate-400" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">
                {isLoading ? '...' : metrics.totalRiskyUsers}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              distinct people across the evaluated tenants
            </p>
          </div>

          {totalDistributionSum > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800/60">
              <div className="flex items-center justify-between text-2xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <span>Detection Sources</span>
                <span>{totalDistributionSum} total instances</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
                {hawkViewOnlyCount > 0 && (
                  <div
                    style={{ width: `${(hawkViewOnlyCount / totalDistributionSum) * 100}%` }}
                    className="bg-blue-500 h-full"
                    title={`HawkView Only: ${hawkViewOnlyCount}`}
                  />
                )}
                {bothCount > 0 && (
                  <div
                    style={{ width: `${(bothCount / totalDistributionSum) * 100}%` }}
                    className="bg-indigo-600 h-full"
                    title={`Both: ${bothCount}`}
                  />
                )}
                {microsoftOnlyCount > 0 && (
                  <div
                    style={{ width: `${(microsoftOnlyCount / totalDistributionSum) * 100}%` }}
                    className="bg-purple-500 h-full"
                    title={`Microsoft Only: ${microsoftOnlyCount}`}
                  />
                )}
              </div>
              <div className="flex items-center justify-between text-2xs text-slate-600 dark:text-slate-400 pt-0.5">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />
                  HawkView ({hawkViewOnlyCount})
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-indigo-600 inline-block" />
                  Both ({bothCount})
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-purple-500 inline-block" />
                  Microsoft ({microsoftOnlyCount})
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 3 Metric Cards */}
        <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* HawkView Findings */}
          <div className="p-4 rounded-xl border border-blue-200/70 dark:border-blue-900/40 bg-blue-50/30 dark:bg-blue-950/20 shadow-2xs flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-900 dark:text-blue-300">
                HawkView Findings
              </span>
              <div className="p-1.5 rounded-lg bg-blue-100/80 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 border border-blue-200/80 dark:border-blue-800/60">
                <ShieldAlert className="h-4 w-4" />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                {isLoading ? '...' : metrics.totalHawkViewUsers}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                distinct users flagged
                {notAssessed > 0 &&
                  ` across ${fleetWide.assessed} of ${fleetWide.inScope} tenants`}
              </p>
            </div>
            <div className="text-2xs font-medium text-blue-700 dark:text-blue-300 pt-1 border-t border-blue-100 dark:border-blue-900/40">
              {totalFindingsCount} active rule finding{totalFindingsCount === 1 ? '' : 's'}
            </div>
          </div>

          {/* Microsoft Detections */}
          <div className="p-4 rounded-xl border border-purple-200/70 dark:border-purple-900/40 bg-purple-50/30 dark:bg-purple-950/20 shadow-2xs flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-purple-900 dark:text-purple-300">
                Microsoft Detections
              </span>
              <div className="p-1.5 rounded-lg bg-purple-100/80 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400 border border-purple-200/80 dark:border-purple-800/60">
                <ShieldCheck className="h-4 w-4" />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                {isLoading ? '...' : metrics.totalMicrosoftUsers}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                reported active in Entra ID
                {/* THE SCREENSHOT FOUND THESE TWO. Side by side, a fully
                    assessed fleet and a one-third assessed one rendered these
                    tiles identically: a bare 0 with no coverage on it. The
                    sweep missed them because it looked for `.length` counts
                    and health words, and these are aggregate metrics. */}
                {notAssessed > 0 &&
                  ` across ${fleetWide.assessed} of ${fleetWide.inScope} tenants`}
              </p>
            </div>
            <div className="text-2xs font-medium text-purple-700 dark:text-purple-300 pt-1 border-t border-purple-100 dark:border-purple-900/40">
              Independent Entra risk state
            </div>
          </div>

          {/* Tenant Coverage */}
          <div
            className={cn(
              'p-4 rounded-xl border shadow-2xs flex flex-col justify-between space-y-3',
              notAssessed === 0
                ? 'border-emerald-200/70 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/20'
                : notAssessed < fleetWide.inScope
                ? 'border-amber-200/70 dark:border-amber-900/40 bg-amber-50/30 dark:bg-amber-950/20'
                : 'border-rose-200/70 dark:border-rose-900/40 bg-rose-50/30 dark:bg-rose-950/20'
            )}
          >
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  'text-xs font-semibold',
                  notAssessed === 0
                    ? 'text-emerald-900 dark:text-emerald-300'
                    : 'text-amber-900 dark:text-amber-300'
                )}
              >
                Tenant Coverage
              </span>
              <div
                className={cn(
                  'p-1.5 rounded-lg border',
                  notAssessed === 0
                    ? 'bg-emerald-100/80 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/80 dark:border-emerald-800/60'
                    : 'bg-amber-100/80 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border-amber-200/80 dark:border-amber-800/60'
                )}
              >
                <Building2 className="h-4 w-4" />
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                {isLoading ? '...' : `${fleetWide.assessed} of ${fleetWide.inScope}`}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                evaluated tenants
              </p>
            </div>
            <div
              className={cn(
                'text-2xs font-medium pt-1 border-t',
                fleetWide.assessed === fleetWide.inScope
                  ? 'text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-900/40'
                  : 'text-amber-700 dark:text-amber-300 border-amber-100 dark:border-amber-900/40'
              )}
            >
              {/* '100% tenants synced' WAS DERIVED FROM failedTenants, WHICH
                  COUNTS ONLY assessmentError. A tenant whose assessment came
                  back null is UNAVAILABLE -- not an error, and it contributed
                  no rows -- so this tile claimed a fully synced fleet over
                  tenants nobody assessed. I named that in the commit that fixed
                  the badge and the empty states and then left the tile itself
                  alone: the visible half fixed and the reassuring half not,
                  which is the shape this whole sweep is about. */}
              {fleetWide.assessed === fleetWide.inScope
                ? `All ${fleetWide.inScope} tenant${fleetWide.inScope === 1 ? '' : 's'} assessed`
                : `${fleetWide.inScope - fleetWide.assessed} of ${fleetWide.inScope} tenant${fleetWide.inScope === 1 ? '' : 's'} not assessed`}
            </div>
          </div>
        </div>
      </div>

      {/* Coverage Status Ribbon */}
      {notAssessed > 0 && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/30 p-3.5 px-4 text-xs text-amber-900 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <div>
              <span className="font-semibold">
                Partial fleet coverage: {notAssessed} of {fleetWide.inScope} tenant{fleetWide.inScope === 1 ? '' : 's'} could not be fully assessed.
              </span>
              <span className="block sm:inline text-2xs text-amber-800 dark:text-amber-300/80 sm:ml-2">
                Available tenant findings remain displayed below without interruption.
              </span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={retryAll}
            className="h-7 px-2.5 text-2xs font-medium border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 bg-white/80 dark:bg-slate-900 hover:bg-amber-100/80 self-start sm:self-center shrink-0"
          >
            Retry failed tenants
          </Button>
        </div>
      )}

      {/* Main Table & Toolbar Card */}
      <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
        {/* Card Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200/80 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-900/50">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Users requiring review
              </h2>
              <Badge
                variant="secondary"
                className="bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs px-2 py-0.5"
              >
                {summary.headline}
              </Badge>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              HawkView rule findings and Microsoft Entra ID Protection detections are maintained as independent sources.
            </p>
          </div>
        </div>

        {/* Toolbar */}
        <div className="p-3.5 sm:p-4 border-b border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              type="text"
              placeholder="Search by user name, email, UPN, or tenant..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs bg-slate-50/50 dark:bg-slate-900 border-slate-300 dark:border-slate-700 focus:bg-white dark:focus:bg-slate-900"
            />
          </div>

          {/* Filters Group */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Tenant Selector */}
            <div className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 font-medium">
              <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0 ml-1" />
              <select
                aria-label="Filter by tenant"
                value={selectedTenant}
                onChange={(e) => setSelectedTenant(e.target.value)}
                className="h-9 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              >
                <option value="ALL">All Tenants ({tenants.length})</option>
                {tenants.map((t: Tenant) => (
                  <option key={t.id} value={t.id}>
                    {t.name || t.domain || t.id}
                  </option>
                ))}
              </select>
            </div>

            {/* Source Filter */}
            <div className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 font-medium">
              <Filter className="h-3.5 w-3.5 text-slate-400 shrink-0 ml-1" />
              <select
                aria-label="Filter by detection source"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as any)}
                className="h-9 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              >
                <option value="ALL">All Sources</option>
                <option value="HAWKVIEW">HawkView Only</option>
                <option value="MICROSOFT">Microsoft Entra Only</option>
                <option value="BOTH">Correlated (Both)</option>
              </select>
            </div>

            {/* Priority Filter */}
            <div className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 font-medium">
              <select
                aria-label="Filter by priority"
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value as any)}
                className="h-9 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              >
                <option value="ALL">All Priorities</option>
                <option value="HIGH">High Priority</option>
                <option value="MEDIUM">Medium Priority</option>
                <option value="LOW">Low Priority</option>
              </select>
            </div>

            {isFilterActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchQuery('')
                  setSelectedTenant('ALL')
                  setSourceFilter('ALL')
                  setPriorityFilter('ALL')
                }}
                className="h-9 px-2.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50"
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {/* Responsive Layout: Desktop/Tablet Table vs Mobile Cards */}

        {/* 1. Desktop & Tablet Table (md and up) */}
        <div className="hidden md:block overflow-x-auto">
          <Table>
            <TableHeader className="bg-slate-50/80 dark:bg-slate-900/80 border-b border-slate-200/80 dark:border-slate-800">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 pl-5">
                  User
                </TableHead>
                <TableHead className="font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 hidden xl:table-cell">
                  Organization
                </TableHead>
                <TableHead className="font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 min-w-[280px] max-w-[400px]">
                  Why this user needs review
                </TableHead>
                <TableHead className="font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 whitespace-nowrap">
                  Found by
                </TableHead>
                <TableHead className="font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 whitespace-nowrap">
                  Latest evidence
                </TableHead>
                <TableHead className="font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 hidden xl:table-cell whitespace-nowrap">
                  Data state
                </TableHead>
                <TableHead className="text-right font-semibold text-xs text-slate-700 dark:text-slate-300 py-3 pr-5">
                  Action
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-40 text-center text-slate-500">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <RefreshCw className="h-6 w-6 animate-spin text-blue-600" />
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        Evaluating fleet-wide identity risk across authorized tenants...
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : summary.empty ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-48 text-center p-6">
                    {/* TWO EMPTY STATES COLLAPSED INTO ONE. They were separate
                        branches -- "no rows at all" and "nothing matched the
                        filters" -- and BOTH drew their own conclusion about a
                        fleet neither had asked about coverage. The first showed a
                        green ShieldCheck in an emerald circle and said "Evaluated
                        N authorized tenants" using totalTenants - failedTenants,
                        which counts a tenant that returned no assessment as
                        evaluated. */}
                    <div className="flex flex-col items-center justify-center gap-2.5 max-w-md mx-auto">
                      {/* THE ICON IS THE STRONGEST CLAIM ON THE SCREEN: read
                          before the prose, believed faster, and impossible to
                          qualify with a clause. Exactly one tone earns the
                          shield, and the tone is derived rather than chosen
                          here. */}
                      {summary.empty.tone === 'QUIET' ? (
                        <div className="p-3 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                          <ShieldCheck className="h-6 w-6" />
                        </div>
                      ) : summary.empty.tone === 'UNKNOWN' ? (
                        <div className="p-3 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                          <AlertTriangle className="h-6 w-6" />
                        </div>
                      ) : (
                        <Search className="h-6 w-6 text-slate-400" />
                      )}
                      <div className="space-y-1">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                          {summary.empty.title}
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                          {summary.empty.detail}
                          {summary.empty.tone === 'QUIET' &&
                            ' Zero findings indicate clean current rule checks, not proof that every identity is uncompromised.'}
                        </p>
                      </div>
                      {summary.empty.tone === 'FILTERED' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSearchQuery('')
                          setSelectedTenant('ALL')
                          setSourceFilter('ALL')
                          setPriorityFilter('ALL')
                        }}
                        className="h-8 text-xs font-medium mt-1"
                      >
                        Clear filters
                      </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows.map((row, idx) => {
                  const displayName = getUserDisplayName(row)
                  const userEmail = getUserEmailOrUpn(row)

                  const isHawkView = row.reasons.length > 0
                  const isMicrosoft = row.detection.microsoft === 'REPORTED'
                  const isBoth = isHawkView && isMicrosoft
                  const isHawkViewOnly = isHawkView && !isMicrosoft
                  const isMicrosoftOnly = !isHawkView && isMicrosoft

                  const primaryReason = row.reasons[0]
                  const mappedPrimary = primaryReason
                    ? mapRuleToPresentation(primaryReason.ruleId, primaryReason.signal)
                    : null

                  const borderAccentClass = isBoth
                    ? 'border-l-4 border-l-indigo-600 dark:border-l-indigo-500'
                    : isHawkViewOnly
                    ? 'border-l-4 border-l-blue-500'
                    : isMicrosoftOnly
                    ? 'border-l-4 border-l-purple-500'
                    : 'border-l-4 border-l-slate-300 dark:border-l-slate-700'

                  return (
                    <TableRow
                      key={`${row.tenantId}-${row.reference}-${idx}`}
                      className={cn(
                        borderAccentClass,
                        'hover:bg-slate-50/90 dark:hover:bg-slate-800/50 transition-colors group'
                      )}
                    >
                      {/* User Column (with inline Tenant info at medium width) */}
                      <TableCell className="py-3.5 pl-4 font-medium">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold text-xs border border-slate-200/80 dark:border-slate-700/80 shadow-2xs">
                            {getInitials(displayName, userEmail)}
                          </div>
                          <div className="space-y-0.5">
                            <div className="font-semibold text-slate-900 dark:text-slate-100 text-sm flex items-center gap-2">
                              {displayName}
                              {row.priority && (
                                <Badge variant="outline" className={priorityBadgeColor(row.priority)}>
                                  {row.priority}
                                </Badge>
                              )}
                            </div>
                            <div
                              className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate max-w-[210px]"
                              title={userEmail}
                            >
                              {userEmail}
                            </div>
                            {/* Inline Tenant info on medium screens where Organization column is hidden */}
                            <div className="text-2xs text-slate-500 dark:text-slate-400 xl:hidden flex items-center gap-1 font-medium pt-0.5">
                              <Building2 className="h-3 w-3 text-slate-400" />
                              <span>{row.tenantName}</span>
                            </div>
                          </div>
                        </div>
                      </TableCell>

                      {/* Organization Column (hidden at < xl) */}
                      <TableCell className="py-3.5 hidden xl:table-cell">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                            <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <span>{row.tenantName}</span>
                          </div>
                          {row.tenantDomain && (
                            <div className="text-2xs text-slate-500 dark:text-slate-400 font-mono">
                              {row.tenantDomain}
                            </div>
                          )}
                        </div>
                      </TableCell>

                      {/* Why this user needs review Column */}
                      <TableCell className="py-3.5 min-w-[280px] max-w-[400px]">
                        {mappedPrimary ? (
                          <div className="space-y-1">
                            <div className="text-xs font-bold text-slate-900 dark:text-slate-100 leading-snug">
                              {mappedPrimary.plainTitle}
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                              {mappedPrimary.plainExplanation}
                            </p>
                            {row.reasons.length > 1 && (
                              <button
                                type="button"
                                onClick={() => openDrawer(row)}
                                aria-label={`View ${row.reasons.length - 1} additional findings for ${displayName}`}
                                className="inline-flex items-center gap-1 text-2xs font-semibold text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 mt-0.5 hover:underline cursor-pointer"
                              >
                                +{row.reasons.length - 1} additional findings
                              </button>
                            )}
                          </div>
                        ) : isMicrosoft ? (
                          <div className="space-y-0.5">
                            <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                              Microsoft Entra ID Protection alert
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-400">
                              Reported active risk in Entra ID Protection.
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400 italic">Security activity needs review</span>
                        )}
                      </TableCell>

                      {/* Found By Column */}
                      <TableCell className="py-3.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {isHawkView && (
                            <Badge className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800/80 font-medium text-2xs px-2 py-0.5">
                              HawkView
                            </Badge>
                          )}
                          {isMicrosoft && (
                            <Badge className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800/80 font-medium text-2xs px-2 py-0.5">
                              Microsoft
                            </Badge>
                          )}
                        </div>
                      </TableCell>

                      {/* Latest Evidence Column */}
                      <TableCell className="py-3.5 whitespace-nowrap">
                        <div className="space-y-1">
                          <LatestEvidenceCell row={row} />
                          {/* Inline Data state badge on medium screens */}
                          <div className="xl:hidden pt-0.5">
                            <DataStateBadge row={row} />
                          </div>
                        </div>
                      </TableCell>

                      {/* Data State Column (hidden at < xl) */}
                      <TableCell className="py-3.5 hidden xl:table-cell whitespace-nowrap">
                        <DataStateBadge row={row} />
                      </TableCell>

                      {/* Action Column */}
                      <TableCell className="py-3.5 text-right pr-4">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openDrawer(row)}
                          aria-label={`Investigate ${displayName}`}
                          className="h-8 px-3 text-xs font-medium text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:text-blue-600 hover:border-blue-300 dark:hover:text-blue-400 dark:hover:border-blue-700 hover:bg-blue-50/50 dark:hover:bg-blue-950/30 transition-colors shadow-2xs group-hover:border-blue-300 dark:group-hover:border-blue-700"
                        >
                          Investigate
                          <ChevronRight className="ml-1 h-3.5 w-3.5 text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* 2. Mobile & Small Tablet Card Layout (< md screens) */}
        <div className="block md:hidden p-3.5 space-y-3.5 bg-slate-50/50 dark:bg-slate-950/40">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500 space-y-2">
              <RefreshCw className="h-6 w-6 animate-spin text-blue-600 mx-auto" />
              <p className="text-xs font-medium">Evaluating fleet-wide identity risk...</p>
            </div>
          ) : summary.empty ? (
            <div className="p-6 text-center text-slate-500 space-y-2">
              {/* Same rule as the desktop table. A green shield here said "you
                  are fine" about tenants nobody assessed, on the narrow screen
                  where it is the only thing visible. */}
              {summary.empty.tone === 'QUIET' ? (
                <ShieldCheck className="h-6 w-6 text-emerald-500 mx-auto" />
              ) : summary.empty.tone === 'UNKNOWN' ? (
                <AlertTriangle className="h-6 w-6 text-amber-500 mx-auto" />
              ) : (
                <Search className="h-6 w-6 text-slate-400 mx-auto" />
              )}
              <p className="text-xs font-bold text-slate-800 dark:text-slate-200">{summary.empty.title}</p>
              <p className="text-2xs text-slate-500 dark:text-slate-400 leading-relaxed">{summary.empty.detail}</p>
            </div>
          ) : (
            filteredRows.map((row, idx) => {
              const displayName = getUserDisplayName(row)
              const userEmail = getUserEmailOrUpn(row)

              const isHawkView = row.reasons.length > 0
              const isMicrosoft = row.detection.microsoft === 'REPORTED'
              const primaryReason = row.reasons[0]
              const mappedPrimary = primaryReason
                ? mapRuleToPresentation(primaryReason.ruleId, primaryReason.signal)
                : null

              return (
                <div
                  key={`mobile-${row.tenantId}-${row.reference}-${idx}`}
                  className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3.5 shadow-2xs"
                >
                  {/* Card Header: User avatar + info + priority */}
                  <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold text-xs border border-slate-200 dark:border-slate-700 shadow-2xs">
                        {getInitials(displayName, userEmail)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 dark:text-slate-100 text-sm truncate">
                          {displayName}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">
                          {userEmail}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {row.priority && (
                        <Badge variant="outline" className={priorityBadgeColor(row.priority)}>
                          {row.priority}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Organization Row */}
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                    <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <span>{row.tenantName}</span>
                    {row.tenantDomain && (
                      <span className="text-2xs font-normal text-slate-400 flex items-center gap-0.5 border-l border-slate-200 dark:border-slate-700 pl-1.5 ml-0.5">
                        <Globe className="h-2.5 w-2.5" />
                        {row.tenantDomain}
                      </span>
                    )}
                  </div>

                  {/* Why this user needs review */}
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 p-3 border border-slate-200/80 dark:border-slate-800 space-y-1">
                    <div className="text-2xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Why review is needed
                    </div>
                    {mappedPrimary ? (
                      <>
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          {mappedPrimary.plainTitle}
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {mappedPrimary.plainExplanation}
                        </p>
                        {row.reasons.length > 1 && (
                          <button
                            type="button"
                            onClick={() => openDrawer(row)}
                            className="text-2xs font-semibold text-blue-600 dark:text-blue-400 hover:underline pt-1 block"
                          >
                            +{row.reasons.length - 1} additional findings
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                        {isMicrosoft ? 'Microsoft Entra ID Protection alert' : 'Security activity needs review'}
                      </div>
                    )}
                  </div>

                  {/* Source & Evidence Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-slate-500 dark:text-slate-400 pt-1">
                    <div className="flex items-center gap-1.5">
                      {isHawkView && (
                        <Badge className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 font-medium text-2xs px-2 py-0.5">
                          HawkView
                        </Badge>
                      )}
                      {isMicrosoft && (
                        <Badge className="bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 font-medium text-2xs px-2 py-0.5">
                          Microsoft
                        </Badge>
                      )}
                    </div>
                    <DataStateBadge row={row} />
                  </div>

                  {/* Full-width Touch Action Button (44px target) */}
                  <Button
                    variant="outline"
                    onClick={() => openDrawer(row)}
                    aria-label={`Investigate ${displayName}`}
                    className="w-full h-11 text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-50/80 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900 shadow-2xs flex items-center justify-center gap-1.5"
                  >
                    Investigate User
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* User Details Drawer */}
      <FleetRiskAssessmentDrawer
        row={drawerRow}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      />
    </div>
  )
}
