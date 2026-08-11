'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  X,
  AlertTriangle,
  AlertCircle,
  ShieldAlert,
  CheckCircle2,
  ChevronRight,
  Copy,
  Check,
  Clock,
  ExternalLink,
  ChevronDown,
  Info,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import type { Tenant } from '@/types/api'
import type { AttentionItem, AttentionSeverity } from '@/types/attention'
import { cn } from '@/lib/utils'
import { tenantOverviewPath } from '@/lib/tenants/navigation'

interface TenantIssueDrawerProps {
  tenant: Tenant | null
  isOpen: boolean
  onClose: () => void
}

const severityConfig: Record<
  AttentionSeverity,
  {
    badge: string
    icon: typeof AlertTriangle
    label: string
    border: string
    bg: string
  }
> = {
  critical: {
    badge: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
    icon: ShieldAlert,
    label: 'Critical',
    border: 'border-red-200 dark:border-red-900/50',
    bg: 'bg-red-50/50 dark:bg-red-950/20',
  },
  high: {
    badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    icon: AlertTriangle,
    label: 'High Priority',
    border: 'border-amber-200 dark:border-amber-900/50',
    bg: 'bg-amber-50/50 dark:bg-amber-950/20',
  },
  medium: {
    badge: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20',
    icon: AlertCircle,
    label: 'Medium Priority',
    border: 'border-yellow-200 dark:border-yellow-900/50',
    bg: 'bg-yellow-50/50 dark:bg-yellow-950/20',
  },
}

function formatSyncTime(timeStr: string | null) {
  if (!timeStr) return 'Awaiting initial synchronization'
  try {
    const d = new Date(timeStr)
    if (isNaN(d.getTime())) return timeStr
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return timeStr
  }
}

export function TenantIssueDrawer({
  tenant,
  isOpen,
  onClose,
}: TenantIssueDrawerProps) {
  const [copied, setCopied] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) {
      setShowTechnical(false)
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen || !tenant) return null

  const attentionItems: AttentionItem[] = computeTenantAttention({
    ...((tenant as any)?.bundle ?? {}),
    connectionStatus: tenant.connectionStatus,
    status: tenant.status,
    missingPermissions: tenant.missingPermissions,
  })

  const copyTenantId = () => {
    const idToCopy = tenant.microsoftTenantId || tenant.id
    navigator.clipboard.writeText(idToCopy)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isDisconnected =
    tenant.status === 'disconnected' ||
    tenant.status === 'suspended' ||
    ['error', 'revoked'].includes(tenant.connectionStatus || '')

  const isPending =
    tenant.status === 'pending' ||
    tenant.connectionStatus === 'pending-consent'

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-950/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-200">
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="drawer-title"
          className="w-screen max-w-md transform bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl transition-transform duration-300 ease-in-out flex flex-col"
        >
          {/* Header */}
          <div className="flex items-start justify-between p-6 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
            <div className="space-y-1 pr-6">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Tenant Details & Issues
                </span>
              </div>
              <h2
                id="drawer-title"
                className="text-xl font-bold text-slate-900 dark:text-white truncate"
              >
                {tenant.name}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {tenant.domain || 'Domain collection pending'}
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
              aria-label="Close drawer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Quick Status Bar */}
            <div className="grid grid-cols-2 gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
              <div>
                <span className="text-[10px] font-semibold uppercase text-slate-400 block mb-1">
                  Connection State
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    'text-xs font-semibold capitalize',
                    tenant.connectionStatus === 'connected'
                      ? 'border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400'
                      : tenant.connectionStatus === 'pending-consent'
                        ? 'border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400'
                        : 'border-red-200 text-red-700 bg-red-50 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400'
                  )}
                >
                  {tenant.connectionStatus || 'Unknown'}
                </Badge>
              </div>

              <div>
                <span className="text-[10px] font-semibold uppercase text-slate-400 block mb-1">
                  Last Sync
                </span>
                <div className="flex items-center gap-1 text-xs font-medium text-slate-700 dark:text-slate-300">
                  <Clock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  <span className="truncate">
                    {formatSyncTime(tenant.lastSync)}
                  </span>
                </div>
              </div>
            </div>

            {/* Tenant ID Copy Bar */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-100/70 dark:bg-slate-800/40 text-xs text-slate-600 dark:text-slate-400">
              <div className="space-y-0.5 truncate pr-2">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">
                  Microsoft Tenant ID
                </span>
                <code className="font-mono text-slate-900 dark:text-slate-200 truncate block">
                  {tenant.microsoftTenantId || tenant.id}
                </code>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={copyTenantId}
                className="h-8 px-2.5 text-xs gap-1 shrink-0 text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </Button>
            </div>

            {/* Attention Items Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>Detected Issues</span>
                  <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0 text-xs px-2 py-0.5">
                    {attentionItems.length}
                  </Badge>
                </h3>
              </div>

              {attentionItems.length === 0 ? (
                <div className="p-6 text-center rounded-2xl border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20 space-y-2">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400 mx-auto" />
                  <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-300">
                    No active issues detected
                  </p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-400/80">
                    This environment is connected and performing within healthy security parameters.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {attentionItems.map((item) => {
                    const cfg = severityConfig[item.severity]
                    const IconComp = cfg.icon

                    return (
                      <div
                        key={item.key}
                        className={cn(
                          'p-4 rounded-2xl border space-y-2 transition-all',
                          cfg.border,
                          cfg.bg
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 font-semibold text-sm text-slate-900 dark:text-white">
                            <IconComp className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                            <span>{item.label}</span>
                          </div>
                          <Badge
                            className={cn(
                              'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 border shrink-0',
                              cfg.badge
                            )}
                          >
                            {cfg.label}
                          </Badge>
                        </div>

                        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                          {item.why}
                        </p>

                        <div className="pt-2 flex items-center justify-between border-t border-slate-200/50 dark:border-slate-800/50">
                          <span className="text-[11px] text-slate-400 font-medium">
                            Recommended Action:
                          </span>
                          <Link href={tenantOverviewPath(String(tenant.id))}>
                            <span className="text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 inline-flex items-center gap-1 hover:underline">
                              Review in Module
                              <ChevronRight className="h-3.5 w-3.5" />
                            </span>
                          </Link>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Missing Permissions (if any) */}
            {tenant.missingPermissions && tenant.missingPermissions.length > 0 && (
              <div className="space-y-2 p-4 rounded-2xl border border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-300">
                  <Info className="h-4 w-4 text-amber-600 shrink-0" />
                  <span>Missing Microsoft Permissions ({tenant.missingPermissions.length})</span>
                </div>
                <ul className="text-xs text-amber-800 dark:text-amber-300/90 space-y-1 list-disc pl-4">
                  {tenant.missingPermissions.map((perm) => (
                    <li key={perm} className="font-mono text-[11px]">
                      {perm}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Technical Details Accordion */}
            <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => setShowTechnical(!showTechnical)}
                className="w-full flex items-center justify-between py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
              >
                <span>Technical Details</span>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform duration-200',
                    showTechnical && 'rotate-180'
                  )}
                />
              </button>

              {showTechnical && (
                <div className="mt-3 p-3 rounded-xl bg-slate-900 text-slate-200 font-mono text-[11px] space-y-2 overflow-x-auto">
                  <div>
                    <span className="text-slate-500">connectionMode:</span>{' '}
                    <span className="text-emerald-400">{tenant.connectionMode}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">provider:</span>{' '}
                    <span className="text-blue-400">{tenant.provider}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">errorCode:</span>{' '}
                    <span className="text-amber-400">
                      {tenant.connectionErrorCode || 'none'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">consentedPermissionsCount:</span>{' '}
                    <span>{tenant.consentedPermissions?.length || 0}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer Action */}
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center gap-3">
            <Link
              href={tenantOverviewPath(String(tenant.id))}
              className="flex-1"
            >
              <Button className="w-full gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                <span>Manage Tenant Environment</span>
                <ExternalLink className="h-4 w-4" />
              </Button>
            </Link>
            <Button
              variant="outline"
              onClick={onClose}
              className="rounded-xl border-slate-200 dark:border-slate-800"
            >
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
