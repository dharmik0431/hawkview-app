'use client'

import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Info,
  LucideIcon,
} from 'lucide-react'
import { customerAttention, customerStatus } from '@/lib/attention/customer-attention'
import type { Tenant } from '@/types/api'
import { computeTenantAttention } from '@/lib/attention/computeTenantAttention'
import {
  normalizeMicrosoftRiskSummary,
  presentMicrosoftRiskSummary,
} from '@/lib/identity-risk/microsoft-risk-summary'
import { tenantRiskyUsersPath } from '@/lib/tenants/navigation'

export type MatrixOverallStateKey =
  | 'critical'
  | 'disconnected'
  | 'needs_attention'
  | 'partially_synchronized'
  | 'stale'
  | 'syncing'
  | 'pending_setup'
  | 'unknown'
  | 'healthy'

export interface MatrixOverallStateInfo {
  key: MatrixOverallStateKey
  label: string
  badgeClass: string
  icon: LucideIcon
  rank: number
}

export function getTenantMatrixOverallState(
  tenant: Tenant
): MatrixOverallStateInfo {
  const view = customerAttention(tenant)
  const critical = view.findings.some(item => item.severity === 'critical')
  const risk = getTenantRiskyUsersInfo(tenant)
  const positive = view.findings.length > 0 || (risk.count ?? 0) > 0
  return {
    key: critical ? 'critical' : positive ? 'needs_attention' : view.accessActions.length ? 'pending_setup' : view.incomplete ? 'unknown' : 'healthy',
    label: positive && !view.findings.length ? 'Microsoft risk reported' : customerStatus(view),
    badgeClass: positive || view.accessActions.length ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-slate-100 text-slate-700 border-slate-200',
    icon: critical ? ShieldAlert : positive ? AlertTriangle : Info,
    rank: critical ? 1 : positive ? 3 : 5,
  }
}

export function getTenantActiveIssuesInfo(tenant: Tenant) {
  const view = customerAttention(tenant)
  const items = [...view.findings, ...view.accessActions]
  const count = items.length || (view.incomplete ? null : 0)
  return {
    count,
    highestSeverity: items.some(i => i.severity === 'critical') ? 'critical' as const : items.some(i => i.severity === 'high') ? 'high' as const : items.length ? 'medium' as const : view.incomplete ? 'unknown' as const : 'none' as const,
    summaryText: items.length ? `${items.length} reported customer action${items.length === 1 ? '' : 's'}` : view.incomplete ? 'Customer action total unavailable' : 'No customer actions reported',
    evidenceAvailable: items.length > 0 || !view.incomplete,
    incomplete: view.incomplete,
  }
}

export function getTenantIdentityInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(String(tenant.status || '').toLowerCase())

  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenant.status === 'pending'

  // MFA
  let mfaText = 'MFA registration: Unavailable'
  let mfaValue = tenant.mfaCoverage
  let mfaStatus: 'good' | 'warning' | 'critical' | 'unavailable' = 'unavailable'

  if (tenant.mfaCoverage !== null && tenant.mfaCoverage !== undefined) {
    mfaValue = tenant.mfaCoverage
    mfaText = `MFA registration: ${mfaValue}% covered`
    if (mfaValue >= 85) mfaStatus = 'good'
    else if (mfaValue >= 50) mfaStatus = 'warning'
    else mfaStatus = 'critical'
  } else if (isPending) {
    mfaText = 'MFA registration: Awaiting sync'
  } else if (isDisconnected) {
    mfaText = 'MFA registration: Connection lost'
  }

  // Risky Identities
  let riskyText = 'Risk data unavailable'
  const summary = normalizeMicrosoftRiskSummary(tenant.microsoftRiskSummary)
  const riskPresentation = summary ? presentMicrosoftRiskSummary(summary) : null
  const riskyCount = riskPresentation?.count ?? null

  riskyText = riskPresentation?.headline ?? 'Risk data not reported'

  return {
    mfaText,
    mfaValue,
    mfaStatus,
    riskyText,
    riskyCount,
  }
}

export function getTenantConnectionDataInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const missingPerms = tenant.missingPermissions || []

  let connectionText = 'Microsoft: Not reported'
  let connectionState: 'connected' | 'disconnected' | 'pending' | 'unknown' = 'unknown'

  if (connectionStatus === 'connected') {
    connectionText = 'Microsoft: Connected'
    connectionState = 'connected'
  } else if (['error', 'revoked', 'disconnected'].includes(connectionStatus)) {
    connectionText = 'Microsoft: Disconnected'
    connectionState = 'disconnected'
  } else if (['pending-consent', 'pending'].includes(connectionStatus)) {
    connectionText = 'Microsoft: Pending Consent'
    connectionState = 'pending'
  }

  const view = customerAttention(tenant)
  const dataText = view.findings.length ? `${view.findings.length} reported finding${view.findings.length === 1 ? '' : 's'}` : view.incomplete ? 'Finding total unavailable' : 'No findings reported'
  const dataStatus = view.incomplete ? 'partial' as const : 'current' as const

  return {
    connectionText,
    connectionState,
    dataText,
    dataStatus,
  }
}

export function getTenantSyncTimeInfo(lastSync: string | null) {
  if (!lastSync) {
    return {
      display: 'Never synchronized',
      fullTimestamp: 'No successful synchronization recorded',
      isStale: true,
    }
  }

  try {
    const d = new Date(lastSync)
    const timeMs = d.getTime()
    if (isNaN(timeMs)) {
      return {
        display: 'Not reported',
        fullTimestamp: 'Synchronization time was not reported in a supported format',
        isStale: false,
      }
    }

    const fullTimestamp = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(d)

    const diffMins = Math.max(0, Math.round((Date.now() - timeMs) / 60000))
    let display = '<1m ago'
    if (diffMins >= 1 && diffMins < 60) {
      display = `${diffMins}m ago`
    } else if (diffMins >= 60) {
      const hrs = Math.round(diffMins / 60)
      if (hrs < 24) {
        display = `${hrs}h ago`
      } else {
        const days = Math.round(hrs / 24)
        display = `${days}d ago`
      }
    }

    const isStale = diffMins > 24 * 60

    return {
      display,
      fullTimestamp,
      isStale,
    }
  } catch {
    return {
      display: 'Not reported',
      fullTimestamp: 'Synchronization time was not reported in a supported format',
      isStale: false,
    }
  }
}

export function getTenantRecommendedAction(tenant: Tenant) {
  const view = customerAttention(tenant)
  const risk = getTenantRiskyUsersInfo(tenant)
  if ((risk.count ?? 0) > 0) return { label: 'Review Microsoft risk', destinationUrl: tenantRiskyUsersPath(tenant.id), description: risk.breakdownNote }
  if (view.findings.length) return { label: 'Review findings', destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`, description: `${view.findings.length} reported findings for review. These can include configuration changes and registration gaps.` }
  if (view.accessActions.length) return { label: 'Review access setup', destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}/settings`, description: view.accessActions[0].why }
  return { label: 'View tenant', destinationUrl: `/tenants/${encodeURIComponent(tenant.id)}`, description: view.incomplete ? 'Customer action total unavailable. Open the tenant to review reported data.' : 'Open the tenant to review reported data.' }
}

export function getTenantSecureScoreInfo(tenant: Tenant) {
  const connectionStatus = String(tenant.connectionStatus || '').toLowerCase()
  const tenantStatus = String(tenant.status || '').toLowerCase()
  const isDisconnected =
    ['error', 'revoked', 'disconnected'].includes(connectionStatus) ||
    ['suspended', 'disconnected'].includes(tenantStatus)
  const isPending =
    ['pending-consent', 'pending'].includes(connectionStatus) ||
    tenantStatus === 'pending'

  if (tenant.secureScore !== null && tenant.secureScore !== undefined) {
    const syncInfo = getTenantSyncTimeInfo(tenant.lastSync)
    return {
      score: tenant.secureScore,
      isAvailable: true,
      stateLabel: `${tenant.secureScore}%`,
      pointsText: 'Points breakdown not supplied',
      dateText: tenant.lastSync ? `Sync: ${syncInfo.display}` : 'Sync pending',
      statusType: 'available' as const,
    }
  }

  if (isDisconnected) {
    return {
      score: null,
      isAvailable: false,
      stateLabel: 'Disconnected',
      pointsText: 'Connection lost',
      dateText: '—',
      statusType: 'disconnected' as const,
    }
  }

  if (isPending) {
    return {
      score: null,
      isAvailable: false,
      stateLabel: 'Awaiting synchronization',
      pointsText: 'Initial sync pending',
      dateText: '—',
      statusType: 'awaiting_sync' as const,
    }
  }

  const missingPerms = tenant.missingPermissions || []
  if (missingPerms.some((p) => p.toLowerCase().includes('security') || p.toLowerCase().includes('score'))) {
    return {
      score: null,
      isAvailable: false,
      stateLabel: 'Permission required',
      pointsText: 'SecurityEvents.Read.All missing',
      dateText: '—',
      statusType: 'permission_required' as const,
    }
  }

  return {
    score: null,
    isAvailable: false,
    stateLabel: 'Not available',
    pointsText: 'License or API unavailable',
    dateText: '—',
    statusType: 'unavailable' as const,
  }
}

export function getTenantRiskyUsersInfo(tenant: Tenant): {count: number | null; isExact?: boolean; label: string; statusType: 'available' | 'partial' | 'unavailable' | 'disconnected' | 'awaiting_sync' | 'permission_required'; breakdownNote: string} {
  const summary = normalizeMicrosoftRiskSummary(tenant.microsoftRiskSummary)
  if (summary) {
    const presentation = presentMicrosoftRiskSummary(summary)
    return {
      count: presentation.count,
      isExact: presentation.exact,
      label: presentation.headline,
      statusType: summary.availability === 'AVAILABLE'
        ? 'available' as const
        : summary.availability === 'PARTIAL'
          ? 'partial' as const
          : 'unavailable' as const,
      breakdownNote: presentation.detail,
    }
  }

  return {
    count: null,
    isExact: false,
    label: 'Risk data not reported',
    statusType: 'unavailable' as const,
    breakdownNote: 'Microsoft risk evidence unavailable',
  }
}

export function getTenantThreatsInfo(tenant: Tenant): {count: number | null; isConfirmedZero: boolean; label: string; statusType: 'available' | 'unavailable' | 'disconnected' | 'awaiting_sync'; resolvedCount: null} {
  const view = customerAttention(tenant)
  const count = view.findings.length || (view.incomplete ? null : 0)
  return {
    count, isConfirmedZero: count === 0 && !view.incomplete,
    label: count === null ? 'Finding total unavailable' : `${count} reported finding${count === 1 ? '' : 's'}`,
    statusType: count === null ? 'unavailable' as const : 'available' as const,
    resolvedCount: null,
  }
}

export function getPrimaryConcern(tenant: Tenant) {
  const view = customerAttention(tenant)
  const item = [...view.findings, ...view.accessActions].sort((a,b) => ({critical:0,high:1,medium:2}[a.severity] - {critical:0,high:1,medium:2}[b.severity]))[0]
  if (item) return { title: item.label, detail: item.why, severity: item.severity === 'critical' ? 'critical' as const : 'warning' as const, icon: AlertTriangle }
  const risk = getTenantRiskyUsersInfo(tenant)
  if ((risk.count ?? 0) > 0) return { title: 'Microsoft risk reported', detail: risk.breakdownNote, severity: 'warning' as const, icon: ShieldAlert }
  return { title: customerStatus(view), detail: 'Open the tenant to review reported data.', severity: 'info' as const, icon: Info }
}
