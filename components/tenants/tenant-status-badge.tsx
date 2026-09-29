'use client'

import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  RefreshCw,
  HelpCircle,
} from 'lucide-react'
import { customerAttention, customerStatus } from '@/lib/attention/customer-attention'
import { Badge } from '@/components/ui/badge'
import { tenantActionableHealthProjection } from '@/lib/attention/computeTenantAttention'
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
  | 'unverified'

export interface DisplayStatusInfo {
  key: DisplayStatusKey
  label: string
  badgeClass: string
  icon: typeof CheckCircle2
  primaryActionLabel: string
  primaryActionVariant: 'default' | 'outline' | 'secondary' | 'ghost'
}

export function getTenantDisplayStatus(tenant: Tenant): DisplayStatusInfo {
  const view = customerAttention(tenant)
  return {
    key: view.findings.length ? 'needs_attention' : view.accessActions.length ? 'pending_setup' : view.incomplete ? 'unverified' : 'healthy',
    label: customerStatus(view),
    badgeClass: view.findings.length || view.accessActions.length
      ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300'
      : 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300',
    icon: view.findings.length ? AlertTriangle : HelpCircle,
    primaryActionLabel: view.findings.length ? 'Review findings' : view.accessActions.length ? 'Review access setup' : 'View tenant',
    primaryActionVariant: 'outline',
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
