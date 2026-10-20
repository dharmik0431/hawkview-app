'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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
  ShieldQuestion,
  Database,
  Layers,
  Sparkles,
  Shield,
  HelpCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { customerAttention, customerTarget } from '@/lib/attention/customer-attention'
import { tenantPermissionStatus } from '@/lib/tenants/tenant-permission-status'
import {
  tenantConnectionBadge,
  serviceCollectionBadge,
  type CollectionServiceKey,
} from '@/lib/tenants/service-collection-status'
import type { Tenant } from '@/types/api'
import type { AttentionItem, AttentionSeverity } from '@/types/attention'
import { cn } from '@/lib/utils'
import {
  tenantOverviewPath,
  tenantSectionPath,
  tenantEntraPath,
  tenantRiskyUsersPath,
  tenantDataFreshnessPath,
} from '@/lib/tenants/navigation'

export type DrawerTabKey = 'action' | 'optional' | 'evidence' | 'findings'

interface TenantIssueDrawerProps {
  tenant: Tenant | null
  isOpen: boolean
  onClose: () => void
  initialTab?: DrawerTabKey
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
  if (!timeStr) return 'Awaiting initial collection'
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

const CORE_SERVICES: Array<{ key: CollectionServiceKey; label: string }> = [
  { key: 'office365', label: 'Office 365 Core' },
  { key: 'entraId', label: 'Entra ID Directory & Users' },
  { key: 'exchange', label: 'Exchange Online' },
  { key: 'sharePointOneDrive', label: 'SharePoint & OneDrive' },
  { key: 'signInLogs', label: 'Sign-in Logs' },
  { key: 'auditLogs', label: 'Unified Audit Logs' },
]

function resolveItemTarget(tenantId: string, item: AttentionItem): { href: string; label: string } {
  if (item.actionUrl) {
    return { href: item.actionUrl, label: item.actionLabel || 'Investigate in Module' }
  }
  const target = customerTarget(item.provenance)
  switch (target) {
    case 'settings':
      return { href: `${tenantSectionPath(tenantId, 'settings')}?tab=permissions`, label: 'Review in Tenant Settings' }
    case 'risky-users':
      return { href: tenantRiskyUsersPath(tenantId), label: 'Investigate in Risky Users' }
    case 'app-registrations':
      return { href: tenantEntraPath(tenantId, 'app-registrations'), label: 'Inspect App Registrations' }
    case 'entra':
      return { href: tenantEntraPath(tenantId, 'security'), label: 'Review Security Policies in Entra' }
    default:
      return { href: tenantOverviewPath(tenantId), label: 'View in Overview' }
  }
}

export function TenantIssueDrawer({
  tenant,
  isOpen,
  onClose,
  initialTab = 'action',
}: TenantIssueDrawerProps) {
  const [mounted, setMounted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)
  const [activeTab, setActiveTab] = useState<DrawerTabKey>(initialTab)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = originalOverflow
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab)
    } else {
      setShowTechnical(false)
    }
  }, [isOpen, initialTab])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!mounted || !isOpen || !tenant) return null

  const connection = tenantConnectionBadge(tenant)
  const permStatus = tenantPermissionStatus(tenant)
  const customer = customerAttention(tenant)

  // 1. Action Required Items
  const actionItems: Array<{
    id: string
    title: string
    observed: string
    why: string
    destinationHref: string
    destinationLabel: string
    severity: 'critical' | 'high' | 'medium'
  }> = []

  // Check Connection Issues
  if (tenant.connectionStatus === 'error') {
    actionItems.push({
      id: 'connection-error',
      title: 'Connection verification failed',
      observed: tenant.connectionErrorCode
        ? `Microsoft connection verification returned error code: ${tenant.connectionErrorCode}.`
        : 'Tenant-wide Microsoft connection check reported an error.',
      why: 'The connection check failed. Review its recorded cause before assuming which collections are affected.',
      destinationHref: `${tenantSectionPath(tenant.id, 'settings')}`,
      destinationLabel: 'Re-authenticate in Tenant Settings',
      severity: 'critical',
    })
  } else if (tenant.status === 'disconnected' || tenant.connectionStatus === 'revoked') {
    actionItems.push({
      id: 'connection-disconnected',
      title: 'Tenant connection disconnected or revoked',
      observed: 'Microsoft 365 access is disconnected or authorization was revoked by an administrator.',
      why: 'Current access needs review. Check collection status separately to see which resources have stopped advancing.',
      destinationHref: `${tenantSectionPath(tenant.id, 'settings')}`,
      destinationLabel: 'Reconnect Tenant in Settings',
      severity: 'critical',
    })
  } else if (
    tenant.onboarding?.complete === false ||
    tenant.status === 'pending' ||
    tenant.connectionStatus === 'pending-consent'
  ) {
    actionItems.push({
      id: 'setup-incomplete',
      title: 'Onboarding setup incomplete',
      observed: 'Administrator consent or initial connection setup has not completed.',
      why: 'Complete the connection setup before relying on tenant collection status.',
      destinationHref: `${tenantSectionPath(tenant.id, 'settings')}`,
      destinationLabel: 'Complete Onboarding Setup in Settings',
      severity: 'high',
    })
  }

  // Check Missing Required Permissions
  if (permStatus.missing.length > 0) {
    actionItems.push({
      id: 'missing-required-permissions',
      title: `${permStatus.missing.length} required Microsoft permission${permStatus.missing.length === 1 ? '' : 's'} missing`,
      observed: `Missing required grants: ${permStatus.missing.join(', ')}.`,
      why: 'The last permission verification reported these required grants missing. Review the affected datasets before changing consent.',
      destinationHref: `${tenantSectionPath(tenant.id, 'settings')}?tab=permissions`,
      destinationLabel: 'Grant Required Permissions in Settings',
      severity: 'critical',
    })
  } else if (permStatus.label === 'Required access blocked') {
    actionItems.push({
      id: 'required-access-blocked',
      title: 'Required Microsoft access blocked',
      observed: permStatus.detail,
      why: 'Core Microsoft Graph endpoints returned access denied during collection attempts.',
      destinationHref: `${tenantSectionPath(tenant.id, 'settings')}?tab=permissions`,
      destinationLabel: 'Review Access Policies in Settings',
      severity: 'high',
    })
  }

  // Check Access Configuration Actions (from customer.accessActions)
  customer.accessActions.forEach((item, idx) => {
    const target = resolveItemTarget(tenant.id, item)
    actionItems.push({
      id: `access-action-${item.key || idx}`,
      title: item.label,
      observed: `Observed access configuration condition: ${item.label}`,
      why: item.why,
      destinationHref: target.href,
      destinationLabel: target.label,
      severity: item.severity,
    })
  })

  // 2. Optional Capabilities Items
  const optionalItems: Array<{
    id: string
    title: string
    observed: string
    why: string
    destinationHref: string
    destinationLabel: string
  }> = []

  permStatus.optional.forEach((perm) => {
    const isExchange = perm === 'Exchange.ManageAsAppV2'
    optionalItems.push({
      id: `optional-perm-${perm}`,
      title: `Optional permission: ${perm}`,
      observed: `Permission "${perm}" is not granted.`,
      why: isExchange
        ? 'Exchange.ManageAsAppV2 is an optional grant. Review the affected Exchange capability in tenant settings before deciding whether to grant it.'
        : `${perm} is an optional grant. Review its affected capability in tenant settings before deciding whether to grant it.`,
      destinationHref: `${tenantSectionPath(tenant.id, 'settings')}?tab=permissions`,
      destinationLabel: 'Review Optional Consent in Settings',
    })
  })

  // 3. Security Findings
  const securityFindings = customer.findings

  const copyTenantId = () => {
    const idToCopy = tenant.microsoftTenantId || tenant.id
    navigator.clipboard.writeText(idToCopy)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] m-0 p-0 overflow-hidden"
      style={{ top: 0, right: 0, bottom: 0, left: 0 }}
    >
      <div
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-200 m-0 p-0"
        onClick={onClose}
        aria-hidden="true"
        style={{ top: 0, right: 0, bottom: 0, left: 0 }}
      />

      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className="fixed top-0 right-0 h-[100dvh] w-full max-w-2xl bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col m-0 p-0 rounded-none z-10 transition-transform duration-300 ease-in-out"
        style={{ height: '100dvh', top: 0, right: 0 }}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 shrink-0 m-0 rounded-none">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Tenant Assessment & Issues
                  </span>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[11px] font-semibold px-2 py-0.5 rounded-md border',
                      connection.tone === 'ok'
                        ? 'border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400'
                        : connection.tone === 'attention'
                          ? 'border-amber-200 text-amber-800 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
                          : 'border-slate-200 text-slate-700 bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    )}
                  >
                    {connection.label}
                  </Badge>
                </div>

                <h2
                  id="drawer-title"
                  className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white truncate"
                >
                  {tenant.name}
                </h2>

                <div className="flex items-center gap-2 mt-1 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                  <span className="truncate max-w-[200px]">
                    {tenant.domain || 'Domain collection pending'}
                  </span>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <button
                    type="button"
                    onClick={copyTenantId}
                    title="Click to copy Microsoft Tenant ID"
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                  >
                    <span className="truncate max-w-[160px]">
                      {tenant.microsoftTenantId || tenant.id}
                    </span>
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <Copy className="h-3 w-3 text-slate-400 shrink-0" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors shrink-0"
                aria-label="Close drawer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Quick Metrics Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 pt-3 border-t border-slate-200/60 dark:border-slate-800 text-xs">
              <div className="p-2 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">
                  Action Required
                </span>
                <span className="font-bold text-slate-900 dark:text-white text-sm">
                  {actionItems.length ? `${actionItems.length} issue${actionItems.length === 1 ? '' : 's'}` : '0 issues'}
                </span>
              </div>

              <div className="p-2 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">
                  Permissions
                </span>
                <span className="font-bold text-slate-900 dark:text-white text-sm truncate block">
                  {permStatus.missing.length
                    ? `${permStatus.missing.length} missing`
                    : permStatus.tone === 'ok'
                      ? 'No gap'
                      : 'Not verified'}
                </span>
              </div>

              <div className="p-2 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">
                  Security Findings
                </span>
                <span className="font-bold text-slate-900 dark:text-white text-sm">
                  {securityFindings.length ? `${securityFindings.length} reported` : customer.incomplete ? 'Unavailable' : '0 reported'}
                </span>
              </div>

              <div className="p-2 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700">
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">
                  Latest Sync
                </span>
                <span className="font-medium text-slate-700 dark:text-slate-300 text-xs truncate block font-mono tabular-nums">
                  {formatSyncTime(tenant.lastSync)}
                </span>
              </div>
            </div>

            {/* Structured 4-Group Navigation Tabs */}
            <div
              role="tablist"
              aria-label="Tenant information groups"
              className="flex items-center gap-1 mt-4 p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800 overflow-x-auto"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'action'}
                aria-controls="panel-action"
                id="tab-action"
                onClick={() => setActiveTab('action')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all shrink-0',
                  activeTab === 'action'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                )}
              >
                <AlertTriangle className={cn('h-3.5 w-3.5', actionItems.length > 0 ? 'text-amber-600' : 'text-slate-400')} />
                <span>Action Required</span>
                {actionItems.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 text-[10px] font-bold">
                    {actionItems.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'optional'}
                aria-controls="panel-optional"
                id="tab-optional"
                onClick={() => setActiveTab('optional')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all shrink-0',
                  activeTab === 'optional'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                )}
              >
                <Sparkles className="h-3.5 w-3.5 text-blue-500" />
                <span>Optional Capabilities</span>
                {optionalItems.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-300 text-[10px] font-semibold">
                    {optionalItems.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'evidence'}
                aria-controls="panel-evidence"
                id="tab-evidence"
                onClick={() => setActiveTab('evidence')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all shrink-0',
                  activeTab === 'evidence'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                )}
              >
                <Database className="h-3.5 w-3.5 text-indigo-500" />
                <span>Evidence & Collection</span>
                {customer.incomplete && (
                  <span className="px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-300 text-[10px]">
                    Partial
                  </span>
                )}
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'findings'}
                aria-controls="panel-findings"
                id="tab-findings"
                onClick={() => setActiveTab('findings')}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all shrink-0',
                  activeTab === 'findings'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                )}
              >
                <Shield className="h-3.5 w-3.5 text-emerald-600" />
                <span>Security Findings</span>
                {securityFindings.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 text-[10px] font-bold">
                    {securityFindings.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Drawer Body Content */}
          <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
            {/* GROUP 1: ACTION REQUIRED */}
            {activeTab === 'action' && (
              <div
                id="panel-action"
                role="tabpanel"
                aria-labelledby="tab-action"
                className="space-y-4 animate-in fade-in-50 duration-200"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                      Action Required
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Verified problems requiring operator intervention before tenant monitoring or administration can proceed normally.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-xs font-bold px-2 py-0.5',
                      actionItems.length > 0
                        ? 'border-amber-200 text-amber-800 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'border-emerald-200 text-emerald-800 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                    )}
                  >
                    {actionItems.length ? `${actionItems.length} required` : '0 issues'}
                  </Badge>
                </div>

                {actionItems.length === 0 ? (
                  <div className="p-6 text-center rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                      No immediate operator actions required
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                      No operator action was reported in the available tenant evidence. Review permissions and collection status separately for their latest verification.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {actionItems.map((item) => {
                      const cfg = severityConfig[item.severity]
                      const IconComp = cfg.icon

                      return (
                        <div
                          key={item.id}
                          className={cn(
                            'p-4 rounded-2xl border space-y-2.5 transition-all',
                            cfg.border,
                            cfg.bg
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                              <IconComp className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                              <span>{item.title}</span>
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

                          <div className="text-xs space-y-1.5 text-slate-700 dark:text-slate-300 leading-relaxed">
                            <div>
                              <span className="font-semibold text-slate-900 dark:text-slate-200">
                                What HawkView observed:{' '}
                              </span>
                              <span>{item.observed}</span>
                            </div>
                            <div>
                              <span className="font-semibold text-slate-900 dark:text-slate-200">
                                Why it matters:{' '}
                              </span>
                              <span>{item.why}</span>
                            </div>
                          </div>

                          <div className="pt-2 flex items-center justify-between border-t border-slate-200/60 dark:border-slate-800/60">
                            <span className="text-[11px] text-slate-500 font-medium">
                              Specific Next Step:
                            </span>
                            <Link href={item.destinationHref}>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2.5 text-xs font-semibold gap-1 bg-white dark:bg-slate-800 hover:bg-slate-50 border-slate-300 dark:border-slate-700 text-blue-600 dark:text-blue-400"
                              >
                                <span>{item.destinationLabel}</span>
                                <ChevronRight className="h-3 w-3" />
                              </Button>
                            </Link>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* GROUP 2: OPTIONAL CAPABILITIES */}
            {activeTab === 'optional' && (
              <div
                id="panel-optional"
                role="tabpanel"
                aria-labelledby="tab-optional"
                className="space-y-4 animate-in fade-in-50 duration-200"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                      Optional Capabilities
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Optional Microsoft grants reported by the last permission verification.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="text-xs font-semibold px-2 py-0.5 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800"
                  >
                    {optionalItems.length ? `${optionalItems.length} available` : 'None pending'}
                  </Badge>
                </div>

                {optionalItems.length === 0 ? (
                  <div className="p-6 text-center rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                    <Info className="h-8 w-8 text-slate-400 mx-auto" />
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                      No ungranted optional permissions reported
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                      This view has no ungranted optional permissions to list. Check the last permission verification before drawing conclusions about current access.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {optionalItems.map((item) => (
                      <div
                        key={item.id}
                        className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-2.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                            <Sparkles className="h-4 w-4 shrink-0 text-blue-500" />
                            <span>{item.title}</span>
                          </div>
                          <Badge
                            variant="outline"
                            className="text-[10px] font-semibold px-2 py-0.5 border-slate-200 text-slate-600 bg-white dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 shrink-0"
                          >
                            Optional
                          </Badge>
                        </div>

                        <div className="text-xs space-y-1.5 text-slate-600 dark:text-slate-400 leading-relaxed">
                          <div>
                            <span className="font-semibold text-slate-900 dark:text-slate-200">
                              What HawkView observed:{' '}
                            </span>
                            <span>{item.observed}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-slate-900 dark:text-slate-200">
                              Why it matters:{' '}
                            </span>
                            <span>{item.why}</span>
                          </div>
                        </div>

                        <div className="pt-2 flex items-center justify-between border-t border-slate-200/60 dark:border-slate-800/60">
                          <span className="text-[11px] text-slate-400 font-medium">
                            Investigation Path:
                          </span>
                          <Link href={item.destinationHref}>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs font-semibold gap-1 bg-white dark:bg-slate-800 hover:bg-slate-50 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                            >
                              <span>{item.destinationLabel}</span>
                              <ChevronRight className="h-3 w-3" />
                            </Button>
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* GROUP 3: EVIDENCE AND COLLECTION */}
            {activeTab === 'evidence' && (
              <div
                id="panel-evidence"
                role="tabpanel"
                aria-labelledby="tab-evidence"
                className="space-y-5 animate-in fade-in-50 duration-200"
              >
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                    Evidence & Collection Health
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    What was last collected, when, and what cannot currently be assessed.
                  </p>
                </div>

                {/* Latest Sync Card */}
                <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <Clock className="h-4 w-4 text-slate-400" />
                      <span>Latest Resource Collection</span>
                    </span>
                    <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300 font-semibold">
                      {formatSyncTime(tenant.lastSync)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Reflects the timestamp of the most recent successful resource collector. Workloads run on staggered schedules; individual services operate within separate freshness windows.
                  </p>
                </div>

                {/* Per-Service Collection Breakdown */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Monitored Services Collection Breakdown
                  </h4>
                  <div className="grid gap-2">
                    {CORE_SERVICES.map((srv) => {
                      const badge = serviceCollectionBadge(tenant.syncFreshness, srv.key)
                      return (
                        <div
                          key={srv.key}
                          className="p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800 dark:text-slate-200">
                              {srv.label}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px] font-semibold px-2 py-0.5 rounded-md border',
                                badge.tone === 'ok'
                                  ? 'border-emerald-200 text-emerald-700 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400'
                                  : badge.tone === 'attention'
                                    ? 'border-amber-200 text-amber-800 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
                                    : 'border-slate-200 text-slate-600 bg-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                              )}
                            >
                              {badge.label}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                            {badge.detail}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* What cannot currently be assessed */}
                <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 space-y-2">
                  <div className="flex items-center gap-2 font-bold text-xs text-slate-900 dark:text-white">
                    <Database className="h-4 w-4 text-indigo-500" />
                    <span>Evidence Assessment Coverage</span>
                  </div>
                  {customer.incomplete ? (
                    <div className="text-xs text-slate-600 dark:text-slate-400 space-y-2 leading-relaxed">
                      <p>
                        <span className="font-semibold text-slate-900 dark:text-slate-200">
                          Notice:{' '}
                        </span>
                        Some security assessments and checks could not be computed because corresponding collector evidence is partial, stale, or unverified. Zero reported findings in uncollected areas does not imply healthy configurations.
                      </p>
                      {customer.limitations.length > 0 && (
                        <p className="text-slate-500">
                          {customer.limitations.length} evidence limitation(s) recorded (e.g. licensing prerequisite limits).
                        </p>
                      )}
                      <div className="pt-1">
                        <Link href={tenantDataFreshnessPath(tenant.id)}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs font-semibold gap-1 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-blue-600 dark:text-blue-400"
                          >
                            <span>Inspect Data Freshness & Sync Gaps</span>
                            <ChevronRight className="h-3 w-3" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1 leading-relaxed">
                      <p>
                        No evidence limitation was reported in this tenant summary. Check Data Freshness for resource-level collection status.
                      </p>
                      <p className="text-[11px] text-slate-500">
                        This summary does not establish payload completeness or the status of every Microsoft 365 feature.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* GROUP 4: SECURITY FINDINGS */}
            {activeTab === 'findings' && (
              <div
                id="panel-findings"
                role="tabpanel"
                aria-labelledby="tab-findings"
                className="space-y-4 animate-in fade-in-50 duration-200"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                      Reported Security Findings
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Separate from connection and permission health.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-xs font-bold px-2 py-0.5',
                      securityFindings.length > 0
                        ? 'border-red-200 text-red-800 bg-red-50 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
                        : customer.incomplete
                          ? 'border-slate-200 text-slate-700 bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
                          : 'border-emerald-200 text-emerald-800 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                    )}
                  >
                    {securityFindings.length ? `${securityFindings.length} reported` : customer.incomplete ? 'Finding total unavailable' : '0 reported'}
                  </Badge>
                </div>

                {/* Active Findings List */}
                {securityFindings.length === 0 ? (
                  <div className="p-6 text-center rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                    {customer.incomplete ? <HelpCircle className="h-8 w-8 text-slate-500 mx-auto" /> : <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />}
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                      {customer.incomplete ? 'Finding total unavailable' : 'No findings reported from available evidence'}
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                      {customer.incomplete
                        ? 'The available evidence cannot establish a finding total. Review evidence and collection limitations before assessing this tenant.'
                        : 'No security findings were reported from currently available collection evidence. This does not confirm the absence of vulnerabilities in unmonitored or uncollected resources.'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {securityFindings.map((item) => {
                      const cfg = severityConfig[item.severity]
                      const IconComp = cfg.icon
                      const target = resolveItemTarget(tenant.id, item)

                      return (
                        <div
                          key={item.key}
                          className={cn(
                            'p-4 rounded-2xl border space-y-2.5 transition-all',
                            cfg.border,
                            cfg.bg
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                              <IconComp className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
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

                          <div className="text-xs space-y-1.5 text-slate-700 dark:text-slate-300 leading-relaxed">
                            <div>
                              <span className="font-semibold text-slate-900 dark:text-slate-200">
                                Observed condition:{' '}
                              </span>
                              <span>{item.label}</span>
                            </div>
                            <div>
                              <span className="font-semibold text-slate-900 dark:text-slate-200">
                                Why it matters:{' '}
                              </span>
                              <span>{item.why}</span>
                            </div>
                            {item.detectedAt && (
                              <div className="text-[11px] text-slate-400">
                                First observed: {formatSyncTime(item.detectedAt)}
                              </div>
                            )}
                          </div>

                          <div className="pt-2 flex items-center justify-between border-t border-slate-200/60 dark:border-slate-800/60">
                            <span className="text-[11px] text-slate-500 font-medium">
                              Investigate:
                            </span>
                            <Link href={target.href}>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2.5 text-xs font-semibold gap-1 bg-white dark:bg-slate-800 hover:bg-slate-50 border-slate-300 dark:border-slate-700 text-blue-600 dark:text-blue-400"
                              >
                                <span>{target.label}</span>
                                <ChevronRight className="h-3 w-3" />
                              </Button>
                            </Link>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

              </div>
            )}

            {/* Technical Diagnostics Accordion */}
            <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
              <button
                type="button"
                onClick={() => setShowTechnical(!showTechnical)}
                className="w-full flex items-center justify-between py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
              >
                <span>Technical Diagnostics</span>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform duration-200',
                    showTechnical && 'rotate-180'
                  )}
                />
              </button>

              {showTechnical && (
                <div className="mt-3 p-3.5 rounded-xl bg-slate-900 text-slate-200 font-mono text-[11px] space-y-2 overflow-x-auto">
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
                  <div>
                    <span className="text-slate-500">tenantInternalId:</span>{' '}
                    <span>{tenant.id}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">microsoftTenantId:</span>{' '}
                    <span>{tenant.microsoftTenantId || 'none'}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="p-4 sm:p-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 flex items-center gap-3 shrink-0 m-0 rounded-none">
            <Link href={tenantOverviewPath(String(tenant.id))} className="flex-1">
              <Button className="w-full gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                <span>Manage Tenant Environment</span>
                <ExternalLink className="h-4 w-4" />
              </Button>
            </Link>
            <Button
              variant="outline"
              onClick={onClose}
              className="rounded-xl border-slate-200 dark:border-slate-800 font-medium"
            >
              Close
            </Button>
          </div>
        </div>
      </div>,
      document.body
    )
}
