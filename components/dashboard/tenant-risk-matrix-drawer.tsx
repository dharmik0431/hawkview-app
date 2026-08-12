'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  X,
  ShieldAlert,
  AlertTriangle,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  ExternalLink,
  Info,
  Layers,
  Key,
  Lock,
  Globe,
  Building2,
  Users,
  Copy,
  Check,
  AlertCircle,
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
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import { cn } from '@/lib/utils'

import {
  getTenantMatrixOverallState,
  getTenantActiveIssuesInfo,
  getTenantIdentityInfo,
  getTenantConnectionDataInfo,
  getTenantSyncTimeInfo,
  getTenantRecommendedAction,
} from './tenant-risk-matrix-helpers'

interface TenantRiskMatrixDrawerProps {
  tenant: Tenant | null
  isOpen: boolean
  onClose: () => void
  originatingElement?: HTMLElement | null
}

export function TenantRiskMatrixDrawer({
  tenant,
  isOpen,
  onClose,
  originatingElement,
}: TenantRiskMatrixDrawerProps) {
  const router = useRouter()
  const drawerRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  const previousFocusRef = React.useRef<HTMLElement | null>(null)
  const [copiedId, setCopiedId] = React.useState(false)

  React.useEffect(() => {
    if (isOpen) {
      previousFocusRef.current =
        originatingElement ?? (document.activeElement as HTMLElement)
      document.body.style.overflow = 'hidden'

      setTimeout(() => {
        closeButtonRef.current?.focus()
      }, 50)
    } else {
      document.body.style.overflow = ''
      if (
        previousFocusRef.current &&
        typeof previousFocusRef.current.focus === 'function'
      ) {
        previousFocusRef.current.focus()
      }
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen, originatingElement])

  React.useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      if (e.key === 'Tab' && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return

        const first = focusables[0]
        const last = focusables[focusables.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen || !tenant) return null

  const overallState = getTenantMatrixOverallState(tenant)
  const StateIcon = overallState.icon
  const activeIssues = getTenantActiveIssuesInfo(tenant)
  const identityInfo = getTenantIdentityInfo(tenant)
  const connData = getTenantConnectionDataInfo(tenant)
  const syncInfo = getTenantSyncTimeInfo(tenant.lastSync)
  const recAction = getTenantRecommendedAction(tenant)

  const attentionItems = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  const copyTenantId = () => {
    const idToCopy = tenant.microsoftTenantId || tenant.id
    navigator.clipboard.writeText(idToCopy)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 2000)
  }

  // These scores measure different things. Never substitute HawkView's score for
  // Microsoft's score: a missing Microsoft value must remain visibly missing.
  const hasMicrosoftSecureScore =
    tenant.secureScore !== null && tenant.secureScore !== undefined

  return (
    <TooltipProvider>
      <div className="fixed inset-0 z-50 overflow-hidden bg-slate-950/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200">
        <div
          className="fixed inset-0"
          onClick={onClose}
          aria-hidden="true"
        />

        <div className="fixed inset-y-0 right-0 flex max-w-full pl-6 sm:pl-10">
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="risk-drawer-title"
            aria-describedby="risk-drawer-description"
            className="w-screen max-w-lg bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl transition-transform duration-300 ease-in-out flex flex-col focus:outline-none"
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-start justify-between p-5 sm:p-6 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/80">
              <div className="space-y-1.5 pr-4 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      'px-2 py-0.5 text-xs font-semibold inline-flex items-center gap-1.5 border rounded-md',
                      overallState.badgeClass
                    )}
                  >
                    <StateIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>{overallState.label}</span>
                  </Badge>

                  <span className="text-xs text-slate-400">·</span>

                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {tenant.provider === 'microsoft'
                      ? 'Microsoft 365'
                      : 'Google Workspace'}
                  </span>
                </div>

                <h2
                  id="risk-drawer-title"
                  className="text-xl font-bold text-slate-900 dark:text-white truncate"
                >
                  {tenant.name}
                </h2>

                <p
                  id="risk-drawer-description"
                  className="text-xs text-slate-500 dark:text-slate-400 truncate"
                >
                  {tenant.domain || 'Primary domain not available'}
                </p>
              </div>

              <Button
                ref={closeButtonRef}
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="h-8 w-8 p-0 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 focus:ring-2 focus:ring-blue-500"
                aria-label="Close tenant risk details"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6 text-sm text-slate-700 dark:text-slate-300">
              {/* Section 1: Summary Banner */}
              <div
                className={cn(
                  'p-4 rounded-xl border text-xs sm:text-sm leading-relaxed space-y-1.5',
                  overallState.key === 'critical'
                    ? 'bg-red-50/80 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-900 dark:text-red-200'
                    : overallState.key === 'needs_attention'
                    ? 'bg-amber-50/80 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200'
                    : overallState.key === 'disconnected'
                    ? 'bg-red-50/80 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-900 dark:text-red-200'
                    : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                )}
              >
                <div className="font-semibold flex items-center gap-2">
                  <StateIcon className="h-4 w-4 shrink-0" />
                  <span>
                    Why this tenant is categorized as &ldquo;{overallState.label}&rdquo;
                  </span>
                </div>
                <p className="text-xs leading-normal opacity-90">
                  {overallState.key === 'critical'
                    ? 'Critical security signals or lost tenant connector connectivity require urgent administrator investigation.'
                    : overallState.key === 'needs_attention'
                    ? 'Security gaps, missing API permissions, or incomplete MFA coverage require administrative action.'
                    : overallState.key === 'disconnected'
                    ? 'The Microsoft 365 consent or connection was revoked or disconnected. Re-authentication is required.'
                    : overallState.key === 'stale'
                    ? 'Data synchronization has passed the 24-hour freshness threshold.'
                    : 'Tenant environment is synchronized and operating within healthy posture baselines.'}
                </p>
              </div>

              {/* Section 2: Connection & Synchronization */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-slate-100 text-sm">
                  <RefreshCw className="h-4 w-4 text-slate-500 shrink-0" />
                  <h3>Connection & Data Health</h3>
                </div>

                <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 text-xs">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                      Connection
                    </span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100 block">
                      {connData.connectionText}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                      Data Freshness
                    </span>
                    <span className="font-semibold text-slate-900 dark:text-slate-100 block">
                      {connData.dataText}
                    </span>
                  </div>

                  <div className="col-span-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">
                      Last Successful Sync:
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-medium text-slate-800 dark:text-slate-200 cursor-help underline decoration-dotted">
                          {syncInfo.display}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <span>{syncInfo.fullTimestamp}</span>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>

              {/* Section 3: Identity & Access Protection */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-slate-100 text-sm">
                  <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  <h3>Identity & Access Protection</h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                      MFA Coverage
                    </span>
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {identityInfo.mfaText}
                    </div>
                    {identityInfo.mfaValue !== null && identityInfo.mfaValue < 85 && (
                      <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
                        Below recommended 85% baseline
                      </div>
                    )}
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                      Risky Identities
                    </span>
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {identityInfo.riskyText}
                    </div>
                  </div>
                </div>
              </div>

              {/* Section 4: Separate HawkView and Microsoft scores; never use one as a fallback for the other. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-2 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between text-xs">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-bold text-slate-700 dark:text-slate-300 cursor-help underline decoration-dotted flex items-center gap-1.5">
                          <Info className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span>HawkView Health Score</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <span>HawkView evaluates tenant posture from synchronized data such as MFA coverage, administrative account protection, permission status, and sync freshness.</span>
                      </TooltipContent>
                    </Tooltip>

                    <span className="font-bold text-base text-slate-900 dark:text-slate-100">
                      {tenant.healthScore} / 100
                    </span>
                  </div>
                </div>

                <div className="space-y-2 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between text-xs gap-3">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-bold text-slate-700 dark:text-slate-300 cursor-help underline decoration-dotted flex items-center gap-1.5">
                          <Info className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span>Microsoft Secure Score</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <span>This value comes directly from Microsoft when secure-score collection is available. HawkView never substitutes its own score here.</span>
                      </TooltipContent>
                    </Tooltip>

                    <span className="font-bold text-base text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {hasMicrosoftSecureScore ? `${tenant.secureScore} / 100` : 'Not collected'}
                    </span>
                  </div>
                  {!hasMicrosoftSecureScore && (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Microsoft Secure Score has not been collected for this tenant yet.
                    </p>
                  )}
                </div>
              </div>

              {activeIssues.count > 0 && (
                <div className="text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-1.5 px-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                  <span>
                    Note: {activeIssues.count} active issue{activeIssues.count === 1 ? '' : 's'} require remediation regardless of score.
                  </span>
                </div>
              )}

              {/* Section 5: Active Issues List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <span>Active Issues</span>
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0 text-xs px-2 py-0.5">
                      {activeIssues.count}
                    </Badge>
                  </h3>
                </div>

                {attentionItems.length === 0 ? (
                  <div className="p-4 text-center rounded-xl border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20 space-y-1">
                    <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400 mx-auto" />
                    <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-300">
                      No active issues detected
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {attentionItems.map((item) => (
                      <div
                        key={item.key}
                        className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                            {item.label}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px] font-bold uppercase px-1.5 py-0.2',
                              item.severity === 'critical'
                                ? 'border-red-200 text-red-700 bg-red-50 dark:bg-red-950/50 dark:text-red-300'
                                : item.severity === 'high'
                                ? 'border-amber-200 text-amber-700 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-300'
                                : 'border-blue-200 text-blue-700 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-300'
                            )}
                          >
                            {item.severity}
                          </Badge>
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {item.why}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Missing permissions list */}
              {tenant.missingPermissions && tenant.missingPermissions.length > 0 && (
                <div className="space-y-2 p-3.5 rounded-xl border border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20">
                  <div className="flex items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-300">
                    <Info className="h-4 w-4 text-amber-600 shrink-0" />
                    <span>
                      Missing Microsoft Permissions ({tenant.missingPermissions.length})
                    </span>
                  </div>
                  <ul className="text-xs text-amber-800 dark:text-amber-300/90 space-y-1 list-disc pl-4 font-mono text-[11px]">
                    {tenant.missingPermissions.map((perm) => (
                      <li key={perm}>{perm}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Technical ID Helper */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-100/70 dark:bg-slate-800/40 text-xs text-slate-600 dark:text-slate-400">
                <div className="truncate pr-2">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">
                    Microsoft Tenant ID
                  </span>
                  <code className="font-mono text-slate-900 dark:text-slate-200 truncate block text-[11px]">
                    {tenant.microsoftTenantId || tenant.id}
                  </code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyTenantId}
                  className="h-7 px-2 text-xs gap-1 shrink-0 text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
                >
                  {copiedId ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  <span>{copiedId ? 'Copied' : 'Copy'}</span>
                </Button>
              </div>
            </div>

            {/* Sticky Footer */}
            <div className="sticky bottom-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-t border-slate-200 dark:border-slate-800 p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-xs text-slate-500 dark:text-slate-400 hidden sm:block">
                Recommended action based on active signals
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onClose}
                  className="h-10 px-4 text-xs font-semibold rounded-xl border-slate-300 dark:border-slate-700"
                >
                  Close
                </Button>

                <Button
                  size="sm"
                  onClick={() => {
                    router.push(recAction.destinationUrl)
                    onClose()
                  }}
                  className="h-10 px-5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 rounded-xl flex-1 sm:flex-none flex items-center justify-center gap-2"
                >
                  <span>{recAction.label}</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
