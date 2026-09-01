'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  RefreshCw,
  X,
} from 'lucide-react'
import type { TenantBundle } from '@/types/tenant-data'
import {
  formatTenantTimestamp,
  type TenantIssue,
  type TenantWorkspaceDisplay,
} from '@/lib/tenant-workspace-state'
import { cn } from '@/lib/utils'

export type TenantRecommendation = {
  id: string
  title: string
  service: string
  explanation: string
  priority: 'High' | 'Medium' | 'Low'
  actionLabel: string
  targetModule: string
}

export function TenantOverview({
  bundle,
  display,
  onOpenModule,
  onSync,
  isSyncing = false,
}: {
  bundle: TenantBundle
  display: TenantWorkspaceDisplay
  onOpenModule: (module: string) => void
  onSync?: () => void
  isSyncing?: boolean
}) {
  const [selectedIssue, setSelectedIssue] = useState<TenantIssue | null>(null)
  const [isTechDetailsOpen, setIsTechDetailsOpen] = useState(false)

  // Derive real operational recommendations strictly from synchronized bundle data
  const recommendations = useMemo<TenantRecommendation[]>(() => {
    const list: TenantRecommendation[] = []

    // 1. Missing Microsoft API Permissions
    const missingPerms =
      (bundle?.tenant as any)?.missingPermissions ||
      (bundle as any)?.missingPermissions
    if (Array.isArray(missingPerms) && missingPerms.length > 0) {
      list.push({
        id: 'rec-missing-perms',
        title: 'Review Microsoft permissions',
        service: 'Microsoft Entra',
        explanation: `${missingPerms.length} required API permission scope${
          missingPerms.length === 1 ? '' : 's'
        } (${missingPerms.slice(0, 2).join(', ')}${
          missingPerms.length > 2 ? '...' : ''
        }) require administrative consent in Entra ID.`,
        priority: 'High',
        actionLabel: 'Review permissions',
        targetModule: 'settings',
      })
    }

    // 2. Disconnected or Failed Sync Status
    if (display.connection === 'disconnected') {
      list.push({
        id: 'rec-reconnect-tenant',
        title: 'Reconnect Microsoft 365 tenant',
        service: 'Tenant Connection',
        explanation:
          'Re-authorize tenant connection credentials to resume automated security monitoring and data synchronization.',
        priority: 'High',
        actionLabel: 'Review permissions',
        targetModule: 'settings',
      })
    } else if (
      (display.state === 'needs-attention' || display.state === 'partially-synchronized') &&
      !list.some((r) => r.id === 'rec-missing-perms')
    ) {
      list.push({
        id: 'rec-failed-sync',
        title: 'Investigate failed synchronization',
        service: 'Tenant Sync',
        explanation:
          'One or more tenant modules encountered errors during the last synchronization cycle. Retry sync or inspect service settings.',
        priority: 'High',
        actionLabel: 'Retry sync',
        targetModule: 'settings',
      })
    }

    // 3. Email Authentication Records (SPF / DKIM / DMARC)
    if (bundle?.dns) {
      const spf = bundle.dns.spf
      const dkim = bundle.dns.dkim
      const dmarc = bundle.dns.dmarc

      const hasSpfIssue =
        !spf ||
        (typeof spf === 'object' && spf.status !== 'healthy') ||
        (typeof spf === 'string' && (!spf.includes('v=spf1') || spf.includes('~all') || spf.includes('+all')))

      const hasDkimIssue =
        !dkim || (typeof dkim === 'object' && dkim.status !== 'healthy')

      const hasDmarcIssue =
        !dmarc ||
        (typeof dmarc === 'object' && dmarc.status !== 'healthy') ||
        (typeof dmarc === 'string' && dmarc.includes('p=none'))

      if (hasSpfIssue || hasDkimIssue || hasDmarcIssue) {
        list.push({
          id: 'rec-email-auth',
          title: 'Complete email authentication (SPF / DKIM / DMARC)',
          service: 'Exchange / DNS',
          explanation:
            'One or more email authentication records (SPF, DKIM, or DMARC) are missing, unverified, or set to a permissive policy on connected domain(s).',
          priority: 'Medium',
          actionLabel: 'Open Domain Protection',
          targetModule: 'dns',
        })
      }
    }

    // 4. License Seat Capacity Utilization
    if (Array.isArray(bundle?.licenses?.rows) && bundle.licenses.rows.length > 0) {
      const atCapacity = bundle.licenses.rows.filter(
        (row) => row.total > 0 && row.used >= row.total
      )
      if (atCapacity.length > 0) {
        list.push({
          id: 'rec-license-capacity',
          title: 'Review fully utilized licenses',
          service: 'Office 365 Licenses',
          explanation: `${atCapacity.length} subscription product${
            atCapacity.length === 1 ? ' has' : 's have'
          } reached 100% seat allocation. Additional user provisioning will fail until capacity is added.`,
          priority: 'Medium',
          actionLabel: 'Review licenses',
          targetModule: 'home',
        })
      }
    }

    // 5. Entra Conditional Access Policies
    if (Array.isArray(bundle?.entra?.caPolicies) && bundle.entra.caPolicies.length > 0) {
      const inactivePolicies = bundle.entra.caPolicies.filter(
        (p) => p.state === 'disabled' || p.state === 'reportOnly'
      )
      if (inactivePolicies.length > 0) {
        list.push({
          id: 'rec-ca-policies',
          title: 'Review Conditional Access policies',
          service: 'Entra ID Security',
          explanation: `${inactivePolicies.length} Conditional Access polic${
            inactivePolicies.length === 1 ? 'y is' : 'ies are'
          } currently disabled or in report-only mode and not enforcing active security protection.`,
          priority: 'Medium',
          actionLabel: 'Review policies',
          targetModule: 'entra',
        })
      }
    }

    return list
  }, [bundle, display])

  // Default to Active issues whenever unresolved issues exist; otherwise Recommendations
  const [activeTab, setActiveTab] = useState<'issues' | 'recommendations'>(
    display.issueCount > 0 || display.state === 'syncing'
      ? 'issues'
      : 'recommendations'
  )

  // Update tab if issue count changes
  useEffect(() => {
    if (display.issueCount > 0 || display.state === 'syncing') {
      setActiveTab('issues')
    }
  }, [display.issueCount, display.state])

  // Escape key handler for remediation drawer
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && selectedIssue) {
        setSelectedIssue(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedIssue])

  const connectionState = display.connection
  const isSyncProgress = display.state === 'syncing'
  const isHealthUnverified = !display.attentionVerified

  const connectionLabel = connectionState === 'connected'
      ? 'Connected'
      : connectionState === 'disconnected'
        ? 'Disconnected'
        : connectionState === 'pending'
          ? 'Pending'
          : 'Not verified'

  const hasUrgentAttention =
    !isSyncProgress &&
    display.attentionVerified &&
    (display.issueCount > 0 || display.state === 'needs-attention')

  const lastSyncText = display.lastSuccessfulSync
    ? formatTenantTimestamp(display.lastSuccessfulSync)
    : 'No successful sync'

  const issueCountText =
    isSyncProgress
      ? 'This can take a few minutes'
      : isHealthUnverified
        ? 'Actionable issue status unavailable'
      : display.issueCount === 1
      ? '1 actionable issue'
      : `${display.issueCount} actionable issues`

  const summaryLabel = isSyncProgress
    ? display.isInitialSync
      ? 'Initial sync in progress'
      : 'Synchronization in progress'
    : hasUrgentAttention
      ? 'Needs Attention'
      : isHealthUnverified
        ? 'Health not verified'
      : 'Healthy'

  return (
    <div className="space-y-5">
      {/* 1. Compact Single-Line Health Summary directly beneath page header */}
      <div
        className={cn(
          'flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 text-[14px] rounded-xs transition-colors',
          isSyncProgress
            ? 'border-l-2 border-l-blue-500 bg-blue-50/50 dark:bg-blue-950/20 text-slate-800 dark:text-slate-200'
            : hasUrgentAttention
            ? 'border-l-2 border-l-amber-500 bg-amber-50/40 dark:bg-amber-950/20 text-slate-800 dark:text-slate-200'
            : isHealthUnverified
            ? 'border-l-2 border-l-slate-400 bg-slate-50 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300'
            : 'border-l-2 border-l-emerald-500 bg-slate-50 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300'
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {isSyncProgress ? (
            <RefreshCw className="h-4 w-4 text-blue-600 shrink-0 animate-spin" aria-hidden="true" />
          ) : hasUrgentAttention ? (
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" aria-hidden="true" />
          ) : isHealthUnverified ? (
            <Info className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden="true" />
          )}

          <span className="text-[15px] font-semibold text-slate-900 dark:text-white">
            {summaryLabel}
          </span>

          <span className="text-slate-300 dark:text-slate-700">•</span>

          <span>Microsoft {connectionLabel.toLowerCase()}</span>

          <span className="text-slate-300 dark:text-slate-700">•</span>

          <span>
            {isSyncProgress
              ? 'Collecting Microsoft 365 data'
              : `Last successful sync ${lastSyncText}`}
          </span>

          <span className="text-slate-300 dark:text-slate-700">•</span>

          <span className={cn(
            isSyncProgress && 'font-medium text-blue-700 dark:text-blue-300',
            !isSyncProgress && display.issueCount > 0 && 'font-semibold text-amber-700 dark:text-amber-400'
          )}>
            {issueCountText}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onOpenModule('settings')}
          className="text-[14px] font-semibold text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline shrink-0 text-left sm:text-right cursor-pointer"
        >
          View connection details
        </button>
      </div>

      {/* 2. Cohesive "Tenant action center" with optional Desktop Summary Rail */}
      <div className="flex flex-col xl:flex-row gap-6 items-start">
        {/* Left/Main: Action Center Container */}
        <section
          aria-labelledby="action-center-heading"
          className="flex-1 w-full bg-white dark:bg-slate-900 rounded-md border border-slate-200 dark:border-slate-800 p-5 shadow-2xs space-y-4"
        >
          {/* Header & Tabs */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800 pb-3 mb-1">
            <div>
              <h2 id="action-center-heading" className="text-[20px] font-semibold text-slate-900 dark:text-white">
                Tenant action center
              </h2>
              <p className="text-[14px] text-slate-600 dark:text-slate-300 mt-1">
                Resolve active problems first, then review recommended improvements.
              </p>
            </div>

            <div className="flex items-center gap-6 shrink-0 self-start sm:self-auto border-b sm:border-b-0 border-slate-200 dark:border-slate-800 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => setActiveTab('issues')}
                className={cn(
                  'text-[14px] font-semibold pb-3 -mb-[13px] transition-colors cursor-pointer border-b-2',
                  activeTab === 'issues'
                    ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 border-transparent'
                )}
              >
                Active issues ({display.attentionVerified ? display.issueCount : 'Not verified'})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('recommendations')}
                className={cn(
                  'text-[14px] font-semibold pb-3 -mb-[13px] transition-colors cursor-pointer border-b-2',
                  activeTab === 'recommendations'
                    ? 'text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-400'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 border-transparent'
                )}
              >
                Recommendations ({recommendations.length})
              </button>
            </div>
          </div>

          {/* Active Issues View */}
          {activeTab === 'issues' && (
            <div>
              {display.issues.length > 0 ? (
                <div className="space-y-3">
                  {display.issues.map((issue) => (
                    <div
                      key={issue.id}
                      className="p-4 border-l-2 border-l-amber-500 bg-amber-50/20 dark:bg-amber-950/10 rounded-r-md border-y border-r border-slate-200/60 dark:border-slate-800 flex flex-col sm:flex-row sm:items-start justify-between gap-4 transition hover:bg-amber-50/30 dark:hover:bg-amber-950/20"
                    >
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <h3 className="text-[15px] font-semibold text-slate-900 dark:text-white leading-snug">
                          {issue.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-amber-100/80 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                            <span>{issue.severity || 'Warning'}</span>
                          </span>
                          <span className="text-slate-300 dark:text-slate-700">•</span>
                          <span className="text-slate-600 dark:text-slate-400 font-medium">
                            Service: {issue.service}
                          </span>
                        </div>
                        <p className="text-[14px] text-slate-600 dark:text-slate-300 leading-[1.5]">
                          {issue.explanation || issue.detail}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 self-start sm:self-center pt-1 sm:pt-0">
                        {/* Primary Action Button (HawkView Navy) */}
                        {issue.action === 'Retry synchronization' && onSync ? (
                          <button
                            type="button"
                            onClick={onSync}
                            disabled={isSyncing}
                            className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white px-3.5 py-1.5 text-[14px] font-semibold shadow-2xs transition disabled:opacity-50 cursor-pointer"
                          >
                            <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                            <span>Retry sync</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenModule(issue.targetModule || 'settings')}
                            className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white px-3.5 py-1.5 text-[14px] font-semibold shadow-2xs transition cursor-pointer"
                          >
                            <span>{issue.action || 'Review permissions'}</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </button>
                        )}

                        {/* Quiet Text Action */}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedIssue(issue)
                            setIsTechDetailsOpen(false)
                          }}
                          className="text-[14px] font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:underline transition cursor-pointer"
                        >
                          Resolve issue
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : isSyncProgress ? (
                <div className="py-10 px-5 text-center text-[14px] text-slate-600 dark:text-slate-300 flex flex-col items-center justify-center gap-2 rounded-md border border-blue-200/80 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20">
                  <RefreshCw className="h-6 w-6 text-blue-600 dark:text-blue-400 animate-spin" aria-hidden="true" />
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {display.isInitialSync
                      ? 'Initial synchronization is in progress'
                      : 'Synchronization is in progress'}
                  </span>
                  <span className="max-w-xl">
                    HawkView is collecting Microsoft 365 data. Some services become available at different times, and temporary gaps are retried automatically. You can leave this page and return later.
                  </span>
                </div>
              ) : isHealthUnverified ? (
                <div role="status" className="py-8 text-center text-[14px] text-slate-500 dark:text-slate-400 flex flex-col items-center justify-center gap-1">
                  <Info className="h-5 w-5 text-slate-400" />
                  <span className="font-semibold text-slate-900 dark:text-white">Actionable issue status unavailable</span>
                  <span>HawkView has not received the tenant-wide health result needed to make a zero-issue claim.</span>
                </div>
              ) : (
                <div className="py-8 text-center text-[14px] text-slate-500 dark:text-slate-400 flex flex-col items-center justify-center gap-1">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  <span className="font-semibold text-slate-900 dark:text-white">No active issues</span>
                  <span>All Microsoft 365 services and permissions are operating normally.</span>
                </div>
              )}
            </div>
          )}

          {/* Recommendations View */}
          {activeTab === 'recommendations' && (
            <div>
              {recommendations.length > 0 ? (
                <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {recommendations.map((rec) => {
                    const isHigh = rec.priority === 'High'
                    return (
                      <div
                        key={rec.id}
                        className="py-4 px-2 sm:px-3 flex flex-col sm:flex-row sm:items-start justify-between gap-4 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors rounded-sm"
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          {/* Line 1: Recommendation title */}
                          <h3 className="text-[15px] font-semibold text-slate-900 dark:text-white leading-snug">
                            {rec.title}
                          </h3>

                          {/* Line 2: Priority · Service */}
                          <div className="flex flex-wrap items-center gap-2 text-[13px]">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border',
                                isHigh
                                  ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800 font-semibold'
                                  : 'bg-amber-50/60 text-amber-900/90 border-amber-200/80 dark:bg-slate-800 dark:text-amber-300/90 dark:border-slate-700'
                              )}
                            >
                              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span>{rec.priority} priority</span>
                            </span>
                            <span className="text-slate-300 dark:text-slate-700">•</span>
                            <span className="text-slate-600 dark:text-slate-400 font-medium">
                              Service: {rec.service}
                            </span>
                          </div>

                          {/* Line 3: Explanation */}
                          <p className="text-[14px] text-slate-600 dark:text-slate-300 leading-[1.5]">
                            {rec.explanation}
                          </p>
                        </div>

                        <div className="shrink-0 self-start sm:self-center pt-1 sm:pt-0">
                          <button
                            type="button"
                            onClick={() => {
                              if (rec.actionLabel === 'Retry sync' && onSync) {
                                onSync()
                              } else {
                                onOpenModule(rec.targetModule)
                              }
                            }}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[14px] font-semibold transition cursor-pointer',
                              isHigh
                                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white shadow-2xs'
                                : 'text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline p-0 bg-transparent'
                            )}
                          >
                            <span>{rec.actionLabel}</span>
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="py-8 text-center text-[14px] text-slate-500 dark:text-slate-400 flex flex-col items-center justify-center gap-1">
                  <Info className="h-5 w-5 text-slate-400" />
                  <span className="font-semibold text-slate-900 dark:text-white">No recommendations</span>
                  <span>Existing tenant configuration shows no immediate advisory items.</span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Right/Secondary: Optional Desktop Summary Rail (~240-280px) */}
        <div className="w-full xl:w-64 shrink-0 border-t xl:border-t-0 xl:border-l border-slate-200/80 dark:border-slate-800 pt-4 xl:pt-0 xl:pl-6 space-y-4 text-[14px]">
          <div className="font-semibold text-slate-900 dark:text-white uppercase tracking-wider text-xs text-slate-500 dark:text-slate-400">
            Tenant Status
          </div>

          <div className="space-y-3.5">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Connection</div>
              <div className="font-semibold text-slate-900 dark:text-white mt-0.5 flex items-center gap-1.5">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    connectionState === 'connected'
                      ? 'bg-emerald-500'
                      : 'bg-red-500'
                  )}
                  aria-hidden="true"
                />
                <span>{connectionLabel}</span>
              </div>
            </div>

            {isSyncProgress && (
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Synchronization</div>
                <div className="font-semibold text-blue-700 dark:text-blue-300 mt-0.5 flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>{display.isInitialSync ? 'Initial sync in progress' : 'In progress'}</span>
                </div>
              </div>
            )}

            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Last successful sync</div>
              <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                {display.lastSuccessfulSync
                  ? formatTenantTimestamp(display.lastSuccessfulSync)
                  : isSyncProgress
                    ? 'Collecting now'
                    : 'No successful sync'}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Active issues</div>
              <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                {display.attentionVerified ? display.issueCount : 'Not verified'}
              </div>
            </div>

            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Recommendations</div>
              <div className="font-semibold text-slate-900 dark:text-white mt-0.5">
                {recommendations.length}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Remediation Drawer */}
      {selectedIssue && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedIssue(null)
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="drawer-title"
        >
          <div className="w-full max-w-md bg-white dark:bg-slate-900 h-full shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col justify-between overflow-hidden animate-in slide-in-from-right duration-200">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 p-4 bg-slate-50/80 dark:bg-slate-950/60">
              <div className="space-y-1 min-w-0 pr-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'text-xs font-semibold px-2 py-0.5 rounded border',
                      selectedIssue.severity === 'Critical'
                        ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800'
                        : selectedIssue.severity === 'Error'
                          ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800'
                          : 'bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-800'
                    )}
                  >
                    {selectedIssue.severity}
                  </span>
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Service: {selectedIssue.service}
                  </span>
                </div>
                <h3 id="drawer-title" className="text-base font-bold text-slate-900 dark:text-white leading-tight">
                  {selectedIssue.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedIssue(null)}
                className="rounded-md p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                aria-label="Close remediation drawer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-4 space-y-4 overflow-y-auto flex-1 text-xs text-slate-700 dark:text-slate-300">
              {/* Explanation */}
              <div className="space-y-1.5">
                <h4 className="font-bold text-slate-900 dark:text-white uppercase text-xs tracking-wider">
                  Plain-Language Explanation
                </h4>
                <p className="bg-slate-50 dark:bg-slate-800/60 p-3 rounded-md border border-slate-200/80 dark:border-slate-800 leading-relaxed text-slate-800 dark:text-slate-200">
                  {selectedIssue.explanation || selectedIssue.detail}
                </p>
              </div>

              {/* Likely Impact */}
              <div className="space-y-1.5">
                <h4 className="font-bold text-slate-900 dark:text-white uppercase text-xs tracking-wider">
                  Likely Impact
                </h4>
                <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                  {selectedIssue.impact ||
                    'Service data in this module may be incomplete, out of date, or restricted until synchronization or permissions are resolved.'}
                </p>
              </div>

              {/* Recommended Steps */}
              <div className="space-y-1.5">
                <h4 className="font-bold text-slate-900 dark:text-white uppercase text-xs tracking-wider">
                  Recommended Steps
                </h4>
                <ol className="list-decimal list-inside space-y-1.5 text-slate-600 dark:text-slate-300 leading-relaxed">
                  {selectedIssue.recommendedSteps?.length ? (
                    selectedIssue.recommendedSteps.map((step, idx) => (
                      <li key={idx} className="pl-1">
                        {step}
                      </li>
                    ))
                  ) : (
                    <>
                      <li>Review tenant settings and consent permissions.</li>
                      <li>Click &quot;Retry synchronization&quot; to attempt refreshing tenant datasets.</li>
                      <li>Contact tenant admin if API scopes require re-consent in Entra ID.</li>
                    </>
                  )}
                </ol>
              </div>

              {/* Expandable Technical Details */}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsTechDetailsOpen(!isTechDetailsOpen)}
                  className="flex items-center justify-between w-full py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5 text-slate-400" />
                    <span>Technical details</span>
                  </span>
                  {isTechDetailsOpen ? (
                    <ChevronDown className="h-4 w-4 text-slate-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  )}
                </button>
                {isTechDetailsOpen && (
                  <div className="mt-2 p-2.5 rounded bg-slate-900 text-slate-200 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
                    {selectedIssue.technicalDetails ||
                      selectedIssue.detail ||
                      'No additional technical stack details recorded.'}
                  </div>
                )}
              </div>

              {/* Last Attempt Time */}
              {selectedIssue.lastDetectedAt && (
                <div className="text-xs text-slate-400 dark:text-slate-500 pt-1">
                  Last detected or attempted:{' '}
                  {formatTenantTimestamp(selectedIssue.lastDetectedAt)}
                </div>
              )}
            </div>

            {/* Drawer Footer Actions */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 flex flex-col sm:flex-row gap-2">
              {selectedIssue.action === 'Retry synchronization' && onSync ? (
                <button
                  type="button"
                  onClick={() => {
                    onSync()
                    setSelectedIssue(null)
                  }}
                  disabled={isSyncing}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 text-xs font-semibold shadow-2xs transition disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                  <span>Retry synchronization</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onOpenModule(selectedIssue.targetModule || 'settings')
                    setSelectedIssue(null)
                  }}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white px-3 py-2 text-xs font-semibold shadow-2xs transition cursor-pointer"
                >
                  <span>{selectedIssue.action || 'Open settings'}</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}

              {selectedIssue.targetModule && selectedIssue.targetModule !== 'settings' && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenModule(selectedIssue.targetModule || 'home')
                    setSelectedIssue(null)
                  }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition cursor-pointer"
                >
                  <span>Open module</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
