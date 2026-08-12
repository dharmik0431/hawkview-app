'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ShieldAlert,
  AlertTriangle,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  ChevronRight,
  Info,
  Lock,
  Users,
  Shield,
  Layers,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { Tenant } from '@/types/api'
import { cn } from '@/lib/utils'

import {
  getTenantSecureScoreInfo,
  getTenantRiskyUsersInfo,
  getTenantThreatsInfo,
  getTenantRecommendedAction,
  getTenantMatrixOverallState,
} from './tenant-risk-matrix-helpers'
import { TenantRiskMatrixDrawer } from './tenant-risk-matrix-drawer'

export type MatrixSortColumn =
  | 'tenant'
  | 'secure_score'
  | 'users_at_risk'
  | 'active_threats'

interface TenantRiskMatrixProps {
  tenants: Tenant[]
  sortColumn?: MatrixSortColumn
  sortDirection?: 'asc' | 'desc'
  onSortChange?: (column: MatrixSortColumn, direction: 'asc' | 'desc') => void
}

function ProviderMark({ provider }: { provider: 'microsoft' | 'google' }) {
  if (provider === 'microsoft') {
    return (
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0">
        <span className="grid grid-cols-2 gap-[2px]">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#F25022]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#7FBA00]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#00A4EF]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[#FFB900]" />
        </span>
      </span>
    )
  }

  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0">
      <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-500 border-t-red-500 border-r-yellow-500 border-b-green-500" />
    </span>
  )
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val))
}

export function TenantRiskMatrix({
  tenants,
  sortColumn: externalSortColumn,
  sortDirection: externalSortDirection,
  onSortChange,
}: TenantRiskMatrixProps) {
  const router = useRouter()
  const [selectedTenant, setSelectedTenant] = React.useState<Tenant | null>(null)
  const [originElement, setOriginElement] = React.useState<HTMLElement | null>(null)

  const [internalSortColumn, setInternalSortColumn] =
    React.useState<MatrixSortColumn>('tenant')
  const [internalSortDir, setInternalSortDir] = React.useState<'asc' | 'desc'>('asc')

  const sortColumn = externalSortColumn ?? internalSortColumn
  const sortDir = externalSortDirection ?? internalSortDir

  const handleHeaderSort = (col: MatrixSortColumn) => {
    let nextDir: 'asc' | 'desc' = 'asc'
    if (sortColumn === col) {
      nextDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      nextDir = col === 'tenant' ? 'asc' : 'desc'
    }

    if (onSortChange) {
      onSortChange(col, nextDir)
    } else {
      setInternalSortColumn(col)
      setInternalSortDir(nextDir)
    }
  }

  const sortedTenants = React.useMemo(() => {
    const list = [...tenants]

    list.sort((a, b) => {
      let cmp = 0

      if (sortColumn === 'tenant') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortColumn === 'secure_score') {
        const scoreA = a.secureScore ?? -1
        const scoreB = b.secureScore ?? -1
        cmp = scoreA - scoreB
      } else if (sortColumn === 'users_at_risk') {
        const usersA = a.riskyIdentityCount ?? 0
        const usersB = b.riskyIdentityCount ?? 0
        cmp = usersA - usersB
      } else if (sortColumn === 'active_threats') {
        const threatsA = getTenantThreatsInfo(a).count ?? -1
        const threatsB = getTenantThreatsInfo(b).count ?? -1
        cmp = threatsA - threatsB
      }

      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [tenants, sortColumn, sortDir])

  if (tenants.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        No managed tenants matching active filters.
      </div>
    )
  }

  const renderSortIcon = (col: MatrixSortColumn) => {
    if (sortColumn !== col) {
      return <ArrowUpDown className="h-3.5 w-3.5 opacity-40 group-hover:opacity-100 transition-opacity" />
    }
    return sortDir === 'asc' ? (
      <ArrowUp className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
    )
  }

  return (
    <TooltipProvider>
      <div className="space-y-2">
        {/* Responsive Table for Desktop (lg+) and Stacked List for Narrow Screens */}
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xs overflow-hidden">
          {/* Desktop Table View */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 text-slate-500 dark:text-slate-400 font-semibold select-none">
                  {/* Col 1: Tenant */}
                  <th scope="col" className="py-3 px-4 min-w-[200px]">
                    <button
                      type="button"
                      onClick={() => handleHeaderSort('tenant')}
                      className="group flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -ml-1"
                      title="Sort by Tenant Name"
                    >
                      <span>Tenant</span>
                      {renderSortIcon('tenant')}
                    </button>
                  </th>

                  {/* Col 2: Microsoft Secure Score, with HawkView Health shown alongside below. */}
                  <th scope="col" className="py-3 px-4 min-w-[190px]">
                    <button
                      type="button"
                      onClick={() => handleHeaderSort('secure_score')}
                      className="group flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -ml-1"
                      title="Sort by Microsoft Secure Score"
                    >
                      <span>Security Scores</span>
                      {renderSortIcon('secure_score')}
                    </button>
                  </th>

                  {/* Col 3: Score Breakdown */}
                  <th scope="col" className="py-3 px-4 min-w-[170px]">
                    <div className="flex items-center gap-1">
                      <span>Score Breakdown</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 text-slate-400 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <span>Identity, Data, and Apps category breakdown</span>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </th>

                  {/* Col 4: Users at Risk */}
                  <th scope="col" className="py-3 px-4 min-w-[160px]">
                    <button
                      type="button"
                      onClick={() => handleHeaderSort('users_at_risk')}
                      className="group flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -ml-1"
                      title="Sort by Users at Risk"
                    >
                      <span>Users at Risk</span>
                      {renderSortIcon('users_at_risk')}
                    </button>
                  </th>

                  {/* Col 5: Threats */}
                  <th scope="col" className="py-3 px-4 min-w-[160px]">
                    <button
                      type="button"
                      onClick={() => handleHeaderSort('active_threats')}
                      className="group flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1 -ml-1"
                      title="Sort by Active Threats"
                    >
                      <span>Threats & Alerts</span>
                      {renderSortIcon('active_threats')}
                    </button>
                  </th>

                  {/* Col 6: Recommended Action */}
                  <th scope="col" className="py-3 px-4 text-right min-w-[180px]">
                    Action
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {sortedTenants.map((t) => {
                  const scoreInfo = getTenantSecureScoreInfo(t)
                  const riskyInfo = getTenantRiskyUsersInfo(t)
                  const threatsInfo = getTenantThreatsInfo(t)
                  const recAction = getTenantRecommendedAction(t)
                  const overallState = getTenantMatrixOverallState(t)

                  return (
                    <tr
                      key={t.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`View security details for ${t.name}`}
                      onClick={(e) => {
                        setSelectedTenant(t)
                        setOriginElement(e.currentTarget as HTMLElement)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedTenant(t)
                          setOriginElement(e.currentTarget as HTMLElement)
                        }
                      }}
                      className="group hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer focus-visible:outline-none focus-visible:bg-slate-50 dark:focus-visible:bg-slate-800/60"
                    >
                      {/* 1. Tenant */}
                      <td className="py-3.5 px-4 align-middle">
                        <div className="flex items-center gap-2.5">
                          <ProviderMark provider={t.provider} />
                          <div className="min-w-0">
                            <div className="font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                              {t.name}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {t.domain || 'Domain not available'}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* 2. Microsoft Secure Score and HawkView Health Score */}
                      <td className="py-3.5 px-4 align-middle">
                        <div className="space-y-2 max-w-[170px]">
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold mb-1">
                              Microsoft Secure Score
                            </div>
                            {scoreInfo.isAvailable && scoreInfo.score !== null ? (
                              <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold text-slate-900 dark:text-slate-100">
                                {scoreInfo.score}%
                              </span>
                              <span className="text-[10px] text-slate-400 font-medium truncate">
                                {scoreInfo.dateText}
                              </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                              <div
                                className={cn(
                                  'h-full rounded-full transition-all duration-300',
                                  scoreInfo.score >= 75
                                    ? 'bg-emerald-500'
                                    : scoreInfo.score >= 50
                                    ? 'bg-amber-500'
                                    : 'bg-red-500'
                                )}
                                style={{ width: `${clamp(scoreInfo.score, 0, 100)}%` }}
                              />
                            </div>
                            <div className="text-[10px] text-slate-400 italic">
                              Points breakdown not provided
                            </div>
                              </div>
                            ) : (
                              <div className="space-y-0.5">
                                <Badge
                              variant="outline"
                              className={cn(
                                'px-2 py-0.5 text-[11px] font-semibold border rounded-md',
                                scoreInfo.statusType === 'disconnected'
                                  ? 'border-red-200 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/50'
                                  : scoreInfo.statusType === 'permission_required'
                                  ? 'border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/50'
                                  : scoreInfo.statusType === 'awaiting_sync'
                                  ? 'border-slate-200 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                  : 'border-slate-200 bg-slate-50 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400'
                              )}
                                >
                                  {scoreInfo.stateLabel}
                                </Badge>
                                <div className="text-[10px] text-slate-400">
                                  {scoreInfo.pointsText}
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="border-t border-slate-100 dark:border-slate-800 pt-2 flex items-center justify-between gap-2">
                            <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">HawkView Health</span>
                            <span className="font-bold text-slate-700 dark:text-slate-200">{t.healthScore}%</span>
                          </div>
                        </div>
                      </td>

                      {/* 3. Score Breakdown */}
                      <td className="py-3.5 px-4 align-middle text-slate-500 dark:text-slate-400">
                        {/* Only short labeled bars when real numeric data exists */}
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-12 text-slate-400 font-medium">Identity</span>
                            <span className="text-slate-400 italic text-[10px]">
                              {overallState.key === 'disconnected'
                                ? 'Disconnected'
                                : overallState.key === 'pending_setup'
                                ? 'Awaiting sync'
                                : 'Not available'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-12 text-slate-400 font-medium">Data</span>
                            <span className="text-slate-400 italic text-[10px]">
                              {overallState.key === 'disconnected'
                                ? 'Disconnected'
                                : overallState.key === 'pending_setup'
                                ? 'Awaiting sync'
                                : 'Not available'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className="w-12 text-slate-400 font-medium">Apps</span>
                            <span className="text-slate-400 italic text-[10px]">
                              {overallState.key === 'disconnected'
                                ? 'Disconnected'
                                : overallState.key === 'pending_setup'
                                ? 'Awaiting sync'
                                : 'Not available'}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* 4. Users at Risk */}
                      <td className="py-3.5 px-4 align-middle">
                        {riskyInfo.statusType === 'available' && riskyInfo.count !== null ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 font-bold">
                              {riskyInfo.count > 0 ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/50">
                                  <Users className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                                  <span>{riskyInfo.label}</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                                  <span>0 users at risk</span>
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              {riskyInfo.breakdownNote}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                'px-2 py-0.5 text-[11px] font-semibold border rounded-md',
                                riskyInfo.statusType === 'permission_required'
                                  ? 'border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                                  : riskyInfo.statusType === 'disconnected'
                                  ? 'border-red-200 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                                  : 'border-slate-200 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                              )}
                            >
                              {riskyInfo.label}
                            </Badge>
                            <div className="text-[10px] text-slate-400">
                              {riskyInfo.breakdownNote}
                            </div>
                          </div>
                        )}
                      </td>

                      {/* 5. Threats */}
                      <td className="py-3.5 px-4 align-middle">
                        {threatsInfo.statusType === 'available' && threatsInfo.count !== null ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 font-bold">
                              {threatsInfo.count > 0 ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-red-50 text-red-800 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/50">
                                  <ShieldAlert className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                                  <span>{threatsInfo.label}</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                                  <span>No active threats</span>
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              Resolved alerts: —
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                'px-2 py-0.5 text-[11px] font-semibold border rounded-md',
                                threatsInfo.statusType === 'disconnected'
                                  ? 'border-red-200 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                                  : 'border-slate-200 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                              )}
                            >
                              {threatsInfo.label}
                            </Badge>
                            <div className="text-[10px] text-slate-400">
                              Resolved alerts: —
                            </div>
                          </div>
                        )}
                      </td>

                      {/* 6. Action */}
                      <td className="py-3.5 px-4 align-middle text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            router.push(recAction.destinationUrl)
                          }}
                          className="h-8 px-3 text-xs font-semibold border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 focus-visible:ring-2 focus-visible:ring-blue-500 shrink-0"
                        >
                          <span>{recAction.label}</span>
                          <ChevronRight className="h-3.5 w-3.5 ml-1" />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile & Tablet Stacked List View (< lg) */}
          <div className="lg:hidden divide-y divide-slate-100 dark:divide-slate-800">
            {sortedTenants.map((t) => {
              const scoreInfo = getTenantSecureScoreInfo(t)
              const riskyInfo = getTenantRiskyUsersInfo(t)
              const threatsInfo = getTenantThreatsInfo(t)
              const recAction = getTenantRecommendedAction(t)
              const overallState = getTenantMatrixOverallState(t)

              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View security overview for ${t.name}`}
                  onClick={(e) => {
                    setSelectedTenant(t)
                    setOriginElement(e.currentTarget as HTMLElement)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedTenant(t)
                      setOriginElement(e.currentTarget as HTMLElement)
                    }
                  }}
                  className="p-4 space-y-3 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {/* Top line: Provider mark, tenant name, domain, overall badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <ProviderMark provider={t.provider} />
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-slate-900 dark:text-slate-100 truncate">
                          {t.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {t.domain || 'Domain not available'}
                        </div>
                      </div>
                    </div>

                    <Badge
                      variant="outline"
                      className={cn(
                        'px-2 py-0.5 text-xs font-semibold shrink-0 border rounded-md',
                        overallState.badgeClass
                      )}
                    >
                      {overallState.label}
                    </Badge>
                  </div>

                  {/* Compact Security Metrics Grid */}
                  <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-slate-100 dark:border-slate-800">
                    {/* Microsoft Secure Score and HawkView Health Score */}
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 space-y-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">
                        Microsoft Secure Score
                      </span>
                      {scoreInfo.isAvailable && scoreInfo.score !== null ? (
                        <div className="space-y-1">
                          <span className="font-bold text-slate-900 dark:text-slate-100 block">
                            {scoreInfo.score}%
                          </span>
                          <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                scoreInfo.score >= 75
                                  ? 'bg-emerald-500'
                                  : scoreInfo.score >= 50
                                  ? 'bg-amber-500'
                                  : 'bg-red-500'
                              )}
                              style={{ width: `${clamp(scoreInfo.score, 0, 100)}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="font-semibold text-slate-600 dark:text-slate-300 block text-[11px]">
                          {scoreInfo.stateLabel}
                        </span>
                      )}
                      <div className="border-t border-slate-200 dark:border-slate-700 pt-1.5 mt-1.5 flex items-center justify-between gap-2">
                        <span className="text-[10px] uppercase font-bold text-slate-400">HawkView Health</span>
                        <span className="font-bold text-slate-700 dark:text-slate-200">{t.healthScore}%</span>
                      </div>
                    </div>

                    {/* Score Breakdown */}
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 space-y-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">
                        Score Breakdown
                      </span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 italic block">
                        {overallState.key === 'disconnected'
                          ? 'Disconnected'
                          : 'Not available'}
                      </span>
                    </div>

                    {/* Users at Risk */}
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 space-y-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">
                        Users at Risk
                      </span>
                      {riskyInfo.statusType === 'available' ? (
                        <span className={cn('font-bold block', riskyInfo.count! > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400')}>
                          {riskyInfo.label}
                        </span>
                      ) : (
                        <span className="font-semibold text-slate-600 dark:text-slate-300 block text-[11px]">
                          {riskyInfo.label}
                        </span>
                      )}
                    </div>

                    {/* Threats */}
                    <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 space-y-1">
                      <span className="text-[10px] uppercase font-bold text-slate-400 block">
                        Threats & Alerts
                      </span>
                      {threatsInfo.statusType === 'available' ? (
                        <span className={cn('font-bold block', threatsInfo.count! > 0 ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400')}>
                          {threatsInfo.label}
                        </span>
                      ) : (
                        <span className="font-semibold text-slate-600 dark:text-slate-300 block text-[11px]">
                          {threatsInfo.label}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bottom line: Action button */}
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                      Tap for overview
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        router.push(recAction.destinationUrl)
                      }}
                      className="h-8 px-3 text-xs font-semibold border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200"
                    >
                      <span>{recAction.label}</span>
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Slide-over Drawer for Tenant Security Overview */}
        <TenantRiskMatrixDrawer
          tenant={selectedTenant}
          isOpen={Boolean(selectedTenant)}
          onClose={() => setSelectedTenant(null)}
          originatingElement={originElement}
        />
      </div>
    </TooltipProvider>
  )
}
