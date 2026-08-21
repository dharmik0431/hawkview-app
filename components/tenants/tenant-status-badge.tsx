'use client'

import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  RefreshCw,
  HelpCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import type { Tenant } from '@/types/api'
import { cn } from '@/lib/utils'

export type DisplayStatusKey =
  | 'healthy'
  | 'needs_attention'
  | 'disconnected'
  | 'pending_setup'
  | 'syncing'
  | 'partially_synchronized'
  | 'stale'

export interface DisplayStatusInfo {
  key: DisplayStatusKey
  label: string
  badgeClass: string
  icon: typeof CheckCircle2
  primaryActionLabel: string
  primaryActionVariant: 'default' | 'outline' | 'secondary' | 'ghost'
}

export function getTenantDisplayStatus(tenant: Tenant): DisplayStatusInfo {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()
  const missingPerms = tenant.missingPermissions || []

  const attentionItems = computeTenantAttention(tenant)

  // 1. Disconnected
  if (
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)
  ) {
    return {
      key: 'disconnected',
      label: 'Disconnected',
      badgeClass:
        'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
      icon: XCircle,
      primaryActionLabel: 'Reconnect',
      primaryActionVariant: 'outline',
    }
  }

  // 2. Pending Setup
  if (
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'
  ) {
    return {
      key: 'pending_setup',
      label: 'Pending Setup',
      badgeClass:
        'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
      icon: Clock,
      primaryActionLabel: 'Complete setup',
      primaryActionVariant: 'outline',
    }
  }

  // 3. Needs Attention
  if (attentionItems.length > 0 || missingPerms.length > 0) {
    const hasCritical = attentionItems.some((item) => item.severity === 'critical')
    return {
      key: 'needs_attention',
      label: 'Needs Attention',
      badgeClass: hasCritical
        ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900'
        : 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
      icon: AlertTriangle,
      primaryActionLabel: 'Review issues',
      primaryActionVariant: 'default',
    }
  }

  // 4. Stale Data / Pending Sync
  if (!tenant.lastSync) {
    return {
      key: 'stale',
      label: 'Awaiting Sync',
      badgeClass:
        'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
      icon: RefreshCw,
      primaryActionLabel: 'Review sync',
      primaryActionVariant: 'outline',
    }
  }

  // Check sync age (>24 hours is stale)
  const syncTime = new Date(tenant.lastSync).getTime()
  const hoursOld = (Date.now() - syncTime) / (1000 * 60 * 60)
  if (hoursOld > 24) {
    return {
      key: 'stale',
      label: 'Stale Data',
      badgeClass:
        'bg-amber-50/80 text-amber-700 border-amber-200/80 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/60',
      icon: Clock,
      primaryActionLabel: 'Review sync',
      primaryActionVariant: 'outline',
    }
  }

  // 5. Healthy
  return {
    key: 'healthy',
    label: 'Healthy',
    badgeClass:
      'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
    icon: CheckCircle2,
    primaryActionLabel: 'View tenant',
    primaryActionVariant: 'ghost',
  }
}

export function TenantStatusBadge({ tenant }: { tenant: Tenant }) {
  const statusInfo = getTenantDisplayStatus(tenant)
  const Icon = statusInfo.icon

  return (
    <Badge
      variant="outline"
      className={cn(
        'px-2.5 py-0.5 text-xs font-medium inline-flex items-center gap-1.5 shrink-0 rounded-md border',
        statusInfo.badgeClass
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{statusInfo.label}</span>
    </Badge>
  )
}
