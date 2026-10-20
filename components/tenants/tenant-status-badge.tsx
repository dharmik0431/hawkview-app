'use client'

import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
} from 'lucide-react'
import { customerAttention, customerStatus } from '@/lib/attention/customer-attention'
import { tenantPermissionStatus } from '@/lib/tenants/tenant-permission-status'
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

export type ReviewSummaryType =
  | 'error'
  | 'pending_setup'
  | 'finding_and_action'
  | 'finding'
  | 'action'
  | 'unverified'
  | 'no_findings'

export interface ReviewSummaryInfo {
  type: ReviewSummaryType
  headline: string
  detail: string
  tone: 'error' | 'warning' | 'neutral' | 'ok'
  drawerTab: 'action' | 'findings'
  primaryActionLabel: string
}

export function getTenantReviewSummary(tenant: Tenant): ReviewSummaryInfo {
  const perm = tenantPermissionStatus(tenant)
  const view = customerAttention(tenant)

  // 1. Connection Errors or Disconnected states
  if (tenant.connectionStatus === 'error') {
    return {
      type: 'error',
      headline: 'Connection error',
      detail: tenant.connectionErrorCode
        ? `Verification code: ${tenant.connectionErrorCode}`
        : 'Connection check reported an error',
      tone: 'error',
      drawerTab: 'action',
      primaryActionLabel: 'Review connection',
    }
  }

  if (tenant.status === 'disconnected' || tenant.connectionStatus === 'revoked') {
    return {
      type: 'error',
      headline: 'Connection disconnected',
      detail: 'Microsoft access revoked or disconnected',
      tone: 'error',
      drawerTab: 'action',
      primaryActionLabel: 'Review connection',
    }
  }

  // 2. Setup Pending
  if (
    tenant.onboarding?.complete === false ||
    tenant.status === 'pending' ||
    tenant.connectionStatus === 'pending-consent'
  ) {
    return {
      type: 'pending_setup',
      headline: 'Setup pending',
      detail: 'Initial onboarding incomplete',
      tone: 'warning',
      drawerTab: 'action',
      primaryActionLabel: 'Continue setup',
    }
  }

  // 3. Required permissions missing
  if (perm.missing.length > 0) {
    return {
      type: 'action',
      headline: `${perm.missing.length} required permission${perm.missing.length === 1 ? '' : 's'} missing`,
      detail: `Missing grants: ${perm.missing.join(', ')}`,
      tone: 'warning',
      drawerTab: 'action',
      primaryActionLabel: 'Review permissions',
    }
  }

  if (perm.label === 'Required access blocked') {
    return {
      type: 'action',
      headline: 'Required access blocked',
      detail: 'Core Microsoft endpoints returned access denied',
      tone: 'warning',
      drawerTab: 'action',
      primaryActionLabel: 'Review permissions',
    }
  }

  const findingsCount = view.findings.length
  const accessActionsCount = view.accessActions.length

  // 4. Distinguish verified security findings vs required customer actions
  if (findingsCount > 0 && accessActionsCount > 0) {
    return {
      type: 'finding_and_action',
      headline: `${findingsCount} security finding${findingsCount === 1 ? '' : 's'} · ${accessActionsCount} action required`,
      detail: `${view.findings[0]?.label || 'Security finding'} and ${view.accessActions[0]?.label || 'access action'}`,
      tone: 'warning',
      drawerTab: 'findings',
      primaryActionLabel: 'Review findings',
    }
  }

  if (findingsCount > 0) {
    return {
      type: 'finding',
      headline: `${findingsCount} reported security finding${findingsCount === 1 ? '' : 's'}`,
      detail: view.findings[0]?.label || 'Review reported security findings',
      tone: 'warning',
      drawerTab: 'findings',
      primaryActionLabel: 'Review findings',
    }
  }

  if (accessActionsCount > 0) {
    return {
      type: 'action',
      headline: `${accessActionsCount} customer action${accessActionsCount === 1 ? '' : 's'} required`,
      detail: view.accessActions[0]?.label || 'Customer administrative action required',
      tone: 'warning',
      drawerTab: 'action',
      primaryActionLabel: 'Review action',
    }
  }

  // 5. Evidence unavailable / incomplete
  if (view.incomplete) {
    return {
      type: 'unverified',
      headline: 'Evidence incomplete',
      detail: 'Finding total unavailable from current evidence',
      tone: 'neutral',
      drawerTab: 'findings',
      primaryActionLabel: 'Review tenant',
    }
  }

  // 6. Clean state: No findings reported from available evidence
  return {
    type: 'no_findings',
    headline: 'No findings reported',
    detail: 'No findings reported from available evidence · No actions reported',
    tone: 'ok',
    drawerTab: 'findings',
    primaryActionLabel: 'Review tenant',
  }
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

export function TenantStatusBadge({
  tenant,
  onClick,
}: {
  tenant: Tenant
  onClick?: () => void
}) {
  const summary = getTenantReviewSummary(tenant)

  const Icon =
    summary.tone === 'ok'
      ? CheckCircle2
      : summary.tone === 'error'
        ? XCircle
        : summary.tone === 'warning'
          ? AlertTriangle
          : HelpCircle

  const toneColor =
    summary.tone === 'ok'
      ? 'text-emerald-700 dark:text-emerald-400'
      : summary.tone === 'error'
        ? 'text-rose-700 dark:text-rose-400'
        : summary.tone === 'warning'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-slate-600 dark:text-slate-400'

  const content = (
    <div className="flex flex-col items-start gap-0.5 text-left">
      <div className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', toneColor)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{summary.headline}</span>
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[280px]">
        {summary.detail}
      </div>
    </div>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${summary.headline}: ${summary.detail}. Click to view details.`}
        className="text-left rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/60 p-1 -m-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {content}
      </button>
    )
  }

  return content
}
